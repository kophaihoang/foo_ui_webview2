# Handoff: foobar2000 WebView2 theme + clear-window plugin + AutoMix

Read this whole file before touching anything. It is written for Claude Code picking up an ongoing project.

## 1. Who the user is and how to work with them

- The user (GitHub `kophaihoang`) writes in **Vietnamese** and wants replies in Vietnamese, short and plain.
- Before larger changes, **explain how you understood the request and ask about anything unclear** ("trả lời xem bạn hiểu ntn, chỗ nào chưa hiểu hỏi lại"). Small, clear fixes: just do them.
- They test on their own Windows 11 PC in foobar2000 v2 (x64). You cannot see or hear their machine, so after each change ask for a screenshot or a listening check.
- Never push to the upstream NereaFantasia repos. Push only to the user's own repos.
- Don't delete user files unless asked. Old deploy folders are the exception (see §4).

## 2. The pieces

| Piece | What it is | Where |
|---|---|---|
| **Theme** | React 19 + jotai + Fluent UI + vite web UI that foobar2000 shows in a WebView2 | Fork snapshot: branch `theme-clear-glass` of `github.com/kophaihoang/foo_ui_webview2` (see §3). Upstream: `github.com/NereaFantasia/foo-webview-default-theme` v0.3.0 |
| **Plugin** | `foo_ui_webview2`, the C++ foobar2000 component that hosts the WebView2 window | `github.com/kophaihoang/foo_ui_webview2`, branch `clear-window` (based on v2.1.0) |
| **AutoMix** | Planned DJ-style transition DSP component for foobar2000. **Not started** | §7 |

## 3. Getting the theme source

The theme was developed in a shallow clone of the upstream repo, so its history can't be pushed as-is. The branch `theme-clear-glass` in the user's fork holds:

- a snapshot of the whole theme tree (upstream 0.3.0 plus all our work), and
- `patches/`: the 17 commits as `git format-patch` files on top of upstream commit `1886839` ("feat: 发布默认主题 0.3.0").

Better setup, if the user agrees: fork `NereaFantasia/foo-webview-default-theme`, check out `1886839`, `git am patches/*.patch` onto a branch `clear-glass`, and push. Then you have real history.

Build and check (Node 22):

```
npm ci
npx tsc --noEmit -p .
npx eslint src
npx prettier --check src
npx vitest run tests/unit/immersive     # unit tests (pre-existing unrelated failures: configPref ×9, onboarding ×3)
npm run build                            # outputs dist/
```

e2e: `playwright.config.ts` wants the `msedge` channel. On Linux, make a throwaway config that sets `channel: undefined` and `launchOptions.executablePath` to a local chromium. The fake host is in `tests/fixtures` (`openPlayer`, `installFakeQueue`). It has only one playing track, and cycling Blueprint→Coverflow by double tap doesn't enter coverflow in the fake host. Click `[data-coverflow-key]` instead.

Lint layering rule (`immersive-layering`): legacy dirs (dial, paper, page, …) can't import new dirs (scene, coverflow, …). Elements import only scene/lease/frame. `page/` is the host and may import anything. Use `scene/viewCycleRequest.ts` and `page/sharedCover.ts` as bridges.

## 4. Deploying the theme to the user's foobar2000

