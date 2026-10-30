// G2: persisted ledger, idempotent effects, recovery and replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, Session } from '../src/runner.ts';
import { decide, fold, reduce, INPUTS } from '../src/engine.ts';
import type { Ev, RunState } from '../src/engine.ts';
import { runMetrics } from '../src/metrics.ts';

const run = (scenario: string, policies: ('keel' | 'static' | 'naive')[], hub = new Hub()) => {
  const s = new Session(hub, scenario, scenario, policies).start().runToEnd();
  return { hub, s };
};

test('replay: re-deciding every recorded input reproduces every recorded decision exactly', () => {
  for (const sc of ['delivery', 'recovery', 'flapping']) {
    const { hub, s } = run(sc, ['keel', 'static', 'naive']);
    for (const runId of s.runIds) {
      const evs = hub.store.events(runId);
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

test('in-process crash at every point of the delivery run: no duplicate effects, same outcome', () => {
  const ref = run('delivery', ['keel']);
  const refMetrics = runMetrics(ref.hub.store, ref.hub.sim, 'delivery-keel');
  const total = ref.hub.store.head('delivery-keel');
  for (let crashAt = 2; crashAt < total; crashAt++) {
    const hub = new Hub();
    const s = new Session(hub, 'delivery', 'delivery', ['keel']).start();
    while (s.tick < 40 && hub.store.head('delivery-keel') < crashAt) { s.runDue(); s.tick++; }
    hub.crashAndRecover('delivery-keel', s);
    s.runToEnd();
    const m = runMetrics(hub.store, hub.sim, 'delivery-keel');
    assert.equal(m.duplicateEffects, 0, `crash before event ${crashAt}`);
    assert.equal(m.goalMet, true, `crash before event ${crashAt}: ${m.truth}`);
    assert.equal(m.revisions, refMetrics.revisions);
  }
});

test('ambiguous acknowledgement: the effect applied but the ack was lost; reconciliation finds it, no repeat', () => {
  const hub = new Hub(':memory:', { dropAckOnce: ['dispatch:1042', 'snapshot_db'] });
  for (const sc of ['delivery', 'recovery']) new Session(hub, sc, sc, ['keel']).start().runToEnd();
  for (const r of ['delivery-keel', 'recovery-keel']) {
    const evs = hub.store.events(r);
    assert.ok(evs.some((e) => e.t === 'effect_uncertain'), `${r} saw an uncertain effect`);
    assert.ok(evs.some((e) => e.t === 'reconciled' && e.found === 'yes'));
    const m = runMetrics(hub.store, hub.sim, r);
    assert.equal(m.duplicateEffects, 0);
    assert.equal(m.goalMet, true);
  }
});

test('stream append is optimistic: a writer with a stale head is refused', () => {
  const { hub } = run('delivery', ['keel']);
  const h = hub.store.head('delivery-keel');
  assert.throws(() => hub.store.append('delivery-keel', h - 1, [{ t: 'recover', at: 99 }], 99), /stream conflict/);
});

// Real process death: SIGKILL inside the effect boundary, then a fresh process recovers from the SQLite file.
for (const failpoint of ['before_effect', 'after_effect']) {
  test(`real SIGKILL ${failpoint.replace('_', ' ')}: recovery from SQLite applies dispatch exactly once`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-crash-'));
    const db = join(dir, 'keel.db');
    try {
      const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fixtures/crash-child.ts', db, 'run'], {
        env: { ...process.env, KEEL_FAILPOINT: failpoint, KEEL_FAILPOINT_EFFECT: 'dispatch:1042' }, encoding: 'utf8',
      });
      assert.notEqual(child.status, 0, `child should have been killed: ${child.stderr}`);
      const rec = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fixtures/crash-child.ts', db, 'recover'], { encoding: 'utf8' });
      assert.equal(rec.status, 0, rec.stderr);
      const m = JSON.parse(rec.stdout.trim().split('\n').at(-1)!);
      assert.equal(m.duplicateEffects, 0);
      assert.equal(m.goalMet, true, m.truth);
      assert.ok(m.sawRecover);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a run with no incoming events does no planning, however long the clock runs', () => {
  const hub = new Hub();
  const s = new Session(hub, 'quiet', 'delivery', ['keel']);
  hub.store.createRun('quiet-keel', 'quiet', 'delivery', 'keel');
  hub.submit('quiet-keel', { t: 'start', runId: 'quiet-keel', scenario: 'delivery', policy: 'keel', at: 0 }, s);
  s.runToEnd(200);
  const kinds = hub.store.events('quiet-keel').map((e: Ev) => e.t);
  assert.ok(!kinds.includes('repair_requested'));
  assert.ok(!kinds.includes('revision'));
  assert.equal(hub.state('quiet-keel')!.status, 'completed');
});
