// Persistence: one append-only event stream per run in SQLite, plus the SIMULATED external system's tables.
// Appends are optimistic-concurrency writes: [input, ...decisions] land together or not at all.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Ev } from './engine.ts';
import { INPUTS } from './engine.ts';

export type Row = { runId: string; n: number; kind: string; input: boolean; tick: number; wall: number; ev: Ev };

export class Store {
  db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, session TEXT NOT NULL, scenario TEXT NOT NULL, policy TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, input INTEGER NOT NULL,
        tick INTEGER NOT NULL, wall REAL NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, n));
      CREATE TABLE IF NOT EXISTS sim_effects (
        op_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, action TEXT NOT NULL, params TEXT NOT NULL,
        request_hash TEXT NOT NULL, tick INTEGER NOT NULL, harm TEXT, sets TEXT NOT NULL, applied TEXT NOT NULL);
    `);
  }

  createRun(runId: string, session: string, scenario: string, policy: string) {
    this.db.prepare('INSERT INTO runs (run_id, session, scenario, policy, created) VALUES (?, ?, ?, ?, ?)').run(runId, session, scenario, policy, Date.now());
  }

  head(runId: string): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(n), 0) AS h FROM events WHERE run_id = ?').get(runId) as { h: number }).h);
  }

  /** Append atomically iff the stream head is still `expected`. Returns the new rows, or throws on a conflict. */
  append(runId: string, expected: number, evs: Ev[], tick: number): Row[] {
    const wall = performance.timeOrigin + performance.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const h = this.head(runId);
      if (h !== expected) throw new Error(`stream conflict on ${runId}: head ${h}, expected ${expected}`);
      const ins = this.db.prepare('INSERT INTO events (run_id, n, kind, input, tick, wall, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const rows = evs.map((ev, i) => {
        const r: Row = { runId, n: h + i + 1, kind: ev.t, input: INPUTS.has(ev.t), tick, wall, ev };
        ins.run(runId, r.n, r.kind, r.input ? 1 : 0, tick, wall, JSON.stringify(ev));
        return r;
      });
      this.db.exec('COMMIT');
      return rows;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  rows(runId: string, after = 0): Row[] {
    return (this.db.prepare('SELECT * FROM events WHERE run_id = ? AND n > ? ORDER BY n').all(runId, after) as Record<string, unknown>[])
      .map((r) => ({ runId: r.run_id as string, n: Number(r.n), kind: r.kind as string, input: r.input === 1, tick: Number(r.tick), wall: Number(r.wall), ev: JSON.parse(r.body as string) as Ev }));
  }

  events(runId: string): Ev[] { return this.rows(runId).map((r) => r.ev); }

  runs(session?: string): { runId: string; session: string; scenario: string; policy: string; created: number }[] {
    const q = session ? this.db.prepare('SELECT * FROM runs WHERE session = ? ORDER BY run_id').all(session) : this.db.prepare('SELECT * FROM runs ORDER BY created').all();
    return (q as Record<string, unknown>[]).map((r) => ({ runId: r.run_id as string, session: r.session as string, scenario: r.scenario as string, policy: r.policy as string, created: Number(r.created) }));
  }
}
