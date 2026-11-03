// AutoMix: crossfade consecutive tracks, the end of one fading out over the start of the next.
//
// The classic way, from live audio only: the last seconds of a track's sound are held back (the decoder runs
// far ahead of the sound card, so holding them leaves no gap), and when the next track arrives they are mixed
// into its first seconds. Nothing of the next track is read ahead, skipped or spliced. A low-priority worker
// finds where each track's sound really ends, so trailing silence is left out of the overlap.
// The beat-matched version (render ahead, qm-dsp, SoundTouch) is in the git history of this branch.
#include <foobar2000/SDK/foobar2000.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <thread>
#include <vector>

#include "mix.h"

DECLARE_COMPONENT_VERSION("AutoMix", "0.6.0",
    "Crossfades tracks when playback moves on by itself: the end of one fades out over the start of the next.\n"
    "Silence at the end and the start is left out. Settings: Preferences > Advanced > Playback > AutoMix.\n\n"
    "License: GPL-3.0-or-later");
VALIDATE_COMPONENT_FILENAME("foo_dsp_automix.dll");

namespace {

using namespace automix;

constexpr GUID guid_dsp = {0x1cbe0af2, 0xf09b, 0x41c9, {0xb7, 0x6e, 0x3c, 0x6a, 0x29, 0x65, 0x4a, 0x2d}};
constexpr GUID guid_branch = {0xae12d125, 0x3ba8, 0x48f0, {0x9d, 0x95, 0x21, 0x58, 0x36, 0xde, 0x57, 0xc3}};
constexpr GUID guid_crossfade = {0x3e8c1f57, 0x2b6d, 0x4a90, {0x8c, 0x14, 0x7a, 0xd2, 0x09, 0x5e, 0xb3, 0x61}};
constexpr GUID guid_silence = {0xbac54e6b, 0x5046, 0x49cd, {0xb2, 0x41, 0x13, 0x5a, 0x33, 0x22, 0xdd, 0xb4}};

advconfig_branch_factory g_branch("AutoMix", guid_branch, advconfig_branch::guid_branch_playback, 0);
advconfig_integer_factory g_cfgCrossfade("Crossfade length (seconds)", guid_crossfade, guid_branch, 0, 6, 1, 15);
advconfig_integer_factory g_cfgSilence("Silence threshold (dB below full scale)", guid_silence, guid_branch, 1, 50, 30, 90);

constexpr double kTailScanSeconds = 30;  // where the sound ends is looked for this far from the end
constexpr double kSettleSeconds = 5;  // the scan waits this long after a track starts (track changes are busy)
constexpr double kLeadSilenceSeconds = 5;  // at most this much silence is skipped at the start of the next track

// ---- seek position: the DSP is flushed on seek but not told where to; the main thread is ----

std::atomic<double> g_seekTime{0};
std::atomic<uint64_t> g_seekTick{0};

class seek_watch : public play_callback_static {
public:
    unsigned get_flags() override { return flag_on_playback_seek; }
    void on_playback_seek(double t) override {
        g_seekTime = t;
        g_seekTick = GetTickCount64();
    }
    void on_playback_starting(play_control::t_track_command, bool) override {}
    void on_playback_new_track(metadb_handle_ptr) override {}
    void on_playback_stop(play_control::t_stop_reason) override {}
    void on_playback_pause(bool) override {}
    void on_playback_edited(metadb_handle_ptr) override {}
    void on_playback_dynamic_info(const file_info&) override {}
    void on_playback_dynamic_info_track(const file_info&) override {}
    void on_playback_time(double) override {}
    void on_volume_change(float) override {}
};
play_callback_static_factory_t<seek_watch> g_seekWatch;

// ---- where a track's sound ends ----

struct Tail {
    abort_callback_impl abort;
    std::atomic<int64_t> soundEnd{-1};  // frame, -1 until known
};

void findSoundEnd(std::shared_ptr<Tail> tail, metadb_handle_ptr track, unsigned rate) {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    try {
        tail->abort.sleep(kSettleSeconds);
        const double length = track->get_length();
        if (length <= 0) return;
        input_decoder::ptr dec;
        input_entry::g_open_for_decoding(dec, nullptr, track->get_path(), tail->abort);
        dec->initialize(track->get_subsong_index(), input_flag_no_looping, tail->abort);
        if (!dec->can_seek()) return;
        const double from = (std::max)(0.0, length - kTailScanSeconds);
        dec->seek(from, tail->abort);
        const double threshold = dbToAmp(-(double)g_cfgSilence.get());
        int64_t frame = std::llround(from * rate), end = -1;
        audio_chunk_impl chunk;
        while (dec->run(chunk, tail->abort)) {
            if (chunk.get_srate() != rate) return;
            const size_t e = audibleEnd(chunk.get_data(), chunk.get_sample_count(), chunk.get_channels(), threshold);
            if (e > 0) end = frame + (int64_t)e;
            frame += (int64_t)chunk.get_sample_count();
        }
        if (end > 0) tail->soundEnd = end;
    } catch (...) {
        // unknown: the held part then ends at the track's end
    }
}

// ---- the DSP ----

// held audio of the outgoing track, with its format
struct Held {
    std::vector<audio_sample> data;
    unsigned rate = 0, channels = 0, channelConfig = 0;
    size_t frames() const { return channels ? data.size() / channels : 0; }
};

class automix_dsp : public dsp_impl_base {
public:
    static GUID g_get_guid() { return guid_dsp; }
    static void g_get_name(pfc::string_base& out) { out = "AutoMix"; }

