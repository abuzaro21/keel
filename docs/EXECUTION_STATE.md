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

## Gates (2026-11-11, branch `wip/async-persistence`, local only)
| Gate | State | Evidence |
|---|---|---|
| A source integrity | PASS | checkpoint `c731622`; only `E:\doo\keel` touched; no force push, no history rewrite |
| B engine invariants | PASS | `npm test` (replay, crash-at-every-point, ack loss, SIGKILL) |
| C database | PASS | 63/63 on SQLite and on Postgres 16; store contract (g7), fencing (g8/g9), export/import SQLite→PG verified |
| D scenarios | PASS | g3g4, R1-6 regression (a "stuck" report never counts as success) |
| E browser | PASS | `docs/evidence/test-e2e.txt` 10/10 desktop + phone |
| F security | PASS (local) | Codex reviews #1 (14 findings) and #2 (3 open items) all fixed with regressions; CSP/nosniff; XFF policy tested; audit 0 vulns; `docs/SECURITY.md` |
| G deployment | READY, NOT DONE: owner approval | Docker image healthy; `scripts/hosted-check.sh` on Postgres (`docs/evidence/hosted-check.txt`); `render.yaml` + `docs/DEPLOY.md` |
| H release | local tag only | film built; docs complete; push/visibility/upload/submission need the owner |

## Done
- Codex review #1 and #2 findings fixed (`aabcfcd`): owner-epoch fencing incl. prune/restore, eviction quiesce, SSE gap close.
- Recorded model proposals re-captured 2026-11-11 (`claude -p`, served claude-sonnet-5-5).
- Film: `film/capture.mjs` (real captures), `film/tts.py` (Kokoro-82M), `film/build.mjs` (ffmpeg), `film/storyboard.md`,
  `film/keel-film.srt`. Output `film/out/keel-film.mp4` (git-ignored; rebuild with the commands in the storyboard).
- Docs: README, ARCHITECTURE (persistence section), FAILURE-TEST (process-level table), SECURITY, DEPLOY, SUBMISSION.
- Security headers on static responses (tested in g5).

## Next (owner decisions; nothing below has been done)
1. Push `wip/async-persistence` to the private repo and merge to `main` (CI then runs on GitHub).
2. Create the Render free web service + free Postgres from `render.yaml` in the "keel" workspace.
3. Make the repository public; upload the film; submit on build.doo.ooo (confirm deadline time zone and deliverables there).
4. Listen to the film once: the narration is synthetic and was checked by duration and captions, not by ear.

## Resume commands
```
cd E:\doo\keel
git checkout wip/async-persistence
npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e
docker start keel-pg-test   # or: docker run -d --name keel-pg-test -e POSTGRES_PASSWORD=keeltest -e POSTGRES_DB=keel -p 127.0.0.1:55432:5432 postgres:16-alpine
KEEL_TEST_DATABASE_URL=postgres://postgres:keeltest@127.0.0.1:55432/keel npm test
```
