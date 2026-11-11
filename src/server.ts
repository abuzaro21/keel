// HTTP API + SSE. The stream presents committed log rows; it never causes adaptation.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hub, Session, SessionClosedError, SEQ_TICK } from './runner.ts';
import type { Row } from './store.ts';
import { FencedError } from './store.ts';
import { scenarios } from './scenarios.ts';
import { policies } from './engine.ts';
import type { PolicyName, RunState } from './engine.ts';
import { contract, evalCond, stepSig } from './model.ts';
import { runMetrics } from './metrics.ts';
import { sign } from './world.ts';
import type { Json } from './model.ts';

export const TICK_MS = Number(process.env.KEEL_TICK_MS ?? 900);
/** Every resident slot is starting or loading; the request may retry shortly. */
export class BusyError extends Error { constructor() { super('at capacity'); } }
const MAX_SESSIONS = 40;            // sessions kept in memory (all of them stay in the store)
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS = 200;
const MAX_INJECTIONS_PER_SESSION = 60;
const MAX_COMMANDS_PER_SESSION = 60;     // operator + crash requests
const MAX_BUFFERED = 1 << 20;             // a slow SSE client past 1 MB of unsent data is cut off
const RETENTION_DAYS = Number(process.env.KEEL_RETENTION_DAYS ?? 7);
/** How many trusted reverse proxies append to X-Forwarded-For in front of us (0 = trust no header). */
export const TRUSTED_HOPS = Number(process.env.KEEL_TRUSTED_PROXY_HOPS ?? 0);
/** Optional single-value header set by a trusted edge proxy (lower-case name). Empty = not used. */
export const CLIENT_IP_HEADER = (process.env.KEEL_CLIENT_IP_HEADER ?? '').toLowerCase();
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

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

export async function runView(hub: Hub, runId: string) {
  const s = hub.state(runId);
  if (!s) throw new SessionClosedError(runId); // its caches were dropped (evicted) after the request looked it up
  return {
    runId, policy: s.policy, policyLabel: policies[s.policy].label, status: s.status, pause: s.pause, tick: s.tick,
    plan: { version: s.plan.version, steps: stepView(s) }, history: s.plans.map((p) => ({ version: p.version, steps: p.steps.map((x) => ({ id: x.id, sig: stepSig(x) })) })),
    revisions: s.revisions, budget: s.budget, goal: s.goal,
    facts: s.world.facts, unstable: s.world.unstable, worldRev: s.world.rev,
    metrics: await runMetrics(hub.store, hub.sim, runId).catch((e) => {
      if (!hub.state(runId)) throw new SessionClosedError(runId); // evicted while the metrics read the store
      throw e;
    }),
  };
}

/**
 * Rate-limit key. A client can put anything in X-Forwarded-For, and some proxies append to (rather than replace)
 * the client's value, so the leftmost entry is never trusted. With N trusted proxy hops, the Nth entry from the
 * right is the address the outermost trusted proxy saw. With 0 hops, only the socket address is used.
 * Identity is best-effort either way; global caps bound what any number of spoofed identities can do.
 */
export function clientKey(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops = TRUSTED_HOPS, header = CLIENT_IP_HEADER): string {
  // Opt-in: a header the edge proxy OVERWRITES on every request (e.g. Cloudflare's cf-connecting-ip in front of Render).
  // Only set this when every request is known to pass through that proxy; a client-supplied copy is otherwise trivially spoofed.
  if (header) {
    const v = req.headers[header];
    if (typeof v === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(v.trim())) return v.trim();
  }
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (hops > 0 && chain.length >= hops) return chain[chain.length - hops];
  return req.socket.remoteAddress ?? '?';
}

