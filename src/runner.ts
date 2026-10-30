// Imperative shell around the pure engine: persists [input, ...decisions], performs the I/O decisions ask for,
// and runs the SIMULATED world clock. The clock schedules world events and effect completions; it never
// asks the agent to re-think — the agent only reacts to the inputs those produce.
import { decide, reduce, fold, policies } from './engine.ts';
import type { Ev, PolicyName, RunState } from './engine.ts';
import { scenarios } from './scenarios.ts';
import type { FeedItem, Scenario } from './scenarios.ts';
import { sign } from './world.ts';
import type { Observation } from './world.ts';
import { Store } from './store.ts';
import type { Row } from './store.ts';
import { Sim } from './sim.ts';
import type { Faults } from './sim.ts';
import { Planner } from './planner.ts';

type Task = { tick: number; pri: number; seq: number; runId: string | null; fn: () => void };
export type Listener = (rows: Row[]) => void;

/** Turn a scenario feed into signed observations. Identical objects go to every policy's run. */
export function feedObservations(S: Scenario): { tick: number; obs: Observation }[] {
  const seq: Record<string, number> = {};
  const out: { tick: number; obs: Observation }[] = [];
  S.feed.forEach((f: FeedItem, i) => {
    if (f.replayOf !== undefined) { out.push({ tick: f.tick, obs: out[f.replayOf].obs }); return; } // duplicate delivery
    const n = f.seq ?? (seq[f.source] = (seq[f.source] ?? 0) + 1);
    const body = { eventId: `${S.id}-e${i + 1}`, source: f.source, seq: n, fact: f.fact, value: f.value, observedAt: f.tick };
    const key = S.sources[f.source]?.key ?? 'unregistered';
    out.push({ tick: f.tick, obs: { ...body, sig: f.forged ? sign(body, 'attacker-guess') : sign(body, key) } });
  });
  return out;
}

export class Hub {
  store: Store; sim: Sim; planner: Planner;
  states = new Map<string, RunState>();
  sessions = new Map<string, Session>();
  listeners = new Set<Listener>();
  /** Test-only crash injection: SIGKILL this process around the effect boundary of one effect key. */
  failpoint: string | null = process.env.KEEL_FAILPOINT ?? null;
  failEffect: string | null = process.env.KEEL_FAILPOINT_EFFECT ?? null;

  constructor(dbPath = ':memory:', faults: Faults = {}) {
    this.store = new Store(dbPath);
    this.sim = new Sim(this.store, faults);
    this.planner = new Planner();
  }

  state(runId: string): RunState | null {
    let s = this.states.get(runId);
    if (!s) {
      const evs = this.store.events(runId);
      if (!evs.length) return null;
      s = fold(evs);
      this.states.set(runId, s);
    }
    return s;
  }

  /** Process one input and everything it synchronously causes, one at a time (single writer per run). */
  submit(runId: string, input: Ev, session: Session) {
    const q: Ev[] = [input];
    while (q.length) {
      const inp = q.shift()!;
      const st = this.state(runId);
      const decisions = decide(st, inp);
      const rows = this.store.append(runId, st?.seq ?? 0, [inp, ...decisions], session.tick);
      let s = st;
      for (const r of rows) s = reduce(s, r.ev);
      this.states.set(runId, s!);
      for (const l of this.listeners) l(rows);
      for (const d of decisions) this.perform(runId, d, s!, q, session);
    }
  }

  private perform(runId: string, d: Ev, s: RunState, q: Ev[], session: Session) {
    const at = session.tick;
    switch (d.t) {
      case 'dispatch':
        session.schedule(at + d.duration, 1, runId, () => this.submit(runId, { t: 'effect_ready', opId: d.opId, at: session.tick }, session));
        break;
      case 'commit_effect': {
        const row = s.ledger[d.opId];
        const die = (point: string) => { if (this.failpoint === point && (!this.failEffect || this.failEffect === row.effectKey)) process.kill(process.pid, 'SIGKILL'); };
        die('before_effect');
        const r = this.sim.execute(runId, scenarios[s.scenario], row.opId, row.action, row.params, row.effectKey, at);
        die('after_effect');
        q.push(r.kind === 'receipt' ? { t: 'receipt', opId: row.opId, at, detail: r.detail } : { t: 'effect_uncertain', opId: row.opId, at });
        break;
      }
      case 'reconcile_requested':
        q.push({ t: 'reconciled', opId: d.opId, found: this.sim.lookup(d.opId), at });
        break;
      case 'repair_requested':
        q.push({ t: 'planner_output', requestId: d.requestId, candidates: this.planner.propose(s), at });
        break;
    }
  }

