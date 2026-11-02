// AutoMix: DJ-style transitions between consecutive tracks.
//
// How it works without adding latency:
//  - At the start of each track a worker thread decodes the last 60 s of it, finds where the sound ends
//    and, for beat matching, its beats and bars.
//  - About 20 s before the transition, it asks the main thread which track plays next (queue first, then
//    the next playlist row), decodes that track's head from the file itself and renders the whole
//    transition ahead of time (transition.cpp): beat-matched when both tracks have a steady beat at
//    close tempos, otherwise a plain equal-power overlap.
//  - From the transition's first frame on, the DSP plays the rendered audio instead of the live track.
//  - When foobar2000 then delivers the next track for real, the DSP drops the part that was already heard.
// Anything unexpected (prediction wrong, decode error, seek, different channel layout) falls back to
// a plain transition or no transition, with the reason written to the Console.
#include <foobar2000/SDK/foobar2000.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <functional>
#include <memory>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <vector>

#include "beats.h"
#include "mix.h"
#include "transition.h"

static_assert(std::is_same_v<audio_sample, float>, "the mixing code assumes 32-bit float samples");

DECLARE_COMPONENT_VERSION("AutoMix", "0.2.0",
    "DJ-style transitions between tracks.\n"
    "Beat-matched when the tracks allow it (tempo glide, bars lined up, bass swap), "
    "otherwise an equal-power overlap with a gradual bass cut. Silence at both ends is skipped.\n"
    "Settings: Preferences > Advanced > Playback > AutoMix.\n\n"
    "Uses qm-dsp (GPL-2.0-or-later) and SoundTouch (LGPL-2.1-or-later).\n"
    "License: GPL-3.0-or-later");
VALIDATE_COMPONENT_FILENAME("foo_dsp_automix.dll");

