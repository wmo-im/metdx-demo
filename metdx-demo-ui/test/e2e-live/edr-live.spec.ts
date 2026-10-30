// Live EDR run (project `live`, `npm run e2e:live`): one small request per query type against the real
// ECMWF/DestinE polytope `operational-data` collection, through the app (vite preview, config `proxy: false`, so the
// browser calls the server directly; it answers with `access-control-allow-origin: *`).
//
// The server is slow and sometimes does not answer (see .ecmwf-multi-agents/notes/live-requests.md), so a test passes
// when the result panel draws the data OR the page shows a clear failure message (status alert / dialog). Which of
// the two happened is attached as an annotation and printed. Opt-in only: skipped without E2E_LIVE=1.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screens');
const BASE = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';
const FALLBACK_DATETIME = '2026-10-29T00:00:00Z';

test.skip(!process.env.E2E_LIVE, 'live tests are opt-in: npm run e2e:live (E2E_LIVE=1)');
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

interface Mode {
  mode: string;
  /** Query string after `<mode>?` (the datetime is appended). */
  query: string;
}
const MODES: Mode[] = [
  { mode: 'position', query: 'coords=POINT(10.0 50.0)&parameter-name=2t' },
  { mode: 'area', query: 'coords=POLYGON((10.0 50.0,11.0 50.0,11.0 51.0,10.0 51.0,10.0 50.0))&parameter-name=2t' },
  { mode: 'trajectory', query: 'coords=LINESTRING(5.0 45.0,15.0 55.0)&parameter-name=2t' },
  { mode: 'radius', query: 'coords=POINT(10.0 50.0)&within=1.0&within-units=degrees&parameter-name=2t' },
  { mode: 'corridor', query: 'coords=LINESTRING(5.0 45.0,15.0 55.0)&corridor-width=1.0&width-units=degrees&corridor-height=10.0&height-units=m&parameter-name=2t' },
  { mode: 'cube', query: 'bbox=10.0,50.0,11.0,51.0&parameter-name=2t' },
];

let datetime = FALLBACK_DATETIME;

test.beforeAll(async ({ request }) => {
  // first step of the collection's current temporal extent (it moves forward as old runs expire)
  try {
    const res = await request.get(`${BASE}?f=json`, { timeout: 30_000 });
    const start = (await res.json())?.extent?.temporal?.interval?.[0]?.[0];
    if (typeof start === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(start)) datetime = start;
  } catch {
    /* keep the fallback */
  }
});

async function openLive(page: Page, mode: string) {
  // same-origin proxy off: the browser talks to the upstream server directly
  await page.route('**/config.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ recordsSource: 'local', proxy: false }) }),
  );
  await page.goto(`/record/${encodeURIComponent('urn:test:live')}/edr?col=${encodeURIComponent(BASE)}`);
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible({ timeout: 60_000 });
  if (mode !== 'position') await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: /2t/ }).first().click();
}

for (const { mode, query } of MODES) {
  test(`${mode}: one request, drawn on the map or a clear message`, async ({ page }) => {
    await openLive(page, mode);
    const url = `${BASE}/${mode}?${query}&datetime=${datetime}&f=json`;
    await page.getByLabel('Request URL').fill(url);
    await page.getByRole('button', { name: 'Fetch' }).click();

    const map = page.getByTestId('map');
    const result = page.getByTestId('edr-result');
    const status = page.getByTestId('edr-status');
    // the outcome: data on the map, a result panel notice (unsupported/too large to draw), or a failed request
    await expect
      .poll(
        async () => {
          const s = await map.getAttribute('data-data');
          if (s === 'drawn' || s === 'loaded') return 'drawn';
          if (await result.getByTestId('edr-result-error').isVisible()) return 'notice';
          const text = (await status.textContent().catch(() => '')) ?? '';
          if (/failed|error/i.test(text)) return 'failed';
          return 'waiting';
        },
        { timeout: 150_000, intervals: [500, 1000, 2000] },
      )
      .not.toBe('waiting');

    const s = await map.getAttribute('data-data');
    let outcome: string;
    if (s === 'drawn' || s === 'loaded') {
      outcome = 'drawn';
      await expect(result.getByTestId('legend')).toBeVisible();
    } else if (await result.getByTestId('edr-result-error').isVisible()) {
      outcome = `notice: ${((await result.getByTestId('edr-result-error').textContent()) ?? '').slice(0, 200)}`;
    } else {
      // failed request: the status alert and the error dialog explain it (not a blank page)
      const text = ((await status.textContent()) ?? '').trim();
      expect(text.length, 'clear failure message').toBeGreaterThan(5);
      const dialog = page.getByRole('dialog');
      outcome = `failed: ${text}${(await dialog.isVisible()) ? ` / ${((await dialog.textContent()) ?? '').slice(0, 200)}` : ''}`;
    }
    console.log(`live ${mode}: ${outcome}`);
    test.info().annotations.push({ type: 'outcome', description: outcome });

    await page.mouse.move(0, 0);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENS}/live-${mode}.png` });
  });
}
