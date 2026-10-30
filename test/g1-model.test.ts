// G1: typed plan model, world events, contradiction detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalCond, project, impact, editDistance, referencedFacts } from '../src/model.ts';
import { apply, initialWorld, judge, sign, FLAP_CHANGES } from '../src/world.ts';
import type { Observation, WorldState } from '../src/world.ts';
import { scenarios } from '../src/scenarios.ts';
import { decide, fold } from '../src/engine.ts';
import type { Ev } from '../src/engine.ts';

const D = scenarios.delivery;
const obs = (o: Omit<Observation, 'sig'>, key = D.sources[o.source]?.key ?? 'x'): Observation => ({ ...o, sig: sign(o, key) });
const ingest = (w: WorldState, o: Observation) => {
  const v = judge(w, o, D.sources);
  return { v, w: v.kind === 'applied' ? apply(w, o, v, D.sources) : w };
};

test('conditions are three-valued: unstable or missing facts are UNKNOWN, never true', () => {
  const f = { a: 1, b: 2 };
  assert.equal(evalCond({ fact: 'a', op: 'lte', ref: 'b' }, f), 'true');
  assert.equal(evalCond({ fact: 'a', op: 'eq', value: 2 }, f), 'false');
  assert.equal(evalCond({ fact: 'missing', op: 'eq', value: 1 }, f), 'unknown');
  assert.equal(evalCond({ fact: 'a', op: 'eq', value: 1 }, f, new Set(['a'])), 'unknown');
});

test('projection finds the exact broken assumption from contracts, not from scenario code', () => {
  const facts = { ...D.facts, 'route:R1.status': 'closed' };
  const p = project(D.domain, D.goal, D.plan, facts, new Set());
  assert.equal(p.ok, false);
  assert.deepEqual(p.failures.map((f) => [f.stepId, f.cond.fact]), [['s5', 'route:R1.status']]);
});

test('impact: entity-bound and downstream steps are affected; completed and unrelated steps are preserved', () => {
  const facts = { ...D.facts, 'route:R1.status': 'closed' };
  const p = project(D.domain, D.goal, D.plan, facts, new Set());
  const imp = impact(D.domain, D.plan, p.failures, new Set(['pick:1042', 'pack:1042']), 'R1');
  assert.deepEqual(imp.affected, ['s4', 's5', 's6']); // label(R1), dispatch(R1), notify (reads dispatchedVia)
  assert.deepEqual(imp.completed, ['s1', 's2']);
  assert.ok(imp.preserved.includes('s3')); // load does not depend on the route
});

test('a change no remaining step reads is not material', () => {
  const refs = referencedFacts(D.domain, D.goal, D.plan, new Set());
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
  assert.equal(ingest(w, obs({ eventId: 'e6', source: 'road-sensor-7', seq: 1, fact: 'route:R1.status', value: 'open', observedAt: 3 })).v.kind, 'stale');
});

test('flapping: repeated changes from a non-authoritative source make the fact unstable; an authority clears it', () => {
  let w = initialWorld(D.facts);
  for (let i = 0; i < FLAP_CHANGES; i++) {
    w = ingest(w, obs({ eventId: `f${i}`, source: 'road-sensor-7', seq: i + 1, fact: 'route:R1.status', value: i % 2 ? 'open' : 'closed', observedAt: 2 + i })).w;
  }
  assert.deepEqual(w.unstable, ['route:R1.status']);
  w = ingest(w, obs({ eventId: 'auth', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 9 })).w;
  assert.deepEqual(w.unstable, []);
});

test('the engine never re-evaluates without an input, and forged events change nothing', () => {
  const start: Ev = { t: 'start', runId: 'r', scenario: 'delivery', policy: 'keel', at: 0 };
  const log: Ev[] = [start, ...decide(null, start)];
  const forged: Ev = { t: 'observation', at: 1, obs: obs({ eventId: 'x', source: 'traffic-authority', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 1 }, 'wrong-key') };
  const before = fold(log);
  const d = decide(before, forged);
  assert.deepEqual(d.map((e) => e.t), ['verdict']);
  assert.equal(fold([...log, forged, ...d]).world.facts['route:R1.status'], 'open');
});
