// The adaptive engine: a pure, event-sourced decision function.
//   state' = reduce(state, event)       — folding the log rebuilds any run exactly
//   decisions = decide(state, input)    — same state + same input => same decisions (replayable)
// The imperative shell (runner.ts) persists [input, ...decisions] atomically and performs the I/O the
// decisions ask for (dispatch/commit_effect -> simulator, repair_requested -> planners, reconcile_requested).
// Nothing here reads a clock: the engine only ever wakes because an input arrived.
import { createHash } from 'node:crypto';
import { activeObligations, condText, contract, entityOf, evalCond, impact, project, referencedFacts, stepSig } from './model.ts';
import type { Ctx, Facts, Goal, Json, Params, Plan, Step } from './model.ts';
import { validate } from './repair.ts';
import type { Candidate, Check } from './repair.ts';
import { apply, applyReceipt, confirm, initialWorld, judge } from './world.ts';
import type { Ingest, Observation, WorldState } from './world.ts';
import { contractHash, scenarios } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

export type PolicyName = 'keel' | 'static' | 'naive' | 'guarded';
export type Policy = {
  name: PolicyName; label: string;
  detect: boolean;            // re-check plan assumptions when observations arrive
  stabilityGate: boolean;     // flapping facts evaluate UNKNOWN; returning to an abandoned plan pauses
  budget: number | null;      // max committed revisions before PAUSE (null = unlimited)
  planBudget: number;         // max repair requests per run, including stale and failed ones
  reviseOnAnyChange: boolean; // replan even while the current plan is still valid
  rank: 'edit' | 'cost';
};
export const policies: Record<PolicyName, Policy> = {
  keel: { name: 'keel', label: 'KEEL', detect: true, stabilityGate: true, budget: 3, planBudget: 12, reviseOnAnyChange: false, rank: 'edit' },
  static: { name: 'static', label: 'Static / open loop', detect: false, stabilityGate: false, budget: 0, planBudget: 0, reviseOnAnyChange: false, rank: 'edit' },
  naive: { name: 'naive', label: 'Naive adaptive', detect: true, stabilityGate: false, budget: null, planBudget: 40, reviseOnAnyChange: true, rank: 'cost' },
  guarded: { name: 'guarded', label: 'Guarded static', detect: true, stabilityGate: true, budget: 0, planBudget: 12, reviseOnAnyChange: false, rank: 'edit' },
};

export type PauseKind = 'unstable' | 'no_repair' | 'budget' | 'ambiguous' | 'stale' | 'oscillation';
export type FailureView = { stepId: string; sig: string; cond: string; truth: string; actual: Json | undefined; obligation: string | null };
export type TriggerView = { eventId: string; source: string; fact: string; prev: Json | undefined; value: Json; observedAt: number };
export type RevisionRecord = {
  from: number; to: number; trigger: TriggerView | null; observations: string[]; because: string;
  oldAssumption: string | null; newObservation: string | null;
  contradiction: FailureView[]; affected: string[]; preserved: string[]; completed: string[];
  removed: string[]; added: string[]; edit: { inserted: number; removed: number; modified: number; distance: number };
  checks: Check[]; chosen: { origin: string; scope: string; rationale: string; cost: number; model?: Candidate['model'] };
  rejected: { origin: string; steps: string[]; failed: Check[] }[];
  before: Step[]; after: Step[];
};
export type RunContext = { facts: Facts; plan: Step[]; goal: Goal; policy: Policy; contractHash: string };

