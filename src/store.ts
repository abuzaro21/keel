// Persistence: one append-only event stream per run, plus the SIMULATED external system's tables.
// Two adapters share one contract: SQLite (local dev, tests, clean clone) and PostgreSQL (hosted demo).
// Appends are optimistic-concurrency writes: [input, ...decisions] land together iff the stream head is unchanged.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { Ev } from './engine.ts';
import type { Facts, Json, Params } from './model.ts';
import type { Observation } from './world.ts';
import { INPUTS } from './engine.ts';

export type Row = { runId: string; n: number; kind: string; input: boolean; tick: number; wall: number; ev: Ev };
export type RunInfo = { runId: string; session: string; scenario: string; policy: string; created: number };
export type EffectRow = { opId: string; runId: string; action: string; params: Params; requestHash: string; tick: number; harm: string | null; applied: Facts };
/**
 * A visitor injection, persisted BEFORE it is delivered to any lane: the signed observation every lane must receive,
 * and whether it also changed SIMULATED ground truth (`real`; a forgery is delivered but changes nothing real).
 * Recovery re-delivers it to any lane whose log lacks its eventId.
 */
export type Injection = { tick: number; fact: string; value: Json; real: boolean; obs: Observation };
export type Dump = {
  format: 'keel-dump/1';
  runs: (RunInfo & { head: number })[];
  events: { runId: string; n: number; tick: number; wall: number; body: string }[];
  effects: (EffectRow & { seq: number })[];
  injections: (Injection & { session: string; seq: number })[];
  clocks: { session: string; tick: number }[];
};

/** Thrown by every write once another process has claimed the database (see `Store.claim`). */
export class FencedError extends Error {
  constructor(mine: number, current: number) { super(`fenced: this process holds owner epoch ${mine}, the database is now owned by epoch ${current}`); }
}
export const SCHEMA_VERSION = 1;

export interface Store {
  readonly kind: 'sqlite' | 'postgres';
  /**
   * Become the single writer: bump the owner epoch and remember it. From then on every write transaction re-reads
   * the epoch under a lock and fails with FencedError if a newer process has claimed the database since. This is a
   * fencing token, so a stalled old process can never apply an effect after the new owner has reconciled it.
   */
  claim(holder: string): Promise<number>;
  /** Called whenever a write is refused because another process owns the database. */
  onFenced?: (e: FencedError) => void;
  createRun(r: Omit<RunInfo, 'created'>): Promise<void>;
  /** Append atomically iff the stream head is still `expected`; throws `stream conflict` otherwise. */
  append(runId: string, expected: number, evs: Ev[], tick: number): Promise<Row[]>;
  rows(runId: string, after?: number): Promise<Row[]>;
  runs(session?: string): Promise<RunInfo[]>;
  /** Insert-once by opId. Returns the stored row (the existing one if the opId was already applied). */
  insertEffect(e: EffectRow): Promise<{ inserted: boolean; row: EffectRow }>;
  effects(runId: string): Promise<EffectRow[]>;
  addInjection(session: string, i: Injection): Promise<void>;
  injections(session: string): Promise<Injection[]>;
  /** Monotonic: never moves a session's world clock backwards. */
  setClock(session: string, tick: number): Promise<void>;
  clock(session: string): Promise<number>;
  /** Sessions with runs created after `since` (ms epoch), newest first — used to resume after a restart. */
  recentSessions(since: number): Promise<string[]>;
  /** Delete whole sessions created before `before` (ms epoch). Returns the number of sessions removed. */
  prune(before: number): Promise<number>;
  dump(): Promise<Dump>;
  /** Load a dump into an empty store (migration between providers). */
  restore(d: Dump): Promise<void>;
  close(): Promise<void>;
}

