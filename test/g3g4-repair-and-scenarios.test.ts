// G3: validated repair, commitment preservation, safe commits.  G4: scenarios, baselines, adversarial containment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Session, feedObservations } from '../src/runner.ts';
import { decide, fold, reduce } from '../src/engine.ts';
import type { Ev, RunState } from '../src/engine.ts';
import { runMetrics } from '../src/metrics.ts';
import { scenarios } from '../src/scenarios.ts';
import type { Scenario } from '../src/scenarios.ts';
import { sign } from '../src/world.ts';
import type { Observation } from '../src/world.ts';
import { Planner } from '../src/planner.ts';

const D = scenarios.delivery;
const variant = (id: string, base: Scenario, patch: Partial<Scenario>) => { scenarios[id] = { ...base, id, ...patch }; return id; };
const authority = (eventId: string, fact: string, value: string, at: number, seq: number, source = 'traffic-authority'): Observation => {
  const body = { eventId, source, seq, fact, value, observedAt: at };
  return { ...body, sig: sign(body, D.sources[source].key) };
};
const session = (scenario: string, policies: ('keel' | 'static' | 'naive')[]) => {
  const hub = new Hub();
  const s = new Session(hub, scenario, scenario, policies).start().runToEnd();
  const m = Object.fromEntries(s.runIds.map((r, i) => [policies[i], runMetrics(hub.store, hub.sim, r)]));
  return { hub, s, m, ev: (p: string) => hub.store.events(`${scenario}-${p}`) };
};

test('Scenario A: static fails silently; KEEL preserves completed work and repairs only route-bound steps', () => {
  const { m, ev } = session('delivery', ['static', 'keel']);
  assert.equal(m.static.beliefGoalMet, true, 'static believes it succeeded');
  assert.equal(m.static.goalMet, false, 'but the simulated world says it failed');
  assert.equal(m.static.invalidActions, 1);
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.keel.revisions, 1);
  assert.equal(m.keel.duplicateEffects, 0);
  assert.equal(m.keel.wastedEffects, 0);
  const rev = ev('keel').find((e) => e.t === 'revision')!;
  assert.ok(rev.t === 'revision');
  assert.deepEqual(rev.record.completed, ['s1', 's2', 's3'], 'pick, pack, load preserved with receipts');
  assert.deepEqual(rev.record.removed, ['label(order=1042,route=R1)', 'dispatch(order=1042,route=R1,truck=T1)']);
  assert.deepEqual(rev.record.added, ['label(order=1042,route=R2)', 'request_permit(route=R2)', 'dispatch(order=1042,route=R2,truck=T1)']);
  assert.equal(rev.record.edit.distance, 3);
  assert.match(rev.record.because, /route:R1\.status became "closed".*traffic-authority/);
  assert.ok(rev.record.checks.every((c) => c.pass));
  assert.equal(m.keel.duplicateObservations, 1, 'the replayed closure event was deduplicated');
});

test('Scenario B: the dependency signal fences the in-flight failover before its effect', () => {
  const { m, ev, hub } = session('recovery', ['static', 'keel']);
  assert.equal(m.static.goalMet, false);
  assert.equal(m.static.beliefGoalMet, true);
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.keel.fenced, 1);
  assert.equal(m.keel.staleObservations, 1, 'the late "healthy" with an older seq was refused');
  assert.ok(!hub.sim.effects('recovery-keel').some((e) => e.params.to === 'region-b'), 'region-b never received traffic');
  const rev = ev('keel').find((e) => e.t === 'revision');
  assert.ok(rev && rev.t === 'revision');
  assert.deepEqual(rev.record.added, ['shed_noncritical()', 'shift_traffic(to=region-c)']);
});

test('undisturbed controls: with no world change, static and KEEL both succeed and nobody revises', () => {
  for (const base of ['delivery', 'recovery']) {
    const id = variant(`${base}-control`, scenarios[base], { feed: [], truth: [] });
    const { m } = session(id, ['static', 'keel']);
    for (const p of ['static', 'keel']) {
      assert.equal(m[p].goalMet, true, `${id} ${p}`);
      assert.equal(m[p].revisions, 0);
    }
  }
});

test('fairness: every policy in a session receives byte-identical observations at identical ticks', () => {
  const hub = new Hub();
  const s = new Session(hub, 'fair', 'flapping', ['static', 'naive', 'keel']).start().runToEnd();
  const seen = s.runIds.map((r) => JSON.stringify(hub.store.rows(r).filter((x) => x.ev.t === 'observation').map((x) => [x.tick, x.ev])));
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[1], seen[2]);
  assert.equal(feedObservations(scenarios.flapping).length, JSON.parse(seen[0]).length);
});

