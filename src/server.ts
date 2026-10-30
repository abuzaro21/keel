// HTTP API + SSE. The stream presents committed log rows; it never causes adaptation.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hub, Session } from './runner.ts';
import type { Row } from './store.ts';
import { scenarios } from './scenarios.ts';
import { policies, remainingOf } from './engine.ts';
import type { PolicyName, RunState } from './engine.ts';
import { contract, evalCond, stepSig } from './model.ts';
import { runMetrics } from './metrics.ts';
import { sign } from './world.ts';
import type { Json } from './model.ts';

export const TICK_MS = Number(process.env.KEEL_TICK_MS ?? 900);
const MAX_SESSIONS = 40;
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS = 200;
const MAX_INJECTIONS_PER_SESSION = 60;
const PUBLIC = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Which observations a visitor may inject. The server signs as the named source; the browser never holds a key. */
const injectable: Record<string, { source: string; fact: string; values: Json[] }[]> = {
  delivery: [
    { source: 'traffic-authority', fact: 'route:R1.status', values: ['open', 'closed'] },
    { source: 'traffic-authority', fact: 'route:R2.status', values: ['open', 'closed'] },
    { source: 'traffic-authority', fact: 'route:R3.status', values: ['open', 'closed'] },
  ],
  recovery: [
    { source: 'dep-monitor', fact: 'svc:region-b.status', values: ['healthy', 'degraded'] },
    { source: 'dep-monitor', fact: 'svc:region-c.status', values: ['healthy', 'degraded'] },
  ],
  flapping: [
    { source: 'traffic-authority', fact: 'route:R1.status', values: ['open', 'closed'] },
    { source: 'traffic-authority', fact: 'route:R2.status', values: ['open', 'closed'] },
  ],
};

export function stepView(s: RunState) {
  const D = scenarios[s.scenario].domain;
  const byKey = new Map(Object.values(s.ledger).map((r) => [r.effectKey, r]));
  const unstable = new Set(s.cfg.stabilityGate ? s.world.unstable : []);
  // Chips are judged where each step would run: beliefs plus the expected effects of earlier pending steps.
  // An assumption a later step will establish is not a contradiction.
  const projected = { ...s.world.facts };
  return s.plan.steps.map((x) => {
    const a = contract(D, x.action);
    const row = byKey.get(a.effectKey(x.params));
    const isDone = s.done.includes(a.effectKey(x.params));
    const state = isDone ? 'done' : row && row.opId === s.inflight ? row.state : 'pending';
    const at = { ...projected };
    if (!isDone) Object.assign(projected, a.produces(x.params, projected));
    const cond = (c: Parameters<typeof evalCond>[0], kind: 'requires' | 'maintains') => ({ kind, text: `${c.fact} ${c.op} ${c.ref ?? JSON.stringify(c.value)}`, fact: c.fact, truth: evalCond(c, kind === 'maintains' ? projected : at, unstable) });
    return {
      id: x.id, sig: stepSig(x), action: x.action, params: x.params, describe: a.describe, commitment: a.commitment, duration: a.duration, state,
      startedAt: row && row.opId === s.inflight ? row.startedAt ?? null : null,
      assumptions: [...a.requires(x.params).map((c) => cond(c, 'requires')), ...(a.maintains?.(x.params) ?? []).map((c) => cond(c, 'maintains'))],
    };
  });
}

export function runView(hub: Hub, runId: string) {
  const s = hub.state(runId)!;
  return {
    runId, policy: s.policy, policyLabel: policies[s.policy].label, status: s.status, pause: s.pause, tick: s.tick,
    plan: { version: s.plan.version, steps: stepView(s) }, history: s.plans.map((p) => ({ version: p.version, steps: p.steps.map((x) => ({ id: x.id, sig: stepSig(x) })) })),
    revisions: s.revisions, budget: s.budget, goal: s.goal,
    facts: s.world.facts, unstable: s.world.unstable, worldRev: s.world.rev,
    metrics: runMetrics(hub.store, hub.sim, runId),
  };
}

