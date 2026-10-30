// Plan repair: deterministic flaw-directed search + the validator every candidate (search or model) must pass.
import { contract, editDistance, evalCond, project, stepSig } from './model.ts';
import type { Cond, Ctx, Domain, Facts, Goal, Params, Step } from './model.ts';

export type Draft = Pick<Step, 'action' | 'params'>;
export type ModelMeta = { mode: 'recorded' | 'live'; model: string; capturedAt: string; promptSha256: string; responseSha256: string };
export type Candidate = { origin: string; steps: Draft[]; rationale: string; model?: ModelMeta; scope?: 'local' | 'full' };
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
const why = (f: { cond: Cond; truth: string; actual: unknown; obligation?: string }) =>
  `${f.obligation ? `the commitment made by ${f.obligation} — ` : ''}${f.cond.fact} ${f.cond.op} ${f.cond.ref ?? JSON.stringify(f.cond.value)}, but it is ${f.truth === 'unknown' ? 'UNKNOWN (unstable, missing or not a number)' : JSON.stringify(f.actual)}`;

/**
 * Executable contract check. Model output is untrusted, so this is the only path to a committed plan.
 * The runtime re-derives every assumption from the contract; a candidate cannot supply its own.
 * `preserve` = signatures of pending steps the repair must keep (only an explicit full-replan scope may drop them).
 */
export function validate(d: Domain, goal: Goal, cand: Draft[], remaining: Step[], c: Ctx, preserve: string[] = [], scope: 'local' | 'full' = 'local'): Verdict {
  const checks: Check[] = [];
  const fail = (): Verdict => ({ valid: false, checks, cost: Infinity, distance: Infinity });
  const shapeOk = Array.isArray(cand) && cand.length <= 12 && cand.every((s) => !!s && typeof s.action === 'string' && !!s.params && typeof s.params === 'object' && !Array.isArray(s.params));
  checks.push({ id: 'shape', pass: shapeOk, detail: shapeOk ? 'well-formed step list (≤12 steps)' : 'malformed candidate' });
  if (!shapeOk) return fail();
  const unknown = cand.find((s) => !Object.hasOwn(d.actions, s.action));
  checks.push({ id: 'catalog', pass: !unknown, detail: unknown ? `unknown action "${unknown.action}"` : 'every step is a registered action contract' });
  if (unknown) return fail();
  const badParam = cand.find((s) => !bindings(d, s.action, c.f).some((b) => stepSig({ action: s.action, params: b }) === stepSig(s)));
  checks.push({ id: 'params', pass: !badParam, detail: badParam ? `${stepSig(badParam)} binds an entity that does not exist` : 'all parameters bind to known entities' });
  if (badParam) return fail();
  const repeat = cand.find((s) => c.done.has(contract(d, s.action).effectKey(s.params)));
  checks.push({ id: 'no-duplicate-effect', pass: !repeat, detail: repeat ? `${stepSig(repeat)} would repeat an effect that already has a receipt` : 'no completed effect is repeated' });
  const keys = cand.map((s) => contract(d, s.action).effectKey(s.params));
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  checks.push({ id: 'single-effect', pass: !twice, detail: twice ? `effect ${twice} appears twice in the plan` : 'each effect appears at most once' });
  const sigs = cand.map(stepSig);
  const dropped = preserve.filter((p) => !sigs.includes(p));
  checks.push({
    id: 'commitments-kept', pass: scope === 'full' || dropped.length === 0,
    detail: dropped.length === 0 ? `unaffected pending steps kept unchanged (${preserve.length})` : scope === 'full' ? `scope expanded to a full replan: ${dropped.join(', ')} not kept` : `drops unaffected step ${dropped[0]}`,
  });
  const proj = project(d, goal, asSteps(cand), c);
  const f0 = proj.failures[0];
  checks.push({ id: 'assumptions', pass: !f0, detail: f0 ? `${sigs[f0.index]} needs ${why(f0)}` : 'every assumption and live commitment holds, in order' });
  checks.push({ id: 'goal', pass: proj.goalFailures.length === 0, detail: proj.goalFailures.length ? `goal or commitment ${proj.goalFailures[0].fact} ${proj.goalFailures[0].op} ${proj.goalFailures[0].ref ?? JSON.stringify(proj.goalFailures[0].value)} is not reached` : 'goal reached and every commitment holds at the end' });
  const valid = checks.every((x) => x.pass);
  return { valid, checks, cost: proj.cost, distance: editDistance(remaining, cand) };
}

/** Would applying `s` (on beliefs `f`) make condition `c` true? */
function establishes(d: Domain, s: Draft, c: Cond, f: Facts): boolean {
  const after = { ...f, ...contract(d, s.action).produces(s.params, f) };
  return evalCond(c, after) === 'true' && evalCond(c, f) !== 'true';
}

