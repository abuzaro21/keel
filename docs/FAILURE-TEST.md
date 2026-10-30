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