const now = () => performance.timeOrigin + performance.now();
const toRow = (runId: string, n: number, ev: Ev, tick: number, wall: number): Row => ({ runId, n, kind: ev.t, input: INPUTS.has(ev.t), tick, wall, ev });
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
function effectRow(r: Record<string, unknown>): EffectRow {
  return { opId: r.op_id as string, runId: r.run_id as string, action: r.action as string, params: parse(r.params), requestHash: r.request_hash as string, tick: Number(r.tick), harm: (r.harm as string | null) ?? null, applied: parse(r.applied) };
}
const injectionRow = (r: Record<string, unknown>): Injection => ({ tick: Number(r.tick), fact: r.fact as string, value: parse<Json>(r.value), real: r.real === true || r.real === 1, obs: parse(r.obs) });

const TABLES = (S: string, t: { real: string; serial: string; bool: string }) => `
  CREATE TABLE IF NOT EXISTS ${S}runs (run_id TEXT PRIMARY KEY, session TEXT NOT NULL, scenario TEXT NOT NULL, policy TEXT NOT NULL, created ${t.real} NOT NULL, head INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS runs_session ON ${S}runs (session);
  CREATE TABLE IF NOT EXISTS ${S}events (
    run_id TEXT NOT NULL REFERENCES ${S}runs(run_id) ON DELETE CASCADE, n INTEGER NOT NULL, kind TEXT NOT NULL, input ${t.bool} NOT NULL,
    tick INTEGER NOT NULL, wall ${t.real} NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, n));
  CREATE TABLE IF NOT EXISTS ${S}sim_effects (
    op_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ${S}runs(run_id) ON DELETE CASCADE, action TEXT NOT NULL, params TEXT NOT NULL,
    request_hash TEXT NOT NULL, tick INTEGER NOT NULL, harm TEXT, applied TEXT NOT NULL, seq ${t.serial});
  CREATE INDEX IF NOT EXISTS sim_effects_run ON ${S}sim_effects (run_id, seq);
  CREATE TABLE IF NOT EXISTS ${S}injections (session TEXT NOT NULL, seq ${t.serial}, tick INTEGER NOT NULL, fact TEXT NOT NULL, value TEXT NOT NULL, real ${t.bool} NOT NULL, obs TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS injections_session ON ${S}injections (session, seq);
  CREATE TABLE IF NOT EXISTS ${S}world_clock (session TEXT PRIMARY KEY, tick INTEGER NOT NULL, updated ${t.real} NOT NULL);
  CREATE TABLE IF NOT EXISTS ${S}owner (id INTEGER PRIMARY KEY CHECK (id = 1), epoch BIGINT NOT NULL, holder TEXT NOT NULL, since ${t.real} NOT NULL);
  CREATE TABLE IF NOT EXISTS ${S}schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
`;
const CLAIM = (S: string, p1: string, p2: string) => `INSERT INTO ${S}owner (id, epoch, holder, since) VALUES (1, 1, ${p1}, ${p2})
  ON CONFLICT (id) DO UPDATE SET epoch = ${S}owner.epoch + 1, holder = EXCLUDED.holder, since = EXCLUDED.since RETURNING epoch`;
/** Refuse to run on a database created by an older, unversioned KEEL (it would silently miss columns). */
function checkVersion(hasRuns: boolean, version: number | undefined) {
  if (version === undefined && hasRuns) throw new Error('legacy KEEL database without schema_meta (pre-async build): export it with that build or start from an empty database');
  if (version !== undefined && version !== SCHEMA_VERSION) throw new Error(`database schema version ${version}, this build needs ${SCHEMA_VERSION}`);
}