namespace {

using namespace automix;

constexpr GUID guid_dsp = {0x1cbe0af2, 0xf09b, 0x41c9, {0xb7, 0x6e, 0x3c, 0x6a, 0x29, 0x65, 0x4a, 0x2d}};
constexpr GUID guid_branch = {0xae12d125, 0x3ba8, 0x48f0, {0x9d, 0x95, 0x21, 0x58, 0x36, 0xde, 0x57, 0xc3}};
constexpr GUID guid_seconds = {0x7c719b04, 0xff1e, 0x47f9, {0x9b, 0x16, 0xda, 0xd6, 0x65, 0xd3, 0xa1, 0x7f}};
constexpr GUID guid_basscut = {0x1a766c43, 0x9487, 0x4d1b, {0x89, 0x46, 0x90, 0x45, 0x95, 0x3c, 0x8f, 0xf6}};
constexpr GUID guid_silence = {0xbac54e6b, 0x5046, 0x49cd, {0xb2, 0x41, 0x13, 0x5a, 0x33, 0x22, 0xdd, 0xb4}};
constexpr GUID guid_beatmatch = {0x5e0f3c21, 0x7d4a, 0x4b9e, {0xa1, 0x3c, 0x6f, 0x0d, 0x92, 0x47, 0xb8, 0x15}};
constexpr GUID guid_bars = {0x8a2d7e64, 0x1c3b, 0x4f05, {0x96, 0x8e, 0x24, 0xc1, 0x5a, 0x7b, 0x03, 0xd9}};
constexpr GUID guid_bpmdiff = {0xd47b1a90, 0x6e25, 0x4c38, {0x8f, 0x71, 0x0b, 0xe3, 0x59, 0x2c, 0xa6, 0x4e}};

advconfig_branch_factory g_branch("AutoMix", guid_branch, advconfig_branch::guid_branch_playback, 0);
advconfig_checkbox_factory g_cfgBeatMatch("Beat matching", guid_beatmatch, guid_branch, 0, true);
advconfig_integer_factory g_cfgBars("Beat-matched overlap (bars)", guid_bars, guid_branch, 1, 8, 4, 16);
advconfig_integer_factory g_cfgBpmDiff("Beat matching: largest tempo difference (%)", guid_bpmdiff, guid_branch, 2, 8, 1, 20);
advconfig_integer_factory g_cfgSeconds("Plain transition length (seconds)", guid_seconds, guid_branch, 3, 8, 4, 16);
advconfig_integer_factory g_cfgBassCut("Plain transition: bass cut on the outgoing track (%)", guid_basscut, guid_branch, 4, 70, 0, 100);
advconfig_integer_factory g_cfgSilence("Silence threshold (dB below full scale)", guid_silence, guid_branch, 5, 50, 30, 90);

constexpr double kTailScanSeconds = 60;  // how much of the outgoing track's end is analysed
constexpr double kHeadSearchSeconds = 30;  // longest leading silence we skip in the next track
constexpr double kHeadSeconds = 60;  // how much of the next track is decoded after its leading silence
constexpr double kPrepareLeadSeconds = 20;  // the next track is predicted and decoded this long before the mix
constexpr double kRecheckLeadSeconds = 2;  // ...and checked once more this long before

void log(const char* msg) { FB2K_console_formatter() << "AutoMix: " << msg; }

struct Failure : std::runtime_error {
    explicit Failure(const char* why) : std::runtime_error(why) {}
    explicit Failure(const pfc::string_base& why) : std::runtime_error(why.get_ptr()) {}
};

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

// ---- main thread helpers ----

// Runs `f` on the main thread and waits for it, abortably (never blocks the main thread on us).
template <typename T>
T inMain(std::function<T()> f, abort_callback& abort) {
    struct Box {
        std::atomic<bool> done{false};
        T value{};
    };
    auto box = std::make_shared<Box>();
    fb2k::inMainThread([box, f] {
        try {
            box->value = f();
        } catch (...) {
        }
        box->done = true;
    });
    while (!box->done) abort.sleep(0.02);
    return box->value;
}

struct NextTrack {
    metadb_handle_ptr handle;
    audio_sample scale = 1;  // ReplayGain scale the player will apply to it
    pfc::string8 why;  // set when there is no usable prediction
};

NextTrack predictNext(const metadb_handle_ptr& current) {
    NextTrack r;
    auto pc = playback_control::get();
    metadb_handle_ptr playing;
    if (!pc->get_now_playing(playing) || playing != current) {
        r.why = "bài DSP đang xử lý không phải bài đang phát (đang convert?)";
        return r;
    }
    auto pm = playlist_manager::get();
    pfc::list_t<t_playback_queue_item> queue;
    pm->queue_get_contents(queue);
    if (queue.get_count() > 0) {
        r.handle = queue[0].m_handle;
    } else if (pc->get_stop_after_current()) {
        r.why = "đang bật Stop after current";
    } else {
        size_t pl, idx;
        if (!pm->get_playing_item_location(&pl, &idx)) {
            r.why = "queue trống và bài đang phát không nằm trong playlist nào";
            return r;
        }
        const size_t count = pm->playlist_get_item_count(pl);
        const char* order = pm->playback_order_get_name(pm->playback_order_get_active());
        const bool isDefault = !strcmp(order, "Default");
        if (isDefault && idx + 1 < count) r.handle = pm->playlist_get_item_handle(pl, idx + 1);
        else if (!strcmp(order, "Repeat (playlist)")) r.handle = pm->playlist_get_item_handle(pl, (idx + 1) % count);
        else if (!strcmp(order, "Repeat (track)")) r.handle = current;
        else if (isDefault) r.why = "đã tới cuối playlist";
        else r.why = (pfc::string_formatter()._formatter() << "queue trống và thứ tự phát \"" << order << "\" không đoán trước được bài kế").get_ptr();
    }
    if (r.handle.is_valid()) r.scale = replaygain_manager::get()->core_settings_query_scale(r.handle);
    return r;
}

// ---- the plan for one track, shared between the DSP and its worker ----

struct Plan {
    abort_callback_impl abort;
    std::atomic<int64_t> pos{-1};  // DSP decode position in frames of the current track, -1 unknown

