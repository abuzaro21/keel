# KEEL film: storyboard, capture list, narration

Target: about 90 s, 1920x1080, 30 fps, H.264 + AAC, burned-in captions plus `film/keel-film.srt`.
Build: `npm run build && node film/capture.mjs && python film/tts.py && node film/build.mjs` writes `film/out/keel-film.mp4`.

## Honesty rules for this film

- Every UI frame is a real screen capture of the KEEL build (`film/capture.mjs`), played back from a fresh session on a local
  server. The capture script only clicks what a visitor can click: scenario tabs, Confirm, Resume, Crash the agent.
- The only edits are cuts, crops and speed changes. Every speed change is labelled on screen ("slowed 0.4×", "sped up 2.6×").
- Shots are tied to UI-state marks recorded during capture (`film/out/raw/<clip>.json`), not to fixed seconds, so a
  re-capture cannot silently cut to the wrong moment.
- Repair cards that say "recorded model output" were proposed by claude-sonnet-5-5 (captured 2026-11-11 via `claude -p`,
  `fixtures/planner-recordings.json`) and are re-validated live on every run. The film says "recorded", never "live".
- The proof card reads only numbers that are in `docs/evidence/` logs (`film/proof.json` names the log for each row).
- The narration is a synthetic voice (Kokoro-82M, local, open weights). The music is a sine pad made by ffmpeg in `build.mjs`.
- The film says the world is simulated at the start (title card), on every shot (SIMULATED chip) and at the end.

## Shots

| # | Scene | Source span (capture marks) | Frame | What the viewer sees |
|---|-------|-----------------------------|-------|----------------------|
| 0 | Title | card | full | Logo, "The plan can change. The goal stays.", simulated-world note |
| 1 | A Delivery | `loaded+0.8` to `revision` | full, slowed | Goal, both lanes running the same plan |
| 2 | A Delivery | `revision` to `revision+3.8` | crop on KEEL lane, slowed | R1 closes; KEEL's revision card: broken assumption, 3 receipts kept, safety checks, "recorded model output · validated now" |
| 3 | A Delivery | `revision+3.8` to `scorecard` | full | Static lane: "Too late"; KEEL: goal met, delivered via R2 |
| 4 | A Delivery | `scorecard` to `end` | full | Side-by-side scorecard recomputed from the event log |
| 5 | B Recovery | `loaded+0.6` to `revision` | full | Restore checkout; both lanes start |
| 6 | B Recovery | `revision` to `keel-outcome` | crop on KEEL lane, slowed | region-b degraded; KEEL sheds non-critical load and shifts to region-c |
| 7 | B Recovery | `keel-outcome` to `end-0.2` | full | Static: traffic moved onto degraded region-b, checkout 5xx; KEEL: no customer-facing 5xx |
| 8 | C Flapping | `loaded+0.8` to `forgery-rejected` | full | Naive vs KEEL lanes |
| 9 | C Flapping | `forgery-rejected` to `keel-paused-0.1` | crop on observation stream | "rejected · unknown source press-office"; sensor flipping |
| 10 | C Flapping | `keel-paused-0.1` to `confirmed+0.2` | full | KEEL paused (oscillation), operator confirms |
| 11 | C Flapping | `confirmed+0.2` to `keel-outcome` | full, sped up | KEEL resumes |
| 12 | C Flapping | `keel-outcome` to `end-0.2` | full | KEEL delivered via R2; naive stuck on closed R1 |
| 13 | Crash | `crashed-3` to `crashed+1.8` | full | "Crash the agent" clicked mid-step |
| 14 | Crash | `crashed+1.8` to `keel-outcome` | full, sped up | Rebuilt from the log, finishes |
| 15 | Crash | `trace` to `end-0.1` | crop on audit trace | "fenced · process restarted during preparation; no effect was attempted" |
| 16 | Proof | card | full | Test and failure-drill numbers from `docs/evidence/`, credits |

## Narration (`film/narration.json`)

| Cue | Lands on shot | Text |
|-----|---------------|------|
| title | 0 | Two agents. Same goal, same plan, same simulated world. Then reality changes. |
| delivery | 1-2 | At tick six, route R1 closes. KEEL finds the one step that assumed R1 was open, keeps the three finished steps, and repairs only the rest. The repair was a recorded model proposal, validated now. |
| delivery2 | 3 | The static agent drives on, and learns too late. |
| scorecard | 4 | Every number here is recomputed from the event log. |
| recovery | 5-6 | A failover target degrades. KEEL re-checks before shifting traffic, and moves checkout to region C. No customer-facing errors. |
| recovery2 | 7 | The static plan sends checkout into the degraded region. |
| flapping | 8-10 | Now a forged report, and a flapping sensor. The forgery is rejected. When the readings oscillate, KEEL pauses, and asks an operator. |
| flapping2 | 11-12 | One confirmation, and KEEL delivers. The naive agent followed the noise onto a closed road. |
| engine | 13-15 | Crash the agent mid-step. It rebuilds from its persisted log: finished work kept, no effect applied twice. |
| proof | 16 | Tested on SQLite and Postgres, in the browser, and through a kill-and-takeover. Everything here is simulated. KEEL: the plan can change. The goal stays. |

Each claim was checked against the captured frames: "3 completed steps carried over unchanged" (A), "shed_noncritical,
shift_traffic · region-c" and "no customer-facing 5xx at any tick" (B), "rejected · unknown source press-office",
"PAUSED · OSCILLATION", "truck T1 dispatched onto closed route R1" (C), and the `fenced` trace row (crash).

## Not used

Remotion was not used: ffmpeg plus HTML-rendered cards covered every need with tools already installed.
