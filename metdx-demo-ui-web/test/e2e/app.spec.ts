import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screens');
const RECORD_TITLE = 'ECMWF IFS Global Deterministic Forecast (Destination Earth)';

async function openRecord(page: Page) {
  await page.goto('/?mock=1');
  await page.getByLabel('Search datasets').fill('Deterministic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('results-header')).toContainText("Found 1 results for 'Deterministic'");
  await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
  await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
}

/** Click/drag on the OpenLayers canvas (relative to the map's centre). */
async function mapBox(page: Page) {
  const box = await page.getByTestId('map').boundingBox();
  if (!box) throw new Error('map not visible');
  return box;
}

test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

test('catalogue lists records with service badges', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.getByTestId('result-card')).toHaveCount(2);
  const card = page.getByTestId('result-card').filter({ hasText: RECORD_TITLE });
  await expect(card.getByTestId('badge-edr')).toBeVisible();
  await expect(card.getByTestId('badge-maps')).toBeVisible();
  await expect(page.getByTestId('map').locator('canvas')).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => {}); // basemap tiles (best effort; may be offline)
  await page.screenshot({ path: `${SCREENS}/catalogue.png` });
});

test('default (no ?mock): the catalogue uses the bundled records, never the GDC', async ({ page }) => {
  const proxied: string[] = [];
  await page.route('**/api/proxy**', (route) => {
    proxied.push(decodeURIComponent(route.request().url()));
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }); // EDR/Maps stay live: none here
  });
  await page.goto('/');
  await expect(page.getByTestId('result-card')).toHaveCount(2);
  await expect(page.getByTestId('records-source')).toHaveText('local records');
  await page.getByLabel('Search datasets').fill('open data');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('results-header')).toContainText("Found 1 results for 'open data'");
  expect(proxied.filter((u) => u.includes('wis2-discovery-metadata'))).toEqual([]);
});

test('?records=gdc switches the indicator and searches the GDC through the proxy', async ({ page }) => {
  const proxied: string[] = [];
  await page.route('**/api/proxy**', (route) => {
    proxied.push(decodeURIComponent(route.request().url()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ numberMatched: 0, features: [] }) });
  });
  await page.goto('/?records=gdc');
  await expect(page.getByTestId('records-source')).toHaveText('WIS2 GDC');
  await expect(page.getByTestId('results-header')).toContainText('0 available');
  expect(proxied.some((u) => u.includes('wis2-discovery-metadata/items?limit=10&offset=0'))).toBe(true);
});

test('search -> record -> EDR -> draw point -> Fetch shows JSON and chart', async ({ page }) => {
  await openRecord(page);
  await page.getByRole('link', { name: 'EDR', exact: true }).click();
  await expect(page.getByTestId('page-edr')).toBeVisible();
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();

  // pick a parameter
  await page.getByRole('button', { name: /2t/ }).first().click();

  // draw a point
  await page.getByRole('button', { name: 'Draw position' }).click();
  const box = await mapBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('edr-geometry')).toContainText(/\d/);
  await expect(page.getByLabel('Request URL')).toHaveValue(/\/position\?coords=POINT\(/);
  await expect(page.getByLabel('Request URL')).toHaveValue(/parameter-name=/);

  await page.mouse.move(0, 0);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500); // let MUI label/ripple transitions settle
  await page.screenshot({ path: `${SCREENS}/edr.png` });

  await page.getByRole('button', { name: 'Fetch' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('result-json')).toContainText('"type": "Coverage');
  await expect(dialog.locator('svg').first()).toBeVisible();
});

test('record -> Maps -> draw bbox -> Fetch puts an image overlay on the map', async ({ page }) => {
  await openRecord(page);
  await page.getByRole('link', { name: 'OGC Maps', exact: true }).click();
  await expect(page.getByTestId('page-maps')).toBeVisible();
  await expect(page.getByLabel('Request URL')).toHaveValue(/\/map\?/);

  await page.getByRole('button', { name: 'Draw BBOX' }).click();
  const box = await mapBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 150, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx + 150, cy + 80, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('maps-status')).toContainText('Bounding box set');
  const url = await page.getByLabel('Request URL').inputValue();
  expect(url).toMatch(/bbox=/);

  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(page.getByTestId('maps-status')).toContainText('Map rendered');
  // The overlay is an OL image layer: an <img>/<canvas> layer element appears in the viewport.
  await expect(page.getByLabel('Clear rendered map')).toBeVisible();
  // The PNG is an OpenLayers ImageStatic layer; the map element mirrors its load state.
  await expect(page.getByTestId('map')).toHaveAttribute('data-overlay', 'loaded');

  await page.getByLabel('Clear rendered map').click();
  await expect(page.getByTestId('map')).not.toHaveAttribute('data-overlay', /.*/);
});

test.describe('going back from a record to the search', () => {
  const backToSearch = async (page: Page, query: string | null) => {
    await expect(page.getByTestId('page-catalogue')).toBeVisible();
    await expect(page.getByTestId('result-card')).toHaveCount(query ? 1 : 2);
    await expect(page.getByLabel('Search datasets')).toHaveValue(query ?? '');
    await expect(page).toHaveURL(query ? new RegExp(`\\?q=${query}$`) : /\/(\?mock=1)?$/);
  };

  for (const query of ['Deterministic', null]) {
    const label = query ? `search "${query}"` : 'empty search';

    test(`${label}: the sidebar Back button returns to the results`, async ({ page }) => {
      await page.goto('/?mock=1');
      if (query) {
        await page.getByLabel('Search datasets').fill(query);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
      }
      await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
      await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
      await page.getByRole('button', { name: 'Back to results' }).click();
      await backToSearch(page, query);
    });

    test(`${label}: the browser Back button returns to the results`, async ({ page }) => {
      await page.goto('/?mock=1');
      if (query) {
        await page.getByLabel('Search datasets').fill(query);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
      }
      await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
      await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
      await page.goBack();
      await backToSearch(page, query);
    });
  }

  test('after record -> EDR -> Record, the sidebar Back still returns to the search', async ({ page }) => {
    await openRecord(page);
    await page.getByRole('link', { name: 'EDR', exact: true }).click();
    await expect(page.getByTestId('page-edr')).toBeVisible();
    await page.getByRole('link', { name: 'Record', exact: true }).click();
    await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
    await page.getByRole('button', { name: 'Back to results' }).click();
    await backToSearch(page, 'Deterministic');
  });

  test('a record opened directly: Back goes to the catalogue', async ({ page }) => {
    await page.goto(`/record/${encodeURIComponent('urn:wmo:md:int-ecmwf:weather.prediction.forecast.global')}?mock=1`);
    await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
    await page.getByRole('button', { name: 'Back to results' }).click();
    await expect(page.getByTestId('page-catalogue')).toBeVisible();
    await expect(page.getByTestId('result-card')).toHaveCount(2);
    await expect(page).toHaveURL(/\/$/);
  });
});

test('EDR defaults: a single datetime and a corridor height', async ({ page }) => {
  await openRecord(page);
  await page.getByRole('link', { name: 'EDR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
  await expect(page.getByLabel('Start date')).toHaveValue('2026-10-19');
  await expect(page.getByLabel('End date')).toHaveValue('');
  await page.getByRole('button', { name: 'corridor', exact: true }).click();
  await expect(page.getByLabel('Corridor height (optional)')).toHaveValue('10');
});
