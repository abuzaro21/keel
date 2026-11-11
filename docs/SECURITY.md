# Security and threat model

KEEL is a public demo of an agent acting on a **simulated** world. Nothing it does reaches a real road, region, truck or
customer. The threats that matter are: a visitor steering the agent with false evidence, a visitor exhausting the
free instance, two server processes writing the same database, and the demo leaking files or secrets.

## Trust boundaries

| Boundary | Who is on the other side | Control |
|---|---|---|
| Browser → `/api/*` | anyone on the internet | allow-listed actions only; JSON bodies capped at 10 kB; per-session caps; global caps |
| Observation → engine | registered simulated sources, visitors, forgers | HMAC-signed envelopes, source namespaces and ranks, sequence and clock-window checks |
| Planner → engine | recorded model outputs, deterministic search | every candidate is untrusted and must pass the validator against current beliefs |
| Process → database | this process, an older or newer copy of it | owner-epoch fencing on every write transaction |
| Repository → public | readers of the source | no `.env`, no secrets; simulation keys are demo constants and say so |

## Visitor input

- A visitor can only inject observations from a fixed allow-list per scenario (`injectable` in `src/server.ts`). The server
  signs them as the named simulated source; the browser never holds a key. A "forged" injection is signed with a wrong
  key and is rejected by the engine, which is the point of that button.
- Operator commands are limited to `resume`, `abort` and `confirm`. A confirmation is built inside the run's mailbox and
  adopts the value current at that moment; the browser cannot choose the value, and a fact that is no longer unstable
  cannot be confirmed (409).
- Session ids are 128 random bits. A session link is a capability: whoever has it can steer that demo run, nothing else.
- Static files are served from `public/` only; `..` and encoded traversal are refused (tested).
- Every HTML response carries a Content-Security-Policy (`script-src 'self'`, `frame-ancestors 'none'`, fonts from
  Google Fonts only), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

## Abuse limits (free instance)

12 new runs per client key per minute and 120 overall; 40 sessions in memory (older ones are evicted and reload from the
store on demand; a slot is reserved before any database read, so a burst gets 503 rather than exceeding 40); 8 SSE streams per session and 200 overall; a slow SSE client is cut off past 1 MB of unsent data;
60 injections and 60 commands per session; sessions older than `KEEL_RETENTION_DAYS` (default 7) are pruned.

### Client identity

`X-Forwarded-For` is client-controlled, and Render's proxy appends to it rather than replacing it, so the leftmost entry
is never trusted. `clientKey()` uses:

1. `KEEL_CLIENT_IP_HEADER` if set (a single header the edge overwrites on every request, for example `cf-connecting-ip`);
   only valid IP characters are accepted. Off by default, because a client can send that header too if a request ever
   bypasses the edge.
2. Otherwise, with `KEEL_TRUSTED_PROXY_HOPS = N`, the N-th entry from the right of `X-Forwarded-For`.
3. Otherwise the socket address.

With the defaults behind a proxy, all visitors share one key, so the per-client limit becomes a stricter shared limit.
That fails safe. Identity is best-effort in every mode; the global caps bound what any number of spoofed identities can do.
Tested in `test/g5-server.test.ts` (spoofed leftmost entries, 0/1/2 hops, malformed header values, header ignored unless configured).

## Database ownership

Each process claims the database on start (`owner.epoch + 1`). Every write re-checks the epoch under a lock and fails with
`FencedError` if a newer process has claimed, including maintenance writes (prune, restore); `scripts/db.ts import` claims the database before it checks and restores it. A fenced process stops its
sessions and answers 503. This prevents a deploy overlap from applying a simulated effect twice. Evidence:
`docs/evidence/hosted-check.txt`.

## Secrets

- `DATABASE_URL` is read from the environment only (Render injects it). It is never logged; `scripts/db.ts` prints counts only.
- Postgres connections use TLS when the URL says `sslmode=require`.
- The simulated sources' HMAC keys are constants in `src/scenarios.ts`. They authenticate nothing real and are not secrets.
- `.env*` files are git-ignored. No API key is needed: the model outputs are recorded fixtures.

## Out of scope

Real-world source authentication (key rotation, producer epochs), multi-writer clusters, user accounts, and protection
of a session link someone chose to share.

## Dependency audit

`npm audit --omit=dev --audit-level=high` runs in CI; last local result: 0 vulnerabilities.