export type Ev =
  // ---- inputs: recorded verbatim; replay feeds exactly these back in
  | { t: 'start'; runId: string; scenario: string; context: RunContext; at: number }
  | { t: 'observation'; obs: Observation; at: number }
  | { t: 'effect_ready'; opId: string; gen: number; at: number }
  | { t: 'receipt'; opId: string; gen: number; applied: Facts; at: number; detail: string }
  | { t: 'effect_uncertain'; opId: string; gen: number; at: number }
  | { t: 'reconciled'; opId: string; gen: number; found: 'yes' | 'no' | 'unknown'; applied: Facts | null; at: number }
  | { t: 'planner_output'; requestId: string; candidates: Candidate[]; at: number }
  | { t: 'operator'; cmd: 'confirm' | 'resume' | 'abort'; fact?: string; value?: Json; at: number }
  | { t: 'recover'; at: number }
  // ---- decisions: derived; replay must reproduce them exactly
  | { t: 'verdict'; obs: Observation; v: Ingest }
  | { t: 'assessed'; fact: string | null; result: 'no_impact' | 'still_valid' | 'ignored_by_policy' | 'kept_plan'; detail: string }
  | { t: 'contradiction'; id: string; trigger: TriggerView | null; failures: FailureView[]; affected: string[]; preserved: string[]; awaiting: string | null }
  | { t: 'fenced'; opId: string; gen: number; stepId: string; reason: string }
  | { t: 'repair_requested'; requestId: string; basedOnRev: number; planVersion: number; contradictionId: string | null; attempt: number }
  | { t: 'candidate_stale'; requestId: string; basedOnRev: number; nowRev: number }
  | { t: 'revision'; record: RevisionRecord }
  | { t: 'dispatch'; opId: string; gen: number; stepId: string; action: string; params: Params; effectKey: string; commitment: string; duration: number; planVersion: number; retry: boolean }
  | { t: 'commit_effect'; opId: string; gen: number; expect: Facts }
  | { t: 'reconcile_requested'; opId: string; gen: number }
  | { t: 'paused'; kind: PauseKind; reason: string }
  | { t: 'resumed'; by: string }
  | { t: 'completed'; beliefGoalMet: boolean; detail: string }
  | { t: 'stopped'; reason: string };

export const INPUTS = new Set(['start', 'observation', 'effect_ready', 'receipt', 'effect_uncertain', 'reconciled', 'planner_output', 'operator', 'recover']);

export type LedgerState = 'prepared' | 'committing' | 'done' | 'uncertain' | 'not_applied' | 'cancelled';
export type LedgerRow = { opId: string; gen: number; stepId: string; action: string; params: Params; effectKey: string; commitment: string; planVersion: number; state: LedgerState; expect: Facts | null; startedAt: number };
export type RunState = {
  runId: string; scenario: string; policy: PolicyName; cfg: Policy; goal: Goal;
  status: 'running' | 'repairing' | 'paused' | 'completed' | 'stopped';
  pause: { kind: PauseKind; reason: string } | null;
  world: WorldState; plan: Plan; plans: Plan[];
  ledger: Record<string, LedgerRow>; done: string[];
  inflight: string | null;
  pending: { requestId: string; basedOnRev: number; planVersion: number; contradictionId: string | null; attempt: number } | null;
  awaiting: { contradictionId: string; trigger: TriggerView | null } | null;
  lastContradiction: Extract<Ev, { t: 'contradiction' }> | null;
  sinceRevision: string[];
  abandoned: { sig: string; doneCount: number }[];
  revisions: number; budget: number | null; proposals: number; tick: number; seq: number;
};

const sc = (s: RunState): Scenario => scenarios[s.scenario];
const unstableOf = (s: RunState) => new Set(s.cfg.stabilityGate ? s.world.unstable : []);
const keyOf = (s: RunState, x: Pick<Step, 'action' | 'params'>) => contract(sc(s).domain, x.action).effectKey(x.params);
export const remainingOf = (s: RunState) => s.plan.steps.filter((x) => !s.done.includes(keyOf(s, x)));
export const ctxOf = (s: RunState): Ctx => {
  const done = new Set(s.done);
  return { f: s.world.facts, done, unstable: unstableOf(s), active: activeObligations(sc(s).domain, s.plan.steps, done) };
};
const tailSig = (steps: Pick<Step, 'action' | 'params'>[]) => steps.map(stepSig).join(' > ');
/** Semantic operation id = hash(run, effect). Each preparation of it gets a new generation. */
export const opIdFor = (runId: string, effectKey: string) => createHash('sha256').update(`${runId}|${effectKey}`).digest('hex').slice(0, 12);
export function startContext(scenario: string, policy: PolicyName): RunContext {
  const S = scenarios[scenario];
  return { facts: S.facts, plan: S.plan, goal: S.goal, policy: policies[policy], contractHash: contractHash(S) };
}