    // written by the worker before `ready` is set, read-only afterwards
    std::atomic<bool> ready{false};
    metadb_handle_ptr next;
    int64_t renderStart = 0;  // frame of the current track where `out` takes over
    int64_t newResume = 0;  // frame of the next track (its own rate) where its live playback carries on
    std::vector<audio_sample> out;  // the rendered transition, current track's rate and channels
};

void waitForPos(Plan& p, int64_t target) {
    for (;;) {
        const int64_t pos = p.pos;
        if (pos >= 0 && pos >= target) return;
        p.abort.sleep(0.1);
    }
}

input_decoder::ptr openDecoder(const metadb_handle_ptr& track, unsigned flags, abort_callback& abort) {
    input_decoder::ptr dec;
    input_entry::g_open_for_decoding(dec, nullptr, track->get_path(), abort);
    dec->initialize(track->get_subsong_index(), flags, abort);
    return dec;
}

std::vector<audio_sample> resample(std::vector<audio_sample> const& in, unsigned channels, unsigned channelConfig,
    unsigned from, unsigned to, const metadb_handle_ptr& track) {
    service_ptr_t<dsp> rs;
    if (!resampler_entry::g_create(rs, from, to, 1.0f))
        throw Failure(pfc::string_formatter()._formatter() << "không có bộ đổi sample rate cho " << from << " → " << to << " Hz");
    dsp_chunk_list_impl list;
    list.insert_item(0, in.size())->set_data(in.data(), in.size() / channels, channels, from, channelConfig);
    rs->run(&list, track, dsp::END_OF_TRACK | dsp::FLUSH);
    std::vector<audio_sample> out;
    for (size_t i = 0; i < list.get_count(); ++i) {
        const audio_chunk* c = list.get_item(i);
        if (c->get_srate() != to || c->get_channels() != channels) throw Failure("bộ đổi sample rate trả về sai định dạng");
        out.insert(out.end(), c->get_data(), c->get_data() + c->get_sample_count() * channels);
    }
    return out;
}

void prepare(std::shared_ptr<Plan> plan, metadb_handle_ptr current, unsigned rate, unsigned channels,
    unsigned channelConfig) {
    Plan& p = *plan;
    abort_callback& abort = p.abort;
    try {
        Settings s;
        s.seconds = (double)g_cfgSeconds.get();
        s.bassCut = (double)g_cfgBassCut.get() / 100;
        s.bars = (int)g_cfgBars.get();
        s.maxBpmDiff = (double)g_cfgBpmDiff.get() / 100;
        const bool beatMatch = g_cfgBeatMatch.get();
        const double threshold = dbToAmp(-(double)g_cfgSilence.get());

        // 1. the end of the current track, at the level the player uses
        const double length = current->get_length();
        if (length <= 0) throw Failure("không biết độ dài bài");
        if (length < 3 * s.seconds) throw Failure("bài quá ngắn so với độ dài chuyển");
        const audio_sample curScale = inMain<audio_sample>(
            [current] { return replaygain_manager::get()->core_settings_query_scale(current); }, abort);
        auto dec = openDecoder(current, input_flag_no_looping, abort);
        if (!dec->can_seek()) throw Failure("không tua được trong file để đọc đuôi bài");
        const double from = (std::max)(0.0, length - kTailScanSeconds);
        dec->seek(from, abort);
        Audio old;
        old.rate = rate;
        old.channels = channels;
        old.start = std::llround(from * rate);
        audio_chunk_impl chunk;
        while (dec->run(chunk, abort)) {
            if (chunk.get_srate() != rate || chunk.get_channels() != channels) throw Failure("định dạng đổi giữa bài");
            old.data.insert(old.data.end(), chunk.get_data(), chunk.get_data() + chunk.get_sample_count() * channels);
        }
        dec.release();
        for (auto& x : old.data) x *= curScale;
        const size_t audible = audibleEnd(old.data.data(), old.data.size() / channels, channels, threshold);
        if (audible == 0) throw Failure("60 giây cuối bài im lặng hoàn toàn");
        const int64_t end = old.start + (int64_t)audible;

        Beats oldBeats;
        OldPlan oldPlan;
        if (beatMatch) {
            oldBeats = analyseBeats(old.data.data(), audible, channels, rate);
            oldPlan = planOldSide(old, end, oldBeats, s.bars);
        }
        const int64_t plainStart = (std::max)(old.start, end - std::llround(s.seconds * rate));
        const int64_t earliest = oldPlan.overlapBeat >= 0 ? (std::min)(oldPlan.renderStart, plainStart) : plainStart;

        // 2. which track comes next
        waitForPos(p, earliest - (int64_t)(kPrepareLeadSeconds * rate));
        const NextTrack next = inMain<NextTrack>([current] { return predictNext(current); }, abort);
        if (!next.handle.is_valid()) throw Failure(pfc::string_formatter()._formatter() << "không đoán được bài kế: " << next.why);

        // 3. its head, from the very start so beat positions are track positions
        auto nd = openDecoder(next.handle, input_flag_simpledecode, abort);
        Audio head;
        head.channels = channels;
        int64_t skip = -1;
        while (nd->run(chunk, abort)) {
            if (head.rate == 0) {
                head.rate = chunk.get_srate();
                if (chunk.get_channels() != channels || chunk.get_channel_config() != channelConfig)
                    throw Failure(pfc::string_formatter()._formatter() << "số kênh khác nhau (" << channels << " và " << chunk.get_channels() << ")");
            }
            if (chunk.get_srate() != head.rate) throw Failure("bài kế đổi sample rate ở đoạn đầu");
            const size_t n = chunk.get_sample_count();
            const int64_t at = head.end();
            head.data.insert(head.data.end(), chunk.get_data(), chunk.get_data() + n * channels);
            if (skip < 0) {
                const size_t first = firstAudible(chunk.get_data(), n, channels, threshold / next.scale);
                if (first < n) skip = at + (int64_t)first;
                else if (head.end() > kHeadSearchSeconds * head.rate) throw Failure("30 giây đầu bài kế im lặng");
            }
            if (skip >= 0 && head.end() >= skip + (int64_t)(kHeadSeconds * head.rate)) break;
        }
        nd.release();
        if (skip < 0) throw Failure("bài kế im lặng hoàn toàn");
        if (head.end() < skip + std::llround(s.seconds * head.rate)) throw Failure("bài kế ngắn hơn độ dài chuyển");
        for (auto& x : head.data) x *= next.scale;

        // 4. render the transition
        const Resampler rs = [&](const std::vector<float>& v, unsigned a, unsigned b) {
            return resample(v, channels, channelConfig, a, b, next.handle);
        };
        Transition t;
        std::string why;
        bool beat = false;
        if (beatMatch) {
            const Beats nextBeats = analyseBeats(head.data.data(), head.data.size() / channels, channels, head.rate);
            beat = beatTransition(old, oldBeats, oldPlan, head, skip, nextBeats, s, rs, t, why);
            if (beat && p.pos >= t.renderStart) {
                beat = false;
                why = "đã qua điểm bắt đầu khớp nhịp";
            }
        }
        if (!beat) t = plainTransition(old, end, head, skip, s, rs);
        if (p.pos >= t.renderStart) throw Failure("đã qua điểm chuyển khi chuẩn bị xong");

        p.next = next.handle;
        p.renderStart = t.renderStart;
        p.newResume = t.newResume;
        p.out = std::move(t.out);
        p.ready = true;
        {
            console::formatter line;  // printed at the end of this block
            line << "AutoMix: sẵn sàng chuyển sang \"" << next.handle << "\": " << t.summary.c_str();
            if (beatMatch && !beat) line << " (không khớp nhịp: " << why.c_str() << ")";
            line << ", bỏ " << pfc::format_float((double)skip / head.rate, 0, 1) << " s im lặng đầu, "
                 << pfc::format_float(length - (double)end / rate, 0, 1) << " s im lặng cuối";
            if (head.rate != rate) line << ", đổi " << head.rate << " → " << rate << " Hz";
        }

        // 5. the queue may have changed since; check once more right before the transition
        waitForPos(p, t.renderStart - (int64_t)(kRecheckLeadSeconds * rate));
        const NextTrack again = inMain<NextTrack>([current] { return predictNext(current); }, abort);
        if (again.handle != next.handle && p.pos < t.renderStart) {
            p.ready = false;
            log("bài kế đã đổi ngay trước lúc chuyển, lần này chuyển bình thường");
        }
    } catch (exception_aborted const&) {
    } catch (std::exception const& e) {
        FB2K_console_formatter() << "AutoMix: chuyển bình thường, lý do: " << e.what();
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

        const unsigned channels = chunk->get_channels();
        size_t n = chunk->get_sample_count();

        // the part of this track that was already heard during the transition
        if (m_dropNew > 0) {
            if ((size_t)m_dropNew >= n) {
                m_dropNew -= (int64_t)n;
                m_pos += (int64_t)n;
                return false;
            }
            const audio_sample* d = chunk->get_data();
            std::vector<audio_sample> rest(d + m_dropNew * channels, d + n * channels);
            chunk->set_data(rest.data(), n - (size_t)m_dropNew, channels, chunk->get_srate(), chunk->get_channel_config());
            m_pos += m_dropNew;
            m_dropNew = 0;
            n = chunk->get_sample_count();
        }

        // after a seek, wait for the main thread to tell where we are
        if (m_pos < 0) {
            if (m_flushTick != 0 && g_seekTick + 50 >= m_flushTick) {
                m_pos = std::llround(g_seekTime * chunk->get_srate()) + m_sinceFlush;
            } else {
                m_sinceFlush += (int64_t)n;
                return true;
            }
        }
        if (m_plan) m_plan->pos = m_pos;

        const int64_t start = m_pos;
        m_pos += (int64_t)n;
        if (!m_plan || !m_plan->ready || chunk->get_srate() != m_rate || channels != m_channels) return true;
        const Plan& p = *m_plan;

        // from renderStart on, the rendered transition replaces the live track, frame for frame;
        // once it runs out the rest of the live track is dropped
        size_t keep = 0;
        if (!m_rendering) {
            if (start > p.renderStart || start + (int64_t)n <= p.renderStart) return true;
            m_rendering = true;
            m_outUsed = 0;
            keep = (size_t)(p.renderStart - start);
        }
        const size_t total = p.out.size() / channels;
        const size_t take = (std::min)(n - keep, total - m_outUsed);
        memcpy(chunk->get_data() + keep * channels, p.out.data() + m_outUsed * channels, take * channels * sizeof(audio_sample));
        m_outUsed += take;
        if (keep + take < n) chunk->set_sample_count(keep + take);
        return keep + take > 0;
    }

    void on_endoftrack(abort_callback&) override { m_trackEnded = true; }
    void on_endofplayback(abort_callback&) override {}

    void flush() override {
        m_pos = -1;
        m_sinceFlush = 0;
        m_flushTick = GetTickCount64();
        m_rendering = false;
        m_outUsed = 0;
        m_dropNew = 0;
        if (m_plan) m_plan->pos = -1;
    }

    double get_latency() override { return 0; }
    bool need_track_change_mark() override { return true; }

private:
    void beginTrack(const dsp_track_t& track, const audio_chunk& chunk) {
        if (m_plan && m_rendering) {
            if (track.is_valid() && track == m_plan->next) {
                // whatever of the rendered transition is left goes out before this track's first chunk
                const std::vector<audio_sample>& out = m_plan->out;
                const size_t total = out.size() / m_channels, piece = m_rate / 2;
                for (size_t at = m_outUsed; at < total; at += piece) {
                    const size_t cnt = (std::min)(piece, total - at);
                    insert_chunk(cnt * m_channels)->set_data(out.data() + at * m_channels, cnt, m_channels, m_rate, m_channelConfig);
                }
                m_dropNew = m_plan->newResume;
                log("đã chuyển bài");
            } else {
                log("bài phát tiếp khác bài đã chuẩn bị, phát bài mới từ đầu");
            }
        }
        stopWorker();
        m_track = track;
        m_trackEnded = false;
        m_pos = 0;
        m_flushTick = 0;
        m_rendering = false;
        m_outUsed = 0;
        m_rate = chunk.get_srate();
        m_channels = chunk.get_channels();
        m_channelConfig = chunk.get_channel_config();
        if (track.is_valid()) {
            m_plan = std::make_shared<Plan>();
            m_worker = std::thread(prepare, m_plan, track, m_rate, m_channels, m_channelConfig);
        }
    }

    void stopWorker() {
        if (m_plan) m_plan->abort.abort();
        if (m_worker.joinable()) m_worker.join();
        m_plan.reset();
    }

    std::shared_ptr<Plan> m_plan;
    std::thread m_worker;
    dsp_track_t m_track;
    bool m_trackEnded = false;
    unsigned m_rate = 0, m_channels = 0, m_channelConfig = 0;
    int64_t m_pos = -1;  // frames into the current track, -1 unknown (after a seek)
    int64_t m_sinceFlush = 0;
    uint64_t m_flushTick = 0;
    bool m_rendering = false;  // the rendered transition has replaced the live track
    size_t m_outUsed = 0;  // frames of it played so far
    int64_t m_dropNew = 0;  // frames still to drop from the start of the new track
};

dsp_factory_nopreset_t<automix_dsp> g_dspFactory;

}  // namespace
