// G5: the recorded genuine model proposals are matched by full planning context, validated now, and labelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, Session } from '../src/runner.ts';
import { parseModelResponse, sha256 } from '../src/planner.ts';
import { sign } from '../src/world.ts';
import { scenarios } from '../src/scenarios.ts';
import type { Recording } from '../src/planner.ts';

const recordings = JSON.parse(readFileSync(new URL('../fixtures/planner-recordings.json', import.meta.url), 'utf8')) as Recording[];

test('recordings are intact: hashes match the stored prompt and response', () => {
  assert.ok(recordings.length >= 3);
  for (const r of recordings) {
    assert.equal(sha256(r.prompt), r.promptSha256);
    assert.equal(sha256(r.response), r.responseSha256);
    assert.ok(r.model && r.capturedAt);
  }
});

for (const scenario of ['delivery', 'recovery']) {
  test(`${scenario}: the committed repair is the recorded model proposal, and it passed every live check`, () => {
    const hub = new Hub();
    new Session(hub, 'm', scenario, ['keel']).start().runToEnd();
    const rev = hub.store.events('m-keel').find((e) => e.t === 'revision');
    assert.ok(rev && rev.t === 'revision');
    assert.equal(rev.record.chosen.origin, 'model:recorded');
    assert.ok(rev.record.chosen.model?.model);
    assert.ok(rev.record.checks.every((c) => c.pass));
  });
}

test('a context nobody recorded (a judge-injected change) falls back to deterministic search', () => {
  const hub = new Hub();
  const s = new Session(hub, 'n', 'delivery', ['keel']).start();
  while (s.tick < 1) { s.runDue(); s.tick++; }
  const body = { eventId: 'judge', source: 'traffic-authority', seq: 99, fact: 'route:R1.status', value: 'closed', observedAt: s.tick };
  s.inject('n-keel', { ...body, sig: sign(body, scenarios.delivery.sources['traffic-authority'].key) });
  s.runToEnd();
  const origins = hub.store.events('n-keel').flatMap((e) => (e.t === 'revision' ? [e.record.chosen.origin] : []));
  assert.ok(origins.length >= 1);
  assert.ok(origins.some((o) => o.startsWith('search')), `expected a search-origin revision, got ${origins}`);
});

test('model text is parsed defensively', () => {
  assert.deepEqual(parseModelResponse('no json here'), []);
  assert.deepEqual(parseModelResponse('{"candidates": "nope"}'), []);
  assert.equal(parseModelResponse('```json\n{"candidates":[{"rationale":"x","steps":[]}]}\n```').length, 1);
});
