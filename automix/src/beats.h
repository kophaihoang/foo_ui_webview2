// Beat and downbeat analysis of a stretch of audio, using qm-dsp (the tracker Mixxx uses).
#pragma once
#include <cstddef>
#include <vector>

namespace automix {

struct Beats {
    std::vector<double> frames;  // beat positions, in frames from the start of the analysed audio
    std::vector<int> downbeats;  // indices into `frames` of the first beat of each bar (4/4 assumed)
    double bpm = 0;  // from the median beat interval
    double spread = 1;  // standard deviation / mean of the beat intervals; small means a steady beat

    bool steady() const { return frames.size() >= 16 && !downbeats.empty() && bpm >= 60 && bpm <= 200 && spread < 0.08; }
};

// `data` is interleaved; any sample rate (it is reduced to <= 48 kHz mono internally).
Beats analyseBeats(const float* data, size_t frames, unsigned channels, unsigned rate);

}  // namespace automix
