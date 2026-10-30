// Comparison metrics. Every number is recomputed from the persisted event log and the simulator's effect table.
import { contract } from './model.ts';
import type { RevisionRecord } from './engine.ts';
import type { Store } from './store.ts';
import type { Sim } from './sim.ts';
import { scenarios } from './scenarios.ts';

export type RunMetrics = {
  runId: string; policy: string; status: string; pause: string | null;
  beliefGoalMet: boolean | null;     // what the agent itself reported
  goalMet: boolean; truth: string;   // what actually happened in the simulated world
  invalidActions: number;            // effects the simulated world recorded as harmful
  prevented: number;                 // steps whose broken assumption was caught before they ran
  fenced: number;                    // operations cancelled inside their preparation window
  revisions: number;
  preservedCompleted: number;        // completed steps carried unchanged into the latest revision
  duplicateEffects: number;          // same semantic effect applied more than once
  wastedEffects: number;             // applied effects that no longer belong to the final plan
  editDistance: number;              // sum over committed revisions
  rejectedObservations: number; staleObservations: number; duplicateObservations: number;
  latency: { eventId: string; detectMs: number; commitMs: number | null; detectTicks: number; commitTicks: number | null }[];
};

export function runMetrics(store: Store, sim: Sim, runId: string): RunMetrics {
  const rows = store.rows(runId);
  const start = rows[0]?.ev;
  if (!start || start.t !== 'start') throw new Error(`no run ${runId}`);
  const S = scenarios[start.scenario];
  const evs = rows.map((r) => r.ev);
  const revs = evs.flatMap((e) => (e.t === 'revision' ? [e.record as RevisionRecord] : []));
  const lastTick = rows.at(-1)!.tick;
  const out = sim.outcome(runId, S, lastTick);
  const effects = sim.effects(runId);
  const keys = effects.map((e) => contract(S.domain, e.action).effectKey(e.params));
  const finalPlan = revs.length ? revs.at(-1)!.after : S.plan;
  const finalKeys = new Set(finalPlan.map((x) => contract(S.domain, x.action).effectKey(x.params)));
  const executedSteps = new Set(evs.flatMap((e) => (e.t === 'dispatch' ? [e.stepId] : [])));
  const caught = new Set(evs.flatMap((e) => (e.t === 'contradiction' ? e.failures.filter((f) => f.truth === 'false' || f.truth === 'unknown').map((f) => f.stepId) : [])));
  const fenced = evs.filter((e) => e.t === 'fenced' && !e.reason.startsWith('process restarted')).length;
  const completed = evs.find((e) => e.t === 'completed');
  const status = [...evs].reverse().find((e) => ['completed', 'paused', 'resumed', 'stopped'].includes(e.t));
  const obsRow = new Map(rows.filter((r) => r.ev.t === 'observation').map((r) => [(r.ev as { obs: { eventId: string } }).obs.eventId, r]));
  const latency = rows.flatMap((r) => {
    if (r.ev.t !== 'contradiction' || !r.ev.trigger) return [];
    const o = obsRow.get(r.ev.trigger.eventId);
    if (!o) return [];
    const trigId = r.ev.trigger.eventId;
    const commit = rows.find((x) => x.n > r.n && x.ev.t === 'revision' && x.ev.record.trigger?.eventId === trigId);
    return [{ eventId: trigId, detectMs: r.wall - o.wall, commitMs: commit ? commit.wall - o.wall : null, detectTicks: r.tick - o.tick, commitTicks: commit ? commit.tick - o.tick : null }];
  }).filter((l, i, a) => a.findIndex((x) => x.eventId === l.eventId) === i);
  const verdicts = evs.flatMap((e) => (e.t === 'verdict' ? [e.v.kind] : []));
  return {
    runId, policy: start.policy,
    status: status?.t === 'resumed' ? 'running' : status?.t ?? 'running',
    pause: status?.t === 'paused' ? status.reason : null,
    beliefGoalMet: completed && completed.t === 'completed' ? completed.beliefGoalMet : null,
    goalMet: out.met, truth: out.detail,
    invalidActions: effects.filter((e) => e.harm).length,
    prevented: [...caught].filter((id) => !executedSteps.has(id)).length,
    fenced,
    revisions: revs.length,
    preservedCompleted: revs.length ? revs.at(-1)!.completed.length : 0,
    duplicateEffects: keys.length - new Set(keys).size,
    wastedEffects: keys.filter((k) => !finalKeys.has(k)).length,
    editDistance: revs.reduce((n, r) => n + r.edit.distance, 0),
    rejectedObservations: verdicts.filter((k) => k === 'rejected').length,
    staleObservations: verdicts.filter((k) => k === 'stale').length,
    duplicateObservations: verdicts.filter((k) => k === 'duplicate').length,
    latency,
  };
}
