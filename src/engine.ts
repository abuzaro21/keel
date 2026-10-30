// The adaptive engine: a pure, event-sourced decision function.
//   state' = reduce(state, event)       — folding the log rebuilds any run exactly
//   decisions = decide(state, input)    — same state + same input => same decisions (replayable)
// The imperative shell (runner.ts) persists [input, ...decisions] atomically and performs the I/O the
// decisions ask for (dispatch/commit_effect -> simulator, repair_requested -> planners, reconcile_requested).
// Nothing here reads a clock: the engine only ever wakes because an input arrived.
import { createHash } from 'node:crypto';
import { condText, contract, entityOf, evalCond, impact, project, referencedFacts, stepSig } from './model.ts';
import type { Json, Params, Plan, Step } from './model.ts';
import { validate } from './repair.ts';
import type { Candidate, Check } from './repair.ts';
import { apply, applyReceipt, canonical, confirm, initialWorld, judge } from './world.ts';
import type { Ingest, Observation, WorldState } from './world.ts';
import { scenarios } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

export type PolicyName = 'keel' | 'static' | 'naive';
export type Policy = {
  name: PolicyName; label: string;
  detect: boolean;            // re-check plan assumptions when observations arrive
  stabilityGate: boolean;     // flapping facts evaluate UNKNOWN; returning to an abandoned plan pauses
  budget: number | null;      // max committed revisions before PAUSE (null = unlimited)
  reviseOnAnyChange: boolean; // replan even while the current plan is still valid
  rank: 'edit' | 'cost';
};
export const policies: Record<PolicyName, Policy> = {
  keel: { name: 'keel', label: 'KEEL', detect: true, stabilityGate: true, budget: 3, reviseOnAnyChange: false, rank: 'edit' },
  static: { name: 'static', label: 'Static baseline', detect: false, stabilityGate: false, budget: 0, reviseOnAnyChange: false, rank: 'edit' },
  naive: { name: 'naive', label: 'Naive adaptive', detect: true, stabilityGate: false, budget: null, reviseOnAnyChange: true, rank: 'cost' },
};

export type PauseKind = 'unstable' | 'no_repair' | 'budget' | 'ambiguous' | 'stale' | 'oscillation';
export type FailureView = { stepId: string; sig: string; cond: string; truth: string; actual: Json | undefined };
export type TriggerView = { eventId: string; source: string; fact: string; prev: Json | undefined; value: Json; observedAt: number };
export type RevisionRecord = {
  from: number; to: number; trigger: TriggerView | null; because: string;
  oldAssumption: string | null; newObservation: string | null;
  contradiction: FailureView[]; affected: string[]; preserved: string[]; completed: string[];
  removed: string[]; added: string[]; edit: { inserted: number; removed: number; modified: number; distance: number };
  checks: Check[]; chosen: { origin: string; rationale: string; cost: number; model?: Candidate['model'] };
  rejected: { origin: string; steps: string[]; failed: Check[] }[];
  before: Step[]; after: Step[];
};

export type Ev =
  // ---- inputs: recorded verbatim; replay feeds exactly these back in
  | { t: 'start'; runId: string; scenario: string; policy: PolicyName; at: number }
  | { t: 'observation'; obs: Observation; at: number }
  | { t: 'effect_ready'; opId: string; at: number }
  | { t: 'receipt'; opId: string; at: number; detail: string }
  | { t: 'effect_uncertain'; opId: string; at: number }
  | { t: 'reconciled'; opId: string; found: 'yes' | 'no' | 'unknown'; at: number }
  | { t: 'planner_output'; requestId: string; candidates: Candidate[]; at: number }
  | { t: 'operator'; cmd: 'confirm' | 'resume' | 'abort'; fact?: string; value?: Json; at: number }
  | { t: 'recover'; at: number }
  // ---- decisions: derived; replay must reproduce them exactly
  | { t: 'verdict'; obs: Observation; v: Ingest }
  | { t: 'assessed'; fact: string | null; result: 'no_impact' | 'still_valid' | 'ignored_by_policy' | 'kept_plan'; detail: string }
  | { t: 'contradiction'; id: string; trigger: TriggerView | null; failures: FailureView[]; affected: string[]; preserved: string[]; awaiting: string | null }
  | { t: 'fenced'; opId: string; stepId: string; reason: string }
  | { t: 'repair_requested'; requestId: string; basedOnRev: number; planVersion: number; contradictionId: string | null; full: boolean; attempt: number }
  | { t: 'candidate_stale'; requestId: string; basedOnRev: number; nowRev: number }
  | { t: 'revision'; record: RevisionRecord }
  | { t: 'dispatch'; opId: string; stepId: string; action: string; params: Params; effectKey: string; commitment: string; duration: number; planVersion: number; retry: boolean }
  | { t: 'commit_effect'; opId: string }
  | { t: 'reconcile_requested'; opId: string }
  | { t: 'paused'; kind: PauseKind; reason: string }
  | { t: 'resumed'; by: string }
  | { t: 'completed'; beliefGoalMet: boolean; detail: string }
  | { t: 'stopped'; reason: string };

