// Renders a whole transition ahead of time: the end of the outgoing track mixed with the head of the next one.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "beats.h"

namespace automix {

// Interleaved audio whose first frame is frame `start` of its track.
struct Audio {
    std::vector<float> data;
    unsigned rate = 0, channels = 0;
    int64_t start = 0;

    int64_t end() const { return start + (int64_t)(data.size() / channels); }
    const float* at(int64_t frame) const { return data.data() + (frame - start) * channels; }
};

using Resampler = std::function<std::vector<float>(const std::vector<float>&, unsigned from, unsigned to)>;

struct Settings {
    double seconds = 8;  // plain overlap length, at most
    double bassCut = 0.7;  // plain: how much of the outgoing bass is gone at the end, 0..1
    int bars = 8;  // beat-matched overlap length, at most, in 4/4 bars
    double maxBpmDiff = 0.08;  // beat-matched only within this relative tempo difference
};

struct Transition {
    std::vector<float> out;  // replaces the outgoing track from `renderStart`; its rate and channels
    int64_t renderStart = 0;  // frame of the outgoing track
    int64_t newResume = 0;  // frame of the next track (its own rate) where its live playback carries on
    std::string summary;
};

// How long the end of the track (before `end`, where its sound stops) stays clearly quieter than the rest:
// a fade-out or a quiet outro. Near 0 for a song sung or played at full level up to its last note, which
// should then be overlapped only briefly.
double quietOutroSeconds(const Audio& old, int64_t end);

// Outgoing-track side of a beat-matched transition, worked out before the next track is known.
// The overlap ends on the first bar line at or after the end of the sound, so the last note is never cut;
// it is as many bars long as the quiet outro (between 2 and the setting), and a tempo glide may come first.
struct OldPlan {
    bool ok = false;
    double overlapStart = 0, overlapEnd = 0;  // frames of the outgoing track, on its bar lines
    int bars = 0;
    int rampBars = 0;  // bars of tempo glide before the overlap, when the tempo has to change
    int64_t renderStart = 0;  // earliest start (with the glide)
};
OldPlan planOldSide(const Audio& old, int64_t oldEnd, const Beats& beats, int maxBars);

// Equal-power overlap of `s.seconds` ending at `oldEnd`; the next track enters at `nextStart`.
Transition plainTransition(const Audio& old, int64_t oldEnd, const Audio& next, int64_t nextStart, const Settings& s,
    const Resampler& resample);

// The outgoing track's tempo glides to the next one's, the bars line up, and the bass swaps on the middle bar.
// Returns false and sets `why` when the tracks don't suit it.
bool beatTransition(const Audio& old, const Beats& oldBeats, const OldPlan& plan, const Audio& next, int64_t nextStart,
    const Beats& nextBeats, const Settings& s, const Resampler& resample, Transition& out, std::string& why);

}  // namespace automix