export function reduce(s: RunState | null, e: Ev): RunState {
  if (e.t === 'start') {
    const S = scenarios[e.scenario];
    if (!S) throw new Error(`unknown scenario ${e.scenario}`);
    if (contractHash(S) !== e.context.contractHash) throw new Error(`run ${e.runId} was recorded under contracts ${e.context.contractHash}; this build has ${contractHash(S)}`);
    const plan = { version: 1, steps: e.context.plan };
    return {
      runId: e.runId, scenario: e.scenario, policy: e.context.policy.name, cfg: e.context.policy, goal: e.context.goal,
      status: 'running', pause: null, world: initialWorld(e.context.facts), plan, plans: [plan], ledger: {}, done: [], inflight: null,
      pending: null, awaiting: null, lastContradiction: null, sinceRevision: [], abandoned: [],
      revisions: 0, budget: e.context.policy.budget, proposals: 0, tick: e.at, seq: 1,
    };
  }
  if (!s) throw new Error('run not started');
  const n: RunState = { ...s, seq: s.seq + 1, tick: 'at' in e ? Math.max(s.tick, e.at) : s.tick };
  const row = 'opId' in e ? s.ledger[e.opId] : undefined;
  const sameGen = !!row && 'gen' in e && row.gen === e.gen;
  const setRow = (patch: Partial<LedgerRow>) => { if (row) n.ledger = { ...s.ledger, [row.opId]: { ...row, ...patch } }; };
  switch (e.t) {
    case 'verdict':
      if (e.v.kind === 'applied') {
        n.world = apply(s.world, e.obs, e.v, sc(s).sources);
        if (e.v.changed) n.sinceRevision = [...s.sinceRevision, e.obs.eventId];
      }
      return n;
    case 'dispatch':
      n.ledger = { ...s.ledger, [e.opId]: { opId: e.opId, gen: e.gen, stepId: e.stepId, action: e.action, params: e.params, effectKey: e.effectKey, commitment: e.commitment, planVersion: e.planVersion, state: 'prepared', expect: null, startedAt: n.tick } };
      n.inflight = e.opId;
      return n;
    case 'fenced': if (sameGen) { setRow({ state: 'cancelled' }); n.inflight = null; } return n;
    case 'commit_effect': if (sameGen) setRow({ state: 'committing', expect: e.expect }); return n;
    case 'effect_uncertain': if (sameGen) setRow({ state: 'uncertain' }); return n;
    case 'receipt': case 'reconciled': {
      if (!row || !sameGen || row.state === 'done') return n; // wrong generation or duplicate receipt: counted once
      if (e.t === 'reconciled' && e.found !== 'yes') {
        setRow({ state: e.found === 'no' ? 'not_applied' : 'uncertain' });
        if (e.found === 'no') n.inflight = null;
        return n;
      }
      setRow({ state: 'done' });
      n.done = [...s.done, row.effectKey];
      n.world = applyReceipt(s.world, (e.t === 'receipt' ? e.applied : e.applied) ?? {}, e.opId, e.at);
      if (s.inflight === e.opId) n.inflight = null;
      return n;
    }
    case 'operator':
      if (e.cmd === 'confirm' && e.fact) n.world = confirm(s.world, e.fact, e.value ?? null, e.at, Math.max(...Object.values(sc(s).sources).map((x) => x.rank)));
      return n;
    case 'contradiction':
      n.lastContradiction = e;
      n.awaiting = e.awaiting ? { contradictionId: e.id, trigger: e.trigger } : null;
      return n;
    case 'repair_requested':
      n.status = 'repairing'; n.awaiting = null; n.proposals = s.proposals + 1;
      n.pending = { requestId: e.requestId, basedOnRev: e.basedOnRev, planVersion: e.planVersion, contradictionId: e.contradictionId, attempt: e.attempt };
      return n;
    case 'candidate_stale': n.pending = null; n.status = 'running'; return n;
    case 'revision':
      n.abandoned = [...s.abandoned, { sig: tailSig(remainingOf(s)), doneCount: s.done.length }];
      n.plan = { version: e.record.to, steps: e.record.after };
      n.plans = [...s.plans, n.plan];
      n.revisions = s.revisions + 1; n.status = 'running'; n.pending = null; n.pause = null; n.awaiting = null; n.sinceRevision = [];
      return n;
    case 'assessed':
      if (s.status === 'repairing' && e.result === 'kept_plan') { n.status = 'running'; n.pending = null; }
      return n;
    case 'paused': n.status = 'paused'; n.pause = { kind: e.kind, reason: e.reason }; n.pending = null; n.awaiting = null; return n;
    case 'resumed':
      n.status = 'running'; n.pause = null;
      if (s.pause?.kind === 'budget' && n.budget !== null && s.revisions >= n.budget) n.budget = s.revisions + 1; // operator grants one more revision
      if (s.pause?.kind === 'budget' && s.proposals >= s.cfg.planBudget) n.proposals = s.cfg.planBudget - 1;
      if (s.pause?.kind === 'oscillation') n.abandoned = [];                                                  // operator accepts returning to an earlier plan
      return n;
    case 'completed': n.status = 'completed'; return n;
    case 'stopped': n.status = 'stopped'; n.pending = null; return n;
    default: return n;
  }
}

