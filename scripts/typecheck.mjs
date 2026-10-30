// Shell-independent typecheck of server/tests and (once it exists) the UI.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
for (const args of [['--noEmit'], ...(existsSync('ui/tsconfig.json') ? [['-p', 'ui', '--noEmit']] : [])]) {
  const r = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