foobar loads themes from `C:\Users\LVH\AppData\Roaming\foobar2000-v2\webview-ui\<folder>\`. Each deploy goes to a **new folder** `trongN`, which the user then selects in foobar:

1. `npm run build`, then copy `dist/` to a new folder `trongN`. The latest is **trong22**, so the next one is trong23.
2. Copy all files of `dist/` into `...\webview-ui\trongN\`, keeping the structure (`current.json`, `index.html`, `fe/0.3.0/...`).
3. Keep `default` and the two newest `trongN` folders. Delete the older ones.
4. Tell the user to select trongN in foobar.

## 5. Theme: what has been built (all in `src/immersive/`)

The Immersive view has 3 screens that cycle **Blueprint → Coverflow → Lyrics → Blueprint**. A double tap on empty space or a tap on the cover moves to the next screen.

- **Clear glass** (`theme/backdrop.ts`, `theme/ThemeRoot.tsx`):
  - Glass is active only while Immersive is up (`immersiveUpAtom`, `setImmersiveUp`). The main UI uses Mica.
  - While Immersive is up, the theme calls `fb.ui.setBlur({enabled:true})` and `setBackgroundTransparency({transparent:true})`. With the patched plugin (§6), this makes the window invisible.
  - `html[data-glass]` drives CSS:
    - Coverflow, Blueprint and Lyrics have no background (no grid, crosses or cover wash), and the 4 corner keys are hidden.
    - Blueprint panels keep a dark box (`--glass-pad-bg`), and Lyrics has a soft shade behind its column (`--glass-shade`).
  - The "Glass opacity" setting sets how dark those boxes and the shade are.
- **Cover flights** (`page/coverFlight.ts`): a compositor-only copy of the cover flies between screens.
  - `flyIntoBlueprint` lands on the record label.
  - `flyIntoLyrics` swaps the scene first, then runs the flight, the fade-out and the fade-in together.
  - `html[data-cover-flight]` hides the real covers during a flight. `Deferred` panels mount after the transition, one per frame.
- **Shuffle plan** (`scene/shufflePlan.ts`): an endless dealt order shown by the coverflow.
  - It holds `order`, `cursor` and `pending`. History before the cursor shows on the left (played side).
  - The next planned song is always kept in the foobar queue.
  - Service methods: `ensure`, `move`, `retire`, `insert`, `playAt`.
- **Coverflow** (`coverflow/`):
  - Drag a card to reorder, on both sides (`dropUpcoming.ts`). In list order, the real playlist rows move.
  - The fold animation on song change follows the side the song was picked from.
  - **Triple tap** on empty space glides back to the playing song. A double tap there waits 380 ms for a third tap before switching screens (`page/ImmersiveView.tsx`, `TRIPLE_TAP_WAIT_MS`).
  - **Drag a card over the bottom edge to sink it** (`sinkSong`):
    - Random order: the song moves to the end of the shuffle plan, leaving the queue if needed.
    - List order: a queued song leaves the queue, and a playlist song moves to the playlist's last row.
- **⏮** follows the coverflow order and restarts the current song if it is past 3 s (`scene/planRewind.ts`).

## 6. Plugin: the `clear-window` patch

Branch `clear-window` of `kophaihoang/foo_ui_webview2`, 2 commits on v2.1.0:

- `src/window/WindowChromeApplier.{h,cpp}` adds the hook `applyClearWindow(clear, fullscreen)`.
  - Clear = effect `none` + blur-behind requested + transparent WebView.
  - In that state, blur-behind is not applied and the corner preference is skipped.
- `src/window/MainWindowDwm.cpp`, `MainWindow::ApplyClearWindowState`:
  - On: frame extension margins 0 (no DWM frame sheet, no shadow), `DWMWCP_DONOTROUND`, and `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`.
  - Off: default border color, and the frame extension is reapplied via `ApplyFramelessState`.
- **Result (user confirmed by screenshot):** the 3 Immersive screens float on the desktop with no window visible. Clicks on empty space still hit the window (not click-through).
- CI: `.github/workflows/clear-window-build.yml` builds the x64 DLL on every push to `clear-window` (except `.github/**` and `*.md`). It uploads the DLL as an artifact and force-pushes it to branch `clear-window-dll`. Artifact blob downloads may be blocked by a network allowlist; fetching `clear-window-dll` over git works.
- **Install:** foobar must be closed. Replace `C:\Users\LVH\AppData\Roaming\foobar2000-v2\user-components-x64\foo_ui_webview2\foo_ui_webview2.dll`. The original v2.1.0 DLL is backed up in `...\foobar2000-v2\backup-foo_ui_webview2-2.1.0\`.
- Updating the official plugin overwrites this patch; it then has to be reapplied.

## 7. Next project: AutoMix (DJ-style transitions), not started

The user asked to study existing open source and see whether Apple-Music-style AutoMix can be done for foobar2000. Findings:

- **Mixxx Auto DJ** (`src/library/autodj/autodjprocessor.cpp`, `calculateTransition`) picks transition points:
  - Skip silence at the end of the outgoing track and the start of the next one.
  - Overlap the outro with the intro, using the shorter of the two lengths.
  - Fall back to a fixed time (e.g. 8 s).
- **pyCrossfade** (`pycrossfade/transition.py`) does beat-matched mixing:
  1. Detect downbeats (madmom).
  2. Gradually time-stretch the outgoing track over 8 bars to the next track's tempo.
  3. Stretch each bar of the overlap so the downbeats line up.
  4. Apply a 3-band DJ EQ crossfade: bass of the old track down, bass of the new track up, a mid dip at the centre.
  5. Balance loudness, and click-protect the seams.
- **dnb-autodj-3** picks transitions from song structure. Research-grade and Drum & Bass only; not worth porting.

How to do it in foobar2000: write a **DSP component** (`dsp_impl_base`, see `lib/foobar2000_sdk/foobar2000/SDK/dsp.h`).

- `need_track_change_mark()` returns true, so `on_endoftrack` marks the exact boundary.
- The DSP keeps the last N seconds in a ring buffer. That buffer adds latency; report it through `get_latency`.
- At the boundary, it mixes that tail with the head of the next track.
- The next track is known in advance: the theme always queues the next planned song.

Planned levels:

1. **Smart crossfade (start here):**
   - Equal-power crossfade plus a bass cut on the outgoing track.
   - Skip silence at both ends, Mixxx-style.
   - Configurable length, 4–12 s.
   - No beat analysis needed.
2. **Beat-matched (AutoMix-like):**
   - Background analysis of the end of the current track and the start of the queued next track: BPM and downbeats via qm-dsp (what Mixxx uses) or aubio.
   - Tempo ramp with SoundTouch (LGPL), then align downbeats.
   - Fall back to level 1 when the BPM difference is above about 6–8 %.
3. Structure-aware selection (dnb-autodj style): skip.

Open questions for the user before starting:

- Where to put it: a new repo (e.g. `kophaihoang/foo_dsp_automix`) or inside the fork?
- Confirm starting with level 1.

The CI pattern from §6 (Windows runner, MSBuild v143, publish the DLL to a branch) can be reused. The foobar SDK is in `foo_ui_webview2/lib/foobar2000_sdk`.

## 8. Theme commit log (newest first)

```
Coverflow: triple tap glides back; dragging a card off the bottom sinks the song to the end
Glass only in Immersive (Mica outside); transparent Coverflow/Blueprint/Lyrics; synced Coverflow→Lyrics flight
Coverflow -> Lyrics: the middle card flies into the lyrics cover
Cover flies into Blueprint off the main thread; previous follows the coverflow order
Coverflow: a song picked several cards ahead keeps the right side in place
Coverflow: drop cards on the played side too; Blueprint panels come in after the switch; spectrum feed reopens
Drop the window-drag workarounds and drag probe (the window was moved by foo_ui_wizard, now removed)
Fold side follows the side the song was picked from; probe keeps the press line
Side-specific song-change fold; drag probe diagnostic
Coverflow: fold side covers back and fan out on song change; shrink host title-bar fallback while immersive
Immersive: no CSS drag regions, top strip moves the window by script; slower record
Vinyl record in Blueprint, terrain off, deferred heavy panels, stable coverflow cards, window drag lock
Cover glides between all views, side cards slide out from behind the cover, drag a cover to reorder
Endless shuffle plan for the coverflow, double tap empty space to switch view on every screen
View cycle order Blueprint -> Coverflow -> Lyrics, cross-fade, coverflow taps, shuffle lookahead
Clear glass backdrop, Immersive transparency, touchpad swipe and one-tap view cycle
(base) feat: 发布默认主题 0.3.0  — upstream 1886839
```

## 9. Known gaps and things to verify with the user

- The sink-to-end drag in **random order** was not tested in a browser (the fake host has no shuffle playlist). Ask the user to try it.
- If the Lyrics shade or the Blueprint boxes are too light or too dark on some wallpapers, adjust `clearGlassVars` in `theme/ThemeRoot.tsx`.
- An e2e test for coverflow triple tap and sink would be good to add (see the probe approach in §3).
