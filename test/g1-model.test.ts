// G1: typed plan model, world events, contradiction detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalCond, project, impact, editDistance, referencedFacts } from '../src/model.ts';
import type { Ctx } from '../src/model.ts';
import { apply, confirm, initialWorld, judge, sign, FLAP_CHANGES } from '../src/world.ts';
import type { Observation, WorldState } from '../src/world.ts';
import { scenarios } from '../src/scenarios.ts';
import { decide, fold, startContext } from '../src/engine.ts';
import type { Ev } from '../src/engine.ts';

process.env.KEEL_PLANNER = 'search'; // deterministic search only; recorded model output is covered in g5-planner.test.ts

const D = scenarios.delivery;
const obs = (o: Omit<Observation, 'sig'>, key = D.sources[o.source]?.key ?? 'x'): Observation => ({ ...o, sig: sign(o, key) });
const ctx = (f: Record<string, unknown>, done: string[] = []): Ctx => ({ f: f as Ctx['f'], done: new Set(done), unstable: new Set(), active: [] });
const ingest = (w: WorldState, o: Observation, now = 10) => {
  const v = judge(w, o, D.sources, now);
  return { v, w: v.kind === 'applied' ? apply(w, o, v, D.sources) : w };
};

test('conditions are three-valued: unstable, missing or non-numeric operands are UNKNOWN, never true', () => {
  const f = { a: 1, b: 2, n: null };
  assert.equal(evalCond({ fact: 'b', op: 'gte', ref: 'n' }, f), 'unknown', '600 >= null must not pass');
  assert.equal(evalCond({ fact: 'a', op: 'lte', ref: 'b' }, f), 'true');
  assert.equal(evalCond({ fact: 'a', op: 'eq', value: 2 }, f), 'false');
  assert.equal(evalCond({ fact: 'missing', op: 'eq', value: 1 }, f), 'unknown');
  assert.equal(evalCond({ fact: 'a', op: 'eq', value: 1 }, f, new Set(['a'])), 'unknown');
});

test('projection finds the exact broken assumption from contracts, not from scenario code', () => {
  const facts = { ...D.facts, 'route:R1.status': 'closed' };
  const p = project(D.domain, D.goal, D.plan, ctx(facts));
  assert.equal(p.ok, false);
  assert.deepEqual(p.failures.map((f) => [f.stepId, f.cond.fact, f.obligation ?? null]), [
    ['s5', 'route:R1.status', null],
    ['s6', 'route:R1.status', 'dispatch(order=1042,route=R1,truck=T1)'], // notify would run while the in-transit commitment is broken
  ]);
});

test('impact: entity-bound and downstream steps are affected; completed and unrelated steps are preserved', () => {
  const facts = { ...D.facts, 'route:R1.status': 'closed' };
  const p = project(D.domain, D.goal, D.plan, ctx(facts));
  const imp = impact(D.domain, D.plan, p.failures, new Set(['pick:1042', 'pack:1042']), ['R1']);
  assert.deepEqual(imp.affected, ['s4', 's5', 's6']); // label(R1), dispatch(R1), notify (reads dispatchedVia)
  assert.deepEqual(imp.completed, ['s1', 's2']);
  assert.ok(imp.preserved.includes('s3')); // load does not depend on the route
});

test('a change no remaining step reads is not material', () => {
  const refs = referencedFacts(D.domain, D.goal, D.plan, ctx(D.facts));
  assert.ok(refs.has('route:R1.status'));
  assert.ok(!refs.has('route:R3.status'));
  assert.ok(!refs.has('weather:depot.tempC'));
});

