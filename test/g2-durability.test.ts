// G2: persisted ledger, idempotent effects, recovery and replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, Session } from '../src/runner.ts';
import { decide, fold, reduce, INPUTS, startContext } from '../src/engine.ts';
import type { Ev, RunState } from '../src/engine.ts';
import { runMetrics } from '../src/metrics.ts';
import { scenarios } from '../src/scenarios.ts';
import { openHub, events, onPostgres, TEST_DB, freshSchema } from './helpers.ts';

process.env.KEEL_PLANNER = 'search'; // deterministic search only; recorded model output is covered in g5-planner.test.ts

const run = async (scenario: string, policies: ('keel' | 'static' | 'naive')[], hubIn?: Hub) => {
  const hub = hubIn ?? await openHub();
  const s = await (await Session.create(hub, scenario, scenario, policies)).runToEnd();
  return { hub, s };
};
const head = (hub: Hub, runId: string) => hub.state(runId)?.seq ?? 0;

test('replay: re-deciding every recorded input reproduces every recorded decision exactly', async () => {
  for (const sc of ['delivery', 'recovery', 'flapping']) {
    const { hub, s } = await run(sc, ['keel', 'static', 'naive']);
    for (const runId of s.runIds) {
      const evs = (await events(hub, runId));
      let st: RunState | null = null;
      for (let i = 0; i < evs.length;) {
        const input = evs[i];
        assert.ok(INPUTS.has(input.t), `${runId} #${i} should be an input, got ${input.t}`);
        const d = decide(st, input);
        const recorded = evs.slice(i + 1, i + 1 + d.length);
        assert.deepEqual(JSON.parse(JSON.stringify(d)), recorded, `${runId}: decisions after ${input.t} #${i} differ on replay`);
        for (const e of [input, ...d]) st = reduce(st, e);
        i += 1 + d.length;
      }
      assert.deepEqual(JSON.parse(JSON.stringify(fold(evs))), JSON.parse(JSON.stringify(hub.state(runId))), `${runId}: folded state equals live state`);
    }
  }
});

test('in-process crash at every point of the delivery run: no duplicate effects, same outcome', async () => {
  const ref = await run('delivery', ['keel']);
  const refMetrics = await runMetrics(ref.hub.store, ref.hub.sim, 'delivery-keel');
  const total = head(ref.hub, 'delivery-keel');
  for (let crashAt = 2; crashAt < total; crashAt++) {
    const hub = await openHub();
    const s = await Session.create(hub, 'delivery', 'delivery', ['keel']);
    while (s.tick < 40 && head(hub, 'delivery-keel') < crashAt) { await s.runDue(); await s.advanceClock(); }
    await hub.crashAndRecover('delivery-keel', s);
    await s.runToEnd();
    const m = await runMetrics(hub.store, hub.sim, 'delivery-keel');
    assert.equal(m.duplicateEffects, 0, `crash before event ${crashAt}`);
    assert.equal(m.goalMet, true, `crash before event ${crashAt}: ${m.truth}`);
    assert.equal(m.revisions, refMetrics.revisions);
  }
});

test('ambiguous acknowledgement: the effect applied but the ack was lost; reconciliation finds it, no repeat', async () => {
  const hub = await openHub({ dropAckOnce: ['dispatch:1042', 'snapshot_db'] });
  for (const sc of ['delivery', 'recovery']) await (await Session.create(hub, sc, sc, ['keel'])).runToEnd();
  for (const r of ['delivery-keel', 'recovery-keel']) {
    const evs = (await events(hub, r));
    assert.ok(evs.some((e) => e.t === 'effect_uncertain'), `${r} saw an uncertain effect`);
    assert.ok(evs.some((e) => e.t === 'reconciled' && e.found === 'yes'));
    const m = await runMetrics(hub.store, hub.sim, r);
    assert.equal(m.duplicateEffects, 0);
    assert.equal(m.goalMet, true);
  }
});

test('stream append is optimistic: a writer with a stale head is refused', async () => {
  const { hub } = await run('delivery', ['keel']);
  const h = head(hub, 'delivery-keel');
  await assert.rejects(hub.store.append('delivery-keel', h - 1, [{ t: 'recover', at: 99 }], 99), /stream conflict/);
  await assert.rejects(hub.store.append('delivery-keel', h + 1, [{ t: 'recover', at: 99 }], 99), /stream conflict/);
});

// Real process death: SIGKILL inside the effect boundary, then a fresh process recovers from the store (SQLite file or Postgres).
for (const failpoint of ['before_effect', 'after_effect']) {
  test(`real SIGKILL ${failpoint.replace('_', ' ')}: a fresh process recovers from ${onPostgres ? 'PostgreSQL' : 'SQLite'}; dispatch applied exactly once`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-crash-'));
    const target = onPostgres ? TEST_DB : join(dir, 'keel.db');
    const env = { ...process.env, KEEL_PG_SCHEMA: freshSchema() };
    try {
      const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fixtures/crash-child.ts', target, 'run'], {
        env: { ...env, KEEL_FAILPOINT: failpoint, KEEL_FAILPOINT_EFFECT: 'dispatch:1042' }, encoding: 'utf8',
      });
      assert.notEqual(child.status, 0, `child should have been killed: ${child.stderr}`);
      const rec = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fixtures/crash-child.ts', target, 'recover'], { env, encoding: 'utf8' });
      assert.equal(rec.status, 0, rec.stderr);
      const m = JSON.parse(rec.stdout.trim().split(/\r?\n/).at(-1)!);
      assert.equal(m.duplicateEffects, 0);
      assert.equal(m.goalMet, true, m.truth);
      assert.ok(m.sawRecover);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a run with no incoming events does no planning, however long the clock runs', async () => {
  scenarios.quiet = { ...scenarios.delivery, id: 'quiet', truth: [], feed: [] }; // nothing ever changes in this world
  const hub = await openHub();
  const s = new Session(hub, 'quiet', 'quiet', ['keel']);
  await hub.store.createRun({ runId: 'quiet-keel', session: 'quiet', scenario: 'quiet', policy: 'keel' });
  await hub.sim.load('quiet-keel', 'quiet');
  await hub.submit('quiet-keel', { t: 'start', runId: 'quiet-keel', scenario: 'quiet', context: startContext('quiet', 'keel'), at: 0 }, s);
  await s.runToEnd(200);
  const kinds = (await events(hub, 'quiet-keel')).map((e: Ev) => e.t);
  assert.ok(!kinds.includes('repair_requested'));
  assert.ok(!kinds.includes('revision'));
  assert.equal(hub.state('quiet-keel')!.status, 'completed');
});
