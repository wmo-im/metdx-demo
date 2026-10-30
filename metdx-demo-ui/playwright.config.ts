import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * End-to-end tests run in chromium against `vite preview` of the production build.
 * - `mock` (test/e2e): mock mode (`?mock=1`) and routed synthetic data; offline, deterministic. `npm run e2e`.
 * - `live` (test/e2e-live): real ECMWF/DestinE requests (through Playwright, no proxy server). Opt-in:
 *   `npm run e2e:live` (sets E2E_LIVE=1; without it the live tests are skipped, e.g. a plain `npx playwright test`).
 */
export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'mock',
      testDir: './test/e2e',
      outputDir: './test-results/mock', // keeps test-results/screens (shared by both projects) out of the clean-up
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'live',
      testDir: './test/e2e-live',
      outputDir: './test-results/live',
      fullyParallel: false,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
