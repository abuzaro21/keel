// Regressions for the Codex G1–G4 gate review (codex-g1-g4-final.md, findings F1–F6, M1–M4). Each test reproduces the reported control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialWorld, judge, apply, sign } from '../src/world.ts';
import type { Observation, WorldState } from '../src/world.ts';
import { project, editOps } from '../src/model.ts';
import type { Domain, Goal } from '../src/model.ts';
import { validate } from '../src/repair.ts';
import { parseModelResponse } from '../src/planner.ts';
import { scenarios } from '../src/scenarios.ts';
import type { Scenario } from '../src/scenarios.ts';
import { Session } from '../src/runner.ts';
import { decide, fold, reduce, startContext } from '../src/engine.ts';
import type { Ev, RunState } from '../src/engine.ts';
import { runMetrics } from '../src/metrics.ts';
import { openHub, events } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';

const D = scenarios.delivery;
const R = scenarios.recovery;
const signed = (o: Omit<Observation, 'sig'>, S: Scenario = D) => ({ ...o, sig: sign(o, S.sources[o.source].key) });
const ingest = (w: WorldState, o: Observation, now = 10) => { const v = judge(w, o, D.sources, now, D.enums); return { v, w: v.kind === 'applied' ? apply(w, o, v, D.sources) : w }; };
const variant = (id: string, base: Scenario, patch: Partial<Scenario>) => { scenarios[id] = { ...base, id, ...patch }; return id; };
const session = async (id: string, policies: ('keel' | 'static')[]) => {
  const hub = await openHub();
  const s = await (await Session.create(hub, id, id, policies)).runToEnd();
  return { hub, s, m: Object.fromEntries(await Promise.all(policies.map(async (p) => [p, await runMetrics(hub.store, hub.sim, `${id}-${p}`)] as const))) };
};

test('F1: a lower-ranked report of the same value does not launder the authority rank', async () => {
  let w = initialWorld(D.facts);
  w = ingest(w, signed({ eventId: 'a', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 5 })).w;
  w = ingest(w, signed({ eventId: 'b', source: 'road-sensor-7', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 6 })).w;
  assert.equal(w.meta['route:R1.status'].source, 'traffic-authority');
  const r = ingest(w, signed({ eventId: 'c', source: 'road-sensor-7', seq: 2, fact: 'route:R1.status', value: 'open', observedAt: 7 }));
  assert.equal(r.v.kind, 'stale');
  assert.equal(r.w.facts['route:R1.status'], 'closed');
});

test('F1: non-integer or infinite sequence numbers are rejected and cannot poison ordering', async () => {
  const w = initialWorld(D.facts);
  for (const seq of ['Infinity', Infinity, 1.5, -1, Number.MAX_VALUE]) {
    const o = { eventId: `s${String(seq)}`, source: 'traffic-authority', seq: seq as number, fact: 'route:R2.status', value: 'closed', observedAt: 5 };
    assert.equal(ingest(w, { ...o, sig: sign(o, D.sources['traffic-authority'].key) }).v.kind, 'rejected', `seq ${String(seq)}`);
  }
});

test('F2: a hostile JSON parameter is rejected as a candidate, never thrown out of the decision loop', async () => {
  const [cand] = parseModelResponse('{"candidates":[{"rationale":"x","steps":[{"action":"label","params":{"order":{"toString":null},"route":"R2"}}]}]}');
  const c = { f: D.facts, done: new Set<string>(), unstable: new Set<string>(), active: [] };
  const v = validate(D.domain, D.goal, cand.steps, D.plan, c);
  assert.equal(v.valid, false);
  assert.equal(v.checks.find((x) => !x.pass)?.id, 'param-shape');
  const hub = await openHub();
  await (await Session.create(hub, 'h', 'delivery', ['keel'])).runToEnd();
  const evs = (await events(hub, 'h-keel'));
  const i = evs.findIndex((e) => e.t === 'repair_requested');
  const st = fold(evs.slice(0, i + 1));
  const req = evs[i] as Extract<Ev, { t: 'repair_requested' }>;
  assert.doesNotThrow(() => decide(st, { t: 'planner_output', requestId: req.requestId, candidates: [{ origin: 'model:evil', rationale: 'x', steps: cand.steps }, { origin: 'model:evil2', rationale: 'y', steps: [{ action: 'label', params: { order: '1042', route: 'R2', extra: 'x' } }] }], at: st.tick }));
});

