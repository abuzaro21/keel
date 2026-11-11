# Failure test: when adaptation itself becomes dangerous

**Setup (scenario "Adaptation failure").** `road-sensor-7`, a registered but lower-ranked source, flips R1 and R2 between open and closed every tick. A forged closure arrives from an unregistered `press-office`. Ground truth: R1 is closed from t2; R2 stays open. The traffic authority confirms at t16.

**Naive adaptive agent** — same engine, same events, same idempotency; it replans on every change and prefers the cheapest plan. It switches R1 → R2 → R1, follows the sensor's last "open" onto the closed road, and tells the customer the delivery is on time. It reports success. The simulated world records a truck stuck at the closure.

**KEEL** contains it with layered, auditable rules:

| Rule | What it does here |
|---|---|
| Authentication + namespace + rank | The forged closure is rejected and changes nothing |
| Adverse change acts immediately | R1 closing triggers a repair at once (R2 + permit) |
| No optimisation revisions | R1 "reopening" while the R2 plan is valid causes no flip |
| Oscillation guard | A repair that would return to the plan abandoned earlier, with no progress since, is refused → pause |
| Flap detector | 3 value changes in 30 ticks ⇒ the fact is UNSTABLE ⇒ UNKNOWN ⇒ nothing irreversible runs on it |
| Revision + planning budgets | Bound total churn; restart does not refill them |
| Latched pause | Only an operator lifts containment (confirm the fact, resume) |

The outcome is honest: KEEL is **paused with the goal unfinished** until a human confirms, and then completes via R2. Nothing irreversible ran on an untrusted fact.

**Other failure cases, each with a test** (`test/`): duplicate and out-of-order delivery; forged ids; producer timestamps outside the clock window; a change arriving during a step's preparation (fenced) and during application (reconciled); a world change between repair request and planner answer (stale candidate rejected); a lost acknowledgement (reconciled, no repeat); crash at every point of a run, plus real `SIGKILL` before and after the effect boundary; no feasible repair (pause, goal not weakened); revision-budget exhaustion; a road closing while the truck is already in transit — an irreversible step that cannot be undone, so KEEL stops instead of sending a false "on time" notice.

## Process-level failures (the agent's own infrastructure)

| Failure | What happens | Evidence |
|---|---|---|
| `SIGKILL` of the container mid-run (Docker image on Postgres) | A second container resumes the session from the database: KEEL completes via R2, 3 completed steps preserved, 0 duplicate effects; the static lane still ends stuck | `scripts/hosted-check.sh`, [`evidence/hosted-check.txt`](evidence/hosted-check.txt) |
| Two instances overlap (zero-downtime deploy) | The newer one claims the owner epoch; the older one's next write is refused, it stops its sessions and answers 503 (health and API) | same, plus `test/g8` R1-1/2/3 |
| A replaced process tries maintenance (prune, restore) | Refused with `FencedError`; the owner's data is untouched | `test/g9` A |
| A session is evicted from memory while its clock tick or an injection is in flight | Eviction waits for the tick, the injection queue and every mailbox; late requests get 409 and the session reloads cleanly | `test/g9` B |
| A live-view frame fails to build | That session's streams are closed instead of skipping rows; the reconnect backfills from the store with no gap | `test/g9` C |
| Concurrent visitor injections and reloads after a restart | Distinct, ordered sequence numbers; store order equals delivery order; parallel reloads all succeed | `test/g8` R1-4/10/11/13 |
| Database from an older build | Refused with a clear message, never half-migrated | `test/g8` R1-8 |
