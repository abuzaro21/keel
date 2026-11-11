// G7: the Store contract, exercised directly against the adapter under test (SQLite file, or PostgreSQL when
// KEEL_TEST_DATABASE_URL is set). Two independent connections stand in for two server processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import type { Store, EffectRow } from '../src/store.ts';
import { onPostgres, TEST_DB, freshSchema } from './helpers.ts';

/** Two connections to one fresh database (same SQLite file / same Postgres schema). */
async function pair(): Promise<{ a: Store; b: Store; done: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'keel-store-'));
  const target = onPostgres ? TEST_DB : join(dir, 'k.db');
  const schema = freshSchema();
  const a = await openStore(target, schema);
  const b = await openStore(target, schema);
  return { a, b, done: async () => { await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const fresh = async () => openStore(onPostgres ? TEST_DB : ':memory:', freshSchema());
const effect = (opId: string, runId: string, applied: Record<string, string | number> = { x: 1 }): EffectRow =>
  ({ opId, runId, action: 'dispatch', params: { order: 1042 }, requestHash: `h-${opId}`, tick: 3, harm: null, applied });

test('two writers racing on one stream head: exactly one append lands, the other is refused, no gaps', async () => {
  const { a, b, done } = await pair();
  try {
    await a.createRun({ runId: 'r', session: 's', scenario: 'delivery', policy: 'keel' });
    for (let round = 0; round < 25; round++) {
      const head = (await a.rows('r')).length;
      const res = await Promise.allSettled([
        a.append('r', head, [{ t: 'recover', at: round }, { t: 'recover', at: round }], round),
        b.append('r', head, [{ t: 'recover', at: round }], round),
      ]);
      assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1, `round ${round}: one winner`);
      const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(lost.reason), /stream conflict/);
    }
    const ns = (await b.rows('r')).map((r) => r.n);
    assert.deepEqual(ns, ns.map((_, i) => i + 1), 'event numbers are contiguous from 1');
  } finally { await done(); }
});

test('two executors racing on one operation id: the effect is stored once; both see the same receipt', async () => {
  const { a, b, done } = await pair();
  try {
    await a.createRun({ runId: 'r', session: 's', scenario: 'delivery', policy: 'keel' });
    for (let i = 0; i < 20; i++) {
      const [x, y] = await Promise.all([a.insertEffect(effect(`op${i}`, 'r', { v: 'a' })), b.insertEffect(effect(`op${i}`, 'r', { v: 'b' }))]);
      assert.equal(Number(x.inserted) + Number(y.inserted), 1, `op${i} inserted exactly once`);
      assert.deepEqual(x.row.applied, y.row.applied, 'the loser adopts the winner\'s recorded mutation');
    }
    const fx = await a.effects('r');
    assert.equal(fx.length, 20);
    assert.equal(new Set(fx.map((e) => e.opId)).size, 20);
  } finally { await done(); }
});

test('the world clock never moves backwards, whatever order concurrent writers commit in', async () => {
  const { a, b, done } = await pair();
  try {
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).setClock('s', (i * 7) % 31)));
    assert.equal(await a.clock('s'), 30);
    await b.setClock('s', 2);
    assert.equal(await a.clock('s'), 30);
  } finally { await done(); }
});

test('sessions are isolated, and prune removes a whole old session (events, effects, injections, clock) and nothing else', async () => {
  const s = await fresh();
  try {
    for (const sess of ['old', 'new']) {
      await s.createRun({ runId: `${sess}-keel`, session: sess, scenario: 'delivery', policy: 'keel' });
      await s.append(`${sess}-keel`, 0, [{ t: 'recover', at: 0 }], 0);
      await s.insertEffect(effect(`${sess}-op`, `${sess}-keel`));
      await s.addInjection(sess, { tick: 1, fact: 'route:R1.status', value: 'closed', real: true, obs: { eventId: `${sess}-i`, source: 'x', seq: 1, fact: 'route:R1.status', value: 'closed', observedAt: 1, sig: 's' } });
      await s.setClock(sess, 5);
    }
    assert.deepEqual((await s.runs('new')).map((r) => r.runId), ['new-keel']);
    assert.equal((await s.injections('new')).length, 1);
    assert.equal((await s.effects('new-keel')).length, 1);
    // backdate one session, then prune everything older than "a minute ago"
    const d = await s.dump();
    const t = await fresh();
    await t.restore({ ...d, runs: d.runs.map((r) => (r.session === 'old' ? { ...r, created: 1 } : r)) });
    assert.equal(await t.prune(Date.now() - 60_000), 1);
    const left = await t.dump();
    assert.deepEqual(left.runs.map((r) => r.session), ['new']);
    assert.ok(left.events.every((e) => e.runId === 'new-keel'));
    assert.ok(left.effects.every((e) => e.runId === 'new-keel'));
    assert.deepEqual(left.injections.map((i) => i.session), ['new']);
    assert.deepEqual(left.clocks.map((c) => c.session), ['new']);
    await t.close();
  } finally { await s.close(); }
});

test('export/import: a dump restored into an empty store is identical, and new writes continue after it', async () => {
  const s = await fresh();
  const t = await fresh();
  try {
    await s.createRun({ runId: 'r', session: 's', scenario: 'delivery', policy: 'keel' });
    await s.append('r', 0, [{ t: 'recover', at: 0 }, { t: 'recover', at: 1 }], 1);
    for (let i = 0; i < 3; i++) await s.insertEffect(effect(`op${i}`, 'r'));
    await s.setClock('s', 9);
    const d = await s.dump();
    await t.restore(JSON.parse(JSON.stringify(d)));
    assert.deepEqual(await t.dump(), d);
    await assert.rejects(t.append('r', 1, [{ t: 'recover', at: 2 }], 2), /stream conflict/, 'restored head is enforced');
    await t.append('r', 2, [{ t: 'recover', at: 2 }], 2);
    await t.insertEffect(effect('op-new', 'r'));
    const fx = await t.effects('r');
    assert.equal(fx.at(-1)!.opId, 'op-new', 'effect order continues after the restored sequence');
    await assert.rejects(s.restore(d), 'restore refuses a non-empty store');
  } finally { await s.close(); await t.close(); }
});