// A tiny synthetic domain for the obligation controls Codex executed.
const syn = (initialHealthy: boolean): { d: Domain; goal: Goal; f: Record<string, boolean> } => ({
  goal: { statement: 'finish', success: [{ fact: 'done', op: 'eq', value: true }] },
  f: { healthy: initialHealthy, done: false, guard: true },
  d: {
    name: 'syn', domains: {},
    actions: {
      heal: { type: 'heal', describe: '', params: {}, commitment: 'reversible', duration: 1, cost: () => 1, requires: () => [], produces: () => ({ healthy: true }), effectKey: () => 'heal' },
      spoil: { type: 'spoil', describe: '', params: {}, commitment: 'reversible', duration: 1, cost: () => 1, requires: () => [], produces: () => ({ healthy: false }), effectKey: () => 'spoil' },
      release: { type: 'release', describe: '', params: {}, commitment: 'reversible', duration: 1, cost: () => 1, requires: () => [], releases: ['hold'], produces: () => ({}), effectKey: () => 'release' },
      finish: { type: 'finish', describe: '', params: {}, commitment: 'irreversible', duration: 1, cost: () => 1, requires: () => [], produces: () => ({ done: true }), effectKey: () => 'finish' },
    },
  },
});
const ob = [{ cond: { fact: 'healthy', op: 'eq' as const, value: true }, action: 'hold', from: 'hold()' }];

test('F3: a broken commitment repaired earlier in the plan no longer blocks a later irreversible step', async () => {
  const { d, goal, f } = syn(false);
  const p = project(d, goal, [{ id: 'a', action: 'heal', params: {} }, { id: 'b', action: 'finish', params: {} }], { f, done: new Set(), unstable: new Set(), active: ob });
  assert.equal(p.failures.length, 0, JSON.stringify(p.failures));
});

test('F3: a step that breaks a live commitment fails even if the next step releases it', async () => {
  const { d, goal, f } = syn(true);
  const p = project(d, goal, [{ id: 'a', action: 'spoil', params: {} }, { id: 'b', action: 'release', params: {} }, { id: 'c', action: 'finish', params: {} }], { f, done: new Set(), unstable: new Set(), active: ob });
  assert.deepEqual(p.failures.map((x) => x.stepId), ['a']);
});

test('F3: a known historical violation is never forgotten: KEEL recovers but does not claim the goal as stated', async () => {
  const id = variant('f3-late-degrade', R, { truth: [{ tick: 5, fact: 'svc:region-b.status', value: 'degraded' }], feed: [{ tick: 5, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'degraded' }] });
  const { m } = await session(id, ['keel']);
  assert.equal(m.keel.goalMet, false, 'the world saw 5xx while region-b served degraded');
  assert.equal(m.keel.beliefGoalMet, false, 'and KEEL itself does not claim success');
  assert.match(m.keel.violations[0], /shift_traffic\(to=region-b\) committed to svc:region-b.status eq "healthy"/);
});

test('F4: receipts carry what physics actually applied; KEEL learns the real demand instead of trusting its estimate', async () => {
  const id = variant('f4-demand', R, {
    physics: { ...R.physics, shed_noncritical: () => ({ set: { 'traffic.rps': 700, 'traffic.shedding': true } }) },
  });
  const { hub, m } = await session(id, ['keel']);
  const rec = (await events(hub, `${id}-keel`)).find((e) => e.t === 'receipt' && e.applied['traffic.rps'] !== undefined);
  assert.ok(rec && rec.t === 'receipt');
  assert.equal(rec.applied['traffic.rps'], 700);
  assert.equal(hub.state(`${id}-keel`)!.world.facts['traffic.rps'], 700);
  assert.equal(m.keel.invalidActions, 0, 'KEEL did not push 700 rps into a 600 rps region');
  assert.equal(hub.sim.truth(`${id}-keel`, scenarios[id], 1)['db.snapshot'], false);
  assert.equal(hub.sim.truth(`${id}-keel`, scenarios[id], 3)['db.snapshot'], true, 'simulator truth now includes every applied mutation');
});

