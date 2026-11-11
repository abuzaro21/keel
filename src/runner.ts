// Imperative shell around the pure engine: persists [input, ...decisions], performs the I/O decisions ask for,
// and runs the SIMULATED world clock. The clock schedules world events and effect completions; it never
// asks the agent to re-think — the agent only reacts to the inputs those produce.
//
// Concurrency: each run has a mailbox (a promise chain). Inputs for one run are processed strictly one at a time:
// decide -> append to the store (awaited, head-checked) -> perform. Nothing for that run can interleave between the
// engine's final check (`commit_effect`) and the simulated effect. Different runs proceed independently.
import { decide, reduce, fold, policies, startContext } from './engine.ts';
import type { Ev, PolicyName, RunState } from './engine.ts';
import { scenarios } from './scenarios.ts';
import type { FeedItem, Scenario } from './scenarios.ts';
import { sign } from './world.ts';
import type { Observation } from './world.ts';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore, FencedError } from './store.ts';
import type { EffectRow, Injection, Row, Store } from './store.ts';
import { Sim } from './sim.ts';
import type { Faults } from './sim.ts';
import { Planner } from './planner.ts';

type Task = { tick: number; pri: number; seq: number; runId: string | null; fn: () => Promise<void> | void };
export type Listener = (rows: Row[]) => void;

/**
 * One sequence space per tick, so a later observation always outranks an earlier one on the same source/fact lane:
 * scheduled feed items take tick*1000 + 1.., world reports tick*1000 + 400.., visitor injections tick*1000 + 500..
 * (truth applies a visitor change after the scheduled change of the same tick, so the agent's belief order matches).
 * ponytail: 400 feed items per source and 500 reports or injections per tick and lane; widen SEQ_TICK if a scenario grows.
 */
export const SEQ_TICK = 1000;
/** Turn a scenario feed into signed observations. Identical objects go to every policy's run. */
export function feedObservations(S: Scenario): { tick: number; obs: Observation }[] {
  const seq: Record<string, number> = {};
  const out: { tick: number; obs: Observation }[] = [];
  S.feed.forEach((f: FeedItem, i) => {
    if (f.replayOf !== undefined) { out.push({ tick: f.tick, obs: out[f.replayOf].obs }); return; } // duplicate delivery
    const n = f.seq ?? f.tick * SEQ_TICK + (seq[f.source] = (seq[f.source] ?? 0) + 1); // an explicit seq (e.g. a deliberately stale 0) is kept
    const body = { eventId: `${S.id}-e${i + 1}`, source: f.source, seq: n, fact: f.fact, value: f.value, observedAt: f.tick };
    const key = S.sources[f.source]?.key ?? 'unregistered';
    out.push({ tick: f.tick, obs: { ...body, sig: f.forged ? sign(body, 'attacker-guess') : sign(body, key) } });
  });
  return out;
}

/** The session was unloaded (evicted) or stopped while a request still held it: the caller should reload it by id. */
export class SessionClosedError extends Error { constructor(id: string) { super(`session ${id} was unloaded`); } }

export class Hub {
  store: Store; sim: Sim; planner: Planner;
  states = new Map<string, RunState>();
  sessions = new Map<string, Session>();
  listeners = new Set<Listener>();
  /** Presentation only: told when a session's world clock advances (the agent is never told). */
  tickListeners = new Set<(session: Session) => void>();
  private chains = new Map<string, Promise<unknown>>();
  /** Set once another process claimed the database: this process must stop writing (and stops its sessions). */
  fenced: FencedError | null = null;
  /** Test-only crash injection: SIGKILL this process around the effect boundary of one effect key. */
  failpoint: string | null = process.env.KEEL_FAILPOINT ?? null;
  failEffect: string | null = process.env.KEEL_FAILPOINT_EFFECT ?? null;

