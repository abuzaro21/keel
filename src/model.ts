// Plan model: facts, conditions, action contracts, plan projection and impact analysis.
// Everything here is pure: no I/O, no clock, no randomness — so decisions replay exactly.

export type Json = string | number | boolean | null;
export type Facts = Record<string, Json>;
export type Op = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte';
/** An assumption. Compared against a literal `value` (a list for `in`) or against another fact (`ref`). */
export type Cond = { fact: string; op: Op; value?: Json | Json[]; ref?: string };
export type Params = Record<string, Json>;

export type ActionContract = {
  type: string;
  describe: string;
  /** param name -> domain name; domains enumerate legal values from current facts. */
  params: Record<string, string>;
  commitment: 'reversible' | 'irreversible';
  duration: number;
  cost(p: Params, f: Facts): number;
  /** Assumptions needed when the step starts. Derived from code, so a planner cannot omit them. */
  requires(p: Params): Cond[];
  /** Obligations that must keep holding after the step completes, until a later step releases them. */
  maintains?(p: Params): Cond[];
  /** Action types whose maintained obligations this step ends (e.g. a new traffic shift ends the old one's). */
  releases?: string[];
  /** The obligations also end once this condition holds (e.g. the carrier reports the truck arrived). */
  maintainsUntil?(p: Params): Cond;
  /** Facts the agent expects to hold after the step succeeds. Keys must not depend on `f`. */
  produces(p: Params, f: Facts): Facts;
  /** Identity of the external side effect. Same key = same effect, whatever the plan version. */
  effectKey(p: Params): string;
};

export type Domain = {
  name: string;
  actions: Record<string, ActionContract>;
  domains: Record<string, (f: Facts) => Json[]>;
};

export type Goal = { statement: string; success: Cond[] };
export type Step = { id: string; action: string; params: Params };
export type Plan = { version: number; steps: Step[] };
/** A live commitment created by a completed step. Ends when released by a later step or when `until` holds. */
export type Obligation = { cond: Cond; action: string; from: string; until?: Cond };

/** Three-valued: a condition over a fact we no longer trust, or with a missing/invalid operand, is UNKNOWN. */
export type Truth = 'true' | 'false' | 'unknown';

export function evalCond(c: Cond, f: Facts, unstable: ReadonlySet<string> = new Set()): Truth {
  if (unstable.has(c.fact) || (c.ref && unstable.has(c.ref))) return 'unknown';
  const a = f[c.fact];
  const b = c.ref !== undefined ? f[c.ref] : c.value;
  if (a === undefined || b === undefined) return 'unknown';
  if (c.op === 'in') return Array.isArray(b) && b.includes(a) ? 'true' : 'false'; // positive allow-list: unknown states fail closed
  if (Array.isArray(b)) return 'unknown';
  if (c.op === 'eq') return a === b ? 'true' : 'false';
  if (c.op === 'neq') return a !== b ? 'true' : 'false';
  // Ordering needs two finite numbers. `600 >= null` must not pass a guard.
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
  const ok = c.op === 'lt' ? a < b : c.op === 'lte' ? a <= b : c.op === 'gt' ? a > b : a >= b;
  return ok ? 'true' : 'false';
}

export const condText = (c: Cond) => `${c.fact} ${c.op} ${c.ref ?? JSON.stringify(c.value)}`;
export const stepSig = (s: Pick<Step, 'action' | 'params'>) =>
  `${s.action}(${Object.keys(s.params).sort().map((k) => `${k}=${s.params[k]}`).join(',')})`;

export function contract(d: Domain, action: string): ActionContract {
  if (!Object.hasOwn(d.actions, action)) throw new Error(`unknown action ${action}`);
  return d.actions[action];
}

const obligationsOf = (a: ActionContract, s: Pick<Step, 'action' | 'params'>): Obligation[] =>
  (a.maintains?.(s.params) ?? []).map((cond) => ({ cond, action: a.type, from: stepSig(s), until: a.maintainsUntil?.(s.params) }));
const ended = (o: Obligation, f: Facts) => !!o.until && evalCond(o.until, f) === 'true';

/** Obligations created by completed steps (in plan order), not yet released by a later completed step nor ended by `until`. */
export function activeObligations(d: Domain, steps: Step[], done: ReadonlySet<string>, f: Facts = {}): Obligation[] {
  let ob: Obligation[] = [];
  for (const s of steps) {
    const a = contract(d, s.action);
    if (!done.has(a.effectKey(s.params))) continue;
    ob = ob.filter((o) => !a.releases?.includes(o.action));
    ob.push(...obligationsOf(a, s));
  }
  return ob.filter((o) => !ended(o, f));
}

export type Ctx = { f: Facts; done: ReadonlySet<string>; unstable: ReadonlySet<string>; active: Obligation[] };
export type Failure = { stepId: string; index: number; cond: Cond; truth: Truth; actual: Json | undefined; obligation?: string };
export type Projection = { ok: boolean; failures: Failure[]; goalFailures: Cond[]; end: Facts; cost: number };

/**
 * Walk the not-yet-done steps forward from current beliefs, applying each step's expected effects.
 * Live obligations are re-evaluated at every position (never a sticky flag). A step fails if:
 *  - an assumption is false/unknown where it would run;
 *  - it is irreversible while an obligation it does not release is broken at that point;
 *  - its effects would break an obligation that held before it (even one a later step releases);
 *  - an obligation it creates does not hold right after it.
 * An obligation still broken at the end is a goal failure: the commitment is never re-established.
 */
