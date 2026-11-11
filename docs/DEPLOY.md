# Deploying the hosted demo (Render, free plans)

Nothing here has been run against Render yet: creating cloud resources is the owner's decision. This is the exact plan.

## What gets created

| Resource | Plan | Notes |
|---|---|---|
| Web service `keel` (Docker, this repo's `Dockerfile`) | Free | spins down after 15 min idle; ~1 min cold start; 750 instance hours/month per workspace |
| Postgres `keel-db` | Free | 1 GB; **expires 30 days after creation**, then a 14-day grace period before deletion; no backups; one free database per workspace |

No paid plan, disk or add-on. `render.yaml` describes both with `plan: free` and `autoDeploy: false`.

## Steps

1. In the Render dashboard, open the **keel** workspace and check that it has no other free Postgres (one per workspace).
2. New → Blueprint → select the `abuzaro21/keel` repository and the branch to deploy. Render reads `render.yaml`.
   Render needs read access to the repository; the repository can stay private.
3. Confirm both resources show **Free**, then apply. `DATABASE_URL` is wired from the database automatically (internal URL, never committed).
4. When the deploy is live: `curl https://<service>.onrender.com/api/health` should return `{"ok":true,"store":"postgres",…}`.
5. Smoke test: open the URL, run each scenario tab, use "Crash the agent", reload the page mid-run (the session continues from the database).

## Client identity behind Render

Defaults are safe: with no proxy settings every visitor shares one rate-limit key (a stricter shared limit). To give
each visitor their own key, verify first which header the edge overwrites, then set **one** of:

- `KEEL_CLIENT_IP_HEADER=cf-connecting-ip` if every request reaches Render through Cloudflare and that header is overwritten
  by the edge (send a request with your own `cf-connecting-ip` and confirm it is replaced), or
- `KEEL_TRUSTED_PROXY_HOPS=1` if exactly one proxy appends the client address to `X-Forwarded-For`.

See [SECURITY.md](SECURITY.md#client-identity).

## Deploys and restarts

- A new instance claims the database (owner epoch). The old one is fenced: it stops its sessions and answers 503, and its
  open pages ask the visitor to reload. No simulated effect can be applied twice across the overlap (`scripts/hosted-check.sh`).
- Spin-down and restarts lose nothing: sessions, effects, injections and clocks are in Postgres and resume on the next request.

## Before day 30: keep the data

```bash
node scripts/db.ts export "$DATABASE_URL" keel-dump.json        # external URL from the Render dashboard
# create the new free database (or a SQLite file), then:
node scripts/db.ts import "<new postgres url or path.db>" keel-dump.json
```

Import refuses a non-empty target and verifies counts. If nobody needs old demo sessions, letting the database expire
and creating a fresh one is also fine: every scenario starts from scratch anyway.

## Rollback

Set the service back to a previous deploy in the Render dashboard. The schema is versioned (`schema_meta`, version 1);
a build that does not recognise the stored version refuses to open the database instead of half-migrating it.

## Without Render

`docker build -t keel . && docker run -p 3000:3000 -e DATABASE_URL=postgres://… keel`, or without `DATABASE_URL` for an
in-container SQLite demo.
