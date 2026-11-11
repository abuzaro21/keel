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

## Gates
| Gate | State | Evidence |
|---|---|---|
| A source integrity | PASS (local) | checkpoint `c731622`; nothing outside `E:\doo\keel` touched |
| B engine invariants | PASS except recordings | `npm test` (replay, crash-at-every-point, ack loss) |
| C database | in progress | `test/g7-store.test.ts` 5/5 on SQLite + Postgres; SIGKILL tests pass on both |
| D scenarios | PASS | g3g4 + e2e |
| E browser | PASS | `npm run test:e2e` 10/10 desktop + Pixel 7 |
| F security | in progress | Codex review #1 running; `npm audit --omit=dev` 0 vulns |
| G deployment | NOT STARTED — needs owner approval | Docker image builds and is healthy locally |
| H release | NOT STARTED | |

## Done this session
- Recorder script ported to the async API (`scripts/record-planner.ts`).
- Dockerfile installs the runtime `pg` dependency (previous image would have crashed with DATABASE_URL set).
- UI: a paused KEEL lane no longer says "stopped"; neutral styling when paused without harm.
- New Store contract tests (`test/g7-store.test.ts`); CI workflow `.github/workflows/ci.yml`.

## Next
1. Triage and fix Codex review #1 findings (with regression tests).
2. Re-capture recorded model proposals AFTER engine changes settle (`node scripts/record-planner.ts`, uses `claude -p`).
3. UI first-15-seconds explainer; README/docs/AI disclosure/submission sheet.
4. Film: Playwright capture + FFmpeg composition, captions, narration.
5. Owner approvals: push branch, Render deploy (web + Postgres free), public visibility, video upload, submission.

## Resume commands
```
cd E:\doo\keel
git checkout wip/async-persistence
npm ci && npm run typecheck && npm test && npm run build && npm run test:e2e
docker start keel-pg-test   # or: docker run -d --name keel-pg-test -e POSTGRES_PASSWORD=keeltest -e POSTGRES_DB=keel -p 127.0.0.1:55432:5432 postgres:16-alpine
KEEL_TEST_DATABASE_URL=postgres://postgres:keeltest@127.0.0.1:55432/keel npm test
```
