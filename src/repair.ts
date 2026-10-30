// Plan repair: deterministic flaw-directed search + the validator every candidate (search or model) must pass.
import { contract, editDistance, evalCond, project, stepSig } from './model.ts';
import type { Cond, Domain, Facts, Goal, Params, Step } from './model.ts';

export type Draft = Pick<Step, 'action' | 'params'>;
export type Candidate = { origin: string; steps: Draft[]; rationale: string; model?: ModelMeta };
export type ModelMeta = { mode: 'recorded' | 'live'; model: string; capturedAt: string; promptSha256: string; responseSha256: string };
export type Check = { id: string; pass: boolean; detail: string };
export type Verdict = { valid: boolean; checks: Check[]; cost: number; distance: number };

/** All legal parameter bindings for an action, enumerated from current beliefs. */
export function bindings(d: Domain, action: string, f: Facts): Params[] {
  const a = contract(d, action);
  let out: Params[] = [{}];
  for (const [name, dom] of Object.entries(a.params)) {
    const values = d.domains[dom]?.(f) ?? [];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [name]: v })));
  }
  return out;
}

const asSteps = (c: Draft[]): Step[] => c.map((s, i) => ({ id: `c${i}`, ...s }));

/**
 * Executable contract check. Model output is untrusted, so this is the only path to a committed plan.
 * The runtime re-derives every assumption from the contract; a candidate cannot supply its own.
 */
export function validate(d: Domain, goal: Goal, cand: Draft[], remaining: Step[], f: Facts, done: ReadonlySet<string>, unstable: ReadonlySet<string>): Verdict {
  const checks: Check[] = [];
  const fail = (): Verdict => ({ valid: false, checks, cost: Infinity, distance: Infinity });
  const shapeOk = Array.isArray(cand) && cand.length <= 12 && cand.every((s) => s && typeof s.action === 'string' && s.params && typeof s.params === 'object');
  checks.push({ id: 'shape', pass: shapeOk, detail: shapeOk ? 'well-formed step list (≤12 steps)' : 'malformed candidate' });
  if (!shapeOk) return fail();
  const unknown = cand.find((s) => !Object.hasOwn(d.actions, s.action));
  checks.push({ id: 'catalog', pass: !unknown, detail: unknown ? `unknown action "${unknown.action}"` : 'every step is a registered action contract' });
  if (unknown) return fail();
  const badParam = cand.find((s) => !bindings(d, s.action, f).some((b) => stepSig({ action: s.action, params: b }) === stepSig(s)));
  checks.push({ id: 'params', pass: !badParam, detail: badParam ? `${stepSig(badParam)} binds an entity that does not exist` : 'all parameters bind to known entities' });
  if (badParam) return fail();
  const repeat = cand.find((s) => done.has(contract(d, s.action).effectKey(s.params)));
  checks.push({ id: 'no-duplicate-effect', pass: !repeat, detail: repeat ? `${stepSig(repeat)} would repeat an effect that already has a receipt` : 'no completed effect is repeated' });
  const keys = cand.map((s) => contract(d, s.action).effectKey(s.params));
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  checks.push({ id: 'single-effect', pass: !twice, detail: twice ? `effect ${twice} appears twice in the plan` : 'each effect appears at most once' });
  const proj = project(d, goal, asSteps(cand), f, done, unstable);
  const f0 = proj.failures[0];
  checks.push({
    id: 'assumptions', pass: !f0,
    detail: f0 ? `${stepSig(cand[f0.index])} needs ${f0.cond.fact} ${f0.cond.op} ${f0.cond.ref ?? JSON.stringify(f0.cond.value)}, but it is ${f0.truth === 'unknown' ? 'UNKNOWN (unstable or missing)' : JSON.stringify(f0.actual)}` : 'every assumption holds on current beliefs, in order',
  });
  checks.push({ id: 'goal', pass: proj.goalFailures.length === 0, detail: proj.goalFailures.length ? `goal condition ${proj.goalFailures[0].fact} is not reached` : 'goal reached at end of plan' });
  const valid = checks.every((c) => c.pass);
  return { valid, checks, cost: proj.cost, distance: editDistance(remaining, asSteps(cand)) };
}

/** Would applying `s` (on beliefs `f`) make condition `c` true? */
function establishes(d: Domain, s: Draft, c: Cond, f: Facts): boolean {
  const after = { ...f, ...contract(d, s.action).produces(s.params, f) };
  return evalCond(c, after) === 'true' && evalCond(c, f) !== 'true';
}

/**
 * Flaw-directed repair (plan-space style): take the first broken assumption and resolve it by
 *   rebind  — same action, other entity (substitution propagates to sibling steps bound to the same entity),
 *   establish — insert an action whose expected effect makes the assumption true,
 *   drop    — remove the flawed step.
 * Breadth-first by number of moves, so the first solved layer is the smallest change; ties by edit distance, then cost.
 */
