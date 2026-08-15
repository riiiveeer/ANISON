import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PWA_PORT || 4174);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/pwa',
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      ...process.env,
      PORT: String(port),
    },
  },
});
