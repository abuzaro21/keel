// G5: HTTP API and SSE presentation layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.KEEL_TICK_MS = '20';
process.env.KEEL_PLANNER = 'search';
const { startServer } = await import('../src/server.ts');
const { TEST_DB, onPostgres, freshSchema } = await import('./helpers.ts');
const TEST_DB_TARGET = () => { if (onPostgres) process.env.KEEL_PG_SCHEMA = freshSchema(); return TEST_DB; };

type Frame = { id: string | null; data: { runId: string; rows: { n: number }[]; view: { status: string } } };
async function readFrames(url: string, headers: Record<string, string>, until: (f: Frame[]) => boolean, ms = 8000): Promise<Frame[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const res = await fetch(url, { headers, signal: ctl.signal });
  const frames: Frame[] = [];
  let buf = '';
  try {
    for await (const chunk of res.body!) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        frames.push({ id: block.split('\n').find((l) => l.startsWith('id: '))?.slice(4) ?? null, data: JSON.parse(data.slice(6)) });
      }
      if (until(frames)) break;
    }
  } catch { /* aborted */ } finally { clearTimeout(timer); ctl.abort(); }
  return frames;
}

test('SSE: a reconnect with Last-Event-ID resumes after the cursor, with no duplicated rows', async () => {
  const { server, hub } = await startServer(0, TEST_DB_TARGET());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ scenario: 'delivery' }) })).json();
    const first = await readFrames(`${base}/api/sessions/${s.sessionId}/stream`, {}, (f) => f.some((x) => x.data.rows.length > 3));
    const lastId = [...first].reverse().find((f) => f.id)!.id!;
    const seen = new Map<string, Set<number>>();
    for (const f of first) for (const r of f.data.rows) { const set = seen.get(f.data.runId) ?? new Set(); assert.ok(!set.has(r.n), 'no duplicate within a connection'); set.add(r.n); seen.set(f.data.runId, set); }
    const second = await readFrames(`${base}/api/sessions/${s.sessionId}/stream`, { 'last-event-id': lastId }, (f) => f.filter((x) => x.data.view.status === 'completed').length >= 2);
    const cursor = new URLSearchParams(lastId);
    for (const f of second) for (const r of f.data.rows) assert.ok(r.n > Number(cursor.get(f.data.runId)), `row ${r.n} of ${f.data.runId} was already delivered before the cursor`);
  } finally { server.close(); await hub.close(); }
});

test('API: only allow-listed observations are injectable; bad bodies are 400; static paths cannot escape', async () => {
  const { server, hub } = await startServer(0, TEST_DB_TARGET());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ scenario: 'delivery' }) })).json();
    const inj = (body: unknown) => fetch(`${base}/api/sessions/${s.sessionId}/inject`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await inj({ fact: 'order:1042.etaMin', value: 1 })).status, 400);
    assert.equal((await inj({ fact: 'route:R1.status', value: 'teleported' })).status, 400);
    assert.equal((await inj({ fact: 'route:R2.status', value: 'closed' })).status, 202);
    assert.equal((await fetch(`${base}/api/sessions/${s.sessionId}/inject`, { method: 'POST', body: '{nope' })).status, 400);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%5csrc%5cserver.ts']) {
      const r = await fetch(`${base}${p}`);
      const text = await r.text();
      assert.ok(!text.includes('"name": "keel"') && !text.includes('startServer'), `${p} leaked a file`);
    }
  } finally { server.close(); await hub.close(); }
});
