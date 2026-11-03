#include "bpmstore.h"

#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>

namespace automix {

namespace {

constexpr double kMinBpm = 40, kMaxBpm = 250;  // tag values outside this are taken as junk
constexpr double kLookupGapSeconds = 0.25;  // Deezer allows 50 requests per 5 s; stay well below

struct Entry {
    double bpm = 0;
    char source = 0;  // 'L' learned (beat tracker), 'D' Deezer (0 = Deezer doesn't know it)
};

std::mutex g_lock;
bool g_loaded = false;
std::unordered_map<std::string, Entry> g_cache;  // by path|subsong

// the background Deezer lookups
std::deque<std::pair<std::string, std::string>> g_lookups;  // key, ISRC
std::set<std::string> g_asked;
std::condition_variable g_wake;
std::thread g_worker;
bool g_quitting = false;

// created on first use: its constructor asks foobar2000 for a service, which isn't there yet while the DLL
// loads; never destroyed, as its destructor would run after those services are gone
abort_callback_impl& lookupAbort() {
    static auto* abort = new abort_callback_impl;
    return *abort;
}

std::string keyOf(const metadb_handle_ptr& track) {
    return std::string(track->get_path()) + "|" + std::to_string(track->get_subsong_index());
}

std::filesystem::path cacheFile() {
    pfc::string8 native;
    const pfc::string8 path = core_api::pathInProfile("automix-bpm.tsv");
    if (!foobar2000_io::extract_native_path(path, native)) native = path;
    return std::filesystem::path(pfc::stringcvt::string_wide_from_utf8(native).get_ptr());
}

// lines: bpm <tab> source <tab> path|subsong; a later line for the same track wins
void loadLocked() {
    if (g_loaded) return;
    g_loaded = true;
    std::ifstream in(cacheFile(), std::ios::binary);
    std::string line;
    while (std::getline(in, line)) {
        const size_t a = line.find('\t'), b = a == std::string::npos ? a : line.find('\t', a + 1);
        if (b == std::string::npos || b != a + 2) continue;
        g_cache[line.substr(b + 1)] = Entry{std::atof(line.substr(0, a).c_str()), line[a + 1]};
    }
}

void storeLocked(const std::string& key, Entry e) {
    g_cache[key] = e;
    std::ofstream out(cacheFile(), std::ios::binary | std::ios::app);
    out << e.bpm << '\t' << e.source << '\t' << key << '\n';
}

double tagBpm(const metadb_handle_ptr& track, pfc::string8& isrc) {
    metadb_info_container::ptr info;
    if (!track->get_info_ref(info)) return 0;
    const file_info& fi = info->info();
    if (const char* v = fi.meta_get("ISRC", 0)) isrc = v;
    const char* v = fi.meta_get("BPM", 0);
    const double bpm = v ? std::atof(v) : 0;
    return bpm >= kMinBpm && bpm <= kMaxBpm ? bpm : 0;
}

void lookupLoop() {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    static const std::regex bpmField("\"bpm\"\\s*:\\s*([0-9.]+)");
    for (;;) {
        std::pair<std::string, std::string> job;
        {
            std::unique_lock<std::mutex> lock(g_lock);
            g_wake.wait(lock, [] { return g_quitting || !g_lookups.empty(); });
            if (g_quitting) return;
            job = g_lookups.front();
            g_lookups.pop_front();
        }
        double bpm = 0;
        try {
            pfc::string8 url = "https://api.deezer.com/track/isrc:";
            url << job.second.c_str();
            file::ptr f = http_client::get()->create_request("GET")->run(url, lookupAbort());
            std::string body;
            char buf[4096];
            for (size_t n; (n = f->read(buf, sizeof buf, lookupAbort())) > 0;) body.append(buf, n);
            std::smatch m;
            if (std::regex_search(body, m, bpmField)) bpm = std::atof(m[1].str().c_str());
        } catch (exception_aborted const&) {
            return;
        } catch (std::exception const&) {
            continue;  // offline or refused: try again in a later session
        }
        {
            std::lock_guard<std::mutex> lock(g_lock);
            if (g_cache[job.first].source != 'L') storeLocked(job.first, Entry{bpm, 'D'});
        }
        if (!lookupAbort().sleep_ex(kLookupGapSeconds)) return;
    }
}

void queueLookupLocked(const std::string& key, const char* isrc) {
    if (g_quitting || !g_asked.insert(key).second) return;
    g_lookups.emplace_back(key, isrc);
    if (!g_worker.joinable()) g_worker = std::thread(lookupLoop);
    g_wake.notify_one();
}

class bpm_shutdown : public initquit {
public:
    void on_quit() override {
        {
            std::lock_guard<std::mutex> lock(g_lock);
            g_quitting = true;
        }
        lookupAbort().abort();
        g_wake.notify_all();
        if (g_worker.joinable()) g_worker.join();
    }
};
FB2K_SERVICE_FACTORY(bpm_shutdown);

class bpm_field : public metadb_display_field_provider {
public:
    t_uint32 get_field_count() override { return 1; }
    void get_field_name(t_uint32, pfc::string_base& out) override { out = "automix_bpm"; }
    bool process_field(t_uint32, metadb_handle* handle, titleformat_text_out* out) override {
        const double bpm = knownBpm(handle);
        if (bpm <= 0) return false;
        out->write(titleformat_inputtypes::meta, pfc::format_float(bpm, 0, 1));
        return true;
    }
};
FB2K_SERVICE_FACTORY(bpm_field);

}  // namespace

double knownBpm(const metadb_handle_ptr& track) {
    if (!track.is_valid()) return 0;
    const std::string key = keyOf(track);
    pfc::string8 isrc;
    const double tag = tagBpm(track, isrc);
    std::lock_guard<std::mutex> lock(g_lock);
    loadLocked();
    const auto it = g_cache.find(key);
    if (it != g_cache.end() && it->second.source == 'L') return it->second.bpm;
    if (tag > 0) return tag;
    if (it != g_cache.end()) return it->second.bpm;
    if (!isrc.is_empty()) queueLookupLocked(key, isrc);
    return 0;
}

void learnBpm(const metadb_handle_ptr& track, double bpm) {
    if (!track.is_valid() || bpm <= 0) return;
    const std::string key = keyOf(track);
    std::lock_guard<std::mutex> lock(g_lock);
    loadLocked();
    const auto it = g_cache.find(key);
    if (it != g_cache.end() && it->second.source == 'L' && std::fabs(it->second.bpm - bpm) < 0.05) return;
    storeLocked(key, Entry{bpm, 'L'});
}

}  // namespace automix
