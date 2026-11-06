# AutoMix redo: plan and rules (agreed 2026-11-06)

Read this before working on AutoMix. It records where AutoMix stands, what failed before, and the plan and rules the user agreed to for the next attempt. Reply to the user in **Vietnamese**, short and plain.

## 1. Where AutoMix stands

- Source: `automix/` on branch `automix` of `github.com/kophaihoang/foo_ui_webview2`.
  - `automix/src/automix.cpp` is the DSP.
  - `automix/src/mix.h` holds the pure helpers.
  - `automix/tests/test_mix.cpp` holds the unit tests.
- CI: `.github/workflows/automix-build.yml` runs on a Windows runner with MSBuild v143.
  - A good build is force-pushed to branch `automix-dll`.
  - A failed build log goes to branch `automix-log`.
  - There is **no local C++ compiler** and **no `gh` CLI**. Poll the public Actions API with `curl`.
- Installed at `C:\Users\LVH\AppData\Roaming\foobar2000-v2\user-components-x64\foo_dsp_automix\foo_dsp_automix.dll`. foobar must be closed to replace it.
- **Current version 0.6.1, confirmed by the user.** It is a classic crossfade.
  - It holds the last N s of the outgoing track (default 6 s), reported through `get_latency`.
  - It ends the track 15 dB below its loudest quarter second (`loudEnd`, `kEndingDropDb`).
  - On auto-advance it mixes that tail into the next track. On a manual change it does no crossfade.
  - It has no read-ahead and no stutter.
  - **0.6.1 is the fallback.** Whatever the redo does must fall back to exactly this behavior when it is unsure.

## 2. What failed before (do not repeat)

- **0.2–0.4: beat matching.** These versions used render-ahead, qm-dsp beats, SoundTouch tempo ramps and Deezer BPM by ISRC.
  - Playback **stuttered after transitions**, because audio was rendered and dropped inside the audio path.
  - The theme's tempo-based pick of the next song **hijacked the user's next song**. That was reverted, and the shuffle order must stay as it is.
  - The code is still in history: `2b4fdf6` (stage 2, beat-matched), `5e1fdec` (0.4.0) and `0e6ec45` (beat self-check). The qm-dsp integration may be reusable for **offline** analysis.
- **0.5.0: in-place fades only.** No stutter, but it sounded like no transition.
- **0.6.0: crossfade over the song's own fade-out tail.** Inaudible. Fixed in 0.6.1.
- **Process failure:** every iteration waited on the user's ears. We had no objective measurement.

## 3. The new approach: beat-aligned crossfade, no time-stretch

1. **Analyse ahead, off the audio thread.**
   - Read the outgoing track's ending and the next track's beginning in a background worker at low priority. Cache the results per track.
   - Find beats, downbeats where they can be trusted, the silent or fading outro, and where the intro really starts.
   - The audio thread only reads finished results.
2. **Align, don't stretch.**
   - Start the fade on a strong beat of the outgoing track.
   - Start the next track at its first strong beat, skipping silence and lead-in.
   - Never change tempo. Nothing is rendered ahead or dropped.
3. **Bass swap.** While the tracks overlap, cut the outgoing low end as the incoming low end comes in. Use cheap biquads so two basslines never stack.
4. **Fallback.** If the analysis is missing, late or unsure (rubato, acoustic, no drums), use exactly the 0.6.1 crossfade. Fall back to beat-level alignment when downbeats are unsure.
5. **The next track** is known in advance, because the theme's shuffle plan always keeps the next planned song in the foobar queue.

## 4. Team

