# KEEL — execution state (handoff file)

Update this file at every milestone. Another agent must be able to resume from it alone.

## Where things are
- Workspace: `E:\doo\keel`. Remote: `https://github.com/abuzaro21/keel` (public since 2026-11-11, owner decision). Remote `main` = `e35922c` (deployed); tag `v1.0.0` = `7541de0`.
- Release branch `wip/async-persistence` merged into `main` by PR #1 (merge commit `7541de0`). First commit on it, `c731622`, is the
  untouched recovered WIP exactly as found on disk (19 modified files + `test/helpers.ts`).
- Local Postgres for tests: Docker container `keel-pg-test` (postgres:16-alpine, `127.0.0.1:55432`, db `keel`,
  throwaway password `keeltest`, no real data). The older container `keel-pg` (port 5433) belongs to earlier
  work; it was not modified.

## Recovery report (2026-11-11)
- Local HEAD == origin/main (`437ffa9`); no other branches, worktrees or stashes.
- Uncommitted: the async Store refactor (SQLite + PostgreSQL adapters behind one `Store` contract), durable
  simulator effects/injections/world clock, export/import, `maintainsUntil` commitments, contract-hash in the
  recorded-model fingerprint, server/SSE fixes. ~1,000 lines. It was **complete enough to compile**:
  typecheck clean; 47/49 Node tests pass on SQLite **and** on PostgreSQL; 10/10 Playwright pass.
- The 2 failures are the recorded-model tests: the fingerprint now covers the action contracts, which changed,
  so the October recordings no longer match (correct behaviour — they must be re-captured, not edited).

## Gates (2026-11-11, branch `wip/async-persistence`, release tag `v1.0.0`)
| Gate | State | Evidence |
|---|---|---|
| A source integrity | PASS | checkpoint `c731622`; only `E:\doo\keel` touched; no force push, no history rewrite |
| B engine invariants | PASS | `npm test` (replay, crash-at-every-point, ack loss, SIGKILL) |
| C database | PASS | 76/76 on SQLite and on Postgres 16; store contract (g7), fencing (g8/g9/g10), capacity (g11), sequencing, session lock and judged-tick watermark (g12), export/import |
| D scenarios | PASS | g3g4, R1-6 regression (a "stuck" report never counts as success) |
| E browser | PASS | `docs/evidence/test-e2e.txt` 10/10 desktop + phone |
| F security | PASS (local) | Codex reviews #1 (14), #2 (3), #3 (4: import fencing, eviction during start-up, evicted view 500, SSE test timing), release verification (3: session-capacity bypass under bursts, caches kept after eviction, render.yaml Postgres version; then 3 more: injection cache lost on crash, reservation leak on id failure, stale injection sequence during crash recovery; then 3: feed/injection sequence clash, injection racing the clock, unbounded quota maps; then 1: an injection rewriting a settled tick; then 2: verdicts judged through an unprocessed tick, paused sessions not restarting after reload) all fixed with regressions; final round SHIP WITH NOTES (hosted-check now asserts its results); CSP/nosniff; XFF policy tested; audit 0 vulns |
| G deployment | DONE | https://keel-1myw.onrender.com: free web service + free Postgres 16 in Frankfurt via Blueprint `exs-dbpuomu7bikc73bg4ugg`; health 200 (`store: postgres`); smoke test, crash recovery and reload after two redeploys in `docs/evidence/hosted-render.txt`; database expires 2026-12-11 |
| H film | DONE (local) | `film/out/keel-film-final.mp4` 89.93 s, logo reveal ending; ASR + loudness + frame checks in `film/storyboard.md`; no human listening review yet |
| I release | DONE | PR #1 merged (`7541de0`), tag `v1.0.0` pushed; CI on main green (run 42958050364: 76/76 SQLite, 76/76 PostgreSQL 16, 10/10 e2e, audit 0, docker); PR #2 adds the Render region (`9cd55c5`), PR #3 docs, PR #4 security headers on JSON responses (`e35922c`, found by a clean-clone check) |

## Done
- Codex review #1 and #2 findings fixed (`aabcfcd`); final review findings fixed with `test/g10-codex-final.test.ts` and a deterministic SSE test C.
- Recorded model proposals re-captured 2026-11-11 (`claude -p`, served claude-sonnet-5-5).
- Film: `film/capture.mjs` (real captures), `film/tts.py` (Kokoro-82M), `film/build.mjs` (ffmpeg + frame-rendered logo reveal),
  `film/storyboard.md`, `film/keel-film.srt`. Output `film/out/keel-film-final.mp4` (git-ignored, ~30 MB).
- Docs: README, ARCHITECTURE, FAILURE-TEST, SECURITY, DEPLOY, SUBMISSION, THESIS.

## Next (owner decisions)
1. Upload the film (`film/out/keel-film-final.mp4`, git-ignored) where the submission form expects it.
2. Submit on build.doo.ooo (confirm the deadline time zone and the required fields on the page; text in `docs/SUBMISSION.md`).
3. Listen to the film once: the narration was checked by ASR, not by ear.
4. Before 2026-12-11: export the free Render database with `scripts/db.ts` or upgrade it, or it is deleted after the grace period.

## Resume commands
```
cd E:\doo\keel
git checkout wip/async-persistence
npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e
docker start keel-pg-test   # or: docker run -d --name keel-pg-test -e POSTGRES_PASSWORD=keeltest -e POSTGRES_DB=keel -p 127.0.0.1:55432:5432 postgres:16-alpine
KEEL_TEST_DATABASE_URL=postgres://postgres:keeltest@127.0.0.1:55432/keel npm test
```
