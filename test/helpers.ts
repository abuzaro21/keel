// Shared test plumbing. KEEL_TEST_DATABASE_URL=postgres://… runs every suite against PostgreSQL
// (a fresh schema per hub); otherwise an in-memory SQLite store is used.
import { randomUUID } from 'node:crypto';
import { Hub } from '../src/runner.ts';
import type { Faults } from '../src/sim.ts';
import type { Ev } from '../src/engine.ts';

export const TEST_DB = process.env.KEEL_TEST_DATABASE_URL ?? ':memory:';
export const onPostgres = /^postgres/.test(TEST_DB);
export const freshSchema = () => `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

export const openHub = (faults: Faults = {}) => Hub.open(TEST_DB, faults, onPostgres ? freshSchema() : undefined);
export const events = async (hub: Hub, runId: string): Promise<Ev[]> => (await hub.store.rows(runId)).map((r) => r.ev);
