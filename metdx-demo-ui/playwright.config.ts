import { defineConfig, devices } from '@playwright/test';

/**
 * Leaflet is off in the default build (VITE_ENABLE_LEAFLET unset). `npm run e2e:leaflet` (E2E_LEAFLET=1) builds a separate
 * Leaflet-enabled app (dist-leaflet, own preview port) and runs both engine projects against it.
 */
const LEAFLET = process.env.E2E_LEAFLET === '1';
const PORT = LEAFLET ? 4174 : 4173;

/**
 * End-to-end tests run in chromium against `vite preview` of the production build.
 * - `mock-ol` / `mock-leaflet` (test/e2e): mock mode (`?mock=1`) and routed synthetic data; offline, deterministic. The same
 *   specs run once per map engine (the `engine` option, see test/e2e/engine.ts). `npm run e2e` runs `mock-ol` against the
 *   default build (OpenLayers only); `npm run e2e:leaflet` runs both against a Leaflet-enabled build.
 * - `live` (test/e2e-live): real ECMWF/DestinE requests (through Playwright, no proxy server). Opt-in:
 *   `npm run e2e:live` (sets E2E_LIVE=1; without it the live tests are skipped, e.g. a plain `npx playwright test`).
 */
export default defineConfig<{ engine: 'ol' | 'leaflet' }>({
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
      name: 'mock-ol',
      testDir: './test/e2e',
      outputDir: './test-results/mock-ol', // keeps test-results/screens (shared by all projects) out of the clean-up
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, engine: 'ol' },
    },
    ...(LEAFLET
      ? [
          {
            name: 'mock-leaflet',
            testDir: './test/e2e',
            outputDir: './test-results/mock-leaflet',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, engine: 'leaflet' as const },
          },
        ]
      : []),
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
    command: LEAFLET
      ? `npx vite build --outDir dist-leaflet && npx vite preview --outDir dist-leaflet --port ${PORT} --strictPort`
      : `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    env: LEAFLET ? { VITE_ENABLE_LEAFLET: '1' } : {},
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
