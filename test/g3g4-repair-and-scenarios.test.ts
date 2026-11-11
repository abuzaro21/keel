// G3: validated repair, commitment preservation, safe commits.  G4: scenarios, baselines, adversarial containment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, feedObservations } from '../src/runner.ts';
import { decide, fold, reduce, startContext } from '../src/engine.ts';
import type { Ev, RunState } from '../src/engine.ts';
import { runMetrics } from '../src/metrics.ts';
import { scenarios } from '../src/scenarios.ts';
import type { Scenario } from '../src/scenarios.ts';
import { sign } from '../src/world.ts';
import type { Observation } from '../src/world.ts';
import { Planner } from '../src/planner.ts';
import { openHub, events } from './helpers.ts';

process.env.KEEL_PLANNER = 'search'; // deterministic search only; recorded model output is covered in g5-planner.test.ts

const D = scenarios.delivery;
const variant = (id: string, base: Scenario, patch: Partial<Scenario>) => { scenarios[id] = { ...base, id, ...patch }; return id; };
const authority = (eventId: string, fact: string, value: string, at: number, seq: number, source = 'traffic-authority'): Observation => {
  const body = { eventId, source, seq, fact, value, observedAt: at };
  return { ...body, sig: sign(body, D.sources[source].key) };
};
const session = async (scenario: string, policies: ('keel' | 'static' | 'naive' | 'guarded')[]) => {
  const hub = await openHub();
  const s = await (await Session.create(hub, scenario, scenario, policies)).runToEnd();
  const m = Object.fromEntries(await Promise.all(s.runIds.map(async (r, i) => [policies[i], await runMetrics(hub.store, hub.sim, r)] as const)));
  const evs = Object.fromEntries(await Promise.all(policies.map(async (p) => [p, await events(hub, `${scenario}-${p}`)] as const)));
  return { hub, s, m, ev: (p: string) => evs[p] };
};

test('Scenario A: static fails silently; KEEL preserves completed work and repairs only route-bound steps', async () => {
  const { m, ev } = await session('delivery', ['static', 'keel']);
  // Open loop: it dispatched onto the closed road and notified the customer "on time"; it only learns the truth from
  // the carrier's report after both irreversible steps already happened.
  assert.equal(m.static.beliefGoalMet, false, 'static finds out only after the fact');
  assert.equal(m.static.goalMet, false, 'and the simulated world says it failed');
  assert.ok(ev('static').some((e) => e.t === 'commit_effect') && ev('static').findIndex((e) => e.t === 'observation' && e.obs.value === 'stuck') < ev('static').findLastIndex((e) => e.t === 'receipt'), 'notify ran after the stuck report');
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

test('Scenario B: the dependency signal fences the in-flight failover before its effect', async () => {
  const { m, ev, hub } = await session('recovery', ['static', 'keel']);
  assert.equal(m.static.goalMet, false);
  assert.equal(m.static.beliefGoalMet, true);
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.keel.fenced, 1);
  assert.equal(m.keel.staleObservations, 1, 'the late "healthy" with an older seq was refused');
  assert.ok(!hub.sim.effects('recovery-keel').some((e) => e.params.to === 'region-b'), 'region-b never received traffic');
  const rev = ev('keel').find((e) => e.t === 'revision');
  assert.ok(rev && rev.t === 'revision');
  assert.deepEqual(rev.record.added, ['shed_noncritical()', 'shift_traffic(to=region-c)', 'resume_noncritical()']);
});

test('undisturbed controls: with no world change, static and KEEL both succeed and nobody revises', async () => {
  for (const base of ['delivery', 'recovery']) {
    const id = variant(`${base}-control`, scenarios[base], { feed: [], truth: [] });
    const { m } = await session(id, ['static', 'keel']);
    for (const p of ['static', 'keel']) {
      assert.equal(m[p].goalMet, true, `${id} ${p}`);
      assert.equal(m[p].revisions, 0);
    }
  }
});

test('fairness: every policy in a session receives byte-identical observations at identical ticks', async () => {
  const hub = await openHub();
  const s = await (await Session.create(hub, 'fair', 'flapping', ['static', 'naive', 'keel'])).runToEnd();
  // The shared world tape; carrier reports ("report-*") are about each lane's own truck and differ by design.
  const seen = await Promise.all(s.runIds.map(async (r) => JSON.stringify((await hub.store.rows(r)).filter((x) => x.ev.t === 'observation' && !x.ev.obs.eventId.startsWith('report-')).map((x) => [x.tick, x.ev]))));
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[1], seen[2]);
  assert.equal(feedObservations(scenarios.flapping).length, JSON.parse(seen[0]).length);
});