export async function startServer(port = Number(process.env.PORT ?? 3000), target?: string) {
  const hub = await Hub.open(target);
  const streams = new Map<string, Set<Conn>>();
  const created: { at: number; ip: string }[] = [];
  let lastPrune = 0;
  const prune = async () => {
    if (Date.now() - lastPrune < 10 * 60_000) return;
    lastPrune = Date.now();
    const n = await hub.store.prune(Date.now() - RETENTION_DAYS * 86_400_000);
    if (n) console.log(`pruned ${n} demo sessions older than ${RETENTION_DAYS} days`);
  };

  /** A session from memory, or reloaded from the store (e.g. after a restart) and resumed if still in progress. */
  const loading = new Map<string, Promise<Session | null>>();
  const evicting = new Map<string, Promise<void>>();
  // Creations and reloads admitted but not yet resident. Counted before any await, so a burst cannot overshoot MAX_SESSIONS.
  let reserved = 0;
  const admit = () => {
    if (hub.sessions.size + reserved >= MAX_SESSIONS) evict();
    if (hub.sessions.size + reserved >= MAX_SESSIONS) return false; // every slot is starting or loading
    reserved++;
    return true;
  };
  const evict = () => {
    const p = evictOldest(hub, streams);
    if (!p) return;
    evicting.set(p.id, p.done);
    void p.done.finally(() => evicting.delete(p.id));
  };
  const getSession = async (id: string): Promise<Session | null> => {
    await evicting.get(id); // never reload a session while its caches are still being torn down
    const live = hub.sessions.get(id);
    if (live) return live;
    let p = loading.get(id);
    if (!p) {
      p = (async () => {
        if (!(await hub.store.runs(id)).length) return null;
        if (!admit()) throw new BusyError();
        let s: Session;
        try { s = await Session.resume(hub, id); } finally { reserved--; }
        if (!s.runIds.every((r) => s.settled(r))) s.play(TICK_MS);
        return s;
      })().finally(() => loading.delete(id));
      loading.set(id, p);
    }
    return p;
  };

  // Resume recent in-progress sessions after a restart: their logs, receipts, clocks and commitments are in the store.
  await prune();
  for (const id of (await hub.store.recentSessions(Date.now() - 30 * 60_000)).slice(0, MAX_SESSIONS)) {
    try { await getSession(id); } catch (e) { console.error(`resume ${id} failed:`, (e as Error).message); }
  }

  // Frames are built strictly in commit order: a later frame never overtakes an earlier one (its cursor would skip rows).
  let frames: Promise<void> = Promise.resolve();
  const broadcast = (sessionId: string, runId: string, rows: Row[]) => {
    if (!streams.get(sessionId)?.size) return;
    frames = frames.then(async () => {
      const subs = streams.get(sessionId);
      if (!subs?.size) return;
      let data: View;
      try { data = await payload(hub, runId); } catch (e) {
        // Never advance a cursor past rows that were not sent: drop these connections instead. Each client reconnects
        // with its Last-Event-ID and the catch-up backfills the missing rows from the store.
        console.error('frame failed; closing streams for a backfill:', (e as Error).message);
        for (const c of subs) { clearInterval(c.ping); c.res.destroy(); }
        subs.clear();
        return;
      }
      for (const c of subs) send(c, runId, rows, data);
    }).catch((e) => console.error('frame failed:', e));
  };
  hub.listeners.add((rows: Row[]) => { if (rows[0]) broadcast(hub.sim.sessionFor(rows[0].runId), rows[0].runId, rows); });
  hub.tickListeners.add((s) => { for (const r of s.runIds) broadcast(s.id, r, []); });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (p === '/api/health') return json(res, hub.fenced ? 503 : 200, { ok: !hub.fenced, store: hub.store.kind, sessions: hub.sessions.size, ...(hub.fenced ? { error: 'another KEEL process owns the database' } : {}) });
      if (hub.fenced && p.startsWith('/api/')) return json(res, 503, { error: 'this instance has been replaced; reload the page' });
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
        if (!pols.length || pols.length > 3 || pols.some((x) => !Object.hasOwn(policies, x))) return json(res, 400, { error: 'bad policies' });
        const ip = clientKey(req);
        const t = Date.now();
        while (created.length && t - created[0].at > 60_000) created.shift();
        if (created.filter((c) => c.ip === ip).length >= 12 || created.length >= 120) return json(res, 429, { error: 'too many new runs; wait a minute' });
        created.push({ at: t, ip });
        if (!admit()) return json(res, 503, { error: 'the demo is at capacity; try again in a minute' });
        void prune().catch((e) => console.error('prune failed:', e));
        // 128 random bits: a session link is a capability (it can steer that demo run), so it must not be guessable.
        let creating: Promise<Session>;
        // create() publishes the session before its first await; from then on it counts itself. Released exactly once,
        // even if building the id throws.
        try { creating = Session.create(hub, randomUUID().replaceAll('-', ''), scenario, pols); } finally { reserved--; }
        const s = await creating;
        s.play(TICK_MS);
        return json(res, 201, { sessionId: s.id, runIds: s.runIds, scenario, tickMs: TICK_MS });
      }
      const m = /^\/api\/sessions\/([\w-]{1,40})(?:\/(stream|inject|operator|crash|export))?$/.exec(p);
      if (m) {
        const s = await getSession(m[1]);
        if (!s) return json(res, 404, { error: 'no such run' });
        const action = m[2];
        if (!action && req.method === 'GET') return json(res, 200, { sessionId: s.id, scenario: s.scenario, tick: s.tick, store: hub.store.kind, runs: await Promise.all(s.runIds.map((r) => runView(hub, r))) });
        if (action === 'stream') {
          const total = [...streams.values()].reduce((n, x) => n + x.size, 0);
          if ((streams.get(s.id)?.size ?? 0) >= MAX_STREAMS_PER_SESSION || total >= MAX_STREAMS) return json(res, 429, { error: 'too many open streams' });
          return await stream(req, res, hub, s, streams);
        }
        if (action === 'export') {
          return json(res, 200, {
            sessionId: s.id, store: hub.store.kind, worldClock: await hub.store.clock(s.id), injections: hub.sim.injections(s.id),
            runs: await Promise.all(s.runIds.map(async (r) => ({ runId: r, events: await hub.store.rows(r), effects: hub.sim.effectRows(r) }))),
          });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readJson(req);
        if (action === 'inject') {
          if (s.injectionsUsed >= MAX_INJECTIONS_PER_SESSION) return json(res, 429, { error: 'injection limit for this run reached; start a new run' });
          const allowed = injectable[s.scenario].find((x) => x.fact === body.fact && x.values.includes(body.value as Json));
          if (!allowed) return json(res, 400, { error: 'that observation is not injectable here' });
          s.injectionsUsed++;
          const src = scenarios[s.scenario].sources[allowed.source];
          const forged = !!body.forged;
          // Built inside the session's injection queue, so two concurrent requests never share a sequence number.
          // Persisted before delivery: a genuine injection changes SIMULATED reality for every lane; a forgery changes nothing real.
          const inj = await s.injectShared(() => {
            const seqs = s.runIds.map((r) => hub.state(r)?.world.lastSeq[`${src.id}|${allowed.fact}`] ?? 0);
            // Agent state can be missing while a lane rebuilds after a crash; the session's injection cache never is.
            const prior = hub.sim.injections(s.id).filter((x) => x.obs.source === src.id && x.obs.fact === allowed.fact).map((x) => x.obs.seq);
            const o = { eventId: `inj-${randomUUID().slice(0, 12)}`, source: src.id, seq: Math.max(...seqs, ...prior, s.tick * SEQ_TICK + 500) + 1, fact: allowed.fact, value: body.value as Json, observedAt: s.tick };
            return { tick: s.tick, fact: allowed.fact, value: body.value as Json, real: !forged, obs: { ...o, sig: forged ? sign(o, 'visitor-forgery') : sign(o, src.key) } };
          });
          return json(res, 202, { eventId: inj.obs.eventId, forged });
        }
        const runId = String(body.runId ?? '');
        if (!s.runIds.includes(runId)) return json(res, 400, { error: 'unknown run' });
        if (s.commandsUsed >= MAX_COMMANDS_PER_SESSION) return json(res, 429, { error: 'command limit for this run reached; start a new run' });
        s.commandsUsed++;
        if (action === 'operator') {
          const cmd = String(body.cmd);
          if (!['resume', 'abort', 'confirm'].includes(cmd)) return json(res, 400, { error: 'bad command' });
          const fact = String(body.fact);
          // Evaluated inside the run's mailbox, after every observation queued before it: a confirmation adopts the value
          // that is current at that moment (the browser cannot choose one), and is refused if the fact is no longer unstable.
          const ok = await s.exclusive(() => hub.submitFrom(runId, (st) => {
            if (cmd !== 'confirm') return { t: 'operator', cmd: cmd as 'resume', at: s.tick };
            if (!st?.world.unstable.includes(fact)) return null;
            return { t: 'operator', cmd: 'confirm', fact, value: st.world.facts[fact], at: s.tick };
          }, s));
          if (!ok) return json(res, 409, { error: 'only an unstable fact can be confirmed' });
          return json(res, 202, { ok: true });
        }
        if (action === 'crash') { await s.exclusive(() => hub.crashAndRecover(runId, s)); return json(res, 202, { ok: true }); }
      }
      if (req.method === 'GET') return serveStatic(res, p);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; } // e.g. an SSE stream already started: never write headers twice
      if ((e as Error).message === 'body too large') return json(res, 413, { error: 'request body too large' });
      if (e instanceof SyntaxError) return json(res, 400, { error: 'malformed JSON' });
      if (e instanceof FencedError) return json(res, 503, { error: 'this instance has been replaced; reload the page' });
      if (e instanceof BusyError) return json(res, 503, { error: 'the demo is at capacity; try again in a minute' });
      if (e instanceof SessionClosedError) return json(res, 409, { error: 'this run was unloaded meanwhile; reload the page' });
      console.error(e);
      json(res, 500, { error: 'internal error' });
    }
  });
  server.listen(port);
  return { server, hub };
}