| Who | Job | Access |
|---|---|---|
| **Lead (main session)** | Fixes the design and the acceptance criteria, hands out work, gates every step, deploys, talks to the user | Full |
| **Agent 1: prototype** | Python prototype and measuring harness: beat/downbeat/intro/outro detection, renders transitions of the user's song pairs to WAV, measures them | Its own scratch folder |
| **Agent 2: C++ port** | Ports the agreed algorithm into `automix/`, adds tests that compare against numbers from the Python version, builds in CI | Its own worktree/branch (`isolation: "worktree"`) |
| **Agent 3: reviewer** | Reviews the audio-thread path for allocation, locks, waits and unbounded work; checks C++ against the Python spec | Read-only (`code-reviewer`) |
| **Agent 4: cross-checker** | Re-measures with **its own** code (never Agent 1's); checks C++ with its own test vectors; **plants fake bugs** in a copy to test whether Agent 3 catches them; verifies each Agent 3 finding is real; audits the lead's gate decisions | Sees **artifacts only**, not the other agents' reasoning |

Run the agents **in sequence**, not in parallel, because each step needs the previous result. Expect 7–9 agent runs in total.

## 5. Rules the user set for the team

1. **Any agent may flag any other agent's error,** including the lead's and Agent 4's.
2. **A contradiction is an error.** That covers:
   - a contradiction within one report;
   - a contradiction between two agents (for example Agent 1 measures 12 ms and Agent 4 measures 35 ms on the same file);
   - a claim that conflicts with the criteria in §6.
3. **Every claim needs rerunnable evidence:** the command plus its output. A bare assertion does not count.
4. **Error ledger:** `automix/redo/ledger.md`. Each entry records who, which statement, what it contradicts or why it is wrong, the evidence, and its status (open / fixed / rebutted with evidence).
5. **Resolution:**
   - The agent at fault fixes the error or rebuts it with evidence.
   - The lead reruns both sides' evidence.
   - If they still disagree, report **both sides to the user**. Never pick one silently.
6. **No step passes while the ledger has open entries.**

## 6. Acceptance criteria (gates, fixed upfront)

- Beat alignment error at the seam **< 20 ms**, on tracks where beats were detected.
- No gap or silence **> 50 ms** inside a transition.
- Loudness dip during the overlap **< 3 dB**, measured as short-term loudness against both sides.
- No clicks: no sample-to-sample jump above the track's normal range at the seams.
- On the audio thread: **no allocation, no lock, no wait, no file or network I/O**, and bounded work per chunk.
- Manual track changes behave as in 0.6.1, with no crossfade.
- Unsure analysis falls back to 0.6.1, and the fallback is verified in a test.
- The user listens to the WAV renders **before** the C++ port starts, and approves them.

## 7. Phases and estimate (about 6–9 h of work over 1–2 days)

| Phase | Time | Gate |
|---|---|---|
| 0. Set up: criteria, `automix/redo/ledger.md`, read the user's song pairs | ~15 min | none |
| 1. Agent 1 prototype, several measure-and-fix rounds | 1–2 h | numbers meet §6 |
| Agent 4 re-measures and looks for contradictions | 20–40 min | ledger clear |
| User listens to the WAVs | user | user approves |
| 2. Agent 2 C++ port (CI build 8–10 min, 3–6 builds) | 2–4 h | CI green, tests match Python |
| Agent 3 review + Agent 4 planted bugs and cross-check | 30–60 min (+30–60 min of fixes) | ledger clear |
| 3. User installs and listens in foobar | user | user approves |

## 8. Before starting

- **Ask the user for 2–3 pairs of songs** they often hear back to back (local file paths). **Never upload their songs** to GitHub or CI. They stay local, so the Python harness runs locally.
- Local tools: Python 3.14 with numpy 2.5 and ffmpeg 9.0 (WinGet). scipy, soundfile and librosa are **not installed**; ask before `pip install`. Decoding through ffmpeg into numpy avoids extra packages.
- Use downbeats only where they are trustworthy (see `0e6ec45`: downbeat choice needed harmonic change). Ballads and Vietnamese pop with free tempo will often fall back.

## 9. Standing rules for working with this user

- For big or unclear tasks, say how you understood them and ask first. Small, clear ones: just do them.
- You cannot hear their machine. After each change, ask them to listen or send a screenshot.
- Push only to `kophaihoang` repos, never to NereaFantasia. Write clear commit messages.
- Don't delete the user's files unless asked.