export function startServer(port = Number(process.env.PORT ?? 3000), dbPath = process.env.KEEL_DB ?? ':memory:') {
  const hub = new Hub(dbPath);
  const streams = new Map<string, Set<ServerResponse>>();
  const created: { at: number; ip: string }[] = [];
  const injections = new Map<string, number>();
  // Behind Render's proxy every socket comes from the proxy; the first forwarded address is the client (spoofable, so a global cap backs it).
  const clientOf = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  hub.listeners.add((rows: Row[]) => {
    const session = rows[0] && hub.store.runs().find((r) => r.runId === rows[0].runId)?.session;
    if (!session) return;
    const subs = streams.get(session);
    if (!subs?.size) return;
    const msg = frame(hub, rows[0].runId, rows);
    for (const res of subs) res.write(msg);
  });

  hub.tickListeners.add((s) => {
    const subs = streams.get(s.id);
    if (!subs?.size) return;
    for (const r of s.runIds) { const msg = frame(hub, r, []); for (const res of subs) res.write(msg); }
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (p === '/api/health') return json(res, 200, { ok: true, sessions: hub.sessions.size });
      if (p === '/api/scenarios' && req.method === 'GET') {
        return json(res, 200, Object.values(scenarios).filter((s) => injectable[s.id]).map((s) => ({
          id: s.id, title: s.title, blurb: s.blurb, goal: s.goal.statement, domain: s.domain.name,
          sources: Object.values(s.sources).map((x) => ({ id: x.id, rank: x.rank, mayAssert: x.mayAssert })),
          injectable: injectable[s.id], tickMs: TICK_MS,
        })));
      }
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        const scenario = String(body.scenario ?? 'delivery');
        if (!injectable[scenario]) return json(res, 400, { error: 'unknown scenario' });
        const pols = (Array.isArray(body.policies) ? body.policies : scenario === 'flapping' ? ['naive', 'keel'] : ['static', 'keel']).map(String) as PolicyName[];
        if (!pols.length || pols.length > 3 || pols.some((x) => !policies[x])) return json(res, 400, { error: 'bad policies' });
        const ip = clientOf(req);
        const now = Date.now();
        while (created.length && now - created[0].at > 60_000) created.shift();
        if (created.filter((c) => c.ip === ip).length >= 12 || created.length >= 120) return json(res, 429, { error: 'too many new runs; wait a minute' });
        if (hub.sessions.size >= MAX_SESSIONS) evictOldest(hub);
        created.push({ at: now, ip });
        const s = new Session(hub, randomUUID().slice(0, 8), scenario, pols).start();
        s.play(TICK_MS);
        return json(res, 201, { sessionId: s.id, runIds: s.runIds, scenario, tickMs: TICK_MS });
      }
      const m = /^\/api\/sessions\/([\w-]+)(?:\/(stream|inject|operator|crash|export))?$/.exec(p);
      if (m) {
        const s = hub.sessions.get(m[1]);
        if (!s) return json(res, 404, { error: 'no such session (sessions are in memory; the demo host may have restarted)' });
        const action = m[2];
        if (!action && req.method === 'GET') return json(res, 200, { sessionId: s.id, scenario: s.scenario, tick: s.tick, runs: s.runIds.map((r) => runView(hub, r)) });
        if (action === 'stream') {
          const total = [...streams.values()].reduce((n, x) => n + x.size, 0);
          if ((streams.get(s.id)?.size ?? 0) >= MAX_STREAMS_PER_SESSION || total >= MAX_STREAMS) return json(res, 429, { error: 'too many open streams' });
          return stream(req, res, hub, s, streams);
        }
        if (action === 'export') return json(res, 200, { sessionId: s.id, runs: s.runIds.map((r) => ({ runId: r, events: hub.store.rows(r), effects: hub.sim.effects(r) })) });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readJson(req);
        if (action === 'inject') {
          const used = injections.get(s.id) ?? 0;
          if (used >= MAX_INJECTIONS_PER_SESSION) return json(res, 429, { error: 'injection limit for this run reached; start a new run' });
          injections.set(s.id, used + 1);
          const allowed = injectable[s.scenario].find((x) => x.fact === body.fact && x.values.includes(body.value as Json));
          if (!allowed) return json(res, 400, { error: 'that observation is not injectable here' });
          const src = scenarios[s.scenario].sources[allowed.source];
          const seqs = s.runIds.map((r) => hub.state(r)!.world.lastSeq[`${src.id}|${allowed.fact}`] ?? 0);
          const o = { eventId: `inj-${randomUUID().slice(0, 8)}`, source: src.id, seq: Math.max(...seqs, 1000 + s.tick) + 1, fact: allowed.fact, value: body.value as Json, observedAt: s.tick };
          const obs = { ...o, sig: body.forged ? sign(o, 'visitor-forgery') : sign(o, src.key) };
          // A genuine injection changes SIMULATED reality for every run, and the source reports it. A forgery changes nothing real.
          if (!body.forged) hub.store.addWorldChange(s.id, s.tick, allowed.fact, body.value);
          s.injectAll(obs);
          return json(res, 202, { eventId: obs.eventId, forged: !!body.forged });
        }
        const runId = String(body.runId ?? '');
        if (!s.runIds.includes(runId)) return json(res, 400, { error: 'unknown run' });
        if (action === 'operator') {
          const cmd = String(body.cmd);
          if (!['resume', 'abort', 'confirm'].includes(cmd)) return json(res, 400, { error: 'bad command' });
          if (cmd === 'confirm' && !(hub.state(runId)!.world.unstable.includes(String(body.fact)))) return json(res, 400, { error: 'only an unstable fact can be confirmed' });
          hub.submit(runId, { t: 'operator', cmd: cmd as 'resume', fact: body.fact as string | undefined, value: body.value as Json, at: s.tick }, s);
          return json(res, 202, { ok: true });
        }
        if (action === 'crash') { hub.crashAndRecover(runId, s); return json(res, 202, { ok: true }); }
      }
      if (req.method === 'GET') return serveStatic(res, p);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof SyntaxError || (e as Error).message === 'body too large') return json(res, 400, { error: 'bad request body' });
      console.error(e);
      json(res, 500, { error: 'internal error' });
    }
  });
  server.listen(port);
  return { server, hub };
}

