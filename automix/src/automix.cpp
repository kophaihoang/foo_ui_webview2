// AutoMix, stage 1: DJ-style overlap between consecutive tracks.
//
// How it works without adding latency:
//  - At the start of each track a worker thread decodes the last 60 s of it to find where the sound ends.
//  - About 20 s before the mix, it asks the main thread which track plays next (queue first, then the
//    next playlist row), decodes that track's head from the file itself, skips its leading silence,
//    applies the same ReplayGain scale the player uses and converts it to the current sample rate.
//  - The DSP mixes that head into the last N seconds of the current track (equal-power fade, bass of the
//    outgoing track cut gradually), then drops the rest of the current track.
//  - When foobar2000 then delivers the next track for real, the DSP drops the part that was already heard.
// Anything unexpected (prediction wrong, decode error, seek, different channel layout) falls back to
// a plain transition, with the reason written to the Console.
#include <foobar2000/SDK/foobar2000.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "mix.h"

DECLARE_COMPONENT_VERSION("AutoMix", "0.1.0",
    "DJ-style transitions between tracks.\n"
    "Stage 1: equal-power overlap, gradual bass cut on the outgoing track, silence skipping.\n"
    "Settings: Preferences > Advanced > Playback > AutoMix.\n\n"
    "License: GPL-3.0-or-later");
VALIDATE_COMPONENT_FILENAME("foo_dsp_automix.dll");

namespace {

constexpr GUID guid_dsp = {0x1cbe0af2, 0xf09b, 0x41c9, {0xb7, 0x6e, 0x3c, 0x6a, 0x29, 0x65, 0x4a, 0x2d}};
constexpr GUID guid_branch = {0xae12d125, 0x3ba8, 0x48f0, {0x9d, 0x95, 0x21, 0x58, 0x36, 0xde, 0x57, 0xc3}};
constexpr GUID guid_seconds = {0x7c719b04, 0xff1e, 0x47f9, {0x9b, 0x16, 0xda, 0xd6, 0x65, 0xd3, 0xa1, 0x7f}};
constexpr GUID guid_basscut = {0x1a766c43, 0x9487, 0x4d1b, {0x89, 0x46, 0x90, 0x45, 0x95, 0x3c, 0x8f, 0xf6}};
constexpr GUID guid_silence = {0xbac54e6b, 0x5046, 0x49cd, {0xb2, 0x41, 0x13, 0x5a, 0x33, 0x22, 0xdd, 0xb4}};

advconfig_branch_factory g_branch("AutoMix", guid_branch, advconfig_branch::guid_branch_playback, 0);
advconfig_integer_factory g_cfgSeconds("Transition length (seconds)", guid_seconds, guid_branch, 0, 8, 4, 16);
advconfig_integer_factory g_cfgBassCut("Bass cut on the outgoing track (%)", guid_basscut, guid_branch, 1, 70, 0, 100);
advconfig_integer_factory g_cfgSilence("Silence threshold (dB below full scale)", guid_silence, guid_branch, 2, 50, 30, 90);

constexpr double kTailScanSeconds = 60;  // how much of the outgoing track's end is analysed
constexpr double kHeadSearchSeconds = 30;  // longest leading silence we skip in the next track
constexpr double kPrepareLeadSeconds = 20;  // the next track is predicted and decoded this long before the mix
constexpr double kRecheckLeadSeconds = 2;  // ...and checked once more this long before
constexpr double kBassCutoffHz = 200;

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

// ---- which track comes next (main thread only) ----

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

// Runs predictNext on the main thread and waits for it, abortably (never blocks the main thread on us).
NextTrack askNext(const metadb_handle_ptr& current, abort_callback& abort) {
    struct Box {
        std::atomic<bool> done{false};
        NextTrack value;
    };
    auto box = std::make_shared<Box>();
    fb2k::inMainThread([box, current] {
        try {
            box->value = predictNext(current);
        } catch (std::exception const& e) {
            box->value.why = e.what();
        }
        box->done = true;
    });
    while (!box->done) abort.sleep(0.02);
    return box->value;
}

// ---- the plan for one track, shared between the DSP and its worker ----

struct Plan {
    abort_callback_impl abort;
    std::atomic<int64_t> pos{-1};  // DSP decode position in frames of the current track, -1 unknown