/** One SSE connection. Its cursor advances only for the lane whose rows it has actually been sent. */
type View = { view: Awaited<ReturnType<typeof runView>>; tick: number };
type Conn = { res: ServerResponse; cursor: Map<string, number>; ready: boolean; backlog: { runId: string; rows: Row[]; data: View }[]; ping: NodeJS.Timeout };

async function payload(hub: Hub, runId: string): Promise<View> {
  const s = hub.sessions.get(hub.sim.sessionFor(runId));
  return { view: await runView(hub, runId), tick: s?.tick ?? 0 };
}

function send(c: Conn, runId: string, rows: Row[], data: View) {
  if (!c.ready) { c.backlog.push({ runId, rows, data }); return; }
  const fresh = rows.filter((r) => r.n > (c.cursor.get(runId) ?? 0));
  if (rows.length && !fresh.length) return; // already delivered during catch-up
  if (fresh.length) c.cursor.set(runId, fresh.at(-1)!.n);
  const id = [...c.cursor].map(([r, n]) => `${r}=${n}`).join('&');
  c.res.write(`id: ${id}\ndata: ${JSON.stringify({ runId, rows: fresh, ...data })}\n\n`);
  if (c.res.writableLength > MAX_BUFFERED) c.res.destroy(); // slow client: drop it; it can reconnect with its cursor
}