test('edit distance is a transparent Levenshtein over step signatures', () => {
  const a = D.plan;
  assert.equal(editDistance(a, a), 0);
  assert.equal(editDistance(a, a.toSpliced(4, 1, { id: 'x', action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R2' } })), 1);
});

test('ingest: duplicate, reused id, unknown source, bad signature, namespace, stale seq, stale time', () => {
  let w = initialWorld(D.facts);
  const o1 = obs({ eventId: 'e1', source: 'traffic-authority', seq: 5, fact: 'route:R1.status', value: 'closed', observedAt: 6 });
  let r = ingest(w, o1); assert.equal(r.v.kind, 'applied'); w = r.w;
  assert.equal(ingest(w, o1).v.kind, 'duplicate');
  assert.match((ingest(w, obs({ ...o1, value: 'open' })).v as { reason: string }).reason, /reused/);
  assert.match((ingest(w, obs({ eventId: 'e2', source: 'press-office', seq: 1, fact: 'route:R2.status', value: 'closed', observedAt: 7 }, 'k')).v as { reason: string }).reason, /unknown source/);
  assert.match((ingest(w, { ...obs({ eventId: 'e3', source: 'traffic-authority', seq: 6, fact: 'route:R2.status', value: 'closed', observedAt: 7 }), sig: 'f00' }).v as { reason: string }).reason, /signature/);
  assert.match((ingest(w, obs({ eventId: 'e4', source: 'weather-feed', seq: 1, fact: 'route:R2.status', value: 'closed', observedAt: 7 })).v as { reason: string }).reason, /may not assert/);
  assert.equal(ingest(w, obs({ eventId: 'e5', source: 'traffic-authority', seq: 4, fact: 'route:R1.status', value: 'open', observedAt: 7 })).v.kind, 'stale');
  const outranked = ingest(w, obs({ eventId: 'e6', source: 'road-sensor-7', seq: 1, fact: 'route:R1.status', value: 'open', observedAt: 7 })).v;
  assert.match((outranked as { reason: string }).reason, /outranked/, 'a sensor cannot overwrite the authority');
  assert.match((ingest(w, obs({ eventId: 'e7', source: 'road-sensor-7', seq: 2, fact: 'route:R2.status', value: 'closed', observedAt: 1_000_000 })).v as { reason: string }).reason, /outside the accepted window/);
  assert.match((ingest(w, obs({ eventId: 'e8', source: 'road-sensor-7', seq: 3, fact: 'route:R2.etaMin', value: 5, observedAt: 7 })).v as { reason: string }).reason, /may not assert/, 'sensor may assert status only');
  assert.match((ingest(w, obs({ eventId: 'e9', source: 'traffic-authority', seq: 9, fact: 'route:R2.status', value: 7, observedAt: 7 })).v as { reason: string }).reason, /must be a string/);
});

test('a forged event cannot reserve the id of the genuine event that follows it', () => {
  let w = initialWorld(D.facts);
  const genuine = obs({ eventId: 'X', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 6 });
  const r1 = ingest(w, { ...genuine, sig: 'forged' });
  assert.equal(r1.v.kind, 'rejected'); w = r1.w;
  const r2 = ingest(w, genuine);
  assert.equal(r2.v.kind, 'applied');
  assert.equal(r2.w.facts['route:R1.status'], 'closed');
});

test('flapping: repeated value changes make a fact unstable; only an operator confirmation clears it', () => {
  let w = initialWorld(D.facts);
  for (let i = 0; i < FLAP_CHANGES; i++) {
    w = ingest(w, obs({ eventId: `f${i}`, source: 'road-sensor-7', seq: i + 1, fact: 'route:R1.status', value: i % 2 ? 'open' : 'closed', observedAt: 2 + i })).w;
  }
  assert.deepEqual(w.unstable, ['route:R1.status']);
  w = ingest(w, obs({ eventId: 'auth', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'open', observedAt: 9 })).w;
  assert.deepEqual(w.unstable, ['route:R1.status'], 'an authority wins on rank but does not lift a containment');
  assert.deepEqual(confirm(w, 'route:R1.status', 'closed', 10, 2).unstable, []);
});

test('the engine never re-evaluates without an input, and forged events change nothing', () => {
  const start: Ev = { t: 'start', runId: 'r', scenario: 'delivery', context: startContext('delivery', 'keel'), at: 0 };
  const log: Ev[] = [start, ...decide(null, start)];
  const forged: Ev = { t: 'observation', at: 1, obs: obs({ eventId: 'x', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 1 }, 'wrong-key') };
  const before = fold(log);
  const d = decide(before, forged);
  assert.deepEqual(d.map((e) => e.t), ['verdict']);
  assert.equal(fold([...log, forged, ...d]).world.facts['route:R1.status'], 'open');
});
