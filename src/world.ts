// World model: the agent's beliefs, built only from verified observations and its own effect receipts.
// Observations are untrusted input; this module decides which ones are allowed to change a belief.
import { createHmac } from 'node:crypto';
import type { Facts, Json } from './model.ts';

export type Source = { id: string; key: string; mayAssert: string[]; authoritative: boolean };
export type Observation = { eventId: string; source: string; seq: number; fact: string; value: Json; observedAt: number; sig: string };

export type FactMeta = { source: string; eventId: string; observedAt: number };
export type WorldState = {
  rev: number;
  facts: Facts;
  meta: Record<string, FactMeta>;
  seen: Record<string, string>;         // eventId -> canonical content (dedupe + reuse detection)
  lastSeq: Record<string, number>;      // `${source}|${fact}` -> highest seq applied
  changes: Record<string, number[]>;    // fact -> observedAt of recent value changes
  unstable: string[];
};

export type Ingest =
  | { kind: 'applied'; changed: boolean; prev: Json | undefined; becameUnstable: boolean; cleared: boolean }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'stale'; reason: string };

/** Flap rule: this many value changes of one fact within FLAP_WINDOW observed-time ticks = unstable. */
export const FLAP_CHANGES = 3;
export const FLAP_WINDOW = 30;

export const canonical = (o: Omit<Observation, 'sig'>) =>
  [o.eventId, o.source, o.seq, o.fact, JSON.stringify(o.value), o.observedAt].join('|');
export const sign = (o: Omit<Observation, 'sig'>, key: string) => createHmac('sha256', key).update(canonical(o)).digest('hex');

export function initialWorld(facts: Facts): WorldState {
  const meta: Record<string, FactMeta> = {};
  for (const k of Object.keys(facts)) meta[k] = { source: 'scenario', eventId: 'initial', observedAt: 0 };
  return { rev: 0, facts: { ...facts }, meta, seen: {}, lastSeq: {}, changes: {}, unstable: [] };
}

/** Pure check: what would ingesting `o` do? `apply` performs it. Split so the engine can record the verdict first. */
export function judge(w: WorldState, o: Observation, sources: Record<string, Source>): Ingest {
  const prior = w.seen[o.eventId];
  if (prior !== undefined) return prior === canonical(o) ? { kind: 'duplicate' } : { kind: 'rejected', reason: `event id ${o.eventId} reused with different content` };
  const src = sources[o.source];
  if (!src) return { kind: 'rejected', reason: `unknown source "${o.source}"` };
  if (o.sig !== sign(o, src.key)) return { kind: 'rejected', reason: `signature does not verify for ${o.source}` };
  if (!src.mayAssert.some((p) => o.fact.startsWith(p))) return { kind: 'rejected', reason: `${o.source} may not assert ${o.fact}` };
  const lane = `${o.source}|${o.fact}`;
  if ((w.lastSeq[lane] ?? -1) >= o.seq) return { kind: 'stale', reason: `seq ${o.seq} ≤ last applied ${w.lastSeq[lane]} from ${o.source}` };
  const m = w.meta[o.fact];
  if (m && o.observedAt < m.observedAt) return { kind: 'stale', reason: `observed at t${o.observedAt}, current belief is from t${m.observedAt}` };
  const prev = w.facts[o.fact];
  const changed = prev !== o.value;
  const recent = changed ? [...(w.changes[o.fact] ?? []), o.observedAt].filter((t) => o.observedAt - t < FLAP_WINDOW) : (w.changes[o.fact] ?? []);
  const wasUnstable = w.unstable.includes(o.fact);
  // ponytail: an authoritative source resets the flap history and is trusted outright; a flapping authority is out of scope.
  const cleared = src.authoritative && wasUnstable;
  const becameUnstable = !src.authoritative && !wasUnstable && recent.length >= FLAP_CHANGES;
  return { kind: 'applied', changed, prev, becameUnstable, cleared };
}

export function apply(w: WorldState, o: Observation, v: Extract<Ingest, { kind: 'applied' }>, sources: Record<string, Source>): WorldState {
  const src = sources[o.source];
  const changes = { ...w.changes };
  if (src.authoritative) changes[o.fact] = [o.observedAt];
  else if (v.changed) changes[o.fact] = [...(changes[o.fact] ?? []), o.observedAt].filter((t) => o.observedAt - t < FLAP_WINDOW);
  let unstable = w.unstable;
  if (v.cleared) unstable = unstable.filter((k) => k !== o.fact);
  if (v.becameUnstable) unstable = [...unstable, o.fact];
  return {
    rev: w.rev + (v.changed || v.cleared || v.becameUnstable ? 1 : 0),
    facts: { ...w.facts, [o.fact]: o.value },
    meta: { ...w.meta, [o.fact]: { source: o.source, eventId: o.eventId, observedAt: o.observedAt } },
    seen: { ...w.seen, [o.eventId]: canonical(o) },
    lastSeq: { ...w.lastSeq, [`${o.source}|${o.fact}`]: o.seq },
    changes,
    unstable,
  };
}

/** Effect receipts are the agent's own evidence: they update beliefs without any source check. */
export function applyReceipt(w: WorldState, facts: Facts, opId: string, at: number): WorldState {
  const meta = { ...w.meta };
  for (const k of Object.keys(facts)) meta[k] = { source: 'receipt', eventId: opId, observedAt: at };
  return { ...w, rev: w.rev + 1, facts: { ...w.facts, ...facts }, meta };
}

/** Operator override of an unstable fact (human confirms the value). */
export function confirm(w: WorldState, fact: string, value: Json, at: number): WorldState {
  return {
    ...w,
    rev: w.rev + 1,
    facts: { ...w.facts, [fact]: value },
    meta: { ...w.meta, [fact]: { source: 'operator', eventId: `confirm@${at}`, observedAt: at } },
    changes: { ...w.changes, [fact]: [at] },
    unstable: w.unstable.filter((k) => k !== fact),
  };
}
