// Beat and downbeat analysis of a stretch of audio, using qm-dsp (the tracker Mixxx uses).
#pragma once
#include <cmath>
#include <cstddef>
#include <vector>

namespace automix {

struct Beats {
    std::vector<double> frames;  // beat positions, in frames from the start of the analysed audio
    std::vector<int> downbeats;  // indices into `frames` of the first beat of each bar (4/4 assumed)
    double spread = 1;  // standard deviation / mean of the beat intervals

    // one steady grid fitted through the beats: beat k is at phase + k * period
    double period = 0;  // frames per beat
    double phase = 0;
    double fitError = 1;  // how far the beats sit from the grid, in beats (RMS)
    int downOffset = 0;  // grid beats with k % 4 == downOffset start a bar
    double bpm = 0;

    bool steady() const {
        return frames.size() >= 16 && !downbeats.empty() && bpm >= 60 && bpm <= 200 && fitError < 0.04;
    }
    // frame of the first bar line at or after `frame`
    double barAtOrAfter(double frame) const {
        const double bar = 4 * period, first = phase + downOffset * period;
        return first + std::ceil((frame - first) / bar) * bar;
    }
};

// `data` is interleaved; any sample rate (it is reduced to <= 48 kHz mono internally).
Beats analyseBeats(const float* data, size_t frames, unsigned channels, unsigned rate);

}  // namespace automix
