// Export / import the whole KEEL database (event logs, simulated effects, injections, world clocks) as one JSON dump.
// The migration path off an expiring free Postgres (or between SQLite and Postgres):
//   node scripts/db.ts export <target> <file.json>      target = postgres://... or a SQLite path
//   node scripts/db.ts import <target> <file.json>      target must be empty
// DATABASE_URL-style secrets are read from the argument only; nothing is logged except counts.
import { readFileSync, writeFileSync } from 'node:fs';
import { openStore } from '../src/store.ts';
import type { Dump } from '../src/store.ts';

const [cmd, target, file] = process.argv.slice(2);
if (!['export', 'import'].includes(cmd) || !target || !file) {
  console.error('usage: node scripts/db.ts export|import <postgres://...|sqlite-path> <file.json>');
  process.exit(2);
}
const store = await openStore(target);
try {
  if (cmd === 'export') {
    const d = await store.dump();
    writeFileSync(file, JSON.stringify(d));
    console.log(`exported ${d.runs.length} runs, ${d.events.length} events, ${d.effects.length} effects, ${d.injections.length} injections`);
  } else {
    const d = JSON.parse(readFileSync(file, 'utf8')) as Dump;
    // Own the target before checking it: a server that claims it meanwhile fences restore() instead of racing it.
    await store.claim('db-import');
    if ((await store.runs()).length) throw new Error('target database is not empty; refusing to merge');
    await store.restore(d);
    const back = await store.dump();
    if (back.events.length !== d.events.length || back.effects.length !== d.effects.length) throw new Error('verification failed: counts differ after import');
    console.log(`imported and verified ${d.runs.length} runs, ${d.events.length} events, ${d.effects.length} effects`);
  }
} finally { await store.close(); }
