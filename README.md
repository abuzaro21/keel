# KEEL — The Adaptive Agent

*The plan can change. The goal stays.* If no safe continuation exists, KEEL stops.

KEEL runs a multi-step plan, re-checks the assumptions behind its remaining steps whenever an observation changes a fact they depend on, repairs only the broken part of the plan, keeps the work it has already finished, and holds still when the world is too unstable to trust.

Built for the DOO Builders League challenge **The Adaptive Agent** — *"Can an AI system recognize that reality changed and safely change its mind?"*

> Everything outside the agent is **simulated**: roads, trucks, regions, sensors and customers. No real system is touched.

## Run it

```bash
git clone <this repo> keel && cd keel
npm ci
npm run build      # judge UI -> public/
npm start          # http://localhost:3000
```
Requires Node **24.13+** (uses built-in `node:sqlite` and TypeScript type stripping; zero runtime npm dependencies).

```bash
npm test           # 49 tests: engine, durability (real SIGKILL), repair, scenarios, regressions, server
npm run typecheck
npx playwright install chromium && npx playwright test   # browser tests (desktop + phone)
```
Docker: `docker build -t keel . && docker run -p 3000:3000 keel`.

## What you will see

The first screen is a running plan, not a settings page. Two agents run on the **same simulated world and the same signed event stream**:

| Scenario | What changes | Static / open loop | KEEL |
|---|---|---|---|
| **Delivery** | Route R1 closes while order #1042 is being loaded (already picked and sealed in its cold box) | Dispatches onto the closed road, tells the customer "on time", reports success — **silent failure** | Keeps pick/pack/load receipts; relabels for R2, inserts the transit permit R2 needs, dispatches on R2; edit distance 3 |
| **Service recovery** | Region-b degrades while traffic is being shifted onto it | Moves traffic onto the degraded region: 5xx outage, reports success | Fences the in-flight shift before its effect, sheds non-critical traffic, shifts to the smaller region-c, restores and brings full traffic back |
| **Adaptation failure** | A faulty sensor flaps R1 and R2; a forged closure arrives | *Naive adaptive* lane (same engine, replans on every change, cheapest first) follows the sensor back onto the closed road | Rejects the forgery, refuses to flip back to a plan it just abandoned (oscillation guard) and treats flapping facts as UNKNOWN; holds before the irreversible dispatch until an operator confirms |

Every revision shows **"I changed my mind because …"** with the exact observation, the broken assumption, what was kept, what changed, every safety check and who proposed the repair. You can change reality yourself (signed events from registered sources), forge an event, crash the agent (it rebuilds from the log), and read the raw audit trace.

## How it works (one paragraph)

The engine is a pure, event-sourced function: `decide(state, input) → decisions`. Inputs are observations, effect receipts, planner answers and operator commands; nothing ever wakes the agent on a timer. Each action is an executable contract (`requires`, `maintains`, `releases`, `produces`, semantic `effectKey`), so assumptions are derived by code, not written by the planner. A changed fact that any remaining step, live commitment or goal reads triggers a forward projection; a failing condition is a contradiction with an exact cause. Repairs come from a deterministic flaw-directed search and from model proposals; **every candidate is untrusted** and must pass the validator against current beliefs. Commits are optimistic (stale candidates are rejected), side effects carry operation ids and generations and are applied once, and every input plus its decisions is appended atomically to SQLite. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## AI usage — honest disclosure

- **Inside the product.** A language model proposes repair candidates. The public demo uses **recorded genuine outputs** of `claude-sonnet-5-5` (captured with `scripts/record-planner.ts` through the Claude Code CLI; serving model taken from CLI metadata; prompt and response stored with sha256 in `fixtures/planner-recordings.json`). A recording is used only when the full planning context hashes identically; it is then **validated against the live run like any other candidate** and labelled "recorded model output · validated now". Any change a visitor injects produces a new context and falls back to the labelled deterministic search. Replayed outputs are never presented as fresh inference. No API key is needed; there is no live-model mode in this release.
  - Observed: in the flapping scenario the model proposed obtaining the reversible permit *before* the irreversible packing step — a valid reordering the deterministic search does not produce.
- **Building it.** Designed and implemented by Claude (Anthropic, Claude Code) with OpenAI Codex (`gpt-6.1-sol`) as independent co-architect and adversarial reviewer: independent architectures, cross-examination, and code-level gate reviews that found real defects (fixed with regression tests). The owner directed the work and makes the release decisions.

## Limitations (stated, not hidden)

- The world, its sources and their HMAC keys are simulated; signatures show the mechanism, not real-world authentication. Producer epochs/key rotation are out of scope.
- Planning domains are small; the search is bounded breadth-first with explicit caps. Real catalogues would need heuristics.
- The engine guarantees "no *next* step on a broken assumption" and fences operations still in their preparation window; it cannot stop an effect that has already been applied — it reconciles and, if needed, stops.
- Hosted demo storage: SQLite lives for the container's life. Crash recovery is real (tested with `SIGKILL` in a child process; demonstrable in the UI), but a host redeploy or idle spin-down starts a fresh demo database.
- Not every changed situation is recoverable: when the truck is already in transit on a road that closes, KEEL stops rather than pretending.
- Thresholds (flap = 3 changes in 30 ticks; 3 revisions; 12 planning requests) are demo values, not tuned.

## Documents
- [Architecture](docs/ARCHITECTURE.md) · [Two-year thesis](docs/THESIS.md) · [Failure test](docs/FAILURE-TEST.md)
