// Self-check for mix.h. Build and run: cl /nologo /EHsc /std:c++20 /I..\src test_mix.cpp && test_mix.exe
#include <cassert>
#include <cmath>
#include <cstdio>
#include "mix.h"

using namespace automix;

int main() {
    // equal power: constant total power, ends fully on each side
    for (double t = 0; t <= 1.0; t += 0.05)
        assert(std::fabs(fadeOutGain(t) * fadeOutGain(t) + fadeInGain(t) * fadeInGain(t) - 1) < 1e-9);
    assert(fadeOutGain(0) == 1 && std::fabs(fadeInGain(0)) < 1e-12);
    assert(std::fabs(fadeOutGain(1)) < 1e-12 && std::fabs(fadeInGain(1) - 1) < 1e-12);

    // silence edges on stereo frames: silent, silent, loud (right channel), silent
    const float s[] = {0, 0, 0.001f, 0, 0, 0.5f, 0, 0};
    const double thr = dbToAmp(-50);  // ~0.00316
    assert(firstAudible(s, 4, 2, thr) == 2);
    assert(audibleEnd(s, 4, 2, thr) == 3);
    const float quiet[] = {0, 0.001f};
    assert(firstAudible(quiet, 1, 2, thr) == 1 && audibleEnd(quiet, 1, 2, thr) == 0);

    // low-pass keeps 50 Hz, removes 5 kHz (so the bass cut takes bass, not treble)
    auto gainAt = [](double hz) {
        LowPass lp;
        lp.setup(200, 44100, 1);
        double peak = 0;
        for (int i = 0; i < 44100; ++i) {
            const double y = lp.process(0, std::sin(2 * kPi * hz * i / 44100));
            if (i > 22050) peak = std::fmax(peak, std::fabs(y));
        }
        return peak;
    };
    assert(gainAt(50) > 0.95);
    assert(gainAt(5000) < 0.01);

    std::puts("test_mix: ok");
    return 0;
}
