// Self-check for beats.cpp on a synthetic 120 BPM loop (kick on every beat, accented first beat, hi-hat off-beats).
// Built by CI together with the qm-dsp sources, see .github/workflows/automix-build.yml.
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "beats.h"

int main() {
    const unsigned rate = 44100, ch = 2;
    const double beat = 0.5;  // 120 BPM
    const size_t frames = rate * 40;
    std::vector<float> a(frames * ch, 0.0f);
    srand(1);
    for (size_t i = 0; i < frames; ++i) {
        const double t = (double)i / rate;
        const double inBeat = std::fmod(t, beat);
        const int n = (int)(t / beat);
        double s = 0;
        const double kick = n % 4 == 0 ? 0.9 : 0.5;
        if (inBeat < 0.15) s += kick * std::exp(-inBeat * 30) * std::sin(2 * 3.14159265 * 60 * inBeat);
        if (inBeat < 0.005) s += kick * 0.6 * (rand() / (double)RAND_MAX * 2 - 1);  // the beater's click
        const double off = std::fmod(t + beat / 2, beat);
        if (off < 0.03) s += 0.15 * std::exp(-off * 150) * (rand() / (double)RAND_MAX * 2 - 1);
        a[i * ch] = a[i * ch + 1] = (float)s;
    }

    const automix::Beats b = automix::analyseBeats(a.data(), frames, ch, rate);
    std::printf("bpm %.2f, spread %.3f, %zu beats, %zu downbeats\n", b.bpm, b.spread, b.frames.size(), b.downbeats.size());
    std::fflush(stdout);
    assert(std::fabs(b.bpm - 120) < 1);
    assert(b.steady());
    std::printf("grid: %.2f BPM, fit error %.3f beats, downbeat offset %d
", b.bpm, b.fitError, b.downOffset);
    std::fflush(stdout);
    assert(std::fabs(b.bpm - 120) < 0.5 && b.fitError < 0.02);
    // the grid's bar lines land on the accented kicks (every 4th beat, from 0 s)
    const double bar0 = b.barAtOrAfter(rate * 2.0) / rate;
    assert(std::fabs(bar0 - std::round(bar0 / 2) * 2) < 0.03);

    // beats land on the kicks at a steady offset (a constant offset cancels out between two tracks)
    std::vector<double> err;
    for (size_t i = 4; i + 4 < b.frames.size(); ++i) {
        double e = std::fmod(b.frames[i] / rate, beat);
        if (e > beat / 2) e -= beat;
        err.push_back(e);
    }
    double mean = 0, worst = 0;
    for (double e : err) mean += e;
    mean /= err.size();
    for (double e : err) worst = std::fmax(worst, std::fabs(e - mean));
    std::printf("beat offset %.1f ms, jitter %.1f ms\n", mean * 1000, worst * 1000);
    std::fflush(stdout);
    assert(worst < 0.015);
    assert(std::fabs(mean) < 0.03);  // on the kicks, not the off-beat hi-hats

    for (size_t i = 1; i < b.downbeats.size(); ++i) assert(b.downbeats[i] - b.downbeats[i - 1] == 4);

    std::puts("test_beats: ok");
    return 0;
}