test('adaptation failure: naive flips with the faulty sensor and hits the closed road; KEEL holds, then resumes on authority', () => {
  const { m, ev } = session('flapping', ['naive', 'keel']);
  assert.equal(m.naive.goalMet, false);
  assert.ok(m.naive.revisions >= 2);
  assert.ok(m.naive.wastedEffects >= 1, 'naive executed work it later abandoned');
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.keel.invalidActions, 0);
  const k = ev('keel');
  const paused = k.find((e) => e.t === 'paused');
  assert.ok(paused && paused.t === 'paused' && paused.kind === 'unstable');
  const resumed = k.findIndex((e) => e.t === 'resumed');
  const firstDispatchAfterPause = k.findIndex((e, i) => i > k.indexOf(paused!) && e.t === 'dispatch');
  assert.ok(resumed > 0 && firstDispatchAfterPause > resumed, 'nothing ran between the pause and the authoritative confirmation');
  assert.equal(m.keel.rejectedObservations, 1, 'forged press-office closure rejected');
});

test('stale candidate: a world change between repair request and planner answer is never committed', () => {
  const hub = new Hub();
  const s = new Session(hub, 'stale', 'delivery', ['keel']);
  hub.store.createRun('stale-keel', 'stale', 'delivery', 'keel');
  const log: Ev[] = [];
  let st: RunState | null = null;
  const feed = (e: Ev) => { const d = decide(st, e); for (const x of [e, ...d]) { st = reduce(st, x); log.push(x); } return d; };
  feed({ t: 'start', runId: 'stale-keel', scenario: 'delivery', policy: 'keel', at: 0 });
  for (const step of ['pick', 'pack', 'load']) {
    const op: string = st!.inflight!;
    assert.equal(st!.ledger[op].action, step);
    feed({ t: 'effect_ready', opId: op, at: 1 });
    if (step === 'load') break;
    feed({ t: 'receipt', opId: op, at: 1, detail: 'ok' });
  }
  feed({ t: 'receipt', opId: st!.inflight!, at: 2, detail: 'ok' });
  const d1 = feed({ t: 'observation', obs: authority('c1', 'route:R1.status', 'closed', 3, 1), at: 3 });
  const req = d1.find((e) => e.t === 'repair_requested');
  assert.ok(req && req.t === 'repair_requested');
  const candidates = new Planner().propose(st!);
  feed({ t: 'observation', obs: authority('c2', 'route:R3.status', 'closed', 4, 2), at: 4 }); // world moves on
  const d2 = feed({ t: 'planner_output', requestId: req.requestId, candidates, at: 4 });
  assert.equal(d2[0].t, 'candidate_stale');
  assert.ok(d2.some((e) => e.t === 'repair_requested'), 're-planned against the new world');
  assert.ok(!d2.some((e) => e.t === 'revision'));
  void s;
});

