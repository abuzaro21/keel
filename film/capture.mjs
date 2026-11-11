// Captures REAL footage of the current KEEL build for the film. Nothing is staged: each clip is a fresh session on a
// local server (in-memory SQLite), driven only by the scenario feed and the clicks listed here.
// Output: film/out/raw/<clip>.webm plus <clip>.json with the wall-clock offsets (s) at which key UI states appeared.
// Usage: npm run build && node film/capture.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';

const PORT = 3400;
const OUT = new URL('./out/raw/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), KEEL_TICK_MS: '650', KEEL_DB: ':memory:' }, stdio: 'inherit',
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const browser = await chromium.launch();
const lane = (p, name) => p.getByRole('article', { name, exact: true });
const center = (loc) => loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
const top = (p, sel) => p.locator(sel).first().evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 16, behavior: 'smooth' }));

const only = process.env.CLIPS?.split(',');
async function clip(name, hash, script) {
  if (only && !only.includes(name)) return;
  const dir = new URL(`./tmp-${name}/`, OUT);
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 }, recordVideo: { dir: dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), size: { width: 1920, height: 1080 } }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => { marks[k] = (Date.now() - t0) / 1000; console.log(`${name}: ${k} @ ${marks[k].toFixed(1)}s`); };
  await page.goto(`http://127.0.0.1:${PORT}/#${hash}`);
  mark('loaded');
  await script(page, mark);
  await page.waitForTimeout(1500);
  mark('end');
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), new URL(`${name}.webm`, OUT));
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(marks, null, 2));
}

try {
  await clip('delivery', 'delivery', async (p, mark) => {
    await lane(p, 'KEEL').getByText('pick · 1042').waitFor();
    await p.waitForTimeout(2500); // intro + goal visible
    await top(p, '.lanes');
    const reason = lane(p, 'KEEL').getByRole('region', { name: 'Why the plan changed' });
    await reason.waitFor({ timeout: 60_000 });
    mark('revision');
    await center(reason);
    await lane(p, 'Static / open loop').getByText('Too late').waitFor({ timeout: 60_000 });
    mark('static-outcome');
    await lane(p, 'KEEL').getByText('delivered via R2').waitFor({ timeout: 60_000 });
    mark('keel-outcome');
    await center(lane(p, 'KEEL').locator('.outcome'));
    await p.waitForTimeout(2500);
    await center(p.getByRole('region', { name: 'Side-by-side comparison' }));
    mark('scorecard');
    await p.waitForTimeout(3000);
  });

  await clip('recovery', 'recovery', async (p, mark) => {
    await lane(p, 'KEEL').getByText('snapshot_db').waitFor();
    await p.waitForTimeout(1500);
    await top(p, '.lanes');
    const reason = lane(p, 'KEEL').getByRole('region', { name: 'Why the plan changed' });
    await reason.waitFor({ timeout: 60_000 });
    mark('revision');
    await center(reason);
    await lane(p, 'KEEL').getByText('no customer-facing 5xx').waitFor({ timeout: 60_000 });
    mark('keel-outcome');
    await lane(p, 'Static / open loop').getByText('checkout returns 5xx').waitFor({ timeout: 60_000 });
    mark('static-outcome');
    await center(lane(p, 'KEEL').locator('.outcome'));
    await p.waitForTimeout(3000);
  });

  await clip('flapping', 'flapping', async (p, mark) => {
    await lane(p, 'KEEL').getByText('pick · 1042').waitFor();
    await p.waitForTimeout(1500);
    await center(p.getByRole('region', { name: 'Observation stream' }));
    const forged = p.getByRole('region', { name: 'Observation stream' }).getByText('unknown source "press-office"');
    await forged.waitFor({ timeout: 60_000 });
    mark('forgery-rejected');
    await center(forged);
    await p.waitForTimeout(3000); // hold on the rejected forgery
    await top(p, '.lanes');
    const pause = lane(p, 'KEEL').getByRole('status', { name: 'Paused' });
    await pause.waitFor({ timeout: 60_000 });
    mark('keel-paused');
    await center(pause);
    await lane(p, 'Naive adaptive').getByText('closed route R1').waitFor({ timeout: 60_000 });
    mark('naive-harm');
    await p.waitForTimeout(2500);
    const confirm = pause.getByRole('button', { name: /^Confirm/ });
    for (let n = await confirm.count(); n > 0; n--) { await confirm.first().click(); await p.waitForTimeout(900); }
    mark('confirmed');
    await pause.getByRole('button', { name: 'Resume' }).click();
    mark('resumed');
    await lane(p, 'KEEL').getByText('delivered via R2').waitFor({ timeout: 60_000 });
    mark('keel-outcome');
    await center(lane(p, 'KEEL').locator('.outcome'));
    await p.waitForTimeout(2500);
  });

  await clip('engine', 'delivery', async (p, mark) => {
    await lane(p, 'KEEL').getByText('pick · 1042').waitFor();
    await top(p, '.lanes');
    await lane(p, 'KEEL').locator('.steps li').nth(2).getByText('receipt').waitFor({ timeout: 60_000 }).catch(() => {});
    await p.waitForTimeout(800);
    const crash = lane(p, 'KEEL').getByRole('button', { name: /Crash the agent/ });
    await center(crash);
    await p.waitForTimeout(800);
    await crash.click();
    mark('crashed');
    await p.waitForTimeout(2500);
    await lane(p, 'KEEL').getByText('delivered via R2').waitFor({ timeout: 60_000 });
    mark('keel-outcome');
    const trace = p.locator('details').filter({ hasText: 'Persistent audit trace' });
    await trace.locator('summary').click();
    await center(trace.locator('summary'));
    mark('trace');
    await p.waitForTimeout(1200);
    await p.mouse.wheel(0, 500);
    await p.waitForTimeout(2500);
  });
} finally {
  await browser.close();
  server.kill();
}
