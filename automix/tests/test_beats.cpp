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
        if (inBeat < 0.15) s += (n % 4 == 0 ? 0.9 : 0.5) * std::exp(-inBeat * 30) * std::sin(2 * 3.14159265 * 60 * inBeat);
        const double off = std::fmod(t + beat / 2, beat);
        if (off < 0.03) s += 0.15 * std::exp(-off * 150) * (rand() / (double)RAND_MAX * 2 - 1);
        a[i * ch] = a[i * ch + 1] = (float)s;
    }

    const automix::Beats b = automix::analyseBeats(a.data(), frames, ch, rate);
    std::printf("bpm %.2f, spread %.3f, %zu beats, %zu downbeats\n", b.bpm, b.spread, b.frames.size(), b.downbeats.size());
    assert(std::fabs(b.bpm - 120) < 1);
    assert(b.steady());

    // beats land on the kicks (systematic offset reported; it cancels out between two tracks)
    double worst = 0;
    for (size_t i = 4; i + 4 < b.frames.size(); ++i) {
        double e = std::fmod(b.frames[i] / rate, beat);
        if (e > beat / 2) e -= beat;
        worst = std::fmax(worst, std::fabs(e));
    }
    std::printf("worst beat offset %.1f ms\n", worst * 1000);
    assert(worst < 0.03);

    for (size_t i = 1; i < b.downbeats.size(); ++i) assert(b.downbeats[i] - b.downbeats[i - 1] == 4);

    std::puts("test_beats: ok");
    return 0;
}
