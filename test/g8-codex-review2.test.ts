// Regressions for Codex review #1 of the async-persistence work (2026-11-11). One test per reproduced finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { scenarios } from '../src/scenarios.ts';
import { Hub, Session } from '../src/runner.ts';
import { openStore } from '../src/store.ts';
import { runMetrics } from '../src/metrics.ts';
import { sign } from '../src/world.ts';
import { openHub, events, onPostgres, TEST_DB, freshSchema } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';

test('R1-6: a carrier "stuck" report never ends the transit commitment or counts as success', async () => {
  // R2 closes in SIMULATED truth while the truck is on it, and nobody reports the closure; only the carrier says "stuck".
  const id = 'delivery-unreported-closure';
  scenarios[id] = { ...scenarios.delivery, id, truth: [...scenarios.delivery.truth, { tick: 12, fact: 'route:R2.status', value: 'closed' }] };
  try {
    const hub = await openHub();
    await (await Session.create(hub, 'x', id, ['keel'])).runToEnd();
    const evs = await events(hub, 'x-keel');
    const m = await runMetrics(hub.store, hub.sim, 'x-keel');
    assert.equal(m.goalMet, false, m.truth);
    assert.notEqual(m.beliefGoalMet, true, 'KEEL must not claim success the world contradicts');
    assert.ok(!evs.some((e) => e.t === 'completed' && e.beliefGoalMet), 'no completed{beliefGoalMet:true}');
    assert.ok(evs.some((e) => e.t === 'observation' && e.obs.fact === 'order:1042.delivery' && e.obs.value === 'stuck'), 'the stuck report was delivered');
    await hub.close();
  } finally { delete scenarios[id]; }
});

test('R1-1/2/3: a second process claims the database; the first is fenced and can never apply an effect again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-fence-'));
  const target = onPostgres ? TEST_DB : join(dir, 'k.db');
  const schema = onPostgres ? freshSchema() : undefined;
  const a = await Hub.open(target, {}, schema);
  try {
    const s = await Session.create(a, 'f', 'delivery', ['keel']);
    const b = await Hub.open(target, {}, schema); // the replacement process starts and claims ownership
    try {
      // A was stalled just before its effect boundary; when it resumes, the insert is refused under the owner lock.
      await assert.rejects(a.store.insertEffect({ opId: 'stale', runId: 'f-keel', action: 'dispatch', params: {}, requestHash: 'h', tick: 1, harm: null, applied: {} }), /fenced/);
      await assert.rejects(s.runToEnd(), /fenced/);
      assert.ok(a.fenced, 'A knows it was replaced');
      assert.equal((await b.store.effects('f-keel')).some((e) => e.opId === 'stale'), false);
      // B, the owner, resumes the session from the store and finishes it with no duplicate effect.
      await (await Session.resume(b, 'f')).runToEnd();
      const m = await runMetrics(b.store, b.sim, 'f-keel');
      assert.equal(m.duplicateEffects, 0);
      assert.equal(m.goalMet, true, m.truth);
    } finally { await b.close(); }
  } finally { await a.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('R1-5: an operator confirmation adopts the value current when it is processed, after earlier queued observations', async () => {
  const hub = await openHub();
  const s = await (await Session.create(hub, 'c', 'flapping', ['keel'])).runToEnd();
  const st = hub.state('c-keel')!;
  const fact = st.world.unstable[0];
  assert.ok(fact, 'flapping leaves an unstable fact');
  const flipped = st.world.facts[fact] === 'open' ? 'closed' : 'open';
  const body = { eventId: 'late', source: 'traffic-authority', seq: 5000, fact, value: flipped, observedAt: s.tick };
  // Not awaited: the observation is still in the mailbox when the confirmation is enqueued.
  const obs = hub.submit('c-keel', { t: 'observation', obs: { ...body, sig: sign(body, scenarios.flapping.sources['traffic-authority'].key) }, at: s.tick }, s);
  const conf = hub.submitFrom('c-keel', (x) => (x?.world.unstable.includes(fact) ? { t: 'operator', cmd: 'confirm', fact, value: x.world.facts[fact], at: s.tick } : null), s);
  await obs;
  const accepted = await conf;
  const c = (await events(hub, 'c-keel')).findLast((e) => e.t === 'operator');
  if (accepted) assert.ok(c && c.t === 'operator' && c.value === flipped, 'confirmation used the newest value');
  else assert.ok(!hub.state('c-keel')!.world.unstable.includes(fact), 'declined only because the fact had settled');
  await hub.close();
});

test('R1-8: a database created by the pre-async build is refused with a clear message, never half-migrated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-legacy-'));
  try {
    const f = join(dir, 'old.db');
    const db = new DatabaseSync(f);
    db.exec('CREATE TABLE runs (run_id TEXT PRIMARY KEY, session TEXT, scenario TEXT, policy TEXT, created REAL)');
    db.close();
    await assert.rejects(openStore(f), /legacy KEEL database/);
    await (await openStore(join(dir, 'new.db'))).close(); // a fresh file initialises and stamps its version...
    await (await openStore(join(dir, 'new.db'))).close(); // ...and reopens cleanly
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R1-4/10/11/13: concurrent injections get distinct ordered sequence numbers; concurrent reloads never 500; ids are 128-bit', async () => {
  process.env.KEEL_TICK_MS = '60000'; // module-level TICK_MS is read once; the session clock barely moves during this test
  const { startServer } = await import('../src/server.ts');
  const dir = mkdtempSync(join(tmpdir(), 'keel-srv-'));
  const target = onPostgres ? TEST_DB : join(dir, 'k.db');
  if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema();
  let { server, hub } = await startServer(0, target);
  try {
    let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ scenario: 'delivery' }) })).json();
    assert.match(s.sessionId, /^[0-9a-f]{32}$/);
    const inj = (value: string) => fetch(`${base}/api/sessions/${s.sessionId}/inject`, { method: 'POST', body: JSON.stringify({ fact: 'route:R2.status', value }) });
    const res = await Promise.all(['closed', 'open', 'closed', 'open', 'closed'].map(inj));
    assert.ok(res.every((r) => r.status === 202));
    const list = hub.sim.injections(s.sessionId);
    const seqs = list.map((i) => i.obs.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'persisted order == sequence order');
    assert.equal(new Set(seqs).size, seqs.length, 'no shared sequence numbers');
    const persisted = (await hub.store.injections(s.sessionId)).map((i) => i.obs.eventId);
    assert.deepEqual(persisted, list.map((i) => i.obs.eventId), 'store order == in-memory truth order');
    for (const r of s.runIds) assert.equal(hub.state(r)!.world.facts['route:R2.status'], list.at(-1)!.value, `${r} believes what simulated truth says`);
    // restart on the same database; simultaneous first requests for the session must all succeed
    server.close(); await hub.close();
    ({ server, hub } = await startServer(0, target));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const x of hub.sessions.values()) x.close();
    hub.sessions.clear();
    const codes = await Promise.all([1, 2, 3].map(async () => (await fetch(`${base}/api/sessions/${s.sessionId}`)).status));
    assert.deepEqual(codes, [200, 200, 200]);
  } finally { server.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.KEEL_TICK_MS; }
});
