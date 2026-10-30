// SIMULATED external world. Nothing here touches a real road, truck, region or customer.
// It owns ground truth (which the agent never reads) and applies effects idempotently by operation id.
import { createHash } from 'node:crypto';
import type { Facts, Params } from './model.ts';
import type { Scenario } from './scenarios.ts';
import type { Store } from './store.ts';

export type ExecResult = { kind: 'receipt'; applied: Facts; detail: string } | { kind: 'timeout' };
export type Faults = { dropAckOnce?: string[] }; // effect keys whose first acknowledgement is lost AFTER applying

export class Sim {
  private dropped = new Set<string>();
  private store: Store;
  faults: Faults;
  constructor(store: Store, faults: Faults = {}) { this.store = store; this.faults = faults; }

  /** Truth at `tick`: initial facts, then scheduled and visitor-made world changes, then applied effects, in time order. */
  truth(runId: string, S: Scenario, tick: number): Facts {
    const t: Facts = { ...S.facts };
    const effects = this.effects(runId);
    const changes = [
      ...[...S.truth, ...this.store.worldChanges(runId)].filter((c) => c.tick <= tick).map((c) => ({ tick: c.tick, order: 0, sets: { [c.fact]: c.value } as Facts })),
      ...effects.filter((e) => e.tick <= tick).map((e, i) => ({ tick: e.tick, order: 1 + i, sets: e.sets })),
    ].sort((a, b) => a.tick - b.tick || a.order - b.order);
    for (const c of changes) Object.assign(t, c.sets);
    return t;
  }

  effects(runId: string): { opId: string; action: string; params: Params; tick: number; harm: string | null; sets: Facts }[] {
    return (this.store.db.prepare('SELECT * FROM sim_effects WHERE run_id = ? ORDER BY tick, rowid').all(runId) as Record<string, unknown>[])
      .map((r) => ({ opId: r.op_id as string, action: r.action as string, params: JSON.parse(r.params as string), tick: Number(r.tick), harm: (r.harm as string) ?? null, sets: JSON.parse(r.sets as string) }));
  }

  /**
   * Apply once per opId. A repeated opId returns the original receipt; an opId reused with other arguments is refused.
   * The receipt reports the mutation the executor ACTUALLY applied: the request, overridden by physics where the
   * world disagrees (e.g. real critical demand). The same mutation becomes simulator truth; replay consumes it verbatim.
   */
  execute(runId: string, S: Scenario, opId: string, action: string, params: Params, expect: Facts, effectKey: string, tick: number): ExecResult {
    const reqHash = createHash('sha256').update(JSON.stringify([runId, action, params])).digest('hex');
    const existing = this.store.db.prepare('SELECT request_hash, applied FROM sim_effects WHERE op_id = ?').get(opId) as { request_hash: string; applied: string } | undefined;
    if (existing) {
      if (existing.request_hash !== reqHash) throw new Error(`opId ${opId} reused with different arguments`);
      return { kind: 'receipt', applied: JSON.parse(existing.applied), detail: 'already applied (idempotent replay of the same operation)' };
    }
    const physics = S.physics[action]?.(params, this.truth(runId, S, tick)) ?? {};
    const actual: Facts = { ...expect, ...physics.set };
    this.store.db.prepare('INSERT INTO sim_effects (op_id, run_id, action, params, request_hash, tick, harm, sets, applied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(opId, runId, action, JSON.stringify(params), reqHash, tick, physics.harm ?? null, JSON.stringify(actual), JSON.stringify(actual));
    if (this.faults.dropAckOnce?.includes(effectKey) && !this.dropped.has(`${runId}|${effectKey}`)) {
      this.dropped.add(`${runId}|${effectKey}`);
      return { kind: 'timeout' }; // the effect happened; only the acknowledgement was lost
    }
    return { kind: 'receipt', applied: actual, detail: 'applied' };
  }

  lookup(opId: string): { found: 'yes' | 'no'; applied: Facts | null } {
    const r = this.store.db.prepare('SELECT applied FROM sim_effects WHERE op_id = ?').get(opId) as { applied: string } | undefined;
    return r ? { found: 'yes', applied: JSON.parse(r.applied) } : { found: 'no', applied: null };
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
