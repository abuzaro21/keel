// Regressions for the release verification (Codex gpt-6.1-sol): bursts of creations or reloads cannot push the
// resident sessions past MAX_SESSIONS (40), and eviction leaves no per-run or per-session cache behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Session } from '../src/runner.ts';
import { onPostgres, TEST_DB, freshSchema } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';
process.env.KEEL_TICK_MS = '3600000';           // no ticking: only admission matters here
process.env.KEEL_CLIENT_IP_HEADER = 'x-test-ip'; // distinct clients, so the per-client rate limit does not interfere
const { startServer, evictOldest } = await import('../src/server.ts');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a burst of creations and of reloads never exceeds the resident-session bound', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-cap-'));
  if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema();
  const { server, hub } = await startServer(0, onPostgres ? TEST_DB : join(dir, 'k.db'));
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, hub.sessions.size); }, 2);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // slow start-up: every creation is still in flight when the next ones arrive
    const setClock = hub.store.setClock.bind(hub.store);
    hub.store.setClock = async (id, tick) => { await delay(150); return setClock(id, tick); };
    const created = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'x-test-ip': `10.0.0.${i}` }, body: JSON.stringify({ scenario: 'delivery' }) })));
    const codes = created.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 40);
    assert.equal(codes.filter((c) => c === 503).length, 10);
    hub.store.setClock = setClock;
    assert.ok(peak <= 40, `creations: resident sessions peaked at ${peak}`);
    const ids = (await Promise.all(created.filter((r) => r.status === 201).map((r) => r.json()))).map((j) => j.sessionId as string);
    // 10 more stored sessions, then unload everything: 50 sessions now exist only in the store
    for (let i = 0; i < 10; i++) ids.push((await Session.create(hub, `extra${i}`, 'delivery', ['static', 'keel'])).id);
    for (let e; (e = evictOldest(hub, new Map())); ) await e.done;
    assert.equal(hub.sessions.size, 0);
    peak = 0; // the extras above bypassed HTTP admission on purpose; measure the reload burst alone
    // slow reloads: all 50 are loading at once
    const runs = hub.store.runs.bind(hub.store);
    hub.store.runs = async (...a: Parameters<typeof runs>) => { await delay(100); return runs(...a); };
    const reloads = await Promise.all(ids.map((id) => fetch(`${base}/api/sessions/${id}`)));
    const rc = reloads.map((r) => r.status);
    assert.ok(rc.every((c) => c === 200 || c === 503), `only 200 or 503: ${rc}`);
    assert.ok(rc.filter((c) => c === 200).length >= 40 - 1, 'the bound is used, not starved');
    assert.ok(peak <= 40, `reloads: resident sessions peaked at ${peak}`);
    assert.ok(hub.sessions.size <= 40);
  } finally { clearInterval(watch); server.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('eviction leaves no mailbox, run mapping or injection cache behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-mem-'));
  if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema();
  const { server, hub } = await startServer(0, onPostgres ? TEST_DB : join(dir, 'k.db'));
  try {
    for (let i = 0; i < 6; i++) await (await Session.create(hub, `m${i}`, 'delivery', ['static', 'keel'])).runToEnd();
    for (let e; (e = evictOldest(hub, new Map())); ) await e.done;
    const h = hub as unknown as { chains: Map<string, unknown>; sim: { sessionOf: Map<string, string>; changes: Map<string, unknown>; fx: Map<string, unknown> } };
    assert.deepEqual([hub.states.size, h.chains.size, h.sim.sessionOf.size, h.sim.changes.size, h.sim.fx.size], [0, 0, 0, 0, 0]);
    // and a run reloads cleanly after that
    const again = await Session.resume(hub, 'm0');
    assert.equal(hub.state(again.runIds[1])?.status, 'completed');
    again.close();
  } finally { server.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});