    // written by the worker before `ready` is set, read-only afterwards
    std::atomic<bool> ready{false};
    metadb_handle_ptr next;
    int64_t mixStart = 0, mixEnd = 0;  // frames of the current track
    int64_t headSkip = 0;  // leading silence of the next track, frames at its own rate
    unsigned nextRate = 0;
    std::vector<audio_sample> head;  // (mixEnd - mixStart) frames, current rate and channels
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
        const double seconds = (double)g_cfgSeconds.get();
        const double threshold = automix::dbToAmp(-(double)g_cfgSilence.get());

        // 1. where does the current track's sound end
        const double length = current->get_length();
        if (length <= 0) throw Failure("không biết độ dài bài");
        if (length < 3 * seconds) throw Failure("bài quá ngắn so với độ dài chuyển");
        auto dec = openDecoder(current, input_flag_no_looping, abort);
        if (!dec->can_seek()) throw Failure("không tua được trong file để đọc đuôi bài");
        const double from = (std::max)(0.0, length - kTailScanSeconds);
        dec->seek(from, abort);
        int64_t frame = (int64_t)std::llround(from * rate);
        int64_t end = -1;
        audio_chunk_impl chunk;
        while (dec->run(chunk, abort)) {
            if (chunk.get_srate() != rate || chunk.get_channels() != channels) throw Failure("định dạng đổi giữa bài");
            const size_t e = automix::audibleEnd(chunk.get_data(), chunk.get_sample_count(), channels, threshold);
            if (e > 0) end = frame + (int64_t)e;
            frame += (int64_t)chunk.get_sample_count();
        }
        dec.release();
        if (end < 0) throw Failure("60 giây cuối bài im lặng hoàn toàn");
        const int64_t mixLen = (int64_t)std::llround(seconds * rate);
        const int64_t mixEnd = end, mixStart = end - mixLen;

        // 2. which track comes next
        waitForPos(p, mixStart - (int64_t)(kPrepareLeadSeconds * rate));
        const NextTrack next = askNext(current, abort);
        if (!next.handle.is_valid()) throw Failure(pfc::string_formatter()._formatter() << "không đoán được bài kế: " << next.why);

        // 3. its head: skip the leading silence, keep the overlap length plus a little for the resampler
        auto nd = openDecoder(next.handle, input_flag_simpledecode, abort);
        std::vector<audio_sample> head;
        unsigned nextRate = 0;
        int64_t skip = -1, decoded = 0, want = 0;
        while (nd->run(chunk, abort)) {
            if (nextRate == 0) {
                nextRate = chunk.get_srate();
                if (chunk.get_channels() != channels || chunk.get_channel_config() != channelConfig)
                    throw Failure(pfc::string_formatter()._formatter() << "số kênh khác nhau (" << channels << " và " << chunk.get_channels() << ")");
                want = (int64_t)std::ceil((seconds + 0.5) * nextRate);
            }
            if (chunk.get_srate() != nextRate) throw Failure("bài kế đổi sample rate ở đoạn đầu");
            const size_t n = chunk.get_sample_count();
            const audio_sample* d = chunk.get_data();
            size_t keepFrom = 0;
            if (skip < 0) {
                const size_t first = automix::firstAudible(d, n, channels, threshold);
                if (first == n) {
                    decoded += (int64_t)n;
                    if (decoded > kHeadSearchSeconds * nextRate) throw Failure("30 giây đầu bài kế im lặng");
                    continue;
                }
                skip = decoded + (int64_t)first;
                keepFrom = first;
            }
            head.insert(head.end(), d + keepFrom * channels, d + n * channels);
            decoded += (int64_t)n;
            if ((int64_t)(head.size() / channels) >= want) break;
        }
        nd.release();
        if ((int64_t)(head.size() / channels) < want) throw Failure("bài kế ngắn hơn độ dài chuyển");
        for (auto& s : head) s *= next.scale;

        pfc::string8 rateNote;
        if (nextRate != rate) {
            head = resample(head, channels, channelConfig, nextRate, rate, next.handle);
            rateNote << ", đổi " << nextRate << " → " << rate << " Hz";
        }
        if ((int64_t)(head.size() / channels) < mixLen) throw Failure("đoạn đầu bài kế hụt sau khi đổi sample rate");
        head.resize((size_t)mixLen * channels);