export function flawRepairs(d: Domain, goal: Goal, remaining: Step[], f: Facts, done: ReadonlySet<string>, unstable: ReadonlySet<string>, maxMoves = 4): Candidate[] {
  const actions = Object.keys(d.actions).flatMap((a) => bindings(d, a, f).map((params) => ({ action: a, params })))
    .filter((s) => !done.has(contract(d, s.action).effectKey(s.params)));
  const start: Draft[] = remaining.map(({ action, params }) => ({ action, params }));
  const seen = new Set([start.map(stepSig).join('>')]);
  let layer = [start];
  for (let depth = 1; depth <= maxMoves; depth++) {
    const next: Draft[][] = [];
    const found: Draft[][] = [];
    for (const steps of layer) {
      const proj = project(d, goal, asSteps(steps), f, done, unstable);
      const flaw = proj.failures[0];
      const kids: Draft[][] = [];
      if (flaw) {
        const i = flaw.index, cur = steps[i];
        for (const b of bindings(d, cur.action, f)) {
          if (stepSig({ action: cur.action, params: b }) === stepSig(cur)) continue;
          const swaps = Object.entries(cur.params).filter(([k, v]) => b[k] !== v).map(([k, v]) => [v, b[k]] as const);
          kids.push(steps.map((s, j) => j === i ? { action: cur.action, params: b }
            : { action: s.action, params: Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, swaps.find(([from]) => from === v)?.[1] ?? v])) }));
        }
        const before = project(d, goal, asSteps(steps.slice(0, i)), f, done, unstable).end;
        for (const s of actions) if (establishes(d, s, flaw.cond, before)) kids.push(steps.toSpliced(i, 0, s));
        kids.push(steps.toSpliced(i, 1));
      } else if (proj.goalFailures.length) {
        for (const s of actions) if (establishes(d, s, proj.goalFailures[0], proj.end)) kids.push([...steps, s]);
      }
      for (const k of kids) {
        const key = k.map(stepSig).join('>');
        if (seen.has(key)) continue;
        seen.add(key);
        if (validate(d, goal, k, remaining, f, done, unstable).valid) found.push(k);
        else next.push(k);
      }
    }
    if (found.length) {
      return found
        .map((steps) => ({ steps, v: validate(d, goal, steps, remaining, f, done, unstable) }))
        .sort((a, b) => a.v.distance - b.v.distance || a.v.cost - b.v.cost)
        .map(({ steps, v }) => ({ origin: 'search', steps, rationale: `flaw-directed repair: ${depth} move${depth > 1 ? 's' : ''}, edit distance ${v.distance}` }));
    }
    layer = next.slice(0, 2000); // ponytail: layer cap keeps demo domains instant; real catalogs need a heuristic
  }
  return [];
}

/** Full replan from current beliefs (breadth-first over the catalog). Used only when no bounded repair exists. */
export function fullReplan(d: Domain, goal: Goal, f: Facts, done: ReadonlySet<string>, unstable: ReadonlySet<string>, maxDepth = 6): Candidate[] {
  const all = Object.keys(d.actions).flatMap((a) => bindings(d, a, f).map((params) => ({ action: a, params })))
    .filter((s) => !done.has(contract(d, s.action).effectKey(s.params)));
  type Node = { seq: Draft[]; end: Facts; cost: number; keys: Set<string> };
  let frontier: Node[] = [{ seq: [], end: { ...f }, cost: 0, keys: new Set() }];
  const visited = new Set<string>();
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: Node[] = [];
    const found: Candidate[] = [];
    for (const node of frontier) {
      for (const s of all) {
        const a = contract(d, s.action), key = a.effectKey(s.params);
        if (node.keys.has(key)) continue;
        if (!a.requires(s.params).every((c) => evalCond(c, node.end, unstable) === 'true')) continue;
        const end = { ...node.end, ...a.produces(s.params, node.end) };
        const state = JSON.stringify(Object.entries(end).sort());
        if (visited.has(state)) continue; // same beliefs reached by another ordering
        visited.add(state);
        const child = { seq: [...node.seq, s], end, cost: node.cost + a.cost(s.params, node.end), keys: new Set([...node.keys, key]) };
        if (goal.success.every((c) => evalCond(c, end, unstable) === 'true')) found.push({ origin: 'search:full-replan', steps: child.seq, rationale: `full replan from current beliefs, ${depth} steps, cost ${child.cost}` });
        else next.push(child);
      }
    }
    if (found.length) return found;
    frontier = next;
  }
  return [];
}