    ~automix_dsp() { stopWorker(); }

    bool on_chunk(audio_chunk* chunk, abort_callback&) override {
        const dsp_track_t track = get_cur_file();
        if (m_trackEnded || track != m_track) beginTrack(track, *chunk);
        if (!m_fading.data.empty()) return fadeIntoNext(chunk);

        const size_t n = chunk->get_sample_count();
        // after a seek, wait for the main thread to tell where we are
        if (m_pos < 0) {
            if (m_flushTick == 0 || g_seekTick + 50 < m_flushTick) {
                m_sinceFlush += (int64_t)n;
                return true;
            }
            m_pos = std::llround(g_seekTime * chunk->get_srate()) + m_sinceFlush;
        }
        const int64_t start = m_pos;
        m_pos += (int64_t)n;
        if (chunk->get_srate() != m_rate) return true;

        // the last seconds of sound are held back for the crossfade; silence after them is dropped
        if (m_holdEnd < 0) {
            const int64_t known = m_tail ? m_tail->soundEnd.load() : -1;
            const int64_t end = known > 0 ? known : m_trackEnd;
            const int64_t len = std::llround((double)g_cfgCrossfade.get() * m_rate);
            if (end <= 0 || start + (int64_t)n <= end - len) return true;
            m_holdEnd = end;
            m_hold = Held{{}, m_rate, chunk->get_channels(), chunk->get_channel_config()};
        }
        const unsigned channels = chunk->get_channels();
        const int64_t len = std::llround((double)g_cfgCrossfade.get() * m_rate);
        const int64_t from = m_holdEnd - len;
        const size_t keep = (size_t)std::clamp<int64_t>(from - start, 0, (int64_t)n);
        const size_t holdTo = (size_t)std::clamp<int64_t>(m_holdEnd - start, 0, (int64_t)n);
        if (channels == m_hold.channels && holdTo > keep) {
            const audio_sample* d = chunk->get_data();
            m_hold.data.insert(m_hold.data.end(), d + keep * channels, d + holdTo * channels);
        }
        if (keep == 0) return false;
        chunk->set_sample_count(keep);
        return true;
    }

    void on_endoftrack(abort_callback&) override { m_trackEnded = true; }

    void on_endofplayback(abort_callback&) override {
        // nothing comes next: the held end plays out as it was
        emit(m_hold, 0, m_hold.frames(), false);
        m_hold = {};
        m_holdEnd = -1;
    }

    void flush() override {
        m_pos = -1;
        m_sinceFlush = 0;
        m_flushTick = GetTickCount64();
        m_hold = {};
        m_holdEnd = -1;
        m_fading = {};
    }

