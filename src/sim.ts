// SIMULATED external world. Nothing here touches a real road, truck, region or customer.
// It owns ground truth (which the agent never reads) and applies effects idempotently by operation id.
// The store is the source of truth; per-run caches make truth queries cheap and are written through.
import { createHash } from 'node:crypto';
import type { Facts, Params } from './model.ts';
import type { Scenario, SimEffect } from './scenarios.ts';
import type { EffectRow, Injection, Store } from './store.ts';

export type ExecResult = { kind: 'receipt'; applied: Facts; detail: string } | { kind: 'timeout' };
export type Faults = { dropAckOnce?: string[] }; // effect keys whose first acknowledgement is lost AFTER applying

export class Sim {
  private dropped = new Set<string>();
  private store: Store;
  private fx = new Map<string, EffectRow[]>();       // runId -> applied effects, in order
  private changes = new Map<string, Injection[]>();   // session -> visitor injections (only `real` ones change truth)
  private sessionOf = new Map<string, string>();      // runId -> session
  faults: Faults;
  constructor(store: Store, faults: Faults = {}) { this.store = store; this.faults = faults; }

  /** Load (or reload after a restart) a run's simulator state from the store. */
  async load(runId: string, session: string) {
    this.sessionOf.set(runId, session);
    this.fx.set(runId, await this.store.effects(runId));
    if (!this.changes.has(session)) this.changes.set(session, await this.store.injections(session));
  }
  forget(runId: string) { this.fx.delete(runId); }
  sessionFor(runId: string): string { return this.sessionOf.get(runId) ?? ''; }

  private effectsOf(runId: string): EffectRow[] {
    const e = this.fx.get(runId);
    if (!e) throw new Error(`simulator state for ${runId} not loaded`);
    return e;
  }

  /** Truth at `tick`: initial facts, then scheduled and visitor-made world changes, then applied effects, in time order. */
  truth(runId: string, S: Scenario, tick: number): Facts {
    const t: Facts = { ...S.facts };
    const visitor = (this.changes.get(this.sessionOf.get(runId) ?? '') ?? []).filter((c) => c.real);
    const changes = [
      ...[...S.truth, ...visitor].filter((c) => c.tick <= tick).map((c) => ({ tick: c.tick, order: 0, sets: { [c.fact]: c.value } as Facts })),
      ...this.effectsOf(runId).filter((e) => e.tick <= tick).map((e, i) => ({ tick: e.tick, order: 1 + i, sets: e.applied })),
    ].sort((a, b) => a.tick - b.tick || a.order - b.order);
    for (const c of changes) Object.assign(t, c.sets);
    return t;
  }

  effects(runId: string): SimEffect[] {
    return this.effectsOf(runId).map((e) => ({ action: e.action, params: e.params, tick: e.tick, harm: e.harm }));
  }

  /** Persist a visitor injection before any lane receives it; a real one also changes shared SIMULATED truth. */
  async addInjection(session: string, i: Injection) {
    await this.store.addInjection(session, i);
    this.changes.set(session, [...(this.changes.get(session) ?? []), i]);
  }
  injections(session: string): Injection[] { return this.changes.get(session) ?? []; }
  effectRows(runId: string): EffectRow[] { return this.effectsOf(runId); }

  /**
   * Apply once per opId. A repeated opId returns the original receipt; an opId reused with other arguments is refused.
   * The receipt reports the mutation the executor ACTUALLY applied: the request, overridden by physics where the
   * world disagrees (e.g. real critical demand). The same mutation becomes simulator truth; replay consumes it verbatim.
   */
  async execute(runId: string, S: Scenario, opId: string, action: string, params: Params, expect: Facts, effectKey: string, tick: number): Promise<ExecResult> {
    const requestHash = createHash('sha256').update(JSON.stringify([runId, action, params])).digest('hex');
    const known = this.effectsOf(runId).find((e) => e.opId === opId);
    const physics = known ? {} : S.physics[action]?.(params, this.truth(runId, S, tick)) ?? {};
    const res = known ? { inserted: false, row: known } : await this.store.insertEffect({ opId, runId, action, params, requestHash, tick, harm: physics.harm ?? null, applied: { ...expect, ...physics.set } });
    if (res.row.requestHash !== requestHash) throw new Error(`opId ${opId} reused with different arguments`);
    if (!res.inserted) {
      if (!known) this.effectsOf(runId).push(res.row); // applied by another process before us: adopt its record
      return { kind: 'receipt', applied: res.row.applied, detail: 'already applied (idempotent replay of the same operation)' };
    }
    this.effectsOf(runId).push(res.row);
    if (this.faults.dropAckOnce?.includes(effectKey) && !this.dropped.has(`${runId}|${effectKey}`)) {
      this.dropped.add(`${runId}|${effectKey}`);
      return { kind: 'timeout' }; // the effect happened; only the acknowledgement was lost
    }
    return { kind: 'receipt', applied: res.row.applied, detail: 'applied' };
  }

  /** Authoritative lookup by operation id, straight from the store (never the cache): did it happen? */
  async lookup(runId: string, opId: string): Promise<{ found: 'yes' | 'no'; applied: Facts | null }> {
    const r = (await this.store.effects(runId)).find((e) => e.opId === opId);
    const cache = this.fx.get(runId);
    if (r && cache && !cache.some((e) => e.opId === opId)) cache.push(r); // adopt it: truth, reports and outcome must see it
    return r ? { found: 'yes', applied: r.applied } : { found: 'no', applied: null };
  }

  /** World time at which this run's outcome is decided (the session keeps the clock running until then). */
  settleTick(runId: string, S: Scenario): number {
    return S.settle?.((t) => this.truth(runId, S, t), this.effects(runId)) ?? 0;
  }

  outcome(runId: string, S: Scenario, tick: number) {
    const effects = this.effects(runId);
    return { ...S.outcome((t) => this.truth(runId, S, t), effects, tick), harms: effects.map((e) => e.harm).filter((h): h is string => !!h) };
  }
}
