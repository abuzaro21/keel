// Regressions for the final independent review (Codex gpt-6.1-sol): import fencing, eviction during start-up,
// and a view read that loses its caches mid-flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Hub, Session, SessionClosedError } from '../src/runner.ts';
import { evictOldest, runView } from '../src/server.ts';
import { openHub } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';

test('import claims the target before checking it, so a later takeover fences the restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-imp-'));
  try {
    const src = join(dir, 'src.db'), dst = join(dir, 'dst.db'), dump = join(dir, 'dump.json');
    const hub = await Hub.open(src);
    await (await Session.create(hub, 'imp', 'delivery', ['keel'])).runToEnd();
    await hub.close();
    const run = (...a: string[]) => execFileSync(process.execPath, ['scripts/db.ts', ...a], { encoding: 'utf8' });
    run('export', src, dump);
    assert.match(run('import', dst, dump), /imported and verified 1 runs/);
    const db = new DatabaseSync(dst);
    assert.equal((db.prepare('SELECT holder FROM owner WHERE id = 1').get() as { holder: string }).holder, 'db-import');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a session that is still starting is never chosen for eviction', async () => {
  const hub = await openHub();
  try {
    const setClock = hub.store.setClock.bind(hub.store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    hub.store.setClock = async (id, tick) => { if (id === 'slow') await gate; return setClock(id, tick); };
    const creating = Session.create(hub, 'slow', 'delivery', ['keel']);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(hub.sessions.has('slow') && !hub.sessions.get('slow')!.ready, 'published but not ready');
    assert.equal(evictOldest(hub, new Map()), null, 'nothing evictable while it starts');
    release();
    const s = await creating;
    assert.ok(s.ready);
    const ev = evictOldest(hub, new Map());
    assert.equal(ev?.id, 'slow');
    await ev!.done;
    const again = await Session.resume(hub, 'slow');
    assert.ok(hub.state(again.runIds[0]), 'the run has its start event and reloads');
    again.close();
  } finally { await hub.close(); }
});

test('a view whose caches are dropped while it reads the store answers SessionClosedError, not a crash', async () => {
  const hub = await openHub();
  try {
    const s = await Session.create(hub, 'v', 'delivery', ['keel']);
    await s.runToEnd();
    const runId = s.runIds[0];
    const rows = hub.store.rows.bind(hub.store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    hub.store.rows = async (...a: Parameters<typeof rows>) => { await gate; return rows(...a); };
    const view = runView(hub, runId);
    s.close(); hub.sessions.delete(s.id); hub.unload(s.runIds); // what eviction does
    release();
    await assert.rejects(view, SessionClosedError);
  } finally { await hub.close(); }
});
