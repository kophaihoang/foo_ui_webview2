#include "beats.h"

#include <algorithm>
#include <cmath>

#include "dsp/onsets/DetectionFunction.h"
#include "dsp/tempotracking/DownBeat.h"
#include "dsp/tempotracking/TempoTrackV2.h"

namespace automix {

Beats analyseBeats(const float* data, size_t frames, unsigned channels, unsigned rate) {
    Beats r;
    // mono, and at most 48 kHz: 96 kHz is averaged in pairs, 192 kHz in fours
    const unsigned f = (rate + 47999) / 48000;
    const double ar = (double)rate / f;
    std::vector<float> mono(frames / f);
    for (size_t i = 0; i < mono.size(); ++i) {
        double s = 0;
        for (size_t k = i * f * channels; k < (i + 1) * f * channels; ++k) s += data[k];
        mono[i] = (float)(s / (f * channels));
    }

    // same settings as Mixxx / the QM bar-and-beat tracker: ~11.6 ms steps, complex spectral difference
    constexpr int kDecimation = 16;  // for the downbeat finder, must divide the step
    const int step = (std::max)(kDecimation, (int)std::lround(ar * 0.01161 / kDecimation) * kDecimation);
    const int window = step * 2;
    DFConfig cfg{};
    cfg.stepSize = step;
    cfg.frameLength = window;
    cfg.DFType = DF_COMPLEXSD;
    cfg.dbRise = 3;
    cfg.adaptiveWhitening = false;
    cfg.whiteningRelaxCoeff = -1;
    cfg.whiteningFloor = -1;
    DetectionFunction detect(cfg);
    DownBeat down((float)ar, kDecimation, step);
    down.setBeatsPerBar(4);

    // frame k is centred on k * step
    std::vector<double> frame(window), df;
    for (size_t k = 0; k * step < mono.size(); ++k) {
        for (int j = 0; j < window; ++j) {
            const long long idx = (long long)(k * step) + j - window / 2;
            frame[j] = idx >= 0 && idx < (long long)mono.size() ? mono[(size_t)idx] : 0.0;
        }
        df.push_back(detect.processTimeDomain(frame.data()));
        if ((k + 1) * step <= mono.size()) down.pushAudioBlock(mono.data() + k * step);
    }

    // like the QM plugin: drop the first two values (start-up noise) and trailing zeros
    size_t used = df.size();
    while (used > 0 && df[used - 1] <= 0) --used;
    if (used < 200) return r;
    std::vector<double> d(df.begin() + 2, df.begin() + used), period(d.size()), tempi, beats;
    TempoTrackV2 tracker((float)ar, step);
    tracker.calculateBeatPeriod(d, period, tempi);
    tracker.calculateBeats(d, period, beats);
    for (auto& b : beats) b += 2;  // back to indices of `df`
    if (beats.size() < 8) return r;

    size_t bufLen = 0;
    const float* buf = down.getBufferedAudio(bufLen);
    down.findDownBeats(buf, bufLen, beats, r.downbeats);

    r.frames.reserve(beats.size());
    for (double b : beats) r.frames.push_back(b * step * f);

    std::vector<double> iv;
    for (size_t i = 1; i < r.frames.size(); ++i) iv.push_back(r.frames[i] - r.frames[i - 1]);
    std::vector<double> sorted = iv;
    std::nth_element(sorted.begin(), sorted.begin() + sorted.size() / 2, sorted.end());
    const double median = sorted[sorted.size() / 2];
    r.bpm = 60.0 * rate / median;
    double mean = 0, var = 0;
    for (double x : iv) mean += x;
    mean /= iv.size();
    for (double x : iv) var += (x - mean) * (x - mean);
    r.spread = std::sqrt(var / iv.size()) / mean;

    // one steady grid through the beats: number them by the median interval (so a missed or doubled beat
    // keeps the count right), then a least-squares line through (number, frame)
    std::vector<double> num(r.frames.size());
    for (size_t i = 0; i < num.size(); ++i) num[i] = std::round((r.frames[i] - r.frames[0]) / median);
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    const double cnt = (double)num.size();
    for (size_t i = 0; i < num.size(); ++i) {
        sx += num[i];
        sy += r.frames[i];
        sxx += num[i] * num[i];
        sxy += num[i] * r.frames[i];
    }
    r.period = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
    r.phase = (sy - r.period * sx) / cnt;
    double err = 0;
    for (size_t i = 0; i < num.size(); ++i) {
        const double e = r.frames[i] - (r.phase + r.period * num[i]);
        err += e * e;
    }
    r.fitError = std::sqrt(err / cnt) / r.period;
    r.bpm = 60.0 * rate / r.period;
    // the bar's first beat: the grid position most downbeats agree on
    int votes[4] = {};
    for (int d : r.downbeats) ++votes[(int)num[(size_t)d] % 4];
    r.downOffset = (int)(std::max_element(votes, votes + 4) - votes);
    return r;
}

}  // namespace automix