/**
 * Flaw-directed repair (plan-space style): take the first broken assumption and resolve it by
 *   rebind    — same action, other entity (the substitution propagates to sibling steps bound to the same entity),
 *   establish — insert an action whose expected effect makes the assumption true,
 *   release   — insert an action that ends a broken commitment (e.g. move traffic off a failed region),
 *   drop      — remove the flawed step.
 * Breadth-first by number of moves, so the first solved layer is the smallest change; ties by edit distance, then cost.
 */
export function flawRepairs(d: Domain, goal: Goal, remaining: Step[], c: Ctx, preserve: string[] = [], maxMoves = 4): Candidate[] {
  const actions = Object.keys(d.actions).flatMap((a) => bindings(d, a, c.f).map((params) => ({ action: a, params })))
    .filter((s) => !c.done.has(contract(d, s.action).effectKey(s.params)));
  const start: Draft[] = remaining.map(({ action, params }) => ({ action, params }));
  const seen = new Set([start.map(stepSig).join('>')]);
  const ok = (k: Draft[]) => validate(d, goal, k, remaining, c, preserve);
  let layer = [start];
  for (let depth = 1; depth <= maxMoves; depth++) {
    const next: Draft[][] = [];
    const found: Draft[][] = [];
    for (const steps of layer) {
      const proj = project(d, goal, asSteps(steps), c);
      const flaw = proj.failures[0];
      const kids: Draft[][] = [];
      const releasers = (actionType: string) => actions.filter((s) => contract(d, s.action).releases?.includes(actionType));
      if (flaw) {
        const i = flaw.index, cur = steps[i];
        for (const b of bindings(d, cur.action, c.f)) {
          if (stepSig({ action: cur.action, params: b }) === stepSig(cur)) continue;
          const swaps = Object.entries(cur.params).filter(([k, v]) => b[k] !== v).map(([k, v]) => [v, b[k]] as const);
          kids.push(steps.map((s, j) => j === i ? { action: cur.action, params: b }
            : { action: s.action, params: Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, swaps.find(([from]) => from === v)?.[1] ?? v])) }));
        }
        const before = project(d, goal, asSteps(steps.slice(0, i)), c).end;
        for (const s of actions) if (establishes(d, s, flaw.cond, before)) kids.push(steps.toSpliced(i, 0, s));
        const ob = flaw.obligation ? c.active.find((o) => o.from === flaw.obligation) : undefined;
        if (ob) for (const s of releasers(ob.action)) kids.push(steps.toSpliced(i, 0, s));
        kids.push(steps.toSpliced(i, 1));
      } else if (proj.goalFailures.length) {
        const g = proj.goalFailures[0];
        for (const s of actions) if (establishes(d, s, g, proj.end)) kids.push([...steps, s]);
        const ob = c.active.find((o) => o.cond === g);
        if (ob) for (const s of releasers(ob.action)) kids.push([s, ...steps]);
      }
      for (const k of kids) {
        const key = k.map(stepSig).join('>');
        if (seen.has(key)) continue;
        seen.add(key);
        if (ok(k).valid) found.push(k);
        else next.push(k);
      }
    }
    if (found.length) {
      return found
        .map((steps) => ({ steps, v: ok(steps) }))
        .sort((a, b) => a.v.distance - b.v.distance || a.v.cost - b.v.cost)
        .map(({ steps, v }) => ({ origin: 'search', scope: 'local' as const, steps, rationale: `flaw-directed repair: ${depth} move${depth > 1 ? 's' : ''}, edit distance ${v.distance}` }));
    }
    layer = next.slice(0, 2000); // ponytail: layer cap keeps demo domains instant; real catalogs need a heuristic
  }
  return [];
}

/** Full replan from current beliefs (breadth-first over the catalog). Used only when no bounded repair exists. */
export function fullReplan(d: Domain, goal: Goal, c: Ctx, maxDepth = 7): Candidate[] {
  const all = Object.keys(d.actions).flatMap((a) => bindings(d, a, c.f).map((params) => ({ action: a, params })))
    .filter((s) => !c.done.has(contract(d, s.action).effectKey(s.params)));
  type Node = { seq: Draft[] };
  let frontier: Node[] = [{ seq: [] }];
  const visited = new Set<string>();
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: Node[] = [];
    const found: Candidate[] = [];
    for (const node of frontier) {
      for (const s of all) {
        const seq = [...node.seq, s];
        const proj = project(d, goal, asSteps(seq), c);
        if (proj.failures.length) continue;
        const state = JSON.stringify(Object.entries(proj.end).sort());
        if (visited.has(state)) continue; // same beliefs reached by another ordering
        visited.add(state);
        if (proj.goalFailures.length === 0) found.push({ origin: 'search:full-replan', scope: 'full', steps: seq, rationale: `full replan from current beliefs, ${depth} steps, cost ${proj.cost}` });
        else next.push({ seq });
      }
    }
    if (found.length) return found;
    frontier = next.slice(0, 3000); // ponytail: same cap as above
  }
  return [];
}