        p.next = next.handle;
        p.mixStart = mixStart;
        p.mixEnd = mixEnd;
        p.headSkip = skip;
        p.nextRate = nextRate;
        p.head = std::move(head);
        p.ready = true;
        FB2K_console_formatter() << "AutoMix: sẵn sàng chuyển sang \"" << next.handle << "\" (bỏ "
                             << pfc::format_float((double)skip / nextRate, 0, 1) << " s im lặng đầu, "
                             << pfc::format_float(length - (double)end / rate, 0, 1) << " s im lặng cuối" << rateNote << ")";

        // 4. the queue may have changed since; check once more right before the mix
        waitForPos(p, mixStart - (int64_t)(kRecheckLeadSeconds * rate));
        const NextTrack again = askNext(current, abort);
        if (again.handle != next.handle && p.pos < mixStart) {
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

        // the part of this track that was already heard during the previous mix
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
                m_pos = (int64_t)std::llround(g_seekTime * chunk->get_srate()) + m_sinceFlush;
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
        if (start + (int64_t)n <= p.mixStart) return true;
        if (start >= p.mixEnd) return m_headUsed < 0;  // after the mix the rest of the old track is silence; drop it

        audio_sample* d = chunk->get_data();
        const double len = (double)(p.mixEnd - p.mixStart);
        for (size_t i = 0; i < n; ++i) {
            const int64_t t = start + (int64_t)i;
            if (t < p.mixStart) continue;
            if (t >= p.mixEnd) {
                chunk->set_sample_count(i);
                break;
            }
            const int64_t k = t - p.mixStart;
            const double prog = (double)k / len;
            const double gOut = automix::fadeOutGain(prog), gIn = automix::fadeInGain(prog), bass = m_bassCut * prog;
            for (unsigned c = 0; c < channels; ++c) {
                const double x = d[i * channels + c];
                const double outgoing = x - m_lowpass.process(c, x) * bass;
                d[i * channels + c] = (audio_sample)(outgoing * gOut + p.head[(size_t)k * channels + c] * gIn);
            }
            m_headUsed = k;
        }
        return chunk->get_sample_count() > 0;
    }

    void on_endoftrack(abort_callback&) override { m_trackEnded = true; }
    void on_endofplayback(abort_callback&) override {}

    void flush() override {
        m_pos = -1;
        m_sinceFlush = 0;
        m_flushTick = GetTickCount64();
        m_headUsed = -1;
        m_dropNew = 0;
        if (m_plan) m_plan->pos = -1;
    }

    double get_latency() override { return 0; }
    bool need_track_change_mark() override { return true; }

private:
    void beginTrack(const dsp_track_t& track, const audio_chunk& chunk) {
        if (m_plan && m_headUsed >= 0) {
            if (track.is_valid() && track == m_plan->next) {
                m_dropNew = m_plan->headSkip +
                            (int64_t)std::llround((double)(m_headUsed + 1) * m_plan->nextRate / m_rate);
                log("đã chuyển bài kiểu DJ");
            } else {
                log("bài phát tiếp khác bài đã trộn trước, phát bài mới từ đầu");
            }
        }
        stopWorker();
        m_track = track;
        m_trackEnded = false;
        m_pos = 0;
        m_flushTick = 0;
        m_headUsed = -1;
        m_rate = chunk.get_srate();
        m_channels = chunk.get_channels();
        m_bassCut = (double)g_cfgBassCut.get() / 100;
        m_lowpass.setup(kBassCutoffHz, m_rate, m_channels);
        if (track.is_valid()) {
            m_plan = std::make_shared<Plan>();
            m_worker = std::thread(prepare, m_plan, track, m_rate, m_channels, chunk.get_channel_config());
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
    unsigned m_rate = 0, m_channels = 0;
    int64_t m_pos = -1;  // frames into the current track, -1 unknown (after a seek)
    int64_t m_sinceFlush = 0;
    uint64_t m_flushTick = 0;
    int64_t m_headUsed = -1;  // last frame of the next track's head mixed in, -1 none
    int64_t m_dropNew = 0;  // frames still to drop from the start of the new track
    double m_bassCut = 0;
    automix::LowPass m_lowpass;
};

dsp_factory_nopreset_t<automix_dsp> g_dspFactory;

}  // namespace