  private constructor(store: Store, faults: Faults) {
    this.store = store;
    this.sim = new Sim(store, faults);
    this.planner = new Planner();
    store.onFenced = (e) => this.fence(e); // any refused write, from any path, stops this process's sessions
  }
  /** Open the store and claim it: this process becomes the only writer; any older process is fenced off. */
  static async open(target?: string, faults: Faults = {}, schema?: string): Promise<Hub> {
    const store = await openStore(target, schema);
    await store.claim(`${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`);
    return new Hub(store, faults);
  }
  async close() { for (const s of this.sessions.values()) s.close(); await this.store.close(); }

  /** The cached state of a loaded run (null if the run has no events yet). */
  state(runId: string): RunState | null { return this.states.get(runId) ?? null; }

  /** (Re)build a run's state and simulator view from the store — exactly what a restarted process does. */
  async load(runId: string, session: string) {
    const rows = await this.store.rows(runId);
    if (rows.length) this.states.set(runId, fold(rows.map((r) => r.ev))); else this.states.delete(runId);
    await this.sim.load(runId, session);
  }

  /**
   * Enqueue work on a run's mailbox; resolves when it (and everything it synchronously caused) is persisted and performed.
   * A closed session accepts no new work, so once it is closed its mailboxes can only drain.
   */
  private enqueue<T>(runId: string, job: () => Promise<T>, session: Session): Promise<T> {
    if (this.fenced) return Promise.reject(this.fenced);
    if (session.closed) return Promise.reject(new SessionClosedError(session.id));
    const next = (this.chains.get(runId) ?? Promise.resolve()).then(job);
    this.chains.set(runId, next.catch(() => {}));
    return next;
  }
  /** Resolves when everything already queued for these runs has finished (used before evicting their caches). */
  /** Drop every in-memory trace of these runs once their session has quiesced; the store keeps them. */
  unload(runIds: string[]) { for (const r of runIds) { this.states.delete(r); this.chains.delete(r); this.sim.forget(r); } }

  async drain(runIds: string[]) {
    for (;;) { // a job that was already queued may queue more for another lane: wait until every chain is stable
      const seen = runIds.map((r) => this.chains.get(r));
      await Promise.all(seen);
      if (runIds.every((r, i) => this.chains.get(r) === seen[i])) return;
    }
  }

  submit(runId: string, input: Ev, session: Session): Promise<void> {
    return this.enqueue(runId, () => this.process(runId, input, session), session);
  }

  /**
   * Build the input from the run's state at the moment it is processed (inside the mailbox), not when the request
   * arrived: e.g. an operator confirmation adopts the value that is current after every earlier observation.
   * Returns false (and records nothing) if `make` declines.
   */
  submitFrom(runId: string, make: (s: RunState | null) => Ev | null, session: Session): Promise<boolean> {
    return this.enqueue(runId, async () => {
      const input = make(this.state(runId));
      if (!input) return false;
      await this.process(runId, input, session);
      return true;
    }, session);
  }

  private fence(e: FencedError) {
    if (this.fenced) return;
    this.fenced = e;
    console.error(`${e.message}; stopping every session in this process`);
    for (const s of this.sessions.values()) s.close();
  }

  private async process(runId: string, input: Ev, session: Session) {
    const q: Ev[] = [input];
    while (q.length) {
      const inp = q.shift()!;
      const st = this.state(runId);
      const decisions = decide(st, inp);
      let rows: Row[];
      try {
        rows = await this.store.append(runId, st?.seq ?? 0, [inp, ...decisions], session.tick);
      } catch (e) {
        this.states.delete(runId); // never act on a state the store rejected; the next input reloads from the log
        if (!this.fenced) await this.load(runId, session.id);
        throw e;
      }
      let s = st;
      for (const r of rows) s = reduce(s, r.ev);
      this.states.set(runId, s!);
      for (const l of this.listeners) l(rows);
      for (const d of decisions) await this.perform(runId, d, s!, q, session);
    }
  }

