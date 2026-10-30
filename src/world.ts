// World model: the agent's beliefs, built only from verified observations and its own effect receipts.
// Observations are untrusted input; this module decides which ones may change a belief.
import { createHmac } from 'node:crypto';
import type { Facts, Json } from './model.ts';

/**
 * A registered producer. `mayAssert` uses exact `kind:*.attribute` patterns (`*` = one entity).
 * `rank` arbitrates between sources: a lower-ranked source cannot overwrite a fact last set by a higher one.
 */
export type Source = { id: string; key: string; mayAssert: string[]; rank: number };
/** Allowed values for enumerated fact classes (`kind:*.attribute` pattern -> values). Anything else is rejected. */
export type Enums = Record<string, Json[]>;
export type Observation = { eventId: string; source: string; seq: number; fact: string; value: Json; observedAt: number; sig: string };

export type FactMeta = { source: string; eventId: string; observedAt: number; rank: number };
export type WorldState = {
  rev: number;
  facts: Facts;
  meta: Record<string, FactMeta>;
  seen: Record<string, string>;         // accepted eventId -> canonical content (dedupe + reuse detection)
  lastSeq: Record<string, number>;      // `${source}|${fact}` -> highest seq applied
  changes: Record<string, number[]>;    // fact -> observedAt ticks of recent value changes
  unstable: string[];
};

export type Ingest =
  | { kind: 'applied'; changed: boolean; prev: Json | undefined; becameUnstable: boolean }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'stale'; reason: string };

/** Flap rule: this many value changes of one fact within FLAP_WINDOW ticks = unstable, whatever the source. */
export const FLAP_CHANGES = 3;
export const FLAP_WINDOW = 30;
/** Observations must be stamped within this many ticks of the simulation clock, never in the future. */
export const MAX_AGE = 30;

export const canonical = (o: Omit<Observation, 'sig'>) =>
  [o.eventId, o.source, o.seq, o.fact, JSON.stringify(o.value), o.observedAt].join('|');
export const sign = (o: Omit<Observation, 'sig'>, key: string) => createHmac('sha256', key).update(canonical(o)).digest('hex');
export const permits = (pattern: string, fact: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w-]+')}$`).test(fact);

export function initialWorld(facts: Facts): WorldState {
  const meta: Record<string, FactMeta> = {};
  for (const k of Object.keys(facts)) meta[k] = { source: 'initial', eventId: 'initial', observedAt: 0, rank: 0 };
  return { rev: 0, facts: { ...facts }, meta, seen: {}, lastSeq: {}, changes: {}, unstable: [] };
}

