import { chromium } from '@playwright/test';
const out = process.argv[2];
const b = await chromium.launch();
for (const [sc, wait] of [['delivery', 'delivered via R2'], ['recovery', 'no customer-facing 5xx'], ['flapping', 'Paused']]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:3211/#' + sc);
  await p.screenshot({ path: `${out}/${sc}-0.png` });
  await p.getByText(wait).first().waitFor({ timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}/${sc}-end.png`, fullPage: true });
  await p.close();
}
await b.close();