test('adaptation failure: naive flips with the faulty sensor and hits the closed road; KEEL holds until an operator confirms', async () => {
  const { m, ev, hub, s } = await session('flapping', ['naive', 'keel']);
  assert.equal(m.naive.goalMet, false);
  assert.ok(m.naive.revisions >= 2);
  assert.match(m.naive.truth, /closed route R1/, 'naive followed the sensor back onto the closed road');
  assert.equal(m.keel.status, 'paused', 'latched: the authority alone does not lift containment');
  assert.equal(m.keel.invalidActions, 0);
  await hub.submit('flapping-keel', { t: 'operator', cmd: 'confirm', fact: 'route:R2.status', value: 'open', at: s.tick }, s);
  await hub.submit('flapping-keel', { t: 'operator', cmd: 'resume', at: s.tick }, s);
  await s.runToEnd();
  const m2 = await runMetrics(hub.store, hub.sim, 'flapping-keel');
  assert.equal(m2.goalMet, true, m2.truth);
  assert.equal(m2.invalidActions, 0);
  const k = (await events(hub, 'flapping-keel'));
  void ev;
  const paused = k.find((e) => e.t === 'paused');
  assert.ok(paused && paused.t === 'paused' && paused.kind === 'unstable');
  const resumed = k.findIndex((e) => e.t === 'resumed' && e.by === 'operator');
  const firstDispatchAfterPause = k.findIndex((e, i) => i > k.indexOf(paused!) && e.t === 'dispatch');
  assert.ok(resumed > 0 && firstDispatchAfterPause > resumed, 'nothing ran between the pause and the operator resume');
  assert.equal(m2.rejectedObservations, 1, 'forged press-office closure rejected');
});

