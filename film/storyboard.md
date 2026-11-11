# KEEL film: storyboard, capture list, narration

Output: `film/out/keel-film-final.mp4`, 89.93 s (2,698 frames), 1920x1080, 30 fps, H.264 High + AAC-LC 48 kHz stereo,
burned-in captions plus `film/keel-film.srt`. The MP4 is git-ignored (about 30 MB); rebuild it from these sources.
Build: `npm run build && node film/capture.mjs && python film/tts.py && node film/build.mjs`.
`build.mjs` refuses to produce a film longer than 90 s or with two narration cues that overlap.

## Honesty rules for this film

- Every UI frame is a real screen capture of the KEEL build (`film/capture.mjs`), played back from a fresh session on a local
  server. The capture script only clicks what a visitor can click: scenario tabs, Confirm, Resume, Crash the agent.
- The only edits are cuts, crops and speed changes. Every speed change is labelled on screen ("slowed 0.4×", "sped up 1.3×").
- Shots are tied to UI-state marks recorded during capture (`film/out/raw/<clip>.json`), not to fixed seconds, so a
  re-capture cannot silently cut to the wrong moment.
- Repair cards that say "recorded model output" were proposed by claude-sonnet-5-5 (captured 2026-11-11 via `claude -p`,
  `fixtures/planner-recordings.json`) and are re-validated live on every run. The film says "recorded", never "live inference".
- The proof card reads only numbers that are in `docs/evidence/` logs (`film/proof.json` names the log for each row).
- The narration is a synthetic voice (Kokoro-82M, local, open weights). The music is a sine pad made by ffmpeg in `build.mjs`.
- The film says the world is simulated at the start (title card), on every shot (SIMULATED chip) and in the closing narration.

## Shots

| # | Scene | Source span (capture marks) | Frame | What the viewer sees |
|---|-------|-----------------------------|-------|----------------------|
| 0 | Title | card, 5.9 s | full | Logo, "The plan can change. The goal stays.", simulated-world note |
| 1 | A Delivery | `loaded+0.8` to `revision` | full, slowed 0.9× | Goal, both lanes running the same plan |
| 2 | A Delivery | `revision` to `revision+3.8` | crop on KEEL lane, slowed 0.4× | R1 closes; KEEL's revision card: broken assumption, 3 receipts kept, safety checks, "recorded model output · validated now" |
| 3 | A Delivery | `revision+3.8` to `scorecard` | full | Static lane: "Too late"; KEEL: goal met, delivered via R2 |
| 4 | A Delivery | `scorecard` to `end` | full | Side-by-side scorecard recomputed from the event log |
| 5 | B Recovery | `loaded+0.6` to `revision` | full | Restore checkout; both lanes start |
| 6 | B Recovery | `revision` to `revision+3.3` | crop on KEEL lane, slowed 0.6× | region-b degraded; KEEL sheds non-critical load and shifts to region-c |
| 7 | B Recovery | `revision+3.3` to `keel-outcome+0.2` | full, slowed | Static lane's outcome card: traffic moved onto degraded region-b |
| 8 | B Recovery | `keel-outcome+0.2` to `end-1.0` | full | KEEL: no customer-facing 5xx |
| 9 | C Flapping | `loaded+1.5` to `forgery-rejected` | full | Naive vs KEEL lanes |
| 10 | C Flapping | `forgery-rejected` to `keel-paused-0.1` | crop on observation stream | "rejected · unknown source press-office"; sensor flipping |
| 11 | C Flapping | `keel-paused-0.1` to `confirmed+0.2` | full, sped up 1.3× | KEEL paused (oscillation), operator confirms |
| 12 | C Flapping | `confirmed+0.2` to `keel-outcome` | full, sped up | KEEL resumes |
| 13 | C Flapping | `keel-outcome` to `end-0.6` | full | KEEL delivered via R2; naive stuck on closed R1 |
| 14 | Crash | `crashed-2.2` to `crashed+1.8` | crop | "Crash the agent" clicked mid-step |
| 15 | Crash | `crashed+1.8` to `keel-outcome` | full, sped up | Rebuilt from the log, finishes |
| 16 | Crash | `trace` to `end-0.1` | crop on audit trace | "fenced · process restarted during preparation; no effect was attempted" |
| 17 | Proof | card, 7.9 s | full | Test and failure-drill numbers from `docs/evidence/`, footage/voice/music credits |
| 18 | Logo reveal | 7.0 s, frame-rendered | full | See below |

## Closing logo reveal (shot 18)