function frame(hub: Hub, runId: string, rows: Row[]) {
  const s = hub.sessions.get(hub.store.runs().find((r) => r.runId === runId)!.session)!;
  const cursor = s.runIds.map((r) => `${r}=${hub.store.head(r)}`).join('&');
  return `id: ${cursor}\ndata: ${JSON.stringify({ runId, rows, view: runView(hub, runId), tick: s.tick })}\n\n`;
}

function stream(req: IncomingMessage, res: ServerResponse, hub: Hub, s: Session, streams: Map<string, Set<ServerResponse>>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const last = new URLSearchParams(String(req.headers['last-event-id'] ?? ''));
  for (const r of s.runIds) {
    const rows = hub.store.rows(r, Number(last.get(r) ?? 0));
    if (rows.length) res.write(frame(hub, r, rows));
    else res.write(`data: ${JSON.stringify({ runId: r, rows: [], view: runView(hub, r), tick: s.tick })}\n\n`);
  }
  const set = streams.get(s.id) ?? new Set();
  set.add(res);
  streams.set(s.id, set);
  const ping = setInterval(() => res.write(': keepalive\n\n'), 20_000); // transport keepalive only; the agent never sees it
  req.on('close', () => { clearInterval(ping); set.delete(res); });
}

function evictOldest(hub: Hub) {
  const [id, s] = hub.sessions.entries().next().value!;
  s.close();
  hub.sessions.delete(id);
  for (const r of s.runIds) hub.states.delete(r);
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  if (!raw) return {};
  const v = JSON.parse(raw);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
function serveStatic(res: ServerResponse, p: string) {
  const rel = normalize(p === '/' ? '/index.html' : p).replace(/^[\\/]+/, '');
  if (rel.startsWith('..')) return json(res, 400, { error: 'bad path' });
  let file = join(PUBLIC, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC, 'index.html'); // SPA fallback
  if (!existsSync(file)) return json(res, 404, { error: 'UI not built: run npm run build' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
  res.end(readFileSync(file));
}
