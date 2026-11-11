// Regressions for release verification rounds 4 to 6 (Codex gpt-6.1-sol): sequence numbers, the session lock, injections
// never landing on a judged tick, verdicts judged only through ticks whose work has run, quotas and clocks across a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { scenarios } from '../src/scenarios.ts';
import { onPostgres, TEST_DB, freshSchema } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';
process.env.KEEL_TICK_MS = '3600000'; // the test drives the clock
const { startServer, evictOldest } = await import('../src/server.ts');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn: (base: string, hub: Awaited<ReturnType<typeof startServer>>['hub']) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-v4-'));
  if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema();
  const { server, hub } = await startServer(0, onPostgres ? TEST_DB : join(dir, 'k.db'));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hub); }
  finally { server.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) });

test('a scheduled closure after an injected "open" is still believed', async () => {
  await withServer(async (base, hub) => {
    const { sessionId, runIds } = await (await post(`${base}/api/sessions`, { scenario: 'delivery', policies: ['keel'] })).json();
    assert.equal((await post(`${base}/api/sessions/${sessionId}/inject`, { fact: 'route:R1.status', value: 'open' })).status, 202);
    const s = hub.sessions.get(sessionId)!;
    await s.runToEnd();
    const st = hub.state(runIds[0])!;
    assert.equal(hub.sim.truth(runIds[0], scenarios.delivery, s.tick)['route:R1.status'], 'closed');
    assert.equal(st.world.facts['route:R1.status'], 'closed', 'the tick-6 closure outranks the tick-0 injection');
    assert.ok(!hub.sim.effects(runIds[0]).some((e) => e.harm), 'no harmful effect');
  });
});

test('the clock waits while an injection is being persisted', async () => {
  await withServer(async (base, hub) => {
    const { sessionId, runIds } = await (await post(`${base}/api/sessions`, { scenario: 'delivery', policies: ['keel'] })).json();
    const s = hub.sessions.get(sessionId)!;
    const add = hub.store.addInjection.bind(hub.store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    hub.store.addInjection = async (...a: Parameters<typeof add>) => { await gate; return add(...a); };
    const inj = post(`${base}/api/sessions/${sessionId}/inject`, { fact: 'route:R2.status', value: 'closed' });
    await delay(30); // the injection is stamped at tick 0 and waits on the store
    const run = s.runToEnd();
    await delay(50);
    assert.equal(s.tick, 0, 'no tick passed while the injection was in flight');
    assert.equal(hub.sim.effects(runIds[0]).length, 0, 'no effect executed against a world missing the injection');
    release();
    assert.equal((await inj).status, 202);
    await run;
    const [i] = hub.sim.injections(sessionId);
    assert.ok(hub.sim.effects(runIds[0]).every((e) => e.tick >= i.tick), 'every effect saw the injected world');
  });
});

test('request quotas survive eviction and reload, and live only on the resident session', async () => {
  await withServer(async (base, hub) => {
    const { sessionId, runIds } = await (await post(`${base}/api/sessions`, { scenario: 'delivery', policies: ['keel'] })).json();
    for (const v of ['closed', 'open']) assert.equal((await post(`${base}/api/sessions/${sessionId}/inject`, { fact: 'route:R3.status', value: v })).status, 202);
    assert.equal((await post(`${base}/api/sessions/${sessionId}/crash`, { runId: runIds[0] })).status, 202);
    const before = hub.sessions.get(sessionId)!;
    assert.deepEqual([before.injectionsUsed, before.commandsUsed], [2, 1]);
    for (let e; (e = evictOldest(hub, new Map())); ) await e.done;
    assert.equal((await fetch(`${base}/api/sessions/${sessionId}`)).status, 200);
    const after = hub.sessions.get(sessionId)!;
    assert.notEqual(after, before);
    assert.equal(after.injectionsUsed, 2, 'injections are counted from the store');
    assert.ok(after.commandsUsed >= 1, 'the crash request still counts');
  });
});


test('an injection after the run has settled cannot rewrite its judged outcome', async () => {
  const { runView } = await import('../src/server.ts');
  await withServer(async (base, hub) => {
    const { sessionId, runIds } = await (await post(`${base}/api/sessions`, { scenario: 'delivery', policies: ['static', 'keel'] })).json();
    const s = hub.sessions.get(sessionId)!;
    await s.runToEnd();
    const settledAt = s.tick;
    const goal = async () => Promise.all(runIds.map(async (r: string) => (await runView(hub, r)).metrics.goalMet));
    const before = await goal();
    assert.deepEqual(before, [false, true], 'static fails, KEEL delivers');
    assert.equal((await post(`${base}/api/sessions/${sessionId}/inject`, { fact: 'route:R2.status', value: 'closed' })).status, 202);
    assert.ok(hub.sim.injections(sessionId)[0].tick > settledAt, 'the change happens after the judged tick');
    assert.deepEqual(await goal(), before, 'outcomes unchanged');
  });
});

test('a verdict changes only when a tick\'s work has run, so a world change at that tick cannot undo it', async () => {
  const { runView } = await import('../src/server.ts');
  await withServer(async (base, hub) => {
    const { sessionId, runIds } = await (await post(`${base}/api/sessions`, { scenario: 'delivery', policies: ['keel'] })).json();
    const s = hub.sessions.get(sessionId)!;
    const verdict = async () => { const m = (await runView(hub, runIds[0])).metrics; return { met: m.goalMet, pending: m.outcomePending }; };
    await s.exclusive(() => s.runDue());
    let prev = await verdict();
    while (s.tick < 40 && !(prev.met && !prev.pending)) {
      await s.exclusive(() => s.advanceClock());
      assert.deepEqual(await verdict(), prev, `t${s.tick}: unchanged before the tick's work runs`);
      await s.exclusive(() => s.runDue());
      prev = await verdict();
    }
    assert.deepEqual(prev, { met: true, pending: false }, 'KEEL delivers');
  });
});

test('a reloaded session whose lanes are all paused still delivers its scheduled world events', async () => {
  await withServer(async (base, hub) => {
    const { sessionId } = await (await post(`${base}/api/sessions`, { scenario: 'flapping' })).json();
    const s = hub.sessions.get(sessionId)!;
    const state = s as unknown as { queue: unknown[]; timer: unknown };
    await s.exclusive(() => s.runDue());
    while (s.tick < 40 && !(s.runIds.every((r) => s.settled(r)) && state.queue.length)) { await s.exclusive(() => s.advanceClock()); await s.exclusive(() => s.runDue()); }
    assert.ok(state.queue.length, 'paused lanes with world events still due');
    for (let e; (e = evictOldest(hub, new Map())); ) await e.done;
    assert.equal((await fetch(`${base}/api/sessions/${sessionId}`)).status, 200);
    const again = hub.sessions.get(sessionId)! as unknown as { queue: unknown[]; timer: unknown };
    assert.ok(again.queue.length && again.timer, 'the reloaded clock runs');
  });
});