  private async perform(runId: string, d: Ev, s: RunState, q: Ev[], session: Session) {
    const at = session.tick;
    switch (d.t) {
      case 'dispatch':
        session.schedule(at + d.duration, 1, runId, () => this.submit(runId, { t: 'effect_ready', opId: d.opId, gen: d.gen, at: session.tick }, session));
        break;
      case 'commit_effect': {
        const row = s.ledger[d.opId];
        const die = (point: string) => { if (this.failpoint === point && (!this.failEffect || this.failEffect === row.effectKey)) process.kill(process.pid, 'SIGKILL'); };
        die('before_effect');
        const r = await this.sim.execute(runId, scenarios[s.scenario], row.opId, row.action, row.params, d.expect, row.effectKey, at);
        die('after_effect');
        const applied = this.sim.effectRows(runId).find((e) => e.opId === row.opId);
        if (applied) session.scheduleReports(runId, applied);
        q.push(r.kind === 'receipt' ? { t: 'receipt', opId: row.opId, gen: d.gen, applied: r.applied, at, detail: r.detail } : { t: 'effect_uncertain', opId: row.opId, gen: d.gen, at });
        break;
      }
      case 'reconcile_requested': {
        const l = await this.sim.lookup(runId, d.opId);
        q.push({ t: 'reconciled', opId: d.opId, gen: d.gen, found: l.found, applied: l.applied, at });
        break;
      }
      case 'repair_requested':
        q.push({ t: 'planner_output', requestId: d.requestId, candidates: this.planner.propose(s), at });
        break;
    }
  }

  /** Simulated agent crash: in-memory agent state and agent timers for the run are dropped, then rebuilt from the store. */
  crashAndRecover(runId: string, session: Session): Promise<void> {
    return this.enqueue(runId, async () => {
      this.states.delete(runId);
      // The simulated WORLD did not crash: load() re-reads this run's effects, and the session's injection cache is kept
      // (dropping it here would let an injection that lands mid-reload rebuild it without the earlier ones).
      session.dropAgentTasks(runId);
      await this.load(runId, session.id);
      await this.process(runId, { t: 'recover', at: session.tick }, session);
    }, session);
  }
}