    double get_latency() override { return m_hold.rate ? (double)m_hold.frames() / m_hold.rate : 0; }
    bool need_track_change_mark() override { return true; }

private:
    // the next track's first frames, with the held end of the previous one fading out over them
    bool fadeIntoNext(audio_chunk* chunk) {
        size_t n = chunk->get_sample_count();
        const unsigned channels = chunk->get_channels();
        if (chunk->get_srate() != m_fading.rate || channels != m_fading.channels) {
            // can't mix different formats: the held end plays out alone, fading
            emit(m_fading, m_fadingUsed, m_fading.frames(), true);
            m_fading = {};
            m_pos += (int64_t)n;
            return true;
        }
        audio_sample* d = chunk->get_data();
        // leave out the next track's leading silence
        if (m_leadSkip >= 0) {
            const size_t first = firstAudible(d, n, channels, dbToAmp(-(double)g_cfgSilence.get()));
            m_pos += (int64_t)first;
            if (first == n && (m_leadSkip += (int64_t)n) < kLeadSilenceSeconds * m_fading.rate) return false;
            m_leadSkip = -1;
            if (first > 0) {
                std::vector<audio_sample> rest(d + first * channels, d + n * channels);
                chunk->set_data(rest.data(), n - first, channels, chunk->get_srate(), chunk->get_channel_config());
                d = chunk->get_data();
                n -= first;
            }
            if (n == 0) return false;
        }
        const size_t total = m_fading.frames();
        for (size_t i = 0; i < n && m_fadingUsed < total; ++i, ++m_fadingUsed) {
            const double prog = (double)m_fadingUsed / total, gIn = fadeInGain(prog), gOut = fadeOutGain(prog);
            for (unsigned c = 0; c < channels; ++c) {
                const size_t k = i * channels + c;
                d[k] = (audio_sample)(d[k] * gIn + m_fading.data[m_fadingUsed * channels + c] * gOut);
            }
        }
        if (m_fadingUsed >= total) m_fading = {};
        m_pos += (int64_t)n;
        return true;
    }

    // inserts frames [from, to) of `held`, optionally fading out over that span
    void emit(const Held& held, size_t from, size_t to, bool fade) {
        const size_t piece = (std::max)(1u, held.rate / 2);
        for (size_t at = from; at < to; at += piece) {
            const size_t cnt = (std::min)(piece, to - at);
            std::vector<audio_sample> part(held.data.begin() + at * held.channels,
                held.data.begin() + (at + cnt) * held.channels);
            if (fade) {
                for (size_t i = 0; i < cnt; ++i) {
                    const double g = fadeOutGain((double)(at + i - from) / (to - from));
                    for (unsigned c = 0; c < held.channels; ++c) part[i * held.channels + c] *= (audio_sample)g;
                }
            }
            insert_chunk(part.size())->set_data(part.data(), cnt, held.channels, held.rate, held.channelConfig);
        }
    }

    void beginTrack(const dsp_track_t& track, const audio_chunk& chunk) {
        if (m_trackEnded && m_hold.frames() > 0) {
            // moved on by itself: the held end crossfades into this track
            m_fading = std::move(m_hold);
            m_fadingUsed = 0;
            m_leadSkip = 0;
        } else {
            emit(m_hold, 0, m_hold.frames(), false);
        }
        m_hold = {};
        m_holdEnd = -1;
        stopWorker();
        m_track = track;
        m_trackEnded = false;
        m_pos = 0;
        m_flushTick = 0;
        m_rate = chunk.get_srate();
        m_trackEnd = track.is_valid() ? std::llround(track->get_length() * m_rate) : 0;
        if (track.is_valid()) {
            m_tail = std::make_shared<Tail>();
            m_worker = std::thread(findSoundEnd, m_tail, track, m_rate);
        }
    }

    void stopWorker() {
        if (m_tail) m_tail->abort.abort();
        if (m_worker.joinable()) m_worker.join();
        m_tail.reset();
    }

    std::shared_ptr<Tail> m_tail;
    std::thread m_worker;
    dsp_track_t m_track;
    bool m_trackEnded = false;
    unsigned m_rate = 0;
    int64_t m_trackEnd = 0;  // frames, from the track's length
    int64_t m_pos = -1;  // frames into the current track, -1 unknown (after a seek)
    int64_t m_sinceFlush = 0;
    uint64_t m_flushTick = 0;
    Held m_hold;  // the outgoing track's last seconds, being collected
    int64_t m_holdEnd = -1;  // frame where its sound ends, once collecting
    Held m_fading;  // the previous track's held end, fading out over this one
    size_t m_fadingUsed = 0;
    int64_t m_leadSkip = -1;  // leading silence skipped so far, -1 once the sound has started
};

dsp_factory_nopreset_t<automix_dsp> g_dspFactory;

}  // namespace