test('stale candidate: a world change between repair request and planner answer is never committed', async () => {
  const hub = await openHub();
  const s = new Session(hub, 'stale', 'delivery', ['keel']);
  await hub.store.createRun({ runId: 'stale-keel', session: 'stale', scenario: 'delivery', policy: 'keel' });
  const log: Ev[] = [];
  let st: RunState | null = null;
  const feed = (e: Ev) => { const d = decide(st, e); for (const x of [e, ...d]) { st = reduce(st, x); log.push(x); } return d; };
  feed({ t: 'start', runId: 'stale-keel', scenario: 'delivery', context: startContext('delivery', 'keel'), at: 0 });
  const land = (at: number) => {
    const op: string = st!.inflight!;
    const gen = st!.ledger[op].gen;
    const c = feed({ t: 'effect_ready', opId: op, gen, at }).find((e) => e.t === 'commit_effect');
    assert.ok(c && c.t === 'commit_effect');
    return feed({ t: 'receipt', opId: op, gen, applied: c.expect, at, detail: 'ok' });
  };
  land(1); land(2); land(2);
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

test('untrusted model candidates: unknown actions, phantom entities, repeated effects, skipped permits are all rejected', async () => {
  const { hub } = await session('delivery', ['keel']);
  const evs = (await events(hub, 'delivery-keel'));
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

test('no feasible repair: KEEL pauses with the goal intact instead of inventing a plan', async () => {
  const id = variant('no-route', D, {
    sources: { ...D.sources, 'permit-office': { id: 'permit-office', key: 'sim-key-permit', mayAssert: ['permit-office:*.status'], rank: 2 } },
    truth: [{ tick: 6, fact: 'route:R1.status', value: 'closed' }],
    feed: [{ tick: 4, source: 'permit-office', fact: 'permit-office:main.status', value: 'closed' }, { tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }],
  });
  const { m, ev } = await session(id, ['static', 'keel']);
  assert.equal(m.static.goalMet, false);
  assert.equal(m.keel.goalMet, false);
  assert.equal(m.keel.invalidActions, 0, 'paused rather than doing harm');
  const p = ev('keel').find((e) => e.t === 'paused');
  assert.ok(p && p.t === 'paused' && p.kind === 'no_repair');
  assert.equal(m.keel.status, 'paused');
});

test('revision budget: after 3 committed revisions a 4th valid repair waits for an operator', async () => {
  const id = variant('budget', D, {
    facts: { ...D.facts, 'route:R3.etaMin': 60, 'route:R4.status': 'open', 'route:R4.etaMin': 65, 'route:R4.permit': 'none' },
    sources: D.sources,
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
  const { m, ev, hub, s } = await session(id, ['keel']);
  assert.equal(m.keel.revisions, 3);
  const p = ev('keel').find((e) => e.t === 'paused');
  assert.ok(p && p.t === 'paused' && p.kind === 'budget', JSON.stringify(p));
  await hub.submit(`${id}-keel`, { t: 'operator', cmd: 'resume', at: s.tick }, s);
  await s.runToEnd();
  assert.equal((await runMetrics(hub.store, hub.sim, `${id}-keel`)).revisions, 4, 'operator granted one more revision');
});

test('oscillation guard: flipping back to an abandoned plan with no progress in between pauses', async () => {
  const hub = await openHub();
  const s = await Session.create(hub, 'osc', 'delivery', ['keel']);
  while (s.tick <= 7) { await s.runDue(); if (s.tick < 7) s.tick++; else break; }
  const st = hub.state('osc-keel')!;
  assert.equal(st.plan.version, 2);
  assert.equal(st.ledger[st.inflight!].action, 'label', 'label(R2) is preparing');
  await s.inject('osc-keel', authority('o1', 'route:R2.status', 'closed', 7, 10));
  assert.ok((await events(hub, 'osc-keel')).some((e) => e.t === 'fenced'));
  await s.inject('osc-keel', authority('o2', 'route:R1.status', 'open', 7, 11));
  const p = (await events(hub, 'osc-keel')).filter((e) => e.t === 'paused').at(-1);
  assert.ok(p && p.t === 'paused' && p.kind === 'oscillation', JSON.stringify(p));
});

test('a closure during the dispatch preparation window is fenced before the truck leaves', async () => {
  const id = variant('closure-at-dispatch', D, { truth: [{ tick: 9, fact: 'route:R1.status', value: 'closed' }], feed: [{ tick: 9, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }] });
  const { m } = await session(id, ['static', 'keel']);
  assert.equal(m.keel.fenced, 1);
  assert.equal(m.keel.goalMet, true);
  assert.equal(m.static.goalMet, false);
});

test('closure while the truck is in transit: an irreversible step cannot be undone, so KEEL stops instead of lying', async () => {
  const id = variant('late-closure', D, { truth: [{ tick: 10, fact: 'route:R1.status', value: 'closed' }], feed: [{ tick: 10, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }] });
  const { m, hub } = await session(id, ['static', 'keel']);
  assert.equal(m.static.goalMet, false);
  assert.match(m.static.truth, /told it was on time/, 'static sends a false on-time notice');
  assert.equal(m.keel.goalMet, false, 'not every changed situation is recoverable');
  assert.equal(m.keel.status, 'paused');
  assert.equal(m.keel.revisions, 0);
  assert.equal(m.keel.duplicateEffects, 0);
  assert.ok(!hub.sim.effects(`${id}-keel`).some((e) => e.action === 'notify'), 'KEEL did not tell the customer it was on time');
  assert.ok(hub.sim.effects(`${id}-keel`).filter((e) => e.action === 'dispatch').length === 1, 'and did not re-dispatch');
});

test('maintained commitment: region-b degrades AFTER traffic moved there; KEEL fences the restart and moves traffic again', async () => {
  const R = scenarios.recovery;
  const id = variant('late-degrade', R, { truth: [{ tick: 5, fact: 'svc:region-b.status', value: 'degraded' }], feed: [{ tick: 5, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'degraded' }] });
  const { m, ev } = await session(id, ['static', 'keel']);
  assert.equal(m.static.goalMet, false, m.static.truth);
  assert.equal(m.keel.fenced, 1, 'restart_region_a was preparing and is cancelled');
  const rev = ev('keel').find((e) => e.t === 'revision');
  assert.ok(rev && rev.t === 'revision');
  assert.match(rev.record.because, /shift_traffic\(to=region-b\) committed to svc:region-b.status eq "healthy"/);
  assert.deepEqual(rev.record.completed, ['s1', 's2']);
  assert.ok(rev.record.added.includes('shift_traffic(to=region-c)'));
});

test('guarded-static control: checking assumptions without repair stops safely but misses the goal', async () => {
  const { m } = await session('delivery', ['guarded', 'keel']);
  assert.equal(m.guarded.invalidActions, 0);
  assert.equal(m.guarded.goalMet, false);
  assert.equal(m.guarded.status, 'paused');
  assert.equal(m.keel.goalMet, true);
});