/** Pure verdict: what would ingesting `o` at clock `now` do? `apply` performs it. */
export function judge(w: WorldState, o: Observation, sources: Record<string, Source>, now: number, enums: Enums = {}): Ingest {
  if (!o || typeof o.eventId !== 'string' || o.eventId.length > 80 || typeof o.source !== 'string' || typeof o.fact !== 'string') return { kind: 'rejected', reason: 'malformed observation' };
  if (!Number.isSafeInteger(o.seq) || o.seq < 0) return { kind: 'rejected', reason: `sequence ${JSON.stringify(o.seq)} is not a non-negative safe integer` };
  const src = Object.hasOwn(sources, o.source) ? sources[o.source] : undefined;
  if (!src) return { kind: 'rejected', reason: `unknown source "${o.source}"` };
  if (typeof o.sig !== 'string' || o.sig !== sign(o, src.key)) return { kind: 'rejected', reason: `signature does not verify for ${o.source}` };
  if (!src.mayAssert.some((p) => permits(p, o.fact))) return { kind: 'rejected', reason: `${o.source} may not assert ${o.fact}` };
  if (!Number.isInteger(o.observedAt) || o.observedAt > now || now - o.observedAt > MAX_AGE) return { kind: 'rejected', reason: `timestamp t${o.observedAt} outside the accepted window at t${now}` };
  if (!Object.hasOwn(w.facts, o.fact)) return { kind: 'rejected', reason: `${o.fact} is not a known fact` };
  if (typeof o.value !== typeof w.facts[o.fact]) return { kind: 'rejected', reason: `${o.fact} must be a ${typeof w.facts[o.fact]}` };
  if (typeof o.value === 'number' && !Number.isFinite(o.value)) return { kind: 'rejected', reason: `${o.fact} must be a finite number` };
  const allowed = Object.entries(enums).find(([p]) => permits(p, o.fact))?.[1];
  if (allowed && !allowed.includes(o.value)) return { kind: 'rejected', reason: `${JSON.stringify(o.value)} is not a known value of ${o.fact} (${allowed.join(', ')})` };
  // Only authenticated, permitted events reach dedupe, so a forgery cannot reserve a genuine event's id.
  const prior = w.seen[o.eventId];
  if (prior !== undefined) return prior === canonical(o) ? { kind: 'duplicate' } : { kind: 'rejected', reason: `event id ${o.eventId} reused with different content` };
  const lane = `${o.source}|${o.fact}`;
  if ((w.lastSeq[lane] ?? -1) >= o.seq) return { kind: 'stale', reason: `seq ${o.seq} ≤ last applied ${w.lastSeq[lane]} from ${o.source}` };
  const m = w.meta[o.fact];
  const prev = w.facts[o.fact];
  if (m && m.rank > src.rank && prev !== o.value) return { kind: 'stale', reason: `outranked: ${m.source} set ${o.fact} = ${JSON.stringify(prev)}` };
  const changed = prev !== o.value;
  const recent = [...(w.changes[o.fact] ?? []), ...(changed ? [o.observedAt] : [])].filter((t) => o.observedAt - t < FLAP_WINDOW);
  const becameUnstable = changed && !w.unstable.includes(o.fact) && recent.length >= FLAP_CHANGES;
  return { kind: 'applied', changed, prev, becameUnstable };
}

export function apply(w: WorldState, o: Observation, v: Extract<Ingest, { kind: 'applied' }>, sources: Record<string, Source>): WorldState {
  const src = sources[o.source];
  const changes = v.changed ? { ...w.changes, [o.fact]: [...(w.changes[o.fact] ?? []), o.observedAt].filter((t) => o.observedAt - t < FLAP_WINDOW) } : w.changes;
  return {
    rev: w.rev + (v.changed || v.becameUnstable ? 1 : 0),
    facts: { ...w.facts, [o.fact]: o.value },
    // Lower-ranked corroboration of the same value keeps the higher-ranked provenance (rank cannot be laundered).
    meta: { ...w.meta, [o.fact]: !v.changed && (w.meta[o.fact]?.rank ?? 0) > src.rank ? w.meta[o.fact] : { source: o.source, eventId: o.eventId, observedAt: o.observedAt, rank: src.rank } },
    seen: { ...w.seen, [o.eventId]: canonical(o) },
    lastSeq: { ...w.lastSeq, [`${o.source}|${o.fact}`]: o.seq },
    changes,
    unstable: v.becameUnstable ? [...w.unstable, o.fact] : w.unstable,
  };
}

/** Effect receipts are the agent's own evidence: they apply the mutation the executor confirmed. */
export function applyReceipt(w: WorldState, facts: Facts, opId: string, at: number): WorldState {
  const meta = { ...w.meta };
  for (const k of Object.keys(facts)) meta[k] = { source: 'receipt', eventId: opId, observedAt: at, rank: 0 };
  return { ...w, rev: w.rev + 1, facts: { ...w.facts, ...facts }, meta };
}

/** Operator confirms the value of an unstable fact (the only way instability clears), at the top source rank. */
export function confirm(w: WorldState, fact: string, value: Json, at: number, rank: number): WorldState {
  return {
    ...w,
    rev: w.rev + 1,
    facts: { ...w.facts, [fact]: value },
    meta: { ...w.meta, [fact]: { source: 'operator', eventId: `confirm@${at}`, observedAt: at, rank } },
    changes: { ...w.changes, [fact]: [] },
    unstable: w.unstable.filter((k) => k !== fact),
  };
}
