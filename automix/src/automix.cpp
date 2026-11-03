// AutoMix: fade out the end of a track and fade in the start of the next one.
//
// Only the volume of the live audio is changed, in place: nothing is buffered, dropped or inserted, so the
// DSP adds no latency and can't make playback stutter. A low-priority worker finds where each track's sound
// really ends (trailing silence), so the fade-out ends there instead of on the silence.
// The beat-matched version (render ahead, qm-dsp, SoundTouch) is in the git history of this branch.
#include <foobar2000/SDK/foobar2000.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <thread>

#include "mix.h"

DECLARE_COMPONENT_VERSION("AutoMix", "0.5.0",
    "Fades out the end of a track and fades in the next one when playback moves on by itself.\n"
    "Trailing silence is taken into account. Settings: Preferences > Advanced > Playback > AutoMix.\n\n"
    "License: GPL-3.0-or-later");
VALIDATE_COMPONENT_FILENAME("foo_dsp_automix.dll");

namespace {

using namespace automix;

constexpr GUID guid_dsp = {0x1cbe0af2, 0xf09b, 0x41c9, {0xb7, 0x6e, 0x3c, 0x6a, 0x29, 0x65, 0x4a, 0x2d}};
constexpr GUID guid_branch = {0xae12d125, 0x3ba8, 0x48f0, {0x9d, 0x95, 0x21, 0x58, 0x36, 0xde, 0x57, 0xc3}};
constexpr GUID guid_fadeout = {0x3e8c1f57, 0x2b6d, 0x4a90, {0x8c, 0x14, 0x7a, 0xd2, 0x09, 0x5e, 0xb3, 0x61}};
constexpr GUID guid_fadein = {0x9b41d6a2, 0x5f37, 0x4e1c, {0xa8, 0x2e, 0x13, 0xc7, 0x6d, 0x90, 0x4b, 0xf5}};
constexpr GUID guid_silence = {0xbac54e6b, 0x5046, 0x49cd, {0xb2, 0x41, 0x13, 0x5a, 0x33, 0x22, 0xdd, 0xb4}};

advconfig_branch_factory g_branch("AutoMix", guid_branch, advconfig_branch::guid_branch_playback, 0);
advconfig_integer_factory g_cfgFadeOut("Fade-out length (seconds)", guid_fadeout, guid_branch, 0, 5, 1, 15);
advconfig_integer_factory g_cfgFadeIn("Fade-in length (seconds)", guid_fadein, guid_branch, 1, 2, 0, 10);
advconfig_integer_factory g_cfgSilence("Silence threshold (dB below full scale)", guid_silence, guid_branch, 2, 50, 30, 90);

constexpr double kTailScanSeconds = 30;  // where the sound ends is looked for this far from the end
constexpr double kSettleSeconds = 5;  // the scan waits this long after a track starts (track changes are busy)

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
        // unknown: the fade-out then ends at the track's end
    }
}

// ---- the DSP ----

class automix_dsp : public dsp_impl_base {
public:
    static GUID g_get_guid() { return guid_dsp; }
    static void g_get_name(pfc::string_base& out) { out = "AutoMix"; }

    ~automix_dsp() { stopWorker(); }

    bool on_chunk(audio_chunk* chunk, abort_callback&) override {
        const dsp_track_t track = get_cur_file();
        if (m_trackEnded || track != m_track) beginTrack(track, *chunk);

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

        const int64_t known = m_tail ? m_tail->soundEnd.load() : -1;
        const int64_t end = known > 0 ? known : m_trackEnd;
        const int64_t outLen = (std::max)<int64_t>(1, std::llround((double)g_cfgFadeOut.get() * m_rate));
        const int64_t inLen = m_fadeIn ? std::llround((double)g_cfgFadeIn.get() * m_rate) : 0;
        const int64_t outFrom = end > 0 ? end - outLen : INT64_MAX;
        if (start >= inLen && start + (int64_t)n <= outFrom) return true;  // the middle of the track: untouched

        audio_sample* d = chunk->get_data();
        const unsigned channels = chunk->get_channels();
        for (size_t i = 0; i < n; ++i) {
            const int64_t t = start + (int64_t)i;
            double g = 1;
            if (t < inLen) g *= fadeInGain((double)t / inLen);
            if (t >= outFrom) g *= t >= end ? 0.0 : fadeOutGain((double)(t - outFrom) / outLen);
            for (unsigned c = 0; c < channels; ++c) d[i * channels + c] *= (audio_sample)g;
        }
        return true;
    }

    void on_endoftrack(abort_callback&) override { m_trackEnded = true; }
    void on_endofplayback(abort_callback&) override {}

    void flush() override {
        m_pos = -1;
        m_sinceFlush = 0;
        m_flushTick = GetTickCount64();
        m_fadeIn = false;  // a seek or a manual change: no fade-in
    }

    double get_latency() override { return 0; }
    bool need_track_change_mark() override { return true; }

private:
    void beginTrack(const dsp_track_t& track, const audio_chunk& chunk) {
        m_fadeIn = m_trackEnded;  // only when the previous track ended by itself
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
    bool m_fadeIn = false;
    unsigned m_rate = 0;
    int64_t m_trackEnd = 0;  // frames, from the track's length
    int64_t m_pos = -1;  // frames into the current track, -1 unknown (after a seek)
    int64_t m_sinceFlush = 0;
    uint64_t m_flushTick = 0;
};

dsp_factory_nopreset_t<automix_dsp> g_dspFactory;

}  // namespace
