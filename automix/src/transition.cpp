#include "transition.h"

#include <SoundTouch.h>

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "mix.h"

namespace automix {

namespace {

constexpr double kBassCutoffHz = 200;
constexpr int kMaxRampBeats = 32;  // the tempo glides over up to 8 bars before the overlap
constexpr double kSpliceSeconds = 0.03;  // live audio -> rendered audio crossfade at renderStart

std::string format(const char* fmt, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    snprintf(buf, sizeof buf, fmt, a, b, c, d);
    return buf;
}

// `frames` frames of `src` from `from`, converted to `rate`, exactly `frames * rate / src.rate` long (zero padded).
std::vector<float> slice(const Audio& src, int64_t from, int64_t frames, unsigned rate, int64_t outFrames,
    const Resampler& resample) {
    const int64_t avail = std::clamp<int64_t>(src.end() - from, 0, frames);
    std::vector<float> v(src.at(from), src.at(from) + avail * src.channels);
    if (src.rate != rate) v = resample(v, src.rate, rate);
    v.resize((size_t)outFrames * src.channels, 0.0f);
    return v;
}

}  // namespace

OldPlan planOldSide(const Audio& old, int64_t oldEnd, const Beats& beats, int bars) {
    OldPlan p;
    const int n4 = 4 * bars, count = (int)beats.frames.size();
    auto abs = [&](int i) { return old.start + (int64_t)std::llround(beats.frames[i]); };
    // the latest bar whose overlap still ends before the sound does
    for (auto it = beats.downbeats.rbegin(); it != beats.downbeats.rend(); ++it) {
        if (*it + n4 < count && abs(*it + n4) <= oldEnd) {
            p.overlapBeat = *it;
            break;
        }
    }
    if (p.overlapBeat < 0) return p;
    // beats in the first 2 s of the analysed audio are less reliable
    int first = 0;
    while (first < p.overlapBeat && abs(first) < old.start + 2 * (int64_t)old.rate) ++first;
    p.rampBeats = (std::min)(kMaxRampBeats, p.overlapBeat - first) / 4 * 4;
    p.renderStart = abs(p.overlapBeat - p.rampBeats);
    return p;
}

Transition plainTransition(const Audio& old, int64_t oldEnd, const Audio& next, int64_t nextStart, const Settings& s,
    const Resampler& resample) {
    const unsigned ch = old.channels;
    const int64_t len = std::llround(s.seconds * old.rate), nextLen = std::llround(s.seconds * next.rate);
    Transition t;
    t.renderStart = (std::max)(old.start, oldEnd - len);
    t.newResume = nextStart + nextLen;
    const int64_t n = oldEnd - t.renderStart;
    const std::vector<float> head = slice(next, nextStart, nextLen, old.rate, n, resample);

    LowPass lp;
    lp.setup(kBassCutoffHz, old.rate, ch);
    t.out.resize((size_t)n * ch);
    const float* o = old.at(t.renderStart);
    for (int64_t k = 0; k < n; ++k) {
        const double prog = (double)k / n, gOut = fadeOutGain(prog), gIn = fadeInGain(prog);
        for (unsigned c = 0; c < ch; ++c) {
            const size_t i = (size_t)k * ch + c;
            const double x = o[i];
            t.out[i] = (float)((x - lp.process(c, x) * s.bassCut * prog) * gOut + head[i] * gIn);
        }
    }
    t.summary = format("chuyển mượt %.0f giây", s.seconds);
    return t;
}

bool beatTransition(const Audio& old, const Beats& oldBeats, const OldPlan& plan, const Audio& next, int64_t nextStart,
    const Beats& nextBeats, const Settings& s, const Resampler& resample, Transition& out, std::string& why) {
    if (!oldBeats.steady()) {
        why = format("bài đang phát không có nhịp đều (%.0f BPM, dao động %.0f%%)", oldBeats.bpm, oldBeats.spread * 100);
        return false;
    }
    if (!nextBeats.steady()) {
        why = format("bài kế không có nhịp đều (%.0f BPM, dao động %.0f%%)", nextBeats.bpm, nextBeats.spread * 100);
        return false;
    }
    const double diff = nextBeats.bpm / oldBeats.bpm - 1;
    if (std::fabs(diff) > s.maxBpmDiff) {
        why = format("lệch BPM quá nhiều (%.1f → %.1f, %+.0f%%)", oldBeats.bpm, nextBeats.bpm, diff * 100);
        return false;
    }
    if (plan.overlapBeat < 0) {
        why = "không tìm được ô nhịp ở cuối bài đang phát";
        return false;
    }

    const unsigned ch = old.channels;
    const double ro = old.rate, rn = next.rate, scale = ro / rn;
    const int n4 = 4 * s.bars;
    auto ob = [&](int i) { return (double)old.start + oldBeats.frames[i]; };
    auto nb = [&](int i) { return (double)next.start + nextBeats.frames[i]; };

    // the next track enters on its first bar after the leading silence
    int k0 = -1;
    for (int d : nextBeats.downbeats) {
        if (nb(d) >= nextStart - 0.05 * rn && d + n4 < (int)nextBeats.frames.size()) {
            k0 = d;
            break;
        }
    }
    if (k0 < 0 || std::llround(nb(k0 + n4)) > next.end()) {
        why = "không tìm được ô nhịp ở đầu bài kế";
        return false;
    }

    // output timeline (outgoing rate, from renderStart): each outgoing beat gets a target length
    const int jR = plan.overlapBeat - plan.rampBeats, segs = plan.rampBeats + n4;
    const double newPeriod = (nb(k0 + n4) - nb(k0)) / n4 * scale;
    std::vector<double> edge(segs + 1, 0.0);
    for (int i = 0; i < segs; ++i) {
        const int j = jR + i;
        double target;
        if (i < plan.rampBeats) {
            const double f = (i + 1.0) / plan.rampBeats;
            target = (ob(j + 1) - ob(j)) * (1 - f) + newPeriod * f;
        } else {
            const int m = i - plan.rampBeats;
            target = (nb(k0 + m + 1) - nb(k0 + m)) * scale;
        }
        edge[i + 1] = edge[i] + target;
    }
    const int64_t total = std::llround(edge[segs]), ovStart = std::llround(edge[plan.rampBeats]);

    // stretch the outgoing track beat by beat onto that timeline, correcting drift as it goes
    soundtouch::SoundTouch st;
    st.setSampleRate(old.rate);
    st.setChannels(ch);
    std::vector<float> stretched, buf(4096 * ch);
    auto receive = [&] {
        unsigned got;
        while ((got = st.receiveSamples(buf.data(), 4096)) > 0) stretched.insert(stretched.end(), buf.begin(), buf.begin() + got * ch);
    };
    for (int i = 0; i < segs; ++i) {
        const int64_t a = std::llround(ob(jR + i)), b = std::llround(ob(jR + i + 1));
        const double produced = (double)(stretched.size() / ch + st.numSamples());
        const double want = (std::max)(1.0, edge[i + 1] - produced);
        st.setTempo(std::clamp((st.numUnprocessedSamples() + (double)(b - a)) / want, 0.5, 2.0));
        st.putSamples(old.at(a), (unsigned)(b - a));
        receive();
    }
    const int64_t tailFrom = std::llround(ob(jR + segs));
    const int64_t extra = std::clamp<int64_t>(old.end() - tailFrom, 0, (int64_t)ro / 2);
    if (extra > 0) st.putSamples(old.at(tailFrom), (unsigned)extra);
    st.flush();
    receive();
    stretched.resize((size_t)total * ch, 0.0f);

    const int64_t nextFrom = std::llround(nb(k0)), nextTo = std::llround(nb(k0 + n4));
    const std::vector<float> head = slice(next, nextFrom, nextTo - nextFrom, old.rate, total - ovStart, resample);

    // mix: highs cross over the whole overlap, the bass swaps within one beat at the middle bar
    const int64_t mid = ovStart + std::llround((nb(k0 + 4 * (s.bars / 2)) - nb(k0)) * scale);
    const double swapLen = (std::max)(1.0, newPeriod);
    const int64_t splice = (std::min)((int64_t)std::llround(kSpliceSeconds * ro), ovStart);
    const float* raw = old.at(std::llround(ob(jR)));
    LowPass lpOld, lpNew;
    lpOld.setup(kBassCutoffHz, ro, ch);
    lpNew.setup(kBassCutoffHz, ro, ch);
    out.out.resize((size_t)total * ch);
    for (int64_t k = 0; k < total; ++k) {
        for (unsigned c = 0; c < ch; ++c) {
            const size_t i = (size_t)k * ch + c;
            double y = stretched[i];
            if (k < splice) y = raw[i] + (y - raw[i]) * ((double)k / splice);
            if (k >= ovStart) {
                const double prog = (double)(k - ovStart) / (total - ovStart);
                const double sw = std::clamp((k - mid) / swapLen, 0.0, 1.0);
                const double oldLow = lpOld.process(c, y), newLow = lpNew.process(c, head[(size_t)(k - ovStart) * ch + c]);
                const double oldHigh = y - oldLow, newHigh = head[(size_t)(k - ovStart) * ch + c] - newLow;
                y = oldHigh * fadeOutGain(prog) + oldLow * (1 - sw) + newHigh * fadeInGain(prog) + newLow * sw;
            }
            out.out[i] = (float)y;
        }
    }
    out.renderStart = std::llround(ob(jR));
    out.newResume = nextTo;
    out.summary = format("khớp nhịp %.1f → %.1f BPM, kéo tốc độ %.0f phách, chồng %.0f ô nhịp", oldBeats.bpm,
        nextBeats.bpm, plan.rampBeats, s.bars);
    return true;
}

}  // namespace automix