// ---------------------------------------------------------------- SQLite
export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try { this.init(); } catch (e) { this.db.close(); throw e; } // never leak the file handle of a refused database
  }
  private init() {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.tx(() => {
      const has = (t: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      checkVersion(has('runs'), has('schema_meta') ? (this.db.prepare('SELECT version FROM schema_meta').get() as { version: number } | undefined)?.version : undefined);
      this.db.exec(TABLES('', { real: 'REAL', serial: 'INTEGER NOT NULL', bool: 'INTEGER' }));
      this.db.prepare('INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO NOTHING').run(SCHEMA_VERSION);
    }, false);
  }
  private epoch: number | null = null;
  onFenced?: (e: FencedError) => void;
  private tx<T>(fn: () => T, fenced = true): T {
    this.db.exec('BEGIN IMMEDIATE'); // single writer for the whole database file
    try {
      if (fenced && this.epoch !== null) {
        const cur = Number((this.db.prepare('SELECT epoch FROM owner WHERE id = 1').get() as { epoch: number } | undefined)?.epoch ?? 0);
        if (cur !== this.epoch) { const err = new FencedError(this.epoch, cur); this.onFenced?.(err); throw err; }
      }
      const r = fn(); this.db.exec('COMMIT'); return r;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async claim(holder: string) {
    this.epoch = this.tx(() => Number((this.db.prepare(CLAIM('', '?', '?')).get(holder, Date.now()) as { epoch: number }).epoch), false);
    return this.epoch;
  }
  async createRun(r: Omit<RunInfo, 'created'>) {
    this.tx(() => this.db.prepare('INSERT INTO runs (run_id, session, scenario, policy, created) VALUES (?, ?, ?, ?, ?)').run(r.runId, r.session, r.scenario, r.policy, Date.now()));
  }
  async append(runId: string, expected: number, evs: Ev[], tick: number) {
    const wall = now();
    return this.tx(() => {
      const h = Number((this.db.prepare('SELECT head FROM runs WHERE run_id = ?').get(runId) as { head: number } | undefined)?.head ?? NaN);
      if (h !== expected) throw new Error(`stream conflict on ${runId}: head ${h}, expected ${expected}`);
      const ins = this.db.prepare('INSERT INTO events (run_id, n, kind, input, tick, wall, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const rows = evs.map((ev, i) => toRow(runId, h + i + 1, ev, tick, wall));
      for (const r of rows) ins.run(runId, r.n, r.kind, r.input ? 1 : 0, tick, wall, JSON.stringify(r.ev));
      this.db.prepare('UPDATE runs SET head = ? WHERE run_id = ?').run(h + evs.length, runId);
      return rows;
    });
  }
  async rows(runId: string, after = 0) {
    return (this.db.prepare('SELECT * FROM events WHERE run_id = ? AND n > ? ORDER BY n').all(runId, after) as Record<string, unknown>[])
      .map((r) => toRow(runId, Number(r.n), JSON.parse(r.body as string) as Ev, Number(r.tick), Number(r.wall)));
  }
  async runs(session?: string) {
    const q = session ? this.db.prepare('SELECT * FROM runs WHERE session = ? ORDER BY run_id').all(session) : this.db.prepare('SELECT * FROM runs ORDER BY created').all();
    return (q as Record<string, unknown>[]).map((r) => ({ runId: r.run_id as string, session: r.session as string, scenario: r.scenario as string, policy: r.policy as string, created: Number(r.created) }));
  }
  async insertEffect(e: EffectRow) {
    return this.tx(() => {
      const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM sim_effects').get() as { s: number }).s);
      const r = this.db.prepare('INSERT INTO sim_effects (op_id, run_id, action, params, request_hash, tick, harm, applied, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(op_id) DO NOTHING')
        .run(e.opId, e.runId, e.action, JSON.stringify(e.params), e.requestHash, e.tick, e.harm, JSON.stringify(e.applied), seq);
      if (r.changes === 1) return { inserted: true, row: e };
      return { inserted: false, row: effectRow(this.db.prepare('SELECT * FROM sim_effects WHERE op_id = ?').get(e.opId) as Record<string, unknown>) };
    });
  }
  async effects(runId: string) {
    return (this.db.prepare('SELECT * FROM sim_effects WHERE run_id = ? ORDER BY seq').all(runId) as Record<string, unknown>[]).map(effectRow);
  }
  async addInjection(session: string, i: Injection) {
    this.tx(() => {
      const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM injections').get() as { s: number }).s);
      this.db.prepare('INSERT INTO injections (session, seq, tick, fact, value, real, obs) VALUES (?, ?, ?, ?, ?, ?, ?)').run(session, seq, i.tick, i.fact, JSON.stringify(i.value), i.real ? 1 : 0, JSON.stringify(i.obs));
    });
  }
  async injections(session: string) {
    return (this.db.prepare('SELECT * FROM injections WHERE session = ? ORDER BY seq').all(session) as Record<string, unknown>[]).map(injectionRow);
  }
  async setClock(session: string, tick: number) {
    this.tx(() => this.db.prepare('INSERT INTO world_clock (session, tick, updated) VALUES (?, ?, ?) ON CONFLICT(session) DO UPDATE SET tick = MAX(world_clock.tick, excluded.tick), updated = excluded.updated').run(session, tick, Date.now()));
  }
  async clock(session: string) {
    return Number((this.db.prepare('SELECT tick FROM world_clock WHERE session = ?').get(session) as { tick: number } | undefined)?.tick ?? 0);
  }
  async recentSessions(since: number) {
    return (this.db.prepare('SELECT session FROM runs GROUP BY session HAVING MAX(created) >= ? ORDER BY MAX(created) DESC').all(since) as { session: string }[]).map((r) => r.session);
  }
  async prune(before: number) {
    const old = (this.db.prepare('SELECT session FROM runs GROUP BY session HAVING MAX(created) < ?').all(before) as { session: string }[]).map((r) => r.session);
    this.tx(() => { for (const s of old) for (const t of ['runs', 'injections', 'world_clock']) this.db.prepare(`DELETE FROM ${t} WHERE session = ?`).run(s); });
    return old.length;
  }
  async dump(): Promise<Dump> {
    const all = (sql: string) => this.db.prepare(sql).all() as Record<string, unknown>[];
    this.db.exec('BEGIN'); // one read snapshot for the whole dump
    try { return this.dumpIn(all); } finally { this.db.exec('COMMIT'); }
  }
  private dumpIn(all: (sql: string) => Record<string, unknown>[]): Dump {
    return {
      format: 'keel-dump/1',
      runs: all('SELECT * FROM runs ORDER BY created').map((r) => ({ runId: r.run_id as string, session: r.session as string, scenario: r.scenario as string, policy: r.policy as string, created: Number(r.created), head: Number(r.head) })),
      events: all('SELECT * FROM events ORDER BY run_id, n').map((r) => ({ runId: r.run_id as string, n: Number(r.n), tick: Number(r.tick), wall: Number(r.wall), body: r.body as string })),
      effects: all('SELECT * FROM sim_effects ORDER BY seq').map((r) => ({ ...effectRow(r), seq: Number(r.seq) })),
      injections: all('SELECT * FROM injections ORDER BY seq').map((r) => ({ ...injectionRow(r), session: r.session as string, seq: Number(r.seq) })),
      clocks: all('SELECT * FROM world_clock').map((r) => ({ session: r.session as string, tick: Number(r.tick) })),
    };
  }
  async restore(d: Dump) {
    if (d.format !== 'keel-dump/1') throw new Error('unknown dump format');
    this.tx(() => {
      for (const r of d.runs) this.db.prepare('INSERT INTO runs (run_id, session, scenario, policy, created, head) VALUES (?, ?, ?, ?, ?, ?)').run(r.runId, r.session, r.scenario, r.policy, r.created, r.head);
      for (const e of d.events) this.db.prepare('INSERT INTO events (run_id, n, kind, input, tick, wall, body) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.runId, e.n, (JSON.parse(e.body) as Ev).t, INPUTS.has((JSON.parse(e.body) as Ev).t) ? 1 : 0, e.tick, e.wall, e.body);
      for (const e of d.effects) this.db.prepare('INSERT INTO sim_effects (op_id, run_id, action, params, request_hash, tick, harm, applied, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(e.opId, e.runId, e.action, JSON.stringify(e.params), e.requestHash, e.tick, e.harm, JSON.stringify(e.applied), e.seq);
      for (const i of d.injections) this.db.prepare('INSERT INTO injections (session, seq, tick, fact, value, real, obs) VALUES (?, ?, ?, ?, ?, ?, ?)').run(i.session, i.seq, i.tick, i.fact, JSON.stringify(i.value), i.real ? 1 : 0, JSON.stringify(i.obs));
      for (const c of d.clocks) this.db.prepare('INSERT INTO world_clock (session, tick, updated) VALUES (?, ?, ?)').run(c.session, c.tick, Date.now());
    });
  }
  async close() { this.db.close(); }
}

// ---------------------------------------------------------------- PostgreSQL
/**
 * Concurrency: READ COMMITTED (Postgres default) plus a row lock on the run (`SELECT … FOR UPDATE`) serialises
 * every append to one run across connections and processes; the (run_id, n) primary key is the backstop. Effects are
 * insert-once by primary key (`ON CONFLICT DO NOTHING`), so two executors racing on one opId apply it exactly once.
 * The clock upsert uses GREATEST, so it is monotonic even under concurrent writers.
 */
export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  pool: pg.Pool;
  schema: string;
  private constructor(pool: pg.Pool, schema: string) { this.pool = pool; this.schema = schema; }

  static async open(url: string, schema = 'keel'): Promise<PgStore> {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error('bad schema name');
    const pool = new pg.Pool({ connectionString: url, max: 5, allowExitOnIdle: true, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
    // An idle client losing its connection (DB restart, network blip) must not crash the process; the pool replaces it.
    pool.on('error', (e) => console.error('postgres idle client error:', e.message));
    const store = new PgStore(pool, schema);
    await store.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`keel-migrate:${schema}`]); // one migrator at a time
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      const has = async (t: string) => (await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [schema, t])).rowCount === 1;
      checkVersion(await has('runs'), await has('schema_meta') ? (await c.query(`SELECT version FROM ${schema}.schema_meta`)).rows[0]?.version : undefined);
      await c.query(TABLES(`${schema}.`, { real: 'DOUBLE PRECISION', serial: 'BIGSERIAL', bool: 'BOOLEAN' }));
      await c.query(`INSERT INTO ${schema}.schema_meta (id, version) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [SCHEMA_VERSION]);
    }, false);
    return store;
  }
  private epoch: number | null = null;
  onFenced?: (e: FencedError) => void;
  async claim(holder: string) {
    this.epoch = Number((await this.pool.query(CLAIM(`${this.schema}.`, '$1', '$2'), [holder, Date.now()])).rows[0].epoch);
    return this.epoch;
  }
  private q(text: string, values?: unknown[]) { return this.pool.query(text.replaceAll('$S.', `${this.schema}.`), values); }
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>, fenced = true, begin = 'BEGIN'): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(begin);
      if (fenced && this.epoch !== null) {
        // FOR SHARE: this owner's writers run concurrently; a claim (UPDATE) waits for them, and every later one sees it.
        const cur = Number((await c.query(`SELECT epoch FROM ${this.schema}.owner WHERE id = 1 FOR SHARE`)).rows[0]?.epoch ?? 0);
        if (cur !== this.epoch) { const err = new FencedError(this.epoch, cur); this.onFenced?.(err); throw err; }
      }
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  async createRun(r: Omit<RunInfo, 'created'>) {
    await this.tx((c) => c.query(`INSERT INTO ${this.schema}.runs (run_id, session, scenario, policy, created) VALUES ($1, $2, $3, $4, $5)`, [r.runId, r.session, r.scenario, r.policy, Date.now()]));
  }
  async append(runId: string, expected: number, evs: Ev[], tick: number) {
    const wall = now();
    const S = this.schema;
    return this.tx(async (c) => {
      const h = (await c.query(`SELECT head FROM ${S}.runs WHERE run_id = $1 FOR UPDATE`, [runId])).rows[0]?.head;
      if (h !== expected) throw new Error(`stream conflict on ${runId}: head ${h}, expected ${expected}`);
      const rows = evs.map((ev, i) => toRow(runId, h + i + 1, ev, tick, wall));
      const vals: unknown[] = [];
      const tuples = rows.map((r, i) => { vals.push(runId, r.n, r.kind, r.input, tick, wall, JSON.stringify(r.ev)); const b = i * 7; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`; });
      if (rows.length) await c.query(`INSERT INTO ${S}.events (run_id, n, kind, input, tick, wall, body) VALUES ${tuples.join(',')}`, vals);
      await c.query(`UPDATE ${S}.runs SET head = $1 WHERE run_id = $2`, [h + evs.length, runId]);
      return rows;
    });
  }
  async rows(runId: string, after = 0) {
    const r = await this.q('SELECT n, tick, wall, body FROM $S.events WHERE run_id = $1 AND n > $2 ORDER BY n', [runId, after]);
    return r.rows.map((x) => toRow(runId, Number(x.n), JSON.parse(x.body) as Ev, Number(x.tick), Number(x.wall)));
  }
  async runs(session?: string) {
    const r = session ? await this.q('SELECT * FROM $S.runs WHERE session = $1 ORDER BY run_id', [session]) : await this.q('SELECT * FROM $S.runs ORDER BY created');
    return r.rows.map((x) => ({ runId: x.run_id, session: x.session, scenario: x.scenario, policy: x.policy, created: Number(x.created) }));
  }
  async insertEffect(e: EffectRow) {
    const S = this.schema;
    return this.tx(async (c) => {
      const r = await c.query(`INSERT INTO ${S}.sim_effects (op_id, run_id, action, params, request_hash, tick, harm, applied) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (op_id) DO NOTHING RETURNING op_id`,
        [e.opId, e.runId, e.action, JSON.stringify(e.params), e.requestHash, e.tick, e.harm, JSON.stringify(e.applied)]);
      if (r.rowCount === 1) return { inserted: true, row: e };
      return { inserted: false, row: effectRow((await c.query(`SELECT * FROM ${S}.sim_effects WHERE op_id = $1`, [e.opId])).rows[0]) };
    });
  }
  async effects(runId: string) {
    return (await this.q('SELECT * FROM $S.sim_effects WHERE run_id = $1 ORDER BY seq', [runId])).rows.map(effectRow);
  }
  async addInjection(session: string, i: Injection) {
    await this.tx((c) => c.query(`INSERT INTO ${this.schema}.injections (session, tick, fact, value, real, obs) VALUES ($1, $2, $3, $4, $5, $6)`, [session, i.tick, i.fact, JSON.stringify(i.value), i.real, JSON.stringify(i.obs)]));
  }
  async injections(session: string) {
    return (await this.q('SELECT * FROM $S.injections WHERE session = $1 ORDER BY seq', [session])).rows.map(injectionRow);
  }
  async setClock(session: string, tick: number) {
    const S = this.schema;
    await this.tx((c) => c.query(`INSERT INTO ${S}.world_clock (session, tick, updated) VALUES ($1, $2, $3) ON CONFLICT (session) DO UPDATE SET tick = GREATEST(${S}.world_clock.tick, EXCLUDED.tick), updated = EXCLUDED.updated`, [session, tick, Date.now()]));
  }
  async clock(session: string) {
    return Number((await this.q('SELECT tick FROM $S.world_clock WHERE session = $1', [session])).rows[0]?.tick ?? 0);
  }
  async recentSessions(since: number) {
    return (await this.q('SELECT session FROM $S.runs GROUP BY session HAVING MAX(created) >= $1 ORDER BY MAX(created) DESC', [since])).rows.map((x) => x.session as string);
  }
  async prune(before: number) {
    const S = this.schema;
    return this.tx(async (c) => {
      const old = (await c.query(`SELECT session FROM ${S}.runs GROUP BY session HAVING MAX(created) < $1`, [before])).rows.map((x) => x.session);
      if (old.length) for (const t of ['runs', 'injections', 'world_clock']) await c.query(`DELETE FROM ${S}.${t} WHERE session = ANY($1)`, [old]);
      return old.length;
    });
  }
  async dump(): Promise<Dump> {
    // One REPEATABLE READ snapshot: every table is read as of the same instant, so run heads match their events.
    return this.tx((c) => this.dumpIn(async (sql: string) => (await c.query(sql.replaceAll('$S.', `${this.schema}.`))).rows as Record<string, unknown>[]), false, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  private async dumpIn(all: (sql: string) => Promise<Record<string, unknown>[]>): Promise<Dump> {
    return {
      format: 'keel-dump/1',
      runs: (await all('SELECT * FROM $S.runs ORDER BY created')).map((r) => ({ runId: r.run_id as string, session: r.session as string, scenario: r.scenario as string, policy: r.policy as string, created: Number(r.created), head: Number(r.head) })),
      events: (await all('SELECT * FROM $S.events ORDER BY run_id, n')).map((r) => ({ runId: r.run_id as string, n: Number(r.n), tick: Number(r.tick), wall: Number(r.wall), body: r.body as string })),
      effects: (await all('SELECT * FROM $S.sim_effects ORDER BY seq')).map((r) => ({ ...effectRow(r), seq: Number(r.seq) })),
      injections: (await all('SELECT * FROM $S.injections ORDER BY seq')).map((r) => ({ ...injectionRow(r), session: r.session as string, seq: Number(r.seq) })),
      clocks: (await all('SELECT * FROM $S.world_clock')).map((r) => ({ session: r.session as string, tick: Number(r.tick) })),
    };
  }
  async restore(d: Dump) {
    if (d.format !== 'keel-dump/1') throw new Error('unknown dump format');
    const S = this.schema;
    await this.tx(async (c) => {
      for (const r of d.runs) await c.query(`INSERT INTO ${S}.runs (run_id, session, scenario, policy, created, head) VALUES ($1, $2, $3, $4, $5, $6)`, [r.runId, r.session, r.scenario, r.policy, r.created, r.head]);
      for (const e of d.events) { const ev = JSON.parse(e.body) as Ev; await c.query(`INSERT INTO ${S}.events (run_id, n, kind, input, tick, wall, body) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [e.runId, e.n, ev.t, INPUTS.has(ev.t), e.tick, e.wall, e.body]); }
      for (const e of d.effects) await c.query(`INSERT INTO ${S}.sim_effects (op_id, run_id, action, params, request_hash, tick, harm, applied, seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [e.opId, e.runId, e.action, JSON.stringify(e.params), e.requestHash, e.tick, e.harm, JSON.stringify(e.applied), e.seq]);
      for (const i of d.injections) await c.query(`INSERT INTO ${S}.injections (session, seq, tick, fact, value, real, obs) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [i.session, i.seq, i.tick, i.fact, JSON.stringify(i.value), i.real, JSON.stringify(i.obs)]);
      for (const k of d.clocks) await c.query(`INSERT INTO ${S}.world_clock (session, tick, updated) VALUES ($1, $2, $3)`, [k.session, k.tick, Date.now()]);
      // keep BIGSERIAL sequences ahead of restored values
      await c.query(`SELECT setval(pg_get_serial_sequence('${S}.sim_effects', 'seq'), GREATEST((SELECT COALESCE(MAX(seq), 0) FROM ${S}.sim_effects), 1))`);
      await c.query(`SELECT setval(pg_get_serial_sequence('${S}.injections', 'seq'), GREATEST((SELECT COALESCE(MAX(seq), 0) FROM ${S}.injections), 1))`);
    });
  }
  async close() { await this.pool.end(); }
}

/** `postgres://…` => PostgreSQL; anything else is a SQLite path (default in-memory). */
export async function openStore(target = process.env.DATABASE_URL ?? process.env.KEEL_DB ?? ':memory:', schema?: string): Promise<Store> {
  return /^postgres(ql)?:\/\//.test(target) ? PgStore.open(target, schema ?? process.env.KEEL_PG_SCHEMA ?? 'keel') : new SqliteStore(target);
}