test('untrusted model candidates: unknown actions, phantom entities, repeated effects, skipped permits are all rejected', () => {
  const { hub } = session('delivery', ['keel']);
  const evs = hub.store.events('delivery-keel');
  const i = evs.findIndex((e) => e.t === 'repair_requested');
  const st = fold(evs.slice(0, i + 1));
  const req = evs[i] as Extract<Ev, { t: 'repair_requested' }>;
  const evil = [
    { origin: 'model:test', rationale: 'teleport', steps: [{ action: 'teleport', params: { order: '1042' } }] },
    { origin: 'model:test', rationale: 'phantom road', steps: [{ action: 'label', params: { order: '1042', route: 'R9' } }, { action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R9' } }, { action: 'notify', params: { order: '1042' } }] },
    { origin: 'model:test', rationale: 'repack', steps: [{ action: 'pack', params: { order: '1042' } }, { action: 'label', params: { order: '1042', route: 'R2' } }, { action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R2' } }, { action: 'notify', params: { order: '1042' } }] },
    { origin: 'model:test', rationale: 'skip permit', steps: [{ action: 'label', params: { order: '1042', route: 'R2' } }, { action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R2' } }, { action: 'notify', params: { order: '1042' } }] },
    { origin: 'model:test', rationale: 'slow road', steps: [{ action: 'label', params: { order: '1042', route: 'R3' } }, { action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R3' } }, { action: 'notify', params: { order: '1042' } }] },
  ].map((c) => ({ ...c, origin: `model:${c.rationale}` }));
  const d = decide(st, { t: 'planner_output', requestId: req.requestId, candidates: evil as never, at: st.tick });
  const p = d.find((e) => e.t === 'paused');
  assert.ok(p && p.t === 'paused' && p.kind === 'no_repair', 'nothing valid => pause, never a weakened goal');
  const fails = Object.fromEntries(evil.map((c) => [c.rationale, '']));
  const d2 = decide(st, { t: 'planner_output', requestId: req.requestId, candidates: [...evil, ...new Planner().propose(st)] as never, at: st.tick });
  const rev = d2.find((e) => e.t === 'revision');
  assert.ok(rev && rev.t === 'revision');
  for (const r of rev.record.rejected) fails[r.origin.slice('model:'.length)] = r.failed[0].id;
  assert.deepEqual(fails, { teleport: 'catalog', 'phantom road': 'params', repack: 'no-duplicate-effect', 'skip permit': 'assumptions', 'slow road': 'assumptions' });
});

test('no feasible repair: KEEL pauses with the goal intact instead of inventing a plan', () => {
  const id = variant('no-route', D, {
    sources: { ...D.sources, 'permit-office': { id: 'permit-office', key: 'sim-key-permit', mayAssert: ['permit-office.'], authoritative: true } },
    truth: [{ tick: 6, fact: 'route:R1.status', value: 'closed' }],
    feed: [{ tick: 4, source: 'permit-office', fact: 'permit-office.status', value: 'closed' }, { tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }],
  });
  const { m, ev } = session(id, ['static', 'keel']);
  assert.equal(m.static.goalMet, false);
  assert.equal(m.keel.goalMet, false);
  assert.equal(m.keel.invalidActions, 0, 'paused rather than doing harm');
  const p = ev('keel').find((e) => e.t === 'paused');
  assert.ok(p && p.t === 'paused' && p.kind === 'no_repair');
  assert.equal(m.keel.status, 'paused');
});

test('revision budget: after 3 committed revisions a 4th valid repair waits for an operator', () => {
  const id = variant('budget', D, {
    facts: { ...D.facts, 'route:R3.etaMin': 60, 'route:R4.status': 'open', 'route:R4.etaMin': 65, 'route:R4.permit': 'none' },
    feed: [
      { tick: 1, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' },
      { tick: 3, source: 'traffic-authority', fact: 'route:R3.status', value: 'closed' },
      { tick: 4, source: 'traffic-authority', fact: 'route:R1.status', value: 'open' },
      { tick: 6, source: 'traffic-authority', fact: 'route:R4.status', value: 'closed' },
      { tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' },
      { tick: 8, source: 'traffic-authority', fact: 'route:R4.status', value: 'open' },
      { tick: 9, source: 'traffic-authority', fact: 'route:R2.status', value: 'closed' },
    ],
    truth: [],
  });
  const { m, ev, hub, s } = session(id, ['keel']);
  assert.equal(m.keel.revisions, 3);
  const p = ev('keel').find((e) => e.t === 'paused');
  assert.ok(p && p.t === 'paused' && p.kind === 'budget', JSON.stringify(p));
  hub.submit(`${id}-keel`, { t: 'operator', cmd: 'resume', at: s.tick }, s);
  s.runToEnd();
  assert.equal(runMetrics(hub.store, hub.sim, `${id}-keel`).revisions, 4, 'operator granted one more revision');
});

test('oscillation guard: flipping back to an abandoned plan with no progress in between pauses', () => {
  const hub = new Hub();
  const s = new Session(hub, 'osc', 'delivery', ['keel']).start();
  while (s.tick <= 7) { s.runDue(); if (s.tick < 7) s.tick++; else break; }
  const st = hub.state('osc-keel')!;
  assert.equal(st.plan.version, 2);
  assert.equal(st.ledger[st.inflight!].action, 'label', 'label(R2) is preparing');
  s.inject('osc-keel', authority('o1', 'route:R2.status', 'closed', 7, 10));
  assert.ok(hub.store.events('osc-keel').some((e) => e.t === 'fenced'));
  s.inject('osc-keel', authority('o2', 'route:R1.status', 'open', 7, 11));
  const p = hub.store.events('osc-keel').filter((e) => e.t === 'paused').at(-1);
  assert.ok(p && p.t === 'paused' && p.kind === 'oscillation', JSON.stringify(p));
});

test('a closure during the dispatch preparation window is fenced before the truck leaves', () => {
  const id = variant('closure-at-dispatch', D, { truth: [{ tick: 9, fact: 'route:R1.status', value: 'closed' }], feed: [{ tick: 9, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }] });
  const { m } = session(id, ['static', 'keel']);
  assert.equal(m.keel.fenced, 1);
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.static.goalMet, false);
});

test('completed irreversible work is never undone or repeated', () => {
  const id = variant('late-closure', D, { truth: [{ tick: 10, fact: 'route:R1.status', value: 'closed' }], feed: [{ tick: 10, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }] });
  const { m, ev } = session(id, ['keel']);
  assert.equal(m.keel.revisions, 0, 'the truck already left on R1; nothing remaining depends on R1');
  assert.equal(m.keel.duplicateEffects, 0);
  assert.ok(ev('keel').some((e) => e.t === 'assessed' && e.result === 'no_impact' && e.fact === 'route:R1.status'));
});