The artwork is the repository logo (`ui/public/keel.svg`: dashed original course, repaired course with arrow, waterline,
keel) in the UI's own dark-theme colours (`#0a141d`, teal `#3ec2bf`, ink `#e5edf2`), with the IBM Plex Sans wordmark.
`build.mjs` renders it as an HTML/SVG page with a pure `render(t)` function, one screenshot per frame (210 frames), so
every frame is reproducible. No new artwork, no 3D, no particles.

| t (s) | Event |
|---|---|
| 0.0–0.8 | fade up from near-black; soft teal ambient light rises behind the mark (radial gradient, slow 6 % scale drift) |
| 0.4–1.4 | waterline draws left to right (stroke-dashoffset) |
| 1.0–1.9 | keel lowers from the waterline (clip reveal) |
| 1.3–2.0 | original course fades in, dashed, at 35 % |
| 1.7–2.95 | repaired course draws, then its arrowhead |
| 2.8–3.8 | wordmark eases in, letter-spacing settling from 0.30 em to 0.14 em |
| 3.7–4.8 | one restrained highlight passes across the wordmark |
| 4.0–4.9 | tagline "The plan can change. The goal stays." |
| 4.9–7.0 | still composition to the last frame (no fade-out; logo fully visible in the final frame) |

The spoken line "KEEL. The plan can change. The goal stays." starts at 2.9 s. It has no burned-in caption (the
same words are on screen); it is in the SRT.

## Narration (`film/narration.json`)

| Cue | Lands on shot | Text |
|-----|---------------|------|
| title | 0 | Two agents, one goal, one simulated world. Then reality changes. |
| delivery | 1-2 | At tick six, route R1 closes. KEEL finds the step that assumed R1 was open, keeps the three finished steps, and repairs only the rest, with a recorded model proposal it validates live. |
| delivery2 | 3 | The static agent drives on, and learns too late. |
| scorecard | 4 | Every number here is recomputed from the event log. |
| recovery | 5-6 | A failover target degrades. KEEL re-checks before shifting traffic, and moves checkout to region C. |
| recovery2 | 7-8 | The static plan sends checkout into the degraded region, and still reports success. KEEL never served an error. |
| flapping | 9-11 | Now a forged report, and a flapping sensor. The forgery is rejected. When the readings oscillate, KEEL pauses, and asks an operator. |
| flapping2 | 12-13 | One confirmation, and KEEL delivers. The naive agent followed the noise onto a closed road. |
| engine | 14-16 | Crash the agent mid-step. It rebuilds from its persisted log: finished work kept, no effect applied twice. |
| proof | 17 | Tested on SQLite and Postgres, in the browser, and under kill-and-takeover. All of it simulated. |
| logo | 18 | KEEL. The plan can change. The goal stays. |

Each claim was checked against the captured frames: "3 completed steps carried over unchanged" (A), "shed_noncritical,
shift_traffic · region-c" and "no customer-facing 5xx at any tick" (B), "rejected · unknown source press-office",
"PAUSED · OSCILLATION", "truck T1 dispatched onto closed route R1" (C), and the `fenced` trace row (crash).

## Automated audio and picture checks (2026-11-11)

No human listening review has been done; these checks are automatic.

- **Words:** every cue and the final mix were transcribed with faster-whisper `small.en` and diffed against the script.
  Final mix: 177 script words, 178 heard, match 0.958; no word missing or clipped. Remaining differences are homophones
  or spelling ("Kiehl" for KEEL, pronounced the same; "root" for route; "SQ light"; "take over"). Two real issues were
  found and fixed: "region C" was heard as "Regency" (now spoken "region, C") and "Postgres" was masked by the music in
  the full mix, so the music now ducks under the voice (sidechain compression). "Postgres" is heard correctly in the
  final mix segment; the full-length pass still writes "postcards", a long-context ASR error.
- **Loudness:** −16.1 LUFS integrated, true peak −1.3 dBFS, no clipping.
- **Picture:** `blackdetect` (0.2 s, 5 %) finds no black segment; 2,698 video frames = timeline length; frames from the
  title, each scene, the proof card and every second of the logo reveal were extracted and inspected; the last frame
  shows the full logo, wordmark and tagline.
- **Timing:** the build fails if any narration cue runs into the next one; captions are split by sentence and timed by
  character weight within each cue (`film/keel-film.srt`, 29 entries).

## Not used

Remotion was not used: ffmpeg plus HTML-rendered frames covered every need with tools already installed.
