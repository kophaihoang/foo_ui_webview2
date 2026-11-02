// Pure audio helpers for AutoMix: no foobar2000 dependencies, so tests/test_mix.cpp can build them alone.
#pragma once
#include <cmath>
#include <cstddef>
#include <vector>

namespace automix {

constexpr double kPi = 3.14159265358979323846;

// Equal-power crossfade: fadeOut^2 + fadeIn^2 == 1 for every progress t in [0, 1].
inline double fadeOutGain(double t) { return std::cos(t * kPi / 2); }
inline double fadeInGain(double t) { return std::sin(t * kPi / 2); }

inline double dbToAmp(double db) { return std::pow(10.0, db / 20.0); }

// First frame where any channel is above the threshold; `frames` if none is.
template <typename T>
size_t firstAudible(const T* data, size_t frames, unsigned channels, double threshold) {
    for (size_t i = 0; i < frames * channels; ++i)
        if (std::fabs(data[i]) > threshold) return i / channels;
    return frames;
}

// One past the last frame where any channel is above the threshold; 0 if none is.
template <typename T>
size_t audibleEnd(const T* data, size_t frames, unsigned channels, double threshold) {
    for (size_t i = frames * channels; i-- > 0;)
        if (std::fabs(data[i]) > threshold) return i / channels + 1;
    return 0;
}

// 2nd order Butterworth low-pass (RBJ cookbook, Q = 1/sqrt 2), transposed direct form II, one state per channel.
// Bass cut is x - lowpass(x) * amount, which is exactly x when amount is 0, so it starts without a click.
struct LowPass {
    double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    std::vector<double> z1, z2;

    void setup(double cutoffHz, double rate, unsigned channels) {
        const double w = 2 * kPi * cutoffHz / rate;
        const double alpha = std::sin(w) / (2 * std::sqrt(0.5));
        const double cosw = std::cos(w);
        const double a0 = 1 + alpha;
        b0 = (1 - cosw) / 2 / a0;
        b1 = (1 - cosw) / a0;
        b2 = b0;
        a1 = -2 * cosw / a0;
        a2 = (1 - alpha) / a0;
        z1.assign(channels, 0.0);
        z2.assign(channels, 0.0);
    }

    double process(unsigned ch, double x) {
        const double y = b0 * x + z1[ch];
        z1[ch] = b1 * x - a1 * y + z2[ch];
        z2[ch] = b2 * x - a2 * y;
        return y;
    }
};

}  // namespace automix