export function fold(events: Ev[]): RunState {
  let s: RunState | null = null;
  for (const e of events) s = reduce(s, e);
  if (!s) throw new Error('empty run');
  return s;
}

/** Decide what follows an input. Returns decisions only; the caller appends [input, ...decisions] atomically. */
export function decide(state: RunState | null, input: Ev): Ev[] {
  if (!INPUTS.has(input.t)) throw new Error(`not an input: ${input.t}`);
  let s = reduce(state, input);
  const out: Ev[] = [];
  const emit = (e: Ev) => { out.push(e); s = reduce(s, e); };
  const S = sc(s), D = S.domain, P = s.cfg, G = s.goal;

  if (s.status === 'stopped' || s.status === 'completed') {
    if (input.t === 'observation') emit({ t: 'verdict', obs: input.obs, v: judge(s.world, input.obs, S.sources, input.at) });
    return out;
  }
  /** Containment pauses latch: only an operator command lifts them. `no_repair` and `stale` wait for evidence. */
  const latched = () => s.status === 'paused' && s.pause?.kind !== 'no_repair' && s.pause?.kind !== 'stale';

  const requestRepair = (contradictionId: string | null, attempt = 1) => {
    if (s.proposals >= P.planBudget) {
      emit({ t: 'paused', kind: 'budget', reason: `planning budget spent (${s.proposals} repair attempts this run, including stale and failed ones); an operator must approve more` });
      return;
    }
    emit({ t: 'repair_requested', requestId: `${s.runId}:r${s.seq + 1}`, basedOnRev: s.world.rev, planVersion: s.plan.version, contradictionId, attempt });
  };

  /** Re-check the remaining plan against current beliefs. `quiet`: say nothing if it is still valid. */
  const evaluate = (trigger: TriggerView | null, changedFact: string | null, attempt = 1, quiet = false) => {
    const remaining = remainingOf(s);
    const c = ctxOf(s);
    // While paused on a broken plan, any accepted change may open a repair path, so it is never "no impact".
    const pausedBroken = s.status === 'paused' && s.pause?.kind === 'no_repair';
    if (changedFact && !P.reviseOnAnyChange && !pausedBroken && !referencedFacts(D, G, remaining, c).has(changedFact)) {
      emit({ t: 'assessed', fact: changedFact, result: 'no_impact', detail: `no remaining step, live commitment or goal condition reads ${changedFact}` });
      return;
    }
    const proj = project(D, G, remaining, c);
    if (proj.failures.length === 0 && proj.goalFailures.length === 0) {
      if (P.reviseOnAnyChange && changedFact && !s.inflight) { requestRepair(null, attempt); return; }
      if (!quiet) emit({ t: 'assessed', fact: changedFact, result: 'still_valid', detail: changedFact ? `${changedFact} changed, but every remaining assumption and commitment still holds` : 'remaining plan still valid' });
      if (s.status === 'paused' && !latched()) emit({ t: 'resumed', by: trigger ? `${trigger.source} ${trigger.eventId}` : 'evidence' });
      return;
    }
    const failuresAll = proj.failures.length ? proj.failures : [];
    // Entities whose *observed* facts broke an assumption (plus the trigger's): every remaining step bound to them is affected.
    const observed = (fact: string) => Object.hasOwn(S.sources, s.world.meta[fact]?.source ?? '');
    const entities = [...new Set([trigger?.fact, ...failuresAll.map((f) => f.cond.fact).filter(observed)].flatMap((f) => (f && entityOf(f)) || []))];
    const imp = impact(D, remaining, failuresAll, c.done, entities);
    const view = (f: (typeof proj.failures)[number]): FailureView => {
      const st = remaining.find((x) => x.id === f.stepId)!;
      return { stepId: f.stepId, sig: stepSig(st), cond: condText(f.cond), truth: f.truth, actual: f.actual, obligation: f.obligation ?? null };
    };
    const direct = failuresAll.filter((f) => !changedFact || f.cond.fact === changedFact || f.cond.ref === changedFact);
    const goalView = proj.goalFailures.map((g): FailureView => ({ stepId: 'goal', sig: 'goal', cond: condText(g), truth: evalCond(g, proj.end, c.unstable), actual: proj.end[g.fact], obligation: null }));
    const id = `${s.runId}:c${s.seq + 1}`;
    const inflightRow = s.inflight ? s.ledger[s.inflight] : null;
    emit({
      t: 'contradiction', id, trigger, failures: failuresAll.length ? (direct.length ? direct : failuresAll).map(view) : goalView,
      affected: imp.affected, preserved: [...s.plan.steps.filter((x) => c.done.has(keyOf(s, x))).map((x) => x.id), ...imp.preserved.filter((x) => remaining.some((r) => r.id === x))],
      awaiting: inflightRow ? inflightRow.opId : null,
    });
    if (inflightRow) {
      // Fence: an operation still in its preparation window whose own step is affected is cancelled before its effect.
      if (inflightRow.state === 'prepared' && imp.affected.includes(inflightRow.stepId)) {
        const why = direct[0] ?? failuresAll[0];
        emit({ t: 'fenced', opId: inflightRow.opId, gen: inflightRow.gen, stepId: inflightRow.stepId, reason: `cancelled before its effect: ${why ? condText(why.cond) : 'its assumption'} no longer holds` });
      } else return; // effect already committing, or unaffected: re-checked the moment it lands
    }
    if (latched()) return;
    requestRepair(id, attempt);
  };

  const advance = () => {
    if (s.status !== 'running' || s.inflight || s.pending) return;
    const next = remainingOf(s)[0];
    if (!next) {
      const met = G.success.every((c) => evalCond(c, s.world.facts) === 'true');
      emit({ t: 'completed', beliefGoalMet: met, detail: met ? 'every step has a receipt; the agent believes the goal is met' : 'plan finished, but the agent does not believe every goal condition holds' });
      return;
    }
    const a = contract(D, next.action);
    if (P.detect) {
      const p = project(D, G, [next], ctxOf(s));
      if (p.failures.length) { evaluate(null, null); return; }
    }
    const opId = opIdFor(s.runId, a.effectKey(next.params));
    const prev = s.ledger[opId];
    emit({ t: 'dispatch', opId, gen: (prev?.gen ?? 0) + 1, stepId: next.id, action: next.action, params: next.params, effectKey: a.effectKey(next.params), commitment: a.commitment, duration: a.duration, planVersion: s.plan.version, retry: !!prev });
  };

  switch (input.t) {
    case 'start': break;
    case 'observation': {
      const prev = s.world.facts[input.obs.fact];
      const v = judge(s.world, input.obs, S.sources, input.at);
      emit({ t: 'verdict', obs: input.obs, v });
      if (v.kind !== 'applied' || !(v.changed || v.becameUnstable)) break;
      const trig: TriggerView = { eventId: input.obs.eventId, source: input.obs.source, fact: input.obs.fact, prev, value: input.obs.value, observedAt: input.obs.observedAt };
      if (!P.detect) { emit({ t: 'assessed', fact: input.obs.fact, result: 'ignored_by_policy', detail: 'the static baseline never re-checks its plan' }); break; }
      if (latched()) {
        // Not re-planned while latched, but a newly broken in-flight step is still fenced.
        const row = s.inflight ? s.ledger[s.inflight] : null;
        if (row?.state === 'prepared' && project(D, G, remainingOf(s).filter((x) => x.id === row.stepId), ctxOf(s)).failures.length) {
          emit({ t: 'fenced', opId: row.opId, gen: row.gen, stepId: row.stepId, reason: 'cancelled before its effect while paused' });
        }
        emit({ t: 'assessed', fact: input.obs.fact, result: 'kept_plan', detail: `paused (${s.pause!.kind}); waiting for an operator` });
        break;
      }
      if (s.status === 'repairing') break; // the pending candidate is now stale and will be re-requested
      evaluate(trig, input.obs.fact);
      break;
    }
    case 'effect_ready': {
      const row = s.ledger[input.opId];
      if (!row || row.gen !== input.gen || row.state !== 'prepared' || s.inflight !== row.opId) break; // fenced or superseded generation
      const expect = contract(D, row.action).produces(row.params, s.world.facts);
      emit({ t: 'commit_effect', opId: row.opId, gen: row.gen, expect });
      break;
    }
    case 'receipt':
      if (P.detect && !s.inflight && !latched()) evaluate(s.awaiting?.trigger ?? null, null, 1, true);
      break;
    case 'effect_uncertain': emit({ t: 'reconcile_requested', opId: input.opId, gen: input.gen }); break;
    case 'reconciled': {
      const row = s.ledger[input.opId];
      if (!row || row.gen !== input.gen) break;
      if (input.found === 'yes') { if (P.detect && !s.inflight && !latched()) evaluate(s.awaiting?.trigger ?? null, null, 1, true); break; }
      if (input.found === 'no') break; // proven not applied: advance() prepares the same opId again (next generation)
      if (row.commitment === 'irreversible') emit({ t: 'paused', kind: 'ambiguous', reason: `${stepSig(row)} may or may not have happened and cannot be undone; an operator must check before anything else runs` });
      else emit({ t: 'commit_effect', opId: row.opId, gen: row.gen, expect: row.expect ?? {} }); // reversible, idempotent by opId: safe to re-apply
      break;
    }
    case 'planner_output': {
      const p = s.pending;
      if (!p || p.requestId !== input.requestId) break; // late answer to a superseded request
      if (s.world.rev !== p.basedOnRev || s.plan.version !== p.planVersion) {
        emit({ t: 'candidate_stale', requestId: p.requestId, basedOnRev: p.basedOnRev, nowRev: s.world.rev });
        if (p.attempt >= 3) { emit({ t: 'paused', kind: 'stale', reason: 'the world kept changing while repairs were being planned (3 stale candidates in a row)' }); break; }
        evaluate(s.lastContradiction?.trigger ?? null, null, p.attempt + 1);
        break;
      }
      commitBest(Array.isArray(input.candidates) ? input.candidates : []);
      break;
    }
    case 'operator':
      if (input.cmd === 'abort') { emit({ t: 'stopped', reason: 'operator stopped the run' }); break; }
      if (input.cmd === 'resume' && s.status === 'paused') {
        const kind = s.pause?.kind;
        emit({ t: 'resumed', by: 'operator' });
        if (kind === 'ambiguous' && s.inflight) { emit({ t: 'reconcile_requested', opId: s.inflight, gen: s.ledger[s.inflight].gen }); break; }
      }
      if (latched()) break;
      evaluate(null, input.cmd === 'confirm' ? input.fact ?? null : null);
      break;
    case 'recover': {
      const row = s.inflight ? s.ledger[s.inflight] : null;
      if (row?.state === 'prepared') emit({ t: 'fenced', opId: row.opId, gen: row.gen, stepId: row.stepId, reason: 'process restarted during preparation; no effect was attempted' });
      else if (row) { emit({ t: 'reconcile_requested', opId: row.opId, gen: row.gen }); break; }
      if (s.status === 'repairing') requestRepair(s.lastContradiction?.id ?? null);
      break;
    }
  }
  advance();
  return out;

  function commitBest(cands: Candidate[]) {
    const remaining = remainingOf(s);
    const c = ctxOf(s);
    const lc = s.pending?.contradictionId && s.lastContradiction?.id === s.pending.contradictionId ? s.lastContradiction : null;
    const preserve = P.reviseOnAnyChange ? [] : (lc?.preserved ?? []).flatMap((id) => remaining.filter((x) => x.id === id && !(lc?.affected ?? []).includes(id)).map(stepSig));
    const judged = cands.map((cand, i) => ({ cand, i, v: validate(D, G, cand.steps, remaining, c, preserve, cand.scope === 'full' ? 'full' : 'local') }));
    const valid = judged.filter((j) => j.v.valid).sort((a, b) => P.rank === 'edit'
      ? a.v.distance - b.v.distance || a.v.cost - b.v.cost || a.i - b.i
      : a.v.cost - b.v.cost || a.i - b.i);
    const sig = (x: unknown) => { const d = x as { action?: unknown; params?: unknown }; return d && typeof d.action === 'string' ? stepSig({ action: d.action, params: (d.params && typeof d.params === 'object' ? d.params : {}) as Params }) : '?'; };
    const rejected = judged.filter((j) => !j.v.valid).map((j) => ({ origin: String(j.cand.origin), steps: (Array.isArray(j.cand.steps) ? j.cand.steps : []).map(sig), failed: j.v.checks.filter((x) => !x.pass) }));
    const keep = (detail: string) => emit({ t: 'assessed', fact: null, result: 'kept_plan', detail });
    if (!valid.length) {
      if (P.reviseOnAnyChange && !lc) return keep('no better plan found');
      if (!P.stabilityGate) return keep('naive agent keeps its plan when no candidate validates');
      const u = s.world.unstable;
      const unknownDriven = !!lc?.failures.some((f) => f.truth === 'unknown') && u.length > 0;
      emit({ t: 'paused', kind: unknownDriven ? 'unstable' : 'no_repair', reason: unknownDriven
        ? `holding before the next step: ${u.join(' and ')} ${u.length > 1 ? 'are' : 'is'} flapping, and no valid plan avoids ${u.length > 1 ? 'them' : 'it'}. An operator must confirm the facts and resume.`
        : `no candidate repair passes validation (${rejected.length} rejected). Holding safely; the goal is not weakened.` });
      return;
    }
    const best = valid[0];
    const prevSteps = s.plan.steps;
    const doneSteps = prevSteps.filter((x) => c.done.has(keyOf(s, x)));
    const pool = new Map(remaining.map((x) => [stepSig(x), x]));
    const to = s.plan.version + 1;
    const newTail: Step[] = best.cand.steps.map((d, i) => { const k = stepSig(d); const kept = pool.get(k); if (kept) pool.delete(k); return kept ?? { id: `v${to}.${i + 1}`, action: d.action, params: d.params }; });
    if (tailSig(newTail) === tailSig(remaining)) return keep('the best candidate is the current plan');
    if (P.stabilityGate && s.abandoned.some((a) => a.sig === tailSig(newTail) && a.doneCount === s.done.length)) {
      emit({ t: 'paused', kind: 'oscillation', reason: `the best repair returns to a plan abandoned earlier with no progress in between (${tailSig(newTail)}). Refusing to flip back; an operator must decide.` });
      return;
    }
    if (s.budget !== null && s.revisions >= s.budget) {
      emit({ t: 'paused', kind: 'budget', reason: `a valid repair exists, but ${s.revisions} revision${s.revisions === 1 ? ' was' : 's were'} already committed this run (budget ${s.budget}). An operator must approve further changes.` });
      return;
    }
    const trig = lc?.trigger ?? null;
    const f0 = lc?.failures[0];
    const removedSteps = remaining.filter((x) => !newTail.includes(x));
    const addedSteps = newTail.filter((x) => !remaining.includes(x));
    const modified = addedSteps.filter((a) => removedSteps.some((r) => r.action === a.action)).length;
    const assumed = f0 ? (f0.obligation ? `${f0.obligation} committed to ${f0.cond}` : `${f0.sig} assumed ${f0.cond}`) : '';
    emit({
      t: 'revision', record: {
        from: s.plan.version, to, trigger: trig, observations: s.sinceRevision,
        because: trig && f0
          ? `I changed my mind because ${trig.fact} became ${JSON.stringify(trig.value)} (reported by ${trig.source} at t${trig.observedAt}), and ${assumed}.`
          : f0 ? `I changed my mind because ${assumed}, which no longer holds.`
          : 'I changed my plan because a cheaper valid plan appeared (naive policy: replans on any change).',
        oldAssumption: f0?.cond ?? null,
        newObservation: trig ? `${trig.fact} = ${JSON.stringify(trig.value)} from ${trig.source} at t${trig.observedAt} (was ${JSON.stringify(trig.prev)})` : null,
        contradiction: lc?.failures ?? [], affected: lc?.affected ?? [], preserved: lc?.preserved ?? [], completed: doneSteps.map((x) => x.id),
        removed: removedSteps.map(stepSig), added: addedSteps.map(stepSig),
        edit: { inserted: addedSteps.length - modified, removed: removedSteps.length - modified, modified, distance: best.v.distance },
        checks: best.v.checks, chosen: { origin: best.cand.origin, scope: best.cand.scope ?? 'local', rationale: best.cand.rationale, cost: best.v.cost, model: best.cand.model },
        rejected, before: prevSteps, after: [...doneSteps, ...newTail],
      },
    });
  }
}