  /** Simulated agent crash: all in-memory agent state and agent timers for the run are dropped, then rebuilt from the log. */
  crashAndRecover(runId: string, session: Session) {
    this.states.delete(runId);
    session.dropAgentTasks(runId);
    this.submit(runId, { t: 'recover', at: session.tick }, session);
  }
}

export class Session {
  tick = 0;
  private queue: Task[] = [];
  private n = 0;
  private timer: NodeJS.Timeout | null = null;
  runIds: string[];
  hub: Hub; id: string; scenario: string; policyNames: PolicyName[];

  constructor(hub: Hub, id: string, scenario: string, policyNames: PolicyName[]) {
    this.hub = hub; this.id = id; this.scenario = scenario; this.policyNames = policyNames;
    if (!scenarios[scenario]) throw new Error(`unknown scenario ${scenario}`);
    for (const p of policyNames) if (!policies[p]) throw new Error(`unknown policy ${p}`);
    this.runIds = policyNames.map((p) => `${id}-${p}`);
    hub.sessions.set(id, this);
  }

  schedule(tick: number, pri: number, runId: string | null, fn: () => void) {
    this.queue.push({ tick, pri, seq: this.n++, runId, fn });
    this.queue.sort((a, b) => a.tick - b.tick || a.pri - b.pri || a.seq - b.seq);
  }
  dropAgentTasks(runId: string) { this.queue = this.queue.filter((t) => t.runId !== runId || t.pri === 0); }

  /** Start every policy's run and schedule the shared world feed (priority 0: world events land before effect completions in a tick). */
  start() {
    const S = scenarios[this.scenario];
    this.policyNames.forEach((p, i) => {
      const runId = this.runIds[i];
      this.hub.store.createRun(runId, this.id, this.scenario, p);
      this.hub.submit(runId, { t: 'start', runId, scenario: this.scenario, policy: p, at: 0 }, this);
    });
    for (const { tick, obs } of feedObservations(S)) {
      for (const runId of this.runIds) this.schedule(tick, 0, null, () => this.inject(runId, obs));
    }
    return this;
  }

  /** Rebuild a session after the process died: clock from the log, undelivered world events rescheduled, every run recovered. */
  static resume(hub: Hub, id: string): Session {
    const runs = hub.store.runs(id);
    if (!runs.length) throw new Error(`no session ${id}`);
    const s = new Session(hub, id, runs[0].scenario, runs.map((r) => r.policy as PolicyName));
    s.tick = Math.max(...runs.map((r) => hub.store.rows(r.runId).at(-1)?.tick ?? 0));
    for (const r of runs) {
      const delivered = hub.store.events(r.runId).flatMap((e) => (e.t === 'observation' ? [e.obs.eventId] : []));
      for (const { tick, obs } of feedObservations(scenarios[s.scenario])) {
        const i = delivered.indexOf(obs.eventId);
        if (i >= 0) { delivered.splice(i, 1); continue; }
        s.schedule(Math.max(tick, s.tick), 0, null, () => s.inject(r.runId, obs));
      }
      hub.states.delete(r.runId);
      hub.submit(r.runId, { t: 'recover', at: s.tick }, s);
    }
    return s;
  }

  inject(runId: string, obs: Observation) { this.hub.submit(runId, { t: 'observation', obs, at: this.tick }, this); }
  injectAll(obs: Observation) { for (const r of this.runIds) this.inject(r, obs); }

  private runDue() {
    while (this.queue.length && this.queue[0].tick <= this.tick) this.queue.shift()!.fn();
  }

  /** Virtual time: advance tick by tick until nothing is left or `maxTick`. Deterministic. */
  runToEnd(maxTick = 80) {
    while (this.tick <= maxTick) {
      this.runDue();
      if (!this.queue.length && this.runIds.every((r) => this.settled(r))) break;
      this.tick++;
    }
    return this;
  }

  /** Real time for the live demo: one tick every `ms`. */
  play(ms: number, maxTick = 80) {
    this.stop();
    this.timer = setInterval(() => {
      this.runDue();
      if ((this.tick >= maxTick) || (!this.queue.length && this.runIds.every((r) => this.settled(r)))) return this.stop();
      this.tick++;
    }, ms);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  settled(runId: string) {
    const s = this.hub.state(runId);
    return !s || s.status === 'completed' || s.status === 'stopped' || (s.status === 'paused' && !s.inflight);
  }
}
