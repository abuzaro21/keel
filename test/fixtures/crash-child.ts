// Child process for the real-crash test: `run` gets SIGKILLed at a failpoint; `recover` resumes from the same SQLite file.
import { Hub, Session } from '../../src/runner.ts';
import { runMetrics } from '../../src/metrics.ts';

const [db, mode] = process.argv.slice(2);
const hub = new Hub(db);
if (mode === 'run') {
  new Session(hub, 'crash', 'delivery', ['keel']).start().runToEnd();
  console.log('not killed');
} else {
  hub.failpoint = null;
  Session.resume(hub, 'crash').runToEnd();
  const m = runMetrics(hub.store, hub.sim, 'crash-keel');
  const sawRecover = hub.store.events('crash-keel').some((e) => e.t === 'recover');
  console.log(JSON.stringify({ ...m, sawRecover }));
}
