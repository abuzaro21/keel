// Regressions for the three items Codex review #2 left open (2026-11-11): A fenced maintenance writes,
// B eviction racing in-flight work, C an SSE frame that fails to build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hub, Session, SessionClosedError } from '../src/runner.ts';
import { onPostgres, TEST_DB, freshSchema } from './helpers.ts';

process.env.KEEL_PLANNER = 'search';

test('A: a fenced process can neither prune nor restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-fa-'));
  const target = onPostgres ? TEST_DB : join(dir, 'k.db');
  const schema = onPostgres ? freshSchema() : undefined;
  const a = await Hub.open(target, {}, schema);
  try {
    await (await Session.create(a, 'p', 'delivery', ['keel'])).runToEnd();
    const dump = await a.store.dump();
    const b = await Hub.open(target, {}, schema); // the replacement claims the database
    try {
      await assert.rejects(a.store.prune(Date.now() + 1e9), /fenced/);
      await assert.rejects(a.store.restore({ ...dump, runs: [{ ...dump.runs[0], runId: 'ghost', session: 'ghost' }], events: [], effects: [], injections: [], clocks: [] }), /fenced/);
      assert.equal((await b.store.runs('p')).length, 1, 'the owner still has the session');
      assert.equal((await b.store.runs('ghost')).length, 0, 'nothing restored by the stale process');
      assert.equal(await b.store.prune(0), 0, 'the owner itself can still prune');
    } finally { await b.close(); }
  } finally { await a.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('B: evicting a session mid-tick never runs work on dropped caches; late callers get SessionClosedError', async () => {
  const hub = await Hub.open(TEST_DB, {}, onPostgres ? freshSchema() : undefined);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  try {
    for (let i = 0; i < 6; i++) {
      const s = await Session.create(hub, `ev${i}`, i % 2 ? 'flapping' : 'delivery', i % 2 ? ['naive', 'keel'] : ['static', 'keel']);
      s.play(1);
      await new Promise((r) => setTimeout(r, 15 + i * 20)); // evict at different points of the run
      // exactly what the server's evictOldest does
      s.close();
      hub.sessions.delete(s.id);
      await s.quiesce();
      for (const r of s.runIds) { hub.states.delete(r); hub.sim.forget(r); }
      await new Promise((r) => setTimeout(r, 30)); // any straggler would now hit the dropped caches
      await assert.rejects(hub.submit(s.runIds[0], { t: 'operator', cmd: 'resume', at: s.tick }, s), SessionClosedError);
      await assert.rejects(s.injectShared({ tick: 0, fact: 'x', value: 1, real: true, obs: {} as never }), SessionClosedError);
      // and the run reloads cleanly from the store afterwards
      const again = await Session.resume(hub, s.id);
      await again.runToEnd();
      again.close();
    }
  } finally { console.error = orig; await hub.close(); }
  assert.deepEqual(errors.filter((e) => /not loaded|not started|TypeError/.test(e)), []);
});

type Frame = { id: string; runId: string; rows: { n: number }[] };
async function frames(url: string, lastId: string, until: (f: Frame[]) => boolean) {
  const res = await fetch(url, { headers: lastId ? { 'last-event-id': lastId } : {} });
  const reader = res.body!.getReader();
  const out: Frame[] = [];
  let buf = '';
  let closed = false;
  const dec = new TextDecoder();
  while (!until(out)) {
    let chunk;
    try { chunk = await reader.read(); } catch { closed = true; break; }
    if (chunk.done) { closed = true; break; }
    buf += dec.decode(chunk.value);
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, k); buf = buf.slice(k + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id !== undefined && data) out.push({ id, ...JSON.parse(data) });
    }
  }
  if (!closed) await reader.cancel().catch(() => {});
  return { out, closed };
}

test('C: a frame that fails to build closes the stream; the reconnect backfills every skipped row', { timeout: 30_000 }, async () => {
  process.env.KEEL_TICK_MS = '40';
  const { startServer } = await import('../src/server.ts');
  const dir = mkdtempSync(join(tmpdir(), 'keel-sse-'));
  const target = onPostgres ? TEST_DB : join(dir, 'k.db');
  if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema();
  const { server, hub } = await startServer(0, target);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ scenario: 'delivery' }) })).json();
    const url = `${base}/api/sessions/${s.sessionId}/stream`;
    // break exactly one frame build after the first frames arrive
    let fail = false;
    const get = hub.sessions.get.bind(hub.sessions);
    hub.sessions.get = (k: string) => { if (fail) { fail = false; throw new Error('injected payload failure'); } return get(k); };
    let armed = false;
    const first = await frames(url, '', (f) => { if (f.length >= 3 && !armed) { armed = true; fail = true; } return false; });
    assert.ok(first.closed, 'the server closed the stream instead of skipping rows');
    const lastId = first.out.at(-1)!.id;
    const seen = new Map<string, number>(first.out.flatMap((f) => f.rows.map((r) => [f.runId, r.n] as [string, number])));
    const cursor = new URLSearchParams(lastId);
    for (const [r, n] of seen) assert.ok(Number(cursor.get(r)) >= n);
    // reconnect with the last id: the next rows of every lane must start exactly after the cursor
    const second = await frames(url, lastId, (f) => s.runIds.every((r: string) => f.some((x) => x.runId === r && x.rows.length)));
    for (const r of s.runIds) {
      const firstNew = second.out.find((x) => x.runId === r && x.rows.length)!.rows[0].n;
      assert.equal(firstNew, Number(cursor.get(r) ?? 0) + 1, `${r}: no gap after reconnect`);
    }
  } finally { server.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.KEEL_TICK_MS; }
});
