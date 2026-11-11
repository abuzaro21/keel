// Child process for the real-crash tests: `run` gets SIGKILLed at a failpoint; `recover` resumes from the same store.
// Store target: argv[2] is a SQLite file path or a postgres:// URL (schema in KEEL_PG_SCHEMA).
import { Hub, Session } from '../../src/runner.ts';
import { runMetrics } from '../../src/metrics.ts';

process.env.KEEL_PLANNER = 'search';
const [target, mode] = process.argv.slice(2);
const hub = await Hub.open(target, {}, process.env.KEEL_PG_SCHEMA);
if (mode === 'run') {
  await (await Session.create(hub, 'crash', 'delivery', ['keel'])).runToEnd();
  console.log('not killed');
} else {
  hub.failpoint = null;
  await (await Session.resume(hub, 'crash')).runToEnd();
  const m = await runMetrics(hub.store, hub.sim, 'crash-keel');
  const sawRecover = (await hub.store.rows('crash-keel')).some((r) => r.ev.t === 'recover');
  console.log(JSON.stringify({ ...m, sawRecover }));
}
await hub.close();
