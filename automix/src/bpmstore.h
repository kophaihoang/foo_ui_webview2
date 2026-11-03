// Tempo of every track, without scanning the library: what AutoMix measured while playing it, else the
// file's BPM tag, else Deezer's figure for its ISRC (looked up in the background, once). Kept in
// <profile>\automix-bpm.tsv and shown to title formatting as %automix_bpm%, which the theme reads to
// line up songs whose tempos match.
#pragma once
#include <foobar2000/SDK/foobar2000.h>

namespace automix {

// The best known tempo, 0 when none yet (a Deezer lookup is then queued if the track has an ISRC).
double knownBpm(const metadb_handle_ptr& track);

// Records a tempo measured by the beat tracker; it wins over tags and Deezer from then on.
void learnBpm(const metadb_handle_ptr& track, double bpm);

}  // namespace automix
