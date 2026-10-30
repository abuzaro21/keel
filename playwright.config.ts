import { defineConfig, devices } from '@playwright/test';

// Local: builds nothing; run `npm run build` first. Set E2E_BASE_URL to test a deployed instance instead.
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3210';
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: base, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node --disable-warning=ExperimentalWarning src/main.ts',
    url: `${base}/api/health`,
    env: { PORT: '3210', KEEL_TICK_MS: '150' },
    reuseExistingServer: false,
  },
});
