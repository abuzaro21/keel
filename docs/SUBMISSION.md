# Submission sheet: KEEL for "The Adaptive Agent"

Status: **not submitted.** Submission and the video upload are owner decisions. The repository is public (owner decision, 2026-11-11) and the hosted demo is live.

| Field | Value |
|---|---|
| Challenge | DOO Builders League, The Adaptive Agent: https://build.doo.ooo/challenges/adaptive-agent |
| Deadline | the challenge page (rendered 2026-11-11 04:36 UTC) shows "4d 19h left", i.e. it closes around **2026-11-15 23:30 UTC**; the page states no exact time or time zone, so submit well before. Submitting needs a Builders League account ("Sign in to submit") |
| Project | KEEL: *The plan can change. The goal stays.* |
| One line | An agent that notices which of its assumptions a change broke, repairs only that part of its plan, keeps the work already done, and stops when the world is too unstable to trust. |
| Repository | https://github.com/abuzaro21/keel (public), release tag `v1.0.0` (`7541de0`) |
| Hosted demo | https://keel-1myw.onrender.com (Render free web service + free Postgres 16, Frankfurt; deployed `main` `e35922c` = `v1.0.0` + region line in `render.yaml` + security headers on every JSON response). Free instance sleeps after 15 min idle (~1 min cold start); the free database expires 2026-12-11. Evidence: [evidence/hosted-render.txt](evidence/hosted-render.txt) |
| Video | `film/out/keel-film-final.mp4` (89.9 s, 1920x1080, 30 fps, H.264/AAC, burned-in captions, closing logo reveal) + `film/keel-film.srt`; built by `film/build.mjs`; git-ignored; not uploaded. Narration checked by ASR, not yet by a human listener ([storyboard](../film/storyboard.md#automated-audio-and-picture-checks-2026-11-11)) |
| Thesis | [THESIS.md](THESIS.md) (266 words) |
| Failure test | [FAILURE-TEST.md](FAILURE-TEST.md) |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| AI disclosure | README, "AI usage — honest disclosure" |

## What a judge should try (3 minutes)

1. **Delivery** tab: wait for t6. KEEL's card says "I changed my mind because route:R1.status became closed…", keeps 3
   finished steps and inserts a permit for R2. The static lane ends "Too late". Scroll to the scorecard.
2. **Adaptation failure** tab: the forged `press-office` report is rejected; KEEL pauses on the flapping sensor. Click
   *Confirm* on the paused card, then *Resume*. The naive lane ends on the closed road.
3. Any tab: **Crash the agent**. It rebuilds from the log; the audit trace shows `fenced … no effect was attempted`.
4. **Change reality** buttons: inject your own (simulated, signed) observation, or a forgery.

## Evidence (runs at the release commit; each log names its commit)

| Check | Result | Log |
|---|---|---|
| Test suite on SQLite | 76 / 76 | [evidence/test-sqlite.txt](evidence/test-sqlite.txt) |
| Same suite on PostgreSQL 16 | 76 / 76 | [evidence/test-postgres.txt](evidence/test-postgres.txt) |
| Browser tests, desktop + phone | 10 / 10 | [evidence/test-e2e.txt](evidence/test-e2e.txt) |
| SIGKILL + resume + takeover, Docker on Postgres | 0 duplicate effects; old instance 503 | [evidence/hosted-check.txt](evidence/hosted-check.txt) |
| Hosted demo smoke + reload after redeploys | crash recovery, forged event rejected, 0 duplicate effects | [evidence/hosted-render.txt](evidence/hosted-render.txt) |
| `npm audit --omit=dev` | 0 vulnerabilities | local run; CI job |
| Independent review (Codex gpt-6.1-sol) | 9 rounds: 14, 3, 4, 3, 3, 3, 1, 2, 1 findings; all fixed with regression tests; final verdict SHIP WITH NOTES, its note fixed | `test/g8-*` to `test/g12-*` |

## Honesty notes for the form

- Everything external is simulated. Recorded model outputs (claude-sonnet-5-5, captured 2026-11-11) are labelled as recorded and are validated live; there is no live model call in the demo.
- Built with Claude Code (implementation) and OpenAI Codex gpt-6.1-sol (independent reviews), directed by the owner.
- The film's narration is a synthetic voice; its frames are real captures with labelled speed changes.

## Form text (ready to paste; the page's submission checklist)

- **Public repo URL (clean clone runs):** https://github.com/abuzaro21/keel (release `v1.0.0`; a fresh clone of the tag runs `npm ci`, `npm run build`, `npm test` 76/76)
- **Live demo URL (required):** https://keel-1myw.onrender.com (free instance: the first visit after 15 idle minutes takes about a minute)
- **90-second video (optional, recommended):** `film/out/keel-film-final.mp4`, 89.9 s, after the owner uploads it (Loom or another host)
- **Notes: AI tools used.** Claude Code (Claude, Anthropic) designed and implemented KEEL; OpenAI Codex `gpt-6.1-sol` reviewed it independently over nine rounds, each finding fixed with a regression test. The demo's repair proposals are recorded output of `claude-sonnet-5-5` (captured 2026-11-11), labelled as recorded and re-validated live by a deterministic checker; no live model call runs in the demo. Narration: Kokoro-82M synthetic voice.
- **Notes: key decisions.** Re-plan only when an observation breaks an assumption a remaining step depends on, never on a timer. Repair the smallest broken part and keep finished work (receipts). Every effect goes through an idempotent, fenced boundary: an append-only event log on PostgreSQL, ownership epochs so a replaced instance cannot write, crash recovery by replay. Sources are signed and ranked; a forged or stale report is refused. When the world is too unstable to trust, KEEL pauses for an operator instead of guessing. A non-adaptive baseline runs side by side on the same simulated world.
- **Notes: out of scope.** Real external systems (everything outside the agent is simulated); multi-writer clusters (one active process per database); live model calls in the public demo; long-term hosting (the free database expires 2026-12-11).