export const INPUTS = new Set(['start', 'observation', 'effect_ready', 'receipt', 'effect_uncertain', 'reconciled', 'planner_output', 'operator', 'recover']);

export type LedgerState = 'prepared' | 'committing' | 'done' | 'uncertain' | 'not_applied' | 'cancelled';
export type LedgerRow = { opId: string; stepId: string; action: string; params: Params; effectKey: string; commitment: string; planVersion: number; state: LedgerState; attempts: number };
export type RunState = {
  runId: string; scenario: string; policy: PolicyName;
  status: 'running' | 'repairing' | 'paused' | 'completed' | 'stopped';
  pause: { kind: PauseKind; reason: string } | null;
  world: WorldState; plan: Plan; plans: Plan[];
  ledger: Record<string, LedgerRow>; done: string[];
  inflight: string | null;
  pending: { requestId: string; basedOnRev: number; planVersion: number; contradictionId: string | null; attempt: number } | null;
  awaiting: { contradictionId: string; trigger: TriggerView | null } | null;
  lastContradiction: Extract<Ev, { t: 'contradiction' }> | null;
  abandoned: { sig: string; doneCount: number }[];
  revisions: number; budget: number | null; tick: number; seq: number;
};

const sc = (s: RunState): Scenario => scenarios[s.scenario];
const pol = (s: RunState) => policies[s.policy];
const unstableOf = (s: RunState) => new Set(pol(s).stabilityGate ? s.world.unstable : []);
const keyOf = (s: RunState, x: Pick<Step, 'action' | 'params'>) => contract(sc(s).domain, x.action).effectKey(x.params);
export const remainingOf = (s: RunState) => s.plan.steps.filter((x) => !s.done.includes(keyOf(s, x)));
const tailSig = (steps: Pick<Step, 'action' | 'params'>[]) => steps.map(stepSig).join(' > ');
/** Operation id = hash(run, semantic effect). A repaired plan that still needs an effect reuses its id. */
export const opIdFor = (runId: string, effectKey: string) => createHash('sha256').update(`${runId}|${effectKey}`).digest('hex').slice(0, 12);