async function stream(req: IncomingMessage, res: ServerResponse, hub: Hub, s: Session, streams: Map<string, Set<Conn>>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const last = new URLSearchParams(String(req.headers['last-event-id'] ?? ''));
  const c: Conn = {
    res, ready: false, backlog: [],
    cursor: new Map(s.runIds.map((r) => [r, Math.max(0, Math.floor(Number(last.get(r))) || 0)])),
    ping: setInterval(() => res.write(': keepalive\n\n'), 20_000), // transport keepalive only; the agent never sees it
  };
  const set = streams.get(s.id) ?? new Set();
  set.add(c); // subscribe first, buffer live frames until the catch-up is written
  streams.set(s.id, set);
  req.on('close', () => { clearInterval(c.ping); set.delete(c); });
  try {
    // Read everything first (live frames keep buffering meanwhile), then write catch-up and backlog in one go, in order.
    const catchup = await Promise.all(s.runIds.map(async (r) => ({ r, rows: await hub.store.rows(r, c.cursor.get(r) ?? 0), data: await payload(hub, r) })));
    c.ready = true;
    for (const { r, rows, data } of catchup) send(c, r, rows, data);
    for (const b of c.backlog.splice(0)) send(c, b.runId, b.rows, b.data);
  } catch (e) { console.error('stream failed:', e); res.destroy(); }
}

/** Stop the oldest session, let its in-flight inputs finish (an effect mid-way needs its caches), then drop the caches. */
export function evictOldest(hub: Hub, streams: Map<string, Set<Conn>>): { id: string; done: Promise<void> } | null {
  const first = [...hub.sessions].find(([, x]) => x.ready); // a session still starting is skipped
  if (!first) return null;
  const [id, s] = first;
  s.close();
  hub.sessions.delete(id);
  for (const c of streams.get(id) ?? []) { clearInterval(c.ping); c.res.end(); }
  streams.delete(id); // the run stays in the store and can be reopened by id
  const done = s.quiesce().catch(() => {}).then(() => hub.unload(s.runIds));
  return { id, done };
}

/** The UI loads only its own bundle plus the Google Fonts stylesheet; nothing may frame it. */
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
  res.end(readFileSync(file));
}
