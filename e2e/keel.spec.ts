import { test, expect } from '@playwright/test';

const lane = (page: import('@playwright/test').Page, name: string) => page.getByRole('article', { name, exact: true });

test('delivery: first screen is a running plan; static learns too late, KEEL repairs and keeps finished work', async ({ page }) => {
  await page.goto('/#delivery');
  await expect(lane(page, 'KEEL').getByText('pick · 1042')).toBeVisible();
  await expect(lane(page, 'Static / open loop').getByText('dispatch · 1042 · R1 · T1')).toBeVisible();
  const reason = lane(page, 'KEEL').getByRole('region', { name: 'Why the plan changed' });
  await expect(reason).toContainText('I changed my mind because route:R1.status became "closed"', { timeout: 30_000 });
  await expect(reason).toContainText('3 completed steps carried over unchanged');
  await expect(lane(page, 'KEEL').locator('.steps').getByText('request_permit · R2')).toBeVisible();
  await expect(lane(page, 'Static / open loop')).toContainText('Too late', { timeout: 30_000 });
  await expect(lane(page, 'KEEL')).toContainText('delivered via R2', { timeout: 30_000 });
  const score = page.getByRole('region', { name: 'Side-by-side comparison' });
  await expect(score.getByRole('row', { name: /Harmful actions executed/ })).toContainText('1');
  await expect(page.getByRole('region', { name: 'Observation stream' })).toContainText('REALITY CHANGED');
  await expect(page.getByRole('region', { name: 'Observation stream' })).toContainText('duplicate delivery');
});

test('recovery: the in-flight failover is fenced before its effect', async ({ page }) => {
  await page.goto('/#recovery');
  const reason = lane(page, 'KEEL').getByRole('region', { name: 'Why the plan changed' });
  await expect(reason).toContainText('svc:region-b.status became "degraded"', { timeout: 30_000 });
  await expect(lane(page, 'KEEL').locator('.steps')).toContainText('shift_traffic · region-c');
  await expect(lane(page, 'KEEL')).toContainText('no customer-facing 5xx', { timeout: 30_000 });
  await expect(lane(page, 'Static / open loop')).toContainText('checkout returns 5xx', { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Side-by-side comparison' }).getByRole('row', { name: /fenced/ })).toContainText('1');
});

test('adaptation failure: naive follows the flapping sensor; KEEL holds until an operator confirms', async ({ page }) => {
  await page.goto('/#flapping');
  const keel = lane(page, 'KEEL');
  const pause = keel.getByRole('status', { name: 'Paused' });
  await expect(pause).toContainText(/flapping|abandoned earlier/, { timeout: 30_000 });
  await expect(lane(page, 'Naive adaptive')).toContainText('closed route R1', { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Observation stream' })).toContainText('unknown source "press-office"');
  await expect(page.getByRole('region', { name: 'Observation stream' })).toContainText('traffic-authority', { timeout: 30_000 });
  const confirm = pause.getByRole('button', { name: /^Confirm/ });
  for (let n = await confirm.count(); n > 0; n--) { await confirm.first().click(); await expect(confirm).toHaveCount(n - 1); }
  await pause.getByRole('button', { name: 'Resume' }).click();
  await expect(keel).toContainText('delivered via R2', { timeout: 30_000 });
});

test('a visitor-forged event is rejected and changes nothing', async ({ page }) => {
  await page.goto('/#delivery');
  await expect(lane(page, 'KEEL').getByText('pick · 1042')).toBeVisible();
  await page.getByRole('button', { name: /forge:/ }).click();
  await expect(page.getByRole('region', { name: 'Observation stream' })).toContainText('signature does not verify');
});

test('layout fits a phone: no horizontal page scroll', async ({ page }) => {
  await page.goto('/#delivery');
  await expect(lane(page, 'KEEL')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