export function reduce(s: RunState | null, e: Ev): RunState {
  if (e.t === 'start') {
    const S = scenarios[e.scenario];
    if (!S) throw new Error(`unknown scenario ${e.scenario}`);
    const plan = { version: 1, steps: S.plan };
    return {
      runId: e.runId, scenario: e.scenario, policy: e.policy, status: 'running', pause: null,
      world: initialWorld(S.facts), plan, plans: [plan], ledger: {}, done: [], inflight: null, pending: null,
      awaiting: null, lastContradiction: null, abandoned: [], revisions: 0, budget: policies[e.policy].budget, tick: e.at, seq: 1,
    };
  }
  if (!s) throw new Error('run not started');
  const n: RunState = { ...s, seq: s.seq + 1, tick: 'at' in e ? Math.max(s.tick, e.at) : s.tick };
  const row = 'opId' in e ? s.ledger[e.opId] : undefined;
  const setRow = (state: LedgerState) => { if (row) n.ledger = { ...s.ledger, [row.opId]: { ...row, state } }; };
  switch (e.t) {
    case 'verdict':
      if (e.v.kind === 'applied') n.world = apply(s.world, e.obs, e.v, sc(s).sources);
      else if (s.world.seen[e.obs.eventId] === undefined) n.world = { ...s.world, seen: { ...s.world.seen, [e.obs.eventId]: canonical(e.obs) } };
      return n;
    case 'dispatch':
      n.ledger = { ...s.ledger, [e.opId]: { opId: e.opId, stepId: e.stepId, action: e.action, params: e.params, effectKey: e.effectKey, commitment: e.commitment, planVersion: e.planVersion, state: 'prepared', attempts: (row?.attempts ?? 0) + 1 } };
      n.inflight = e.opId;
      return n;
    case 'fenced': setRow('cancelled'); n.inflight = null; return n;
    case 'commit_effect': setRow('committing'); return n;
    case 'effect_uncertain': setRow('uncertain'); return n;
    case 'receipt': case 'reconciled': {
      if (!row) return n;
      if (e.t === 'reconciled' && e.found !== 'yes') {
        setRow(e.found === 'no' ? 'not_applied' : 'uncertain');
        if (e.found === 'no') n.inflight = null;
        return n;
      }
      if (row.state === 'done') return n; // duplicate receipt: the effect is counted once
      setRow('done');
      n.done = [...s.done, row.effectKey];
      n.world = applyReceipt(s.world, contract(sc(s).domain, row.action).produces(row.params, s.world.facts), e.opId, e.at);
      if (s.inflight === e.opId) n.inflight = null;
      return n;
    }
    case 'operator':
      if (e.cmd === 'confirm' && e.fact) n.world = confirm(s.world, e.fact, e.value ?? null, e.at);
      return n;
    case 'contradiction':
      n.lastContradiction = e;
      n.awaiting = e.awaiting ? { contradictionId: e.id, trigger: e.trigger } : null;
      return n;
    case 'repair_requested':
      n.status = 'repairing'; n.awaiting = null;
      n.pending = { requestId: e.requestId, basedOnRev: e.basedOnRev, planVersion: e.planVersion, contradictionId: e.contradictionId, attempt: e.attempt };
      return n;
    case 'candidate_stale': n.pending = null; n.status = 'running'; return n;
    case 'revision':
      n.abandoned = [...s.abandoned, { sig: tailSig(remainingOf(s)), doneCount: s.done.length }];
      n.plan = { version: e.record.to, steps: e.record.after };
      n.plans = [...s.plans, n.plan];
      n.revisions = s.revisions + 1; n.status = 'running'; n.pending = null; n.pause = null; n.awaiting = null;
      return n;
    case 'assessed':
      if (s.status === 'repairing' && e.result === 'kept_plan') { n.status = 'running'; n.pending = null; }
      return n;
    case 'paused': n.status = 'paused'; n.pause = { kind: e.kind, reason: e.reason }; n.pending = null; n.awaiting = null; return n;
    case 'resumed':
      n.status = 'running'; n.pause = null;
      if (s.pause?.kind === 'budget' && n.budget !== null) n.budget += 1; // operator grants one more revision
      if (s.pause?.kind === 'oscillation') n.abandoned = [];             // operator accepts returning to an earlier plan
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
  const S = sc(s), D = S.domain, P = pol(s);

  if (s.status === 'stopped' || s.status === 'completed') {
    if (input.t === 'observation') emit({ t: 'verdict', obs: input.obs, v: judge(s.world, input.obs, S.sources) });
    return out;
  }
  const blockedForOperator = () => s.status === 'paused' && (s.pause?.kind === 'budget' || s.pause?.kind === 'ambiguous' || s.pause?.kind === 'oscillation');

  const requestRepair = (contradictionId: string | null, attempt = 1) => emit({
    t: 'repair_requested', requestId: `${s.runId}:r${s.seq + 1}`, basedOnRev: s.world.rev, planVersion: s.plan.version, contradictionId, full: false, attempt,
  });

  /** Re-check the remaining plan against current beliefs. */
  const evaluate = (trigger: TriggerView | null, changedFact: string | null, attempt = 1) => {
    const remaining = remainingOf(s);
    const done = new Set(s.done);
    // While paused on a broken plan, any accepted change may open a repair path, so it is never "no impact".
    const pausedBroken = s.status === 'paused' && (s.pause?.kind === 'no_repair' || s.pause?.kind === 'unstable');
    if (changedFact && !P.reviseOnAnyChange && !pausedBroken && !referencedFacts(D, S.goal, remaining, done).has(changedFact)) {
      emit({ t: 'assessed', fact: changedFact, result: 'no_impact', detail: `no remaining step or goal condition reads ${changedFact}` });
      return;
    }
    const proj = project(D, S.goal, remaining, s.world.facts, done, unstableOf(s));
    if (proj.failures.length === 0 && proj.goalFailures.length === 0) {
      if (P.reviseOnAnyChange && changedFact && !s.inflight) { requestRepair(null, attempt); return; }
      emit({ t: 'assessed', fact: changedFact, result: 'still_valid', detail: changedFact ? `${changedFact} changed, but every remaining assumption still holds` : 'remaining plan still valid' });
      if (s.status === 'paused' && !blockedForOperator()) emit({ t: 'resumed', by: trigger ? `${trigger.source} ${trigger.eventId}` : 'operator' });
      return;
    }
    const entity = trigger ? entityOf(trigger.fact) : null;
    const imp = impact(D, remaining, proj.failures, done, entity);
    const view = (f: (typeof proj.failures)[number]): FailureView => {
      const st = remaining.find((x) => x.id === f.stepId)!;
      return { stepId: f.stepId, sig: stepSig(st), cond: condText(f.cond), truth: f.truth, actual: f.actual };
    };
    const direct = proj.failures.filter((f) => !changedFact || f.cond.fact === changedFact || f.cond.ref === changedFact);
    const id = `${s.runId}:c${s.seq + 1}`;
    const inflightRow = s.inflight ? s.ledger[s.inflight] : null;
    emit({
      t: 'contradiction', id, trigger, failures: (direct.length ? direct : proj.failures).map(view),
      affected: imp.affected, preserved: [...s.plan.steps.filter((x) => done.has(keyOf(s, x))).map((x) => x.id), ...imp.preserved.filter((x) => remaining.some((r) => r.id === x))],
      awaiting: inflightRow ? inflightRow.opId : null,
    });
    if (inflightRow) {
      // Fence: an operation still in its preparation window whose own step is affected is cancelled before its effect.
      if (inflightRow.state === 'prepared' && imp.affected.includes(inflightRow.stepId)) {
        emit({ t: 'fenced', opId: inflightRow.opId, stepId: inflightRow.stepId, reason: `cancelled before its effect: ${(direct[0] && condText(direct[0].cond)) ?? 'assumption'} no longer holds` });
      } else return; // effect already committing, or unaffected: repair the moment it lands
    }
    if (blockedForOperator()) return;
    requestRepair(id, attempt);
  };

  const advance = () => {
    if (s.status !== 'running' || s.inflight || s.pending) return;
    const next = remainingOf(s)[0];
    if (!next) {
      const met = S.goal.success.every((c) => evalCond(c, s.world.facts) === 'true');
      emit({ t: 'completed', beliefGoalMet: met, detail: met ? 'every step has a receipt; the agent believes the goal is met' : 'plan finished, but the agent does not believe every goal condition holds' });
      return;
    }
    const a = contract(D, next.action);
    if (P.detect && a.requires(next.params).some((c) => evalCond(c, s.world.facts, unstableOf(s)) !== 'true')) { evaluate(null, null); return; }
    const opId = opIdFor(s.runId, a.effectKey(next.params));
    emit({ t: 'dispatch', opId, stepId: next.id, action: next.action, params: next.params, effectKey: a.effectKey(next.params), commitment: a.commitment, duration: a.duration, planVersion: s.plan.version, retry: !!s.ledger[opId] });
  };

  switch (input.t) {
    case 'start': break;
    case 'observation': {
      const prev = s.world.facts[input.obs.fact];
      const v = judge(s.world, input.obs, S.sources);
      emit({ t: 'verdict', obs: input.obs, v });
      if (v.kind !== 'applied' || !(v.changed || v.becameUnstable || v.cleared)) break;
      const trig: TriggerView = { eventId: input.obs.eventId, source: input.obs.source, fact: input.obs.fact, prev, value: input.obs.value, observedAt: input.obs.observedAt };
      if (!P.detect) { emit({ t: 'assessed', fact: input.obs.fact, result: 'ignored_by_policy', detail: 'the static baseline never re-checks its plan' }); break; }
      if (blockedForOperator()) { emit({ t: 'assessed', fact: input.obs.fact, result: 'kept_plan', detail: `paused (${s.pause!.kind}); waiting for an operator` }); break; }
      if (s.status === 'repairing') break; // the pending candidate is now stale and will be re-requested
      evaluate(trig, input.obs.fact);
      break;
    }
    case 'effect_ready': {
      const row = s.ledger[input.opId];
      if (row?.state === 'prepared' && s.inflight === row.opId) emit({ t: 'commit_effect', opId: row.opId });
      break; // otherwise the operation was fenced or superseded: its timer firing changes nothing
    }
    case 'receipt':
      if (s.awaiting && !s.inflight) evaluate(s.awaiting.trigger, null);
      break;
    case 'effect_uncertain': emit({ t: 'reconcile_requested', opId: input.opId }); break;
    case 'reconciled': {
      const row = s.ledger[input.opId];
      if (!row) break;
      if (input.found === 'yes') { if (s.awaiting && !s.inflight) evaluate(s.awaiting.trigger, null); break; }
      if (input.found === 'no') break; // proven not applied: advance() re-dispatches the same opId
      if (row.commitment === 'irreversible') emit({ t: 'paused', kind: 'ambiguous', reason: `${stepSig(row)} may or may not have happened and cannot be undone; an operator must check before anything else runs` });
      else emit({ t: 'commit_effect', opId: row.opId }); // reversible + idempotent by opId: safe to re-apply
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
      commitBest(input.candidates);
      break;
    }
    case 'operator':
      if (input.cmd === 'abort') { emit({ t: 'stopped', reason: 'operator stopped the run' }); break; }
      if (input.cmd === 'resume' && s.status === 'paused') {
        const kind = s.pause?.kind;
        emit({ t: 'resumed', by: 'operator' });
        if (kind === 'ambiguous' && s.inflight) { emit({ t: 'reconcile_requested', opId: s.inflight }); break; }
      }
      if (s.status === 'paused' && blockedForOperator()) break;
      evaluate(null, input.cmd === 'confirm' ? input.fact ?? null : null);
      break;
    case 'recover': {
      const row = s.inflight ? s.ledger[s.inflight] : null;
      if (row?.state === 'prepared') emit({ t: 'fenced', opId: row.opId, stepId: row.stepId, reason: 'process restarted during preparation; no effect was attempted' });
      else if (row) { emit({ t: 'reconcile_requested', opId: row.opId }); break; }
      if (s.status === 'repairing') requestRepair(s.lastContradiction?.id ?? null);
      break;
    }
  }
  advance();
  return out;

  function commitBest(cands: Candidate[]) {
    const remaining = remainingOf(s);
    const done = new Set(s.done);
    const judged = cands.map((c, i) => ({ c, i, v: validate(D, S.goal, c.steps, remaining, s.world.facts, done, unstableOf(s)) }));
    const valid = judged.filter((j) => j.v.valid).sort((a, b) => P.rank === 'edit'
      ? a.v.distance - b.v.distance || a.v.cost - b.v.cost || a.i - b.i
      : a.v.cost - b.v.cost || a.i - b.i);
    const rejected = judged.filter((j) => !j.v.valid).map((j) => ({ origin: j.c.origin, steps: (Array.isArray(j.c.steps) ? j.c.steps : []).map((x) => (x && x.action ? stepSig({ action: String(x.action), params: x.params ?? {} }) : '?')), failed: j.v.checks.filter((c) => !c.pass) }));
    const lc = s.pending?.contradictionId && s.lastContradiction?.id === s.pending.contradictionId ? s.lastContradiction : null;
    const keep = (detail: string) => emit({ t: 'assessed', fact: null, result: 'kept_plan', detail });
    if (!valid.length) {
      if (P.reviseOnAnyChange && !lc) return keep('no better plan found');
      if (!P.stabilityGate) return keep('naive agent keeps its plan when no candidate validates');
      const unknownDriven = !!lc?.failures.some((f) => f.truth === 'unknown') || s.world.unstable.length > 0;
      const u = s.world.unstable;
      emit({ t: 'paused', kind: unknownDriven ? 'unstable' : 'no_repair', reason: unknownDriven
        ? `holding before the next step: ${u.join(' and ')} ${u.length > 1 ? 'are' : 'is'} flapping, and no valid plan avoids ${u.length > 1 ? 'them' : 'it'}. Waiting for an authoritative observation or an operator.`
        : `no candidate repair passes validation (${rejected.length} rejected). Holding safely; the goal is not weakened.` });
      return;
    }
    const best = valid[0];
    const prevSteps = s.plan.steps;
    const doneSteps = prevSteps.filter((x) => done.has(keyOf(s, x)));
    const pool = new Map(remaining.map((x) => [stepSig(x), x]));
    const to = s.plan.version + 1;
    const newTail: Step[] = best.c.steps.map((d, i) => { const sig = stepSig(d); const kept = pool.get(sig); if (kept) pool.delete(sig); return kept ?? { id: `v${to}.${i + 1}`, action: d.action, params: d.params }; });
    if (tailSig(newTail) === tailSig(remaining)) return keep('the best candidate is the current plan');
    if (P.stabilityGate && s.abandoned.some((a) => a.sig === tailSig(newTail) && a.doneCount === s.done.length)) {
      emit({ t: 'paused', kind: 'oscillation', reason: `the best repair returns to a plan abandoned earlier with no progress in between (${tailSig(newTail)}). Refusing to flip back; an operator must decide.` });
      return;
    }
    if (s.budget !== null && s.revisions >= s.budget) {
      emit({ t: 'paused', kind: 'budget', reason: `a valid repair exists, but ${s.revisions} revisions were already committed this run (budget ${s.budget}). An operator must approve further changes.` });
      return;
    }
    const trig = lc?.trigger ?? null;
    const f0 = lc?.failures[0];
    const removedSteps = remaining.filter((x) => !newTail.includes(x));
    const addedSteps = newTail.filter((x) => !remaining.includes(x));
    const modified = addedSteps.filter((a) => removedSteps.some((r) => r.action === a.action)).length;
    emit({
      t: 'revision', record: {
        from: s.plan.version, to, trigger: trig,
        because: trig && f0
          ? `I changed my mind because ${trig.fact} became ${JSON.stringify(trig.value)} (reported by ${trig.source} at t${trig.observedAt}), and ${f0.sig} assumed ${f0.cond}.`
          : f0 ? `I changed my mind because ${f0.sig} assumed ${f0.cond}, which no longer holds.`
          : 'I changed my plan because a cheaper valid plan appeared (naive policy: replans on any change).',
        oldAssumption: f0?.cond ?? null,
        newObservation: trig ? `${trig.fact} = ${JSON.stringify(trig.value)} from ${trig.source} at t${trig.observedAt} (was ${JSON.stringify(trig.prev)})` : null,
        contradiction: lc?.failures ?? [], affected: lc?.affected ?? [], preserved: lc?.preserved ?? [], completed: doneSteps.map((x) => x.id),
        removed: removedSteps.map(stepSig), added: addedSteps.map(stepSig),
        edit: { inserted: addedSteps.length - modified, removed: removedSteps.length - modified, modified, distance: best.v.distance },
        checks: best.v.checks, chosen: { origin: best.c.origin, rationale: best.c.rationale, cost: best.v.cost, model: best.c.model },
        rejected, before: prevSteps, after: [...doneSteps, ...newTail],
      },
    });
  }
}