export function project(d: Domain, goal: Goal, steps: Step[], c: Ctx): Projection {
  const end: Facts = { ...c.f };
  const failures: Failure[] = [];
  let cost = 0;
  let ob: Obligation[] = [...c.active];
  const holds = (o: Obligation) => evalCond(o.cond, end, c.unstable) === 'true';
  const fail = (s: Step, index: number, o: Obligation) =>
    failures.push({ stepId: s.id, index, cond: o.cond, truth: evalCond(o.cond, end, c.unstable), actual: end[o.cond.fact], obligation: o.from });
  steps.forEach((s, index) => {
    const a = contract(d, s.action);
    if (c.done.has(a.effectKey(s.params))) return;
    const kept = ob.filter((o) => !a.releases?.includes(o.action));
    const heldBefore = new Map(kept.map((o) => [o, holds(o)]));
    if (a.commitment === 'irreversible') for (const o of kept) if (!heldBefore.get(o)) fail(s, index, o);
    for (const r of a.requires(s.params)) {
      const t = evalCond(r, end, c.unstable);
      if (t !== 'true') failures.push({ stepId: s.id, index, cond: r, truth: t, actual: end[r.fact] });
    }
    cost += a.cost(s.params, end);
    Object.assign(end, a.produces(s.params, end));
    for (const o of kept) if (heldBefore.get(o) && !holds(o)) fail(s, index, o);
    const created = obligationsOf(a, s);
    for (const o of created) if (!holds(o) && !failures.some((f) => f.index === index && condText(f.cond) === condText(o.cond))) fail(s, index, o);
    ob = [...kept, ...created].filter((o) => !ended(o, end));
  });
  const goalFailures = [...goal.success.filter((g) => evalCond(g, end, c.unstable) !== 'true'), ...ob.filter((o) => !holds(o)).map((o) => o.cond)];
  return { ok: failures.length === 0 && goalFailures.length === 0, failures, goalFailures, end, cost };
}

/** Every fact the remaining plan, a live obligation, or the goal reads. A change outside this set cannot be material. */
export function referencedFacts(d: Domain, goal: Goal, steps: Step[], c: Pick<Ctx, 'done' | 'active'>): Set<string> {
  const keys = new Set<string>();
  const add = (x: Cond) => { keys.add(x.fact); if (x.ref) keys.add(x.ref); };
  for (const s of steps) {
    const a = contract(d, s.action);
    if (!c.done.has(a.effectKey(s.params))) { a.requires(s.params).forEach(add); a.maintains?.(s.params).forEach(add); }
  }
  c.active.forEach((o) => add(o.cond));
  goal.success.forEach(add);
  return keys;
}

export type Impact = { affected: string[]; preserved: string[]; completed: string[] };

/** "route:R1.status" -> "R1": the entity a fact is about. */
export const entityOf = (fact: string) => /^[\w-]+:([\w-]+)\./.exec(fact)?.[1] ?? null;

/**
 * Causal-link impact. Affected = steps with a failing assumption, remaining steps bound to the entity
 * whose fact changed (e.g. every step parameterised by route R1), and every later step that reads a fact
 * an affected step would have produced. Completed steps and untouched pending steps are preserved.
 */
export function impact(d: Domain, steps: Step[], failures: Failure[], done: ReadonlySet<string>, entities: string[] = []): Impact {
  const affected = new Set(failures.map((x) => x.stepId));
  const broken = new Set<string>();
  const completed: string[] = [];
  for (const s of steps) {
    const a = contract(d, s.action);
    if (done.has(a.effectKey(s.params))) { completed.push(s.id); continue; }
    if (Object.values(s.params).some((v) => typeof v === 'string' && entities.includes(v))) affected.add(s.id);
    const reads = a.requires(s.params).flatMap((c) => (c.ref ? [c.fact, c.ref] : [c.fact]));
    if (!affected.has(s.id) && reads.some((k) => broken.has(k))) affected.add(s.id);
    if (affected.has(s.id)) Object.keys(a.produces(s.params, {})).forEach((k) => broken.add(k));
  }
  const preserved = steps.filter((s) => !affected.has(s.id)).map((s) => s.id);
  return { affected: steps.filter((s) => affected.has(s.id)).map((s) => s.id), preserved, completed };
}

/** One-to-one alignment behind the edit distance: how many steps were rebound, inserted and removed. */
export function editOps(a: Pick<Step, 'action' | 'params'>[], b: Pick<Step, 'action' | 'params'>[]) {
  const x = a.map(stepSig), y = b.map(stepSig);
  const D = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  let i = x.length, j = y.length, modified = 0, inserted = 0, removed = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)) { if (x[i - 1] !== y[j - 1]) modified++; i--; j--; }
    else if (j > 0 && D[i][j] === D[i][j - 1] + 1) { inserted++; j--; }
    else { removed++; i--; }
  }
  return { modified, inserted, removed, distance: D[x.length][y.length] };
}

/** Levenshtein distance over step signatures — the transparent "how much did the plan change" metric. */
export function editDistance(a: Pick<Step, 'action' | 'params'>[], b: Pick<Step, 'action' | 'params'>[]): number {
  const x = a.map(stepSig), y = b.map(stepSig);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