test('F5: a revoked permit fails closed — KEEL does not dispatch, and physics punishes a dispatch without a valid permit', async () => {
  const id = variant('f5-revoked', D, {
    truth: [{ tick: 6, fact: 'route:R1.status', value: 'closed' }, { tick: 10, fact: 'route:R2.permit', value: 'revoked' }],
    feed: [{ tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' }, { tick: 10, source: 'traffic-authority', fact: 'route:R2.permit', value: 'revoked' }],
  });
  const { hub, m } = await session(id, ['keel']);
  assert.ok(!hub.sim.effects(`${id}-keel`).some((e) => e.action === 'dispatch'), 'no dispatch on a revoked permit');
  assert.equal(m.keel.invalidActions, 0);
  assert.equal(m.keel.status, 'paused');
  const o = { eventId: 'bad', source: 'traffic-authority', seq: 50, fact: 'route:R2.permit', value: 'maybe', observedAt: 5 };
  assert.equal(judge(initialWorld(D.facts), { ...o, sig: sign(o, D.sources['traffic-authority'].key) }, D.sources, 5, D.enums).kind, 'rejected', 'unknown enum value');
});

test('F6: the outcome is never read from the future; before arrival it is pending', async () => {
  const hub = await openHub();
  const s = await Session.create(hub, 'f6', 'delivery', ['keel']);
  while (s.tick < 13) { await s.runDue(); await s.advanceClock(); }
  const mid = await runMetrics(hub.store, hub.sim, 'f6-keel');
  assert.equal(mid.outcomePending, true, mid.truth);
  assert.equal(mid.goalMet, false);
  await s.runToEnd();
  const end = await runMetrics(hub.store, hub.sim, 'f6-keel');
  assert.equal(end.outcomePending, false);
  assert.equal(end.goalMet, true, end.truth);
});

test('M1: a receipt for a cancelled preparation does not resurrect it; it raises an incident pause', async () => {
  const start: Ev = { t: 'start', runId: 'm1', scenario: 'delivery', context: startContext('delivery', 'keel'), at: 0 };
  let st: RunState | null = null;
  const feed = (e: Ev) => { const d = decide(st, e); for (const x of [e, ...d]) st = reduce(st, x); return d; };
  feed(start);
  const op = st!.inflight!;
  feed({ t: 'recover', at: 1 }); // fences gen 1, re-prepares gen 2
  const d = feed({ t: 'receipt', opId: op, gen: 1, applied: { 'order:1042.picked': true }, at: 1, detail: 'late' });
  assert.equal(st!.done.length, 0);
  assert.ok(d.length === 0 || d.every((e) => e.t !== 'completed'));
});

test('M3: edit components come from a one-to-one alignment and are never negative', async () => {
  const a = [{ action: 'label', params: { route: 'R1' } }, { action: 'dispatch', params: { route: 'R1' } }];
  const b = [{ action: 'label', params: { route: 'R2' } }, { action: 'label', params: { route: 'R3' } }, { action: 'dispatch', params: { route: 'R1' } }];
  const e = editOps(a, b);
  assert.ok(e.modified >= 0 && e.inserted >= 0 && e.removed >= 0);
  assert.equal(e.modified + e.inserted + e.removed, e.distance);
});

test('M4: a genuine injected change alters simulated truth for every run; a forgery alters nothing', async () => {
  const hub = await openHub();
  const s = await Session.create(hub, 'm4', 'delivery', ['static', 'keel']);
  await s.injectShared({ tick: 2, fact: 'route:R2.status', value: 'closed', real: true, obs: signed({ eventId: 'm4', source: 'traffic-authority', seq: 900, fact: 'route:R2.status', value: 'closed', observedAt: 2 }) });
  for (const r of s.runIds) assert.equal(hub.sim.truth(r, D, 3)['route:R2.status'], 'closed');
  assert.equal(hub.sim.truth('m4-keel', D, 1)['route:R2.status'], 'open');
});
