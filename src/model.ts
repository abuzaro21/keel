// Plan model: facts, conditions, action contracts, plan projection and impact analysis.
// Everything here is pure: no I/O, no clock, no randomness — so decisions replay exactly.

export type Json = string | number | boolean | null;
export type Facts = Record<string, Json>;
export type Op = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
/** An assumption. Compared against a literal `value` or against another fact (`ref`). */
export type Cond = { fact: string; op: Op; value?: Json; ref?: string };
export type Params = Record<string, Json>;

export type ActionContract = {
  type: string;
  describe: string;
  /** param name -> domain name; domains enumerate legal values from current facts. */
  params: Record<string, string>;
  commitment: 'reversible' | 'irreversible';
  duration: number;
  cost(p: Params, f: Facts): number;
  /** Assumptions this step needs. Derived from code, so a planner cannot omit them. */
  requires(p: Params): Cond[];
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

/** Three-valued: a condition over a fact we no longer trust is UNKNOWN, never true. */
export type Truth = 'true' | 'false' | 'unknown';

export function evalCond(c: Cond, f: Facts, unstable: ReadonlySet<string> = new Set()): Truth {
  if (unstable.has(c.fact) || (c.ref && unstable.has(c.ref))) return 'unknown';
  const a = f[c.fact];
  const b = c.ref !== undefined ? f[c.ref] : c.value;
  if (a === undefined || b === undefined) return 'unknown';
  let ok: boolean;
  switch (c.op) {
    case 'eq': ok = a === b; break;
    case 'neq': ok = a !== b; break;
    case 'lt': ok = (a as number) < (b as number); break;
    case 'lte': ok = (a as number) <= (b as number); break;
    case 'gt': ok = (a as number) > (b as number); break;
    case 'gte': ok = (a as number) >= (b as number); break;
  }
  return ok ? 'true' : 'false';
}

export const condText = (c: Cond) => `${c.fact} ${c.op} ${c.ref ?? JSON.stringify(c.value)}`;
export const stepSig = (s: Pick<Step, 'action' | 'params'>) =>
  `${s.action}(${Object.keys(s.params).sort().map((k) => `${k}=${s.params[k]}`).join(',')})`;

export function contract(d: Domain, action: string): ActionContract {
  const a = d.actions[action];
  if (!a) throw new Error(`unknown action ${action}`);
  return a;
}

export type Failure = { stepId: string; index: number; cond: Cond; truth: Truth; actual: Json | undefined };
export type Projection = { ok: boolean; failures: Failure[]; goalFailures: Cond[]; end: Facts; cost: number };

/**
 * Walk the not-yet-done steps forward from current beliefs, applying each step's expected effects.
 * A step fails if any assumption is false or unknown at the point it would run.
 * `done` holds effect keys that already have receipts: those steps are skipped, their facts are already in `f`.
 */
export function project(d: Domain, goal: Goal, steps: Step[], f: Facts, done: ReadonlySet<string>, unstable: ReadonlySet<string> = new Set()): Projection {
  const end: Facts = { ...f };
  const failures: Failure[] = [];
  let cost = 0;
  steps.forEach((s, index) => {
    const a = contract(d, s.action);
    if (done.has(a.effectKey(s.params))) return;
    for (const c of a.requires(s.params)) {
      const t = evalCond(c, end, unstable);
      if (t !== 'true') failures.push({ stepId: s.id, index, cond: c, truth: t, actual: end[c.fact] });
    }
    cost += a.cost(s.params, end);
    Object.assign(end, a.produces(s.params, end));
  });
  const goalFailures = goal.success.filter((c) => evalCond(c, end, unstable) !== 'true');
  return { ok: failures.length === 0 && goalFailures.length === 0, failures, goalFailures, end, cost };
}

/** Every fact the remaining plan or the goal reads. A change outside this set cannot be material. */
export function referencedFacts(d: Domain, goal: Goal, steps: Step[], done: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  const add = (c: Cond) => { keys.add(c.fact); if (c.ref) keys.add(c.ref); };
  for (const s of steps) {
    const a = contract(d, s.action);
    if (!done.has(a.effectKey(s.params))) a.requires(s.params).forEach(add);
  }
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
export function impact(d: Domain, steps: Step[], failures: Failure[], done: ReadonlySet<string>, entity: string | null = null): Impact {
  const affected = new Set(failures.map((x) => x.stepId));
  const broken = new Set<string>();
  const completed: string[] = [];
  for (const s of steps) {
    const a = contract(d, s.action);
    if (done.has(a.effectKey(s.params))) { completed.push(s.id); continue; }
    if (entity && Object.values(s.params).includes(entity)) affected.add(s.id);
    const reads = a.requires(s.params).flatMap((c) => (c.ref ? [c.fact, c.ref] : [c.fact]));
    if (!affected.has(s.id) && reads.some((k) => broken.has(k))) affected.add(s.id);
    if (affected.has(s.id)) Object.keys(a.produces(s.params, {})).forEach((k) => broken.add(k));
  }
  const preserved = steps.filter((s) => !affected.has(s.id)).map((s) => s.id);
  return { affected: steps.filter((s) => affected.has(s.id)).map((s) => s.id), preserved, completed };
}

/** Levenshtein distance over step signatures — the transparent "how much did the plan change" metric. */
export function editDistance(a: Step[], b: Step[]): number {
  const x = a.map(stepSig), y = b.map(stepSig);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