export class Session {
  tick = 0;
  private queue: Task[] = [];
  private n = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /**
   * Clock iterations, injections, operator commands and crashes of one session run one at a time. Every effect executes
   * against a settled simulated world, and an injection is stamped, persisted and delivered at one tick that cannot move.
   */
  private lock: Promise<unknown> = Promise.resolve();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.lock.then(fn);
    this.lock = job.catch(() => {});
    return job;
  }
  /** Last tick whose due work has run. A world change never lands on it: outcomes up to that tick are already judged. */
  private ran = -1;
  /** Request quotas, restored from the store on resume so an unload or restart never resets them. */
  injectionsUsed = 0;
  commandsUsed = 0;
  closed = false;
  /** Fully loaded (started or resumed). Only a ready session may be evicted: closing one mid-start would leave a run without its start event. */
  ready = false;
  private ms = 0;
  runIds: string[];
  hub: Hub; id: string; scenario: string; policyNames: PolicyName[];

  constructor(hub: Hub, id: string, scenario: string, policyNames: PolicyName[]) {
    this.hub = hub; this.id = id; this.scenario = scenario; this.policyNames = policyNames;
    if (!Object.hasOwn(scenarios, scenario)) throw new Error(`unknown scenario ${scenario}`);
    for (const p of policyNames) if (!Object.hasOwn(policies, p)) throw new Error(`unknown policy ${p}`);
    if (new Set(policyNames).size !== policyNames.length) throw new Error('duplicate policy');
    this.runIds = policyNames.map((p) => `${id}-${p}`);
    // Not published in hub.sessions here: only `create`/`resume` publish a session, once it is fully loaded.
  }

  /** Create and start a session: one run per policy, sharing one world feed. */
  static async create(hub: Hub, id: string, scenario: string, policyNames: PolicyName[]): Promise<Session> {
    if (hub.fenced) throw hub.fenced;
    const s = new Session(hub, id, scenario, policyNames);
    hub.sessions.set(id, s); // its own start-up inputs need it reachable (presentation looks up the clock)
    try { await s.exclusive(() => s.start()); } catch (e) { hub.sessions.delete(id); throw e; }
    s.ready = true;
    return s;
  }

  schedule(tick: number, pri: number, runId: string | null, fn: () => Promise<void> | void) {
    this.queue.push({ tick, pri, seq: this.n++, runId, fn });
    this.queue.sort((a, b) => a.tick - b.tick || a.pri - b.pri || a.seq - b.seq);
    if (this.ms && !this.timer) this.play(this.ms); // new work (e.g. after an operator resume) restarts a settled clock
  }
  dropAgentTasks(runId: string) { this.queue = this.queue.filter((t) => t.runId !== runId || t.pri === 0); }

  /** Start every policy's run and schedule the shared world feed (priority 0: world events land before effect completions in a tick). */
  async start() {
    const S = scenarios[this.scenario];
    await this.hub.store.setClock(this.id, 0);
    for (const [i, p] of this.policyNames.entries()) {
      const runId = this.runIds[i];
      await this.hub.store.createRun({ runId, session: this.id, scenario: this.scenario, policy: p });
      await this.hub.sim.load(runId, this.id);
      await this.hub.submit(runId, { t: 'start', runId, scenario: this.scenario, context: startContext(this.scenario, p), at: 0 }, this);
    }
    for (const { tick, obs } of feedObservations(S)) {
      for (const runId of this.runIds) this.schedule(tick, 0, null, () => this.inject(runId, obs));
    }
    return this;
  }

  /** Rebuild a session after the process died: clock from the store, undelivered world events rescheduled, every run recovered. */
  static async resume(hub: Hub, id: string): Promise<Session> {
    const runs = await hub.store.runs(id);
    if (!runs.length) throw new Error(`no session ${id}`);
    const s = new Session(hub, id, runs[0].scenario, runs.map((r) => r.policy as PolicyName));
    const lastRowTick = Math.max(0, ...(await Promise.all(runs.map(async (r) => (await hub.store.rows(r.runId)).at(-1)?.tick ?? 0))));
    s.tick = Math.max(lastRowTick, await hub.store.clock(id));
    s.ran = s.tick; // conservatively: its work may have run before the restart
    for (const r of runs) {
      await hub.load(r.runId, id);
      const rows = await hub.store.rows(r.runId);
      // Conservative: a recovery after a restart counts like a crash request.
      s.commandsUsed += rows.filter((x) => x.ev.t === 'operator' || x.ev.t === 'recover').length;
      const delivered = rows.flatMap((x) => (x.ev.t === 'observation' ? [x.ev.obs.eventId] : []));
      const deliver = (tick: number, obs: Observation) => {
        const i = delivered.indexOf(obs.eventId);
        if (i >= 0) { delivered.splice(i, 1); return; }
        s.schedule(Math.max(tick, s.tick), 0, null, () => s.inject(r.runId, obs));
      };
      for (const { tick, obs } of feedObservations(scenarios[s.scenario])) deliver(tick, obs);
      for (const inj of hub.sim.injections(id)) deliver(inj.tick, inj.obs); // a crash mid fan-out cannot starve one lane
      for (const e of hub.sim.effectRows(r.runId)) s.scheduleReports(r.runId, e, delivered); // undelivered world reports
      const st = hub.state(r.runId);
      if (st && st.status !== 'completed' && st.status !== 'stopped') await hub.submit(r.runId, { t: 'recover', at: s.tick }, s);
    }
    s.injectionsUsed = hub.sim.injections(id).length;
    s.ready = true;
    hub.sessions.set(id, s); // published only now: a concurrent request never sees a half-loaded session
    return s;
  }

  /** World-side reports about an applied effect (e.g. carrier arrival), delivered at their due tick. Idempotent. */
  private reported = new Set<string>();
  scheduleReports(runId: string, e: EffectRow, alreadyDelivered: string[] = []) {
    const S = scenarios[this.scenario];
    const truthAt = (t: number) => this.hub.sim.truth(runId, S, t);
    (S.reports?.(e, truthAt) ?? []).forEach((r, i) => {
      const eventId = `report-${e.opId}-${i}`;
      if (this.reported.has(eventId)) return;
      this.reported.add(eventId);
      if (alreadyDelivered.includes(eventId)) return;
      this.schedule(Math.max(r.tick, this.tick), 0, null, () => {
        const body = { eventId, source: r.source, seq: this.tick * SEQ_TICK + 400 + i, fact: r.fact, value: r.value(truthAt), observedAt: this.tick };
        return this.inject(runId, { ...body, sig: sign(body, S.sources[r.source].key) });
      });
    });
  }

  /**
   * A visitor injection: persisted first (with its signed envelope), then delivered to every lane. Recovery re-delivers
   * missing copies. Runs under the session lock, so persisted order == simulated-truth order == delivery order, a builder
   * sees the sequence numbers every earlier injection already consumed, and no clock tick or effect slips in between.
   */
  injectShared(i: Injection | (() => Injection)): Promise<Injection> {
    return this.exclusive(async () => {
      if (this.closed) throw new SessionClosedError(this.id);
      if (this.ran >= this.tick) await this.advanceClock(); // e.g. a settled clock: the change happens at the next tick
      const inj = typeof i === 'function' ? i() : i;
      await this.hub.sim.addInjection(this.id, inj);
      await this.injectAll(inj.obs);
      return inj;
    });
  }

  inject(runId: string, obs: Observation) { return this.hub.submit(runId, { t: 'observation', obs, at: this.tick }, this); }
  async injectAll(obs: Observation) { for (const r of this.runIds) await this.inject(r, obs); }

  async advanceClock() {
    this.tick++;
  }

  async runDue() {
    while (!this.closed && this.queue.length && this.queue[0].tick <= this.tick) await this.queue.shift()!.fn();
    this.ran = this.tick;
    // The persisted clock is the judged watermark: outcomes are reported only through ticks whose work has run.
    await this.hub.store.setClock(this.id, this.tick);
    for (const l of this.hub.tickListeners) l(this); // viewers get the verdict through this tick
  }

  /** Virtual time: advance tick by tick until nothing is left or `maxTick`. Deterministic. */
  async runToEnd(maxTick = 80) {
    while (this.tick <= maxTick) {
      const done = await this.exclusive(async () => {
        await this.runDue();
        if (!this.queue.length && this.runIds.every((r) => this.settled(r))) return true;
        await this.advanceClock();
        return false;
      });
      if (done) break;
    }
    return this;
  }

  /** Real time for the live demo: one tick every `ms` (a tick never overlaps the previous one). */
  play(ms: number, maxTick = 200) {
    this.stop();
    this.ms = ms;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.exclusive(async () => {
        try {
          await this.runDue();
          if ((this.tick >= maxTick) || (!this.queue.length && this.runIds.every((r) => this.settled(r)))) return this.stop();
          await this.advanceClock();
        } catch (e) { console.error(`session ${this.id}:`, e); this.stop(); } finally { this.busy = false; }
      });
    }, ms);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Stop for good (session evicted): new work no longer restarts the clock. */
  close() { this.closed = true; this.ms = 0; this.stop(); }
  /** Resolves once nothing of this (closed) session can still touch its runs' caches. */
  async quiesce() {
    await this.lock;
    await this.hub.drain(this.runIds);
  }

  settled(runId: string) {
    const s = this.hub.state(runId);
    if (s && this.tick < this.hub.sim.settleTick(runId, scenarios[s.scenario])) return false; // truck still in transit
    return !s || s.status === 'completed' || s.status === 'stopped' || (s.status === 'paused' && !s.inflight);
  }
}
