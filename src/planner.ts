// Candidate generation. Every candidate here is UNTRUSTED: the engine validates it against contracts and
// current beliefs before anything commits. Model output is one more candidate source, never an authority.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { contract, stepSig } from './model.ts';
import { flawRepairs, fullReplan } from './repair.ts';
import type { Candidate, Draft } from './repair.ts';
import { ctxOf, remainingOf } from './engine.ts';
import type { RunState } from './engine.ts';
import { scenarios } from './scenarios.ts';

export type Recording = {
  fingerprint: string; scenario: string; model: string; capturedAt: string;
  prompt: string; response: string; promptSha256: string; responseSha256: string;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Everything planning-relevant, canonicalised. Two runs with the same context get the same recorded answer. */
export function planningContext(s: RunState) {
  const S = scenarios[s.scenario];
  const D = S.domain;
  return {
    goal: s.goal,
    catalog: Object.values(D.actions).map((a) => ({ action: a.type, params: a.params, describe: a.describe, commitment: a.commitment })),
    entities: Object.fromEntries(Object.entries(D.domains).map(([k, fn]) => [k, fn(s.world.facts)])),
    beliefs: Object.fromEntries(Object.entries(s.world.facts).sort(([a], [b]) => a.localeCompare(b))),
    unstableFacts: [...s.world.unstable].sort(),
    liveCommitments: ctxOf(s).active.map((o) => `${o.from} keeps ${o.cond.fact} ${o.cond.op} ${o.cond.ref ?? JSON.stringify(o.cond.value)}`),
    completed: s.plan.steps.filter((x) => s.done.includes(contract(D, x.action).effectKey(x.params))).map(stepSig),
    remainingPlan: remainingOf(s).map(stepSig),
    brokenAssumptions: s.lastContradiction?.failures.map((f) => `${f.sig} needs ${f.cond} (now ${f.truth === 'unknown' ? 'UNKNOWN' : JSON.stringify(f.actual)})`) ?? [],
  };
}
export const fingerprint = (s: RunState) => sha(JSON.stringify({ scenario: s.scenario, ...planningContext(s) }));

export function plannerPrompt(s: RunState): string {
  return [
    'You are the repair planner inside an adaptive agent. A running plan has broken assumptions.',
    'Propose up to 3 alternative continuations (the steps still to run) that reach the goal.',
    'Use ONLY actions from the catalog and entities from the entity lists. Completed steps already happened and must not be repeated.',
    'Prefer the smallest change to the remaining plan. Your output will be validated by a deterministic checker; invalid plans are discarded.',
    'Reply with JSON only: {"candidates":[{"rationale":"...","steps":[{"action":"...","params":{...}}]}]}',
    '',
    JSON.stringify(planningContext(s), null, 2),
  ].join('\n');
}

export function parseModelResponse(text: string): { rationale: string; steps: Draft[] }[] {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]) as { candidates?: { rationale?: unknown; steps?: unknown }[] };
    return (j.candidates ?? []).slice(0, 3).map((c) => ({ rationale: String(c.rationale ?? ''), steps: (Array.isArray(c.steps) ? c.steps : []) as Draft[] }));
  } catch { return []; }
}

export class Planner {
  recordings: Recording[];
  constructor(file = new URL('../fixtures/planner-recordings.json', import.meta.url)) {
    // KEEL_PLANNER=search disables recorded model output (engine tests stay independent of fixture contents).
    this.recordings = process.env.KEEL_PLANNER !== 'search' && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Recording[] : [];
  }

  /** Recorded genuine model output for exactly this planning context, if one was captured. */
  recorded(s: RunState): Candidate[] {
    const fp = fingerprint(s);
    const r = this.recordings.find((x) => x.fingerprint === fp);
    if (!r) return [];
    return parseModelResponse(r.response).map((c) => ({
      origin: `model:recorded`, steps: c.steps, rationale: c.rationale,
      model: { mode: 'recorded', model: r.model, capturedAt: r.capturedAt, promptSha256: r.promptSha256, responseSha256: r.responseSha256 },
    }));
  }

  /** Synchronous candidates (no network). Live inference, when enabled, is added by the runner. */
  propose(s: RunState): Candidate[] {
    const S = scenarios[s.scenario];
    const c = ctxOf(s);
    const remaining = remainingOf(s);
    if (s.cfg.reviseOnAnyChange) {
      // Naive adaptive: replans from scratch for the cheapest plan on every change.
      return [...fullReplan(S.domain, s.goal, c), ...flawRepairs(S.domain, s.goal, remaining, c)];
    }
    const lc = s.lastContradiction;
    const preserve = (lc?.preserved ?? []).flatMap((id) => remaining.filter((x) => x.id === id && !(lc?.affected ?? []).includes(id)).map(stepSig));
    const local = flawRepairs(S.domain, s.goal, remaining, c, preserve);
    const search = local.length ? local : fullReplan(S.domain, s.goal, c);
    return [...this.recorded(s), ...search];
  }
}

export const sha256 = sha;
