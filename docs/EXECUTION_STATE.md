# KEEL — execution state (handoff file)

Update this file at every milestone. Another agent must be able to resume from it alone.

## Where things are
- Workspace: `E:\doo\keel`. Remote: `https://github.com/abuzaro21/keel` (private). Remote `main` = `437ffa9`.
- Working branch: `wip/async-persistence` (local only until pushed). First commit on it, `c731622`, is the
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
| C database | PASS | 74/74 on SQLite and on Postgres 16; store contract (g7), fencing (g8/g9/g10), capacity (g11), sequencing and session lock (g12), export/import |
| D scenarios | PASS | g3g4, R1-6 regression (a "stuck" report never counts as success) |
| E browser | PASS | `docs/evidence/test-e2e.txt` 10/10 desktop + phone |
| F security | PASS (local) | Codex reviews #1 (14), #2 (3), #3 (4: import fencing, eviction during start-up, evicted view 500, SSE test timing), release verification (3: session-capacity bypass under bursts, caches kept after eviction, render.yaml Postgres version; then 3 more: injection cache lost on crash, reservation leak on id failure, stale injection sequence during crash recovery) all fixed with regressions; CSP/nosniff; XFF policy tested; audit 0 vulns |
| G deployment | READY, NOT DONE: owner approval | Render workspace "KEEL" exists and is empty (API, 2026-11-11); Docker hosted-check on Postgres; `render.yaml` + `docs/DEPLOY.md` |
| H film | DONE (local) | `film/out/keel-film-final.mp4` 89.93 s, logo reveal ending; ASR + loudness + frame checks in `film/storyboard.md`; no human listening review yet |
| I release | BLOCKED on push | `git push` was refused twice by the session's permission classifier ("Out-of-Place Publication") although the owner's directive authorizes pushing to the private repo; the owner runs the push (commands below) |

## Done
- Codex review #1 and #2 findings fixed (`aabcfcd`); final review findings fixed with `test/g10-codex-final.test.ts` and a deterministic SSE test C.
- Recorded model proposals re-captured 2026-11-11 (`claude -p`, served claude-sonnet-5-5).
- Film: `film/capture.mjs` (real captures), `film/tts.py` (Kokoro-82M), `film/build.mjs` (ffmpeg + frame-rendered logo reveal),
  `film/storyboard.md`, `film/keel-film.srt`. Output `film/out/keel-film-final.mp4` (git-ignored, ~30 MB).
- Docs: README, ARCHITECTURE, FAILURE-TEST, SECURITY, DEPLOY, SUBMISSION, THESIS.

## Next (owner decisions; nothing below has been done)
1. Push and open CI: `git push -u origin wip/async-persistence && git push origin v1.0.0`; when CI is green, merge to `main`
   (`gh pr create --base main --head wip/async-persistence`, then merge without squashing history).
2. Approve creating the Render free web service + free Postgres from `render.yaml` in workspace "KEEL" (expires 30 days after creation).
3. Make the repository public; upload the film; submit on build.doo.ooo (confirm deadline time zone and deliverables there).
4. Listen to the film once: the narration was checked by ASR, not by ear.

## Resume commands
```
cd E:\doo\keel
git checkout wip/async-persistence
npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e
docker start keel-pg-test   # or: docker run -d --name keel-pg-test -e POSTGRES_PASSWORD=keeltest -e POSTGRES_DB=keel -p 127.0.0.1:55432:5432 postgres:16-alpine
KEEL_TEST_DATABASE_URL=postgres://postgres:keeltest@127.0.0.1:55432/keel npm test
```
