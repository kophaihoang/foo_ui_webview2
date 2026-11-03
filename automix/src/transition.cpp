#include "transition.h"

#include <SoundTouch.h>

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "mix.h"

namespace automix {

namespace {

constexpr double kBassCutoffHz = 200;
constexpr int kRampBars = 4;  // the tempo glides over up to this many bars before the overlap
constexpr double kSpliceSeconds = 0.03;  // live audio -> stretched audio crossfade at renderStart
constexpr double kQuietDb = 6;  // an outro is at least this much quieter than the body of the song
constexpr double kMaxDrift = 0.015;  // seconds two unstretched tempos may drift apart over the overlap

std::string format(const char* fmt, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    snprintf(buf, sizeof buf, fmt, a, b, c, d);
    return buf;
}

// `frames` frames of `src` from `from`, converted to `rate`, exactly `outFrames` long (zero padded).
std::vector<float> slice(const Audio& src, int64_t from, int64_t frames, unsigned rate, int64_t outFrames,
    const Resampler& resample) {
    const int64_t avail = std::clamp<int64_t>(src.end() - from, 0, frames);
    std::vector<float> v(src.at(from), src.at(from) + avail * src.channels);
    if (src.rate != rate) v = resample(v, src.rate, rate);
    v.resize((size_t)outFrames * src.channels, 0.0f);
    return v;
}

// bars of overlap for an outro this many bars long: 1 for a song that is loud to its last note, else 2..max
int overlapBars(double outroBars, int maxBars) {
    if (outroBars < 1) return 1;
    return std::clamp((int)std::lround(outroBars), 2, (std::max)(2, maxBars));
}

}  // namespace

double quietOutroSeconds(const Audio& old, int64_t end) {
    const unsigned ch = old.channels;
    const int64_t block = old.rate / 4;
    std::vector<double> rms;
    for (int64_t f = old.start; f + block <= end; f += block) {
        double sum = 0;
        for (const float* p = old.at(f); p < old.at(f + block); ++p) sum += (double)*p * *p;
        rms.push_back(std::sqrt(sum / ((double)block * ch)));
    }
    if (rms.size() < 8) return 0;
    std::vector<double> sorted = rms;
    std::sort(sorted.begin(), sorted.end());
    const double quiet = sorted[sorted.size() * 4 / 5] * dbToAmp(-kQuietDb);
    size_t i = rms.size();
    while (i > 0 && rms[i - 1] < quiet) --i;
    return (double)(rms.size() - i) * block / old.rate;
}

OldPlan planOldSide(const Audio& old, int64_t oldEnd, const Beats& beats, int maxBars) {
    OldPlan p;
    if (!beats.steady()) return p;
    const double base = (double)old.start, bar = 4 * beats.period;
    p.overlapEnd = base + beats.barAtOrAfter((double)(oldEnd - old.start));
    p.bars = overlapBars(quietOutroSeconds(old, oldEnd) * old.rate / bar, maxBars);
    p.overlapStart = p.overlapEnd - p.bars * bar;
    const double earliest = base + 2.0 * old.rate;  // the first seconds of the analysis are less reliable
    if (p.overlapStart < earliest) return p;
    p.rampBars = std::clamp((int)((p.overlapStart - earliest) / bar), 0, kRampBars);
    p.renderStart = std::llround(p.overlapStart - p.rampBars * bar);
    p.ok = true;
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
    t.summary = format("chuyển mượt %.1f giây", s.seconds);
    return t;
}

bool beatTransition(const Audio& old, const Beats& oldBeats, const OldPlan& plan, const Audio& next, int64_t nextStart,
    const Beats& nextBeats, const Settings& s, const Resampler& resample, Transition& out, std::string& why) {
    if (!oldBeats.steady()) {
        why = format("bài đang phát không có nhịp đều (%.0f BPM, lệch lưới %.0f%%)", oldBeats.bpm, oldBeats.fitError * 100);
        return false;
    }
    if (!nextBeats.steady()) {
        why = format("bài kế không có nhịp đều (%.0f BPM, lệch lưới %.0f%%)", nextBeats.bpm, nextBeats.fitError * 100);
        return false;
    }
    const double diff = nextBeats.bpm / oldBeats.bpm - 1;
    if (std::fabs(diff) > s.maxBpmDiff) {
        why = format("lệch BPM quá nhiều (%.1f → %.1f, %+.0f%%)", oldBeats.bpm, nextBeats.bpm, diff * 100);
        return false;
    }
    if (!plan.ok) {
        why = "không tìm được ô nhịp ở cuối bài đang phát";
        return false;
    }

    const unsigned ch = old.channels;
    const double ro = old.rate, rn = next.rate, scale = ro / rn;
    const double po = oldBeats.period, pn = nextBeats.period, pnOld = pn * scale;  // frames per beat
    const int n4 = 4 * plan.bars;

    // the next track enters on its first bar line after the leading silence
    const double enter = (double)next.start + nextBeats.barAtOrAfter((double)(nextStart - next.start) - 0.05 * rn);
    const double resume = enter + n4 * pn;
    if (std::llround(resume) > next.end()) {
        why = "đoạn đầu bài kế ngắn hơn đoạn chồng";
        return false;
    }

    // stretch only when the tempos would audibly drift apart over the overlap
    const bool stretch = std::fabs(po / pnOld - 1) * (n4 * pnOld / ro) > kMaxDrift;
    const int ramp = stretch ? plan.rampBars : 0;
    const int segs = 4 * ramp + n4;

    // output timeline (outgoing rate, from renderStart): each outgoing grid beat gets a target length
    std::vector<double> edge(segs + 1, 0.0);
    for (int i = 0; i < segs; ++i) {
        const double f = i < 4 * ramp ? (i + 1.0) / (4 * ramp) : 1.0;
        edge[i + 1] = edge[i] + po * (1 - f) + pnOld * f;
    }
    const int64_t total = std::llround(edge[segs]), ovStart = std::llround(edge[4 * ramp]);

    // the outgoing audio from renderStart to the overlap's end (and half a second more), silent past the track
    const double startF = plan.overlapStart - ramp * 4 * po;
    const int64_t from = std::llround(startF), to = std::llround(plan.overlapEnd) + (int64_t)ro / 2;
    std::vector<float> src((size_t)(to - from) * ch, 0.0f);
    const int64_t have = std::clamp<int64_t>(old.end() - from, 0, to - from);
    std::copy(old.at(from), old.at(from) + have * ch, src.begin());

    std::vector<float> body;
    if (!stretch) {
        body.assign(src.begin(), src.begin() + (std::min)(src.size(), (size_t)total * ch));
    } else {
        // beat by beat onto the timeline, correcting drift as it goes
        soundtouch::SoundTouch st;
        st.setSampleRate(old.rate);
        st.setChannels(ch);
        std::vector<float> buf(4096 * ch);
        auto receive = [&] {
            unsigned got;
            while ((got = st.receiveSamples(buf.data(), 4096)) > 0) body.insert(body.end(), buf.begin(), buf.begin() + got * ch);
        };
        auto inAt = [&](int i) { return std::llround(startF + i * po) - from; };
        for (int i = 0; i < segs; ++i) {
            const int64_t a = inAt(i), b = inAt(i + 1);
            const double produced = (double)(body.size() / ch + st.numSamples());
            const double want = (std::max)(1.0, edge[i + 1] - produced);
            st.setTempo(std::clamp((st.numUnprocessedSamples() + (double)(b - a)) / want, 0.5, 2.0));
            st.putSamples(src.data() + a * ch, (unsigned)(b - a));
            receive();
        }
        const int64_t tail = inAt(segs);
        st.putSamples(src.data() + tail * ch, (unsigned)(to - from - tail));
        st.flush();
        receive();
    }
    body.resize((size_t)total * ch, 0.0f);

    const std::vector<float> head =
        slice(next, std::llround(enter), std::llround(resume) - std::llround(enter), old.rate, total - ovStart, resample);

    // mix: highs cross over the whole overlap, the bass swaps within one beat at the middle bar
    const int64_t mid = ovStart + std::llround(4.0 * (plan.bars / 2) * pnOld);
    const double swapLen = (std::max)(1.0, pnOld);
    const int64_t splice = stretch ? (std::min)((int64_t)std::llround(kSpliceSeconds * ro), ovStart) : 0;
    LowPass lpOld, lpNew;
    lpOld.setup(kBassCutoffHz, ro, ch);
    lpNew.setup(kBassCutoffHz, ro, ch);
    out.out.resize((size_t)total * ch);
    for (int64_t k = 0; k < total; ++k) {
        for (unsigned c = 0; c < ch; ++c) {
            const size_t i = (size_t)k * ch + c;
            double y = body[i];
            if (k < splice) y = src[i] + (y - src[i]) * ((double)k / splice);
            if (k >= ovStart) {
                const double prog = (double)(k - ovStart) / (total - ovStart);
                const double sw = std::clamp((k - mid) / swapLen, 0.0, 1.0);
                const double x = head[(size_t)(k - ovStart) * ch + c];
                const double oldLow = lpOld.process(c, y), newLow = lpNew.process(c, x);
                y = (y - oldLow) * fadeOutGain(prog) + oldLow * (1 - sw) + (x - newLow) * fadeInGain(prog) + newLow * sw;
            }
            out.out[i] = (float)y;
        }
    }
    out.renderStart = from;
    out.newResume = std::llround(resume);
    out.summary = format("khớp nhịp %.1f → %.1f BPM, chồng %.0f ô nhịp", oldBeats.bpm, nextBeats.bpm, plan.bars);
    out.summary += stretch ? format(", kéo tốc độ %.0f ô nhịp trước đó", ramp) : ", không cần kéo tốc độ";
    return true;
}

}  // namespace automix
