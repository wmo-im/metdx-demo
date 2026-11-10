import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, QUICK, expectMapRendered, settleMap, shotName, test } from './engine';

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

test('catalogue lists the default-query records with service badges', async ({ page, engine }) => {
  await page.goto('/?mock=1');
  await expect(page.getByLabel('Search datasets')).toHaveValue('metdx-demo');
  await expect(page.getByTestId('result-card')).toHaveCount(3);
  await expect(page.getByTestId('results-header')).toContainText("Found 3 results for 'metdx-demo'");
  const card = page.getByTestId('result-card').filter({ hasText: RECORD_TITLE });
  await expect(card.getByTestId('badge-edr')).toBeVisible();
  await expect(card.getByTestId('badge-maps')).toBeVisible();
  // MSC: its collection cannot be fetched (no fixture / 502 upstream): no badges, no error, no hang
  const msc = page.getByTestId('result-card').filter({ hasText: 'Weather Elements on the Grid' });
  await expect(msc).toBeVisible();
  await expect(msc.getByTestId('badge-edr')).toHaveCount(0);
  await expect(msc.getByTestId('badge-maps')).toHaveCount(0);
  await expectMapRendered(page, engine);
  await settleMap(page);
  await page.screenshot({ path: `${SCREENS}/${shotName('catalogue', engine)}.png` });
});

test('clearing the default query lists all records', async ({ page }) => {
  await page.goto('/?mock=1');
  await expect(page.getByTestId('result-card')).toHaveCount(3);
  await page.getByLabel('Search datasets').fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('results-header')).toContainText('Showing latest datasets (3 available)');
  await expect(page.getByLabel('Search datasets')).toHaveValue('');
});

test('?records=local: the bundled records, never the catalogue', async ({ page }) => {
  const proxied: string[] = [];
  await page.route('**/api/proxy**', (route) => {
    proxied.push(decodeURIComponent(route.request().url()));
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }); // EDR/Maps stay live: none here
  });
  await page.goto('/?records=local');
  await expect(page.getByTestId('result-card')).toHaveCount(3);
  await expect(page.getByTestId('records-source')).toHaveText('local records');
  await page.getByLabel('Search datasets').fill('open data');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('results-header')).toContainText("Found 1 results for 'open data'");
  expect(proxied.filter((u) => u.includes('wis2-discovery-metadata'))).toEqual([]);
});

test('default (no ?mock): searches the catalogue for the default query through the proxy', async ({ page }) => {
  const proxied: string[] = [];
  await page.route('**/api/proxy**', (route) => {
    proxied.push(decodeURIComponent(route.request().url()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ numberMatched: 0, features: [] }) });
  });
  await page.goto('/');
  await expect(page.getByTestId('records-source')).toHaveText('wmo-resource-catalogue.labs.wis2dev.io');
  await expect(page.getByLabel('Search datasets')).toHaveValue('metdx-demo');
  await expect(page.getByTestId('results-header')).toContainText("Found 0 results for 'metdx-demo'");
  expect(
    proxied.some((u) =>
      u.includes('https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items?limit=10&offset=0&q=metdx-demo'),
    ),
  ).toBe(true);
});

/** The visible [west, south, east, north] the map mirrors as `data-view` (both engines). */
async function mapView(page: Page): Promise<number[]> {
  const v = await page.getByTestId('map').getAttribute('data-view');
  return v ? v.split(',').map(Number) : [];
}

test('the map starts on the whole world; opening a record shows its footprint with context around it', async ({ page }) => {
  await page.goto('/?mock=1');
  const world = [-180, -85, 180, 85];
  const contains = (v: number[], b: number[]) => v.length === 4 && v[0] <= b[0] && v[1] <= b[1] && v[2] >= b[2] && v[3] >= b[3];
  await expect.poll(async () => contains(await mapView(page), world), { message: 'initial view contains the world' }).toBe(true);

  await page.getByLabel('Search datasets').fill('Deterministic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
  await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
  // the record's EDR collection covers the world ([-180,-90,180,90] in the mock): the view shows all of it, and some more
  const footprint = [-180, -90, 180, 90];
  await expect
    .poll(async () => {
      const v = await mapView(page);
      return contains(v, [-180, -85, 180, 85]) && v[2] - v[0] >= footprint[2] - footprint[0];
    })
    .toBe(true);
});

test('opening a record with a regional footprint zooms to it, with context around it', async ({ page }) => {
  const europe = [-10, 35, 30, 60];
  const collection = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'collections', 'operational-data.json'), 'utf8'));
  collection.extent.spatial.bbox = [europe];
  await page.route('**/api/proxy**', (route) => {
    const upstream = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (/\/collections\/operational-data(\?|$)/.test(upstream)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(collection) });
    }
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/?records=local');
  const contains = (v: number[], b: number[]) => v.length === 4 && v[0] <= b[0] && v[1] <= b[1] && v[2] >= b[2] && v[3] >= b[3];
  await expect.poll(async () => contains(await mapView(page), [-180, -85, 180, 85])).toBe(true); // starts on the world
  const world = await mapView(page);

  await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
  await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
  await expect
    .poll(async () => {
      const v = await mapView(page);
      return contains(v, europe) && v[2] - v[0] < world[2] - world[0];
    }, { message: 'the view is narrower than the world and contains the footprint' })
    .toBe(true);
  const v = await mapView(page);
  expect(v[2] - v[0]).toBeGreaterThan(europe[2] - europe[0]); // context around the footprint
  expect(v[3] - v[1]).toBeGreaterThan(europe[3] - europe[1]);
});

test('search -> record -> EDR -> draw point -> Fetch shows JSON and chart', { tag: QUICK }, async ({ page, engine }) => {
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

  await settleMap(page);
  await page.screenshot({ path: `${SCREENS}/${shotName('edr', engine)}.png` });

  await page.getByRole('button', { name: 'Fetch' }).click();
  const panel = page.getByTestId('edr-result');
  await expect(panel.locator('svg').first()).toBeVisible(); // the series chart, in the sidebar
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await panel.getByRole('button', { name: 'View JSON' }).click();
  await expect(page.getByRole('dialog').getByTestId('result-json')).toContainText('"type": "Coverage');
});

test('record -> Maps -> draw bbox -> Fetch puts an image overlay on the map', { tag: QUICK }, async ({ page }) => {
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
  await expect(page.getByLabel('Clear rendered map')).toBeVisible();
  // The PNG is an image layer of the engine (OL ImageStatic / reprojected Leaflet imageOverlay); the map element mirrors its load state.
  await expect(page.getByTestId('map')).toHaveAttribute('data-overlay', 'loaded');

  await page.getByLabel('Clear rendered map').click();
  await expect(page.getByTestId('map')).not.toHaveAttribute('data-overlay', /.*/);
});

test.describe('going back from a record to the search', () => {
  const backToSearch = async (page: Page, query: string | null) => {
    await expect(page.getByTestId('page-catalogue')).toBeVisible();
    // no query typed: the default query (metdx-demo) applies and matches all three bundled/mock records
    await expect(page.getByTestId('result-card')).toHaveCount(query ? 1 : 3);
    await expect(page.getByLabel('Search datasets')).toHaveValue(query ?? 'metdx-demo');
    await expect(page).toHaveURL(query ? new RegExp(`\\?q=${query}$`) : /\/(\?mock=1)?$/);
  };

  for (const query of ['Deterministic', null]) {
    const label = query ? `search "${query}"` : 'default search';

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
    await expect(page.getByTestId('result-card')).toHaveCount(3);
    await expect(page).toHaveURL(/\/$/);
  });
});

test('EDR defaults: position = first step + 1 day, other modes a single step, and a corridor height', async ({ page }) => {
  await openRecord(page);
  await page.getByRole('link', { name: 'EDR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
  await expect(page.getByLabel('Start date')).toHaveValue('2026-10-19');
  await expect(page.getByLabel('End date')).toHaveValue('2026-10-20');
  await page.getByRole('button', { name: 'corridor', exact: true }).click();
  await expect(page.getByLabel('End date')).toHaveValue('2026-10-19');
  await expect(page.getByLabel('Corridor height (optional)')).toHaveValue('10');
});

test('EDR datetime dropdowns offer only the available times, depending on the date', async ({ page }) => {
  await page.goto('/?mock=1');
  const col = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/stepped-data';
  await page.goto(`/record/${encodeURIComponent('urn:test:stepped')}/edr?col=${encodeURIComponent(col)}`);
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
  await expect(page.getByLabel('Start date')).toHaveValue('2026-11-09');
  await expect(page.getByLabel('End date')).toHaveValue('2026-11-10');
  await expect(page.getByText(/Steps: hourly to 12 Nov 18:00, then 3-hourly/)).toBeVisible();

  const optionTexts = async (label: string) => {
    await page.getByRole('combobox', { name: label }).click();
    const texts = await page.getByRole('option').allTextContents();
    await page.keyboard.press('Escape');
    return texts;
  };
  expect(await optionTexts('Start time')).toHaveLength(24);
  await page.getByRole('combobox', { name: 'Start date' }).click();
  await page.getByRole('option', { name: '2026-11-16' }).click();
  expect(await optionTexts('Start time')).toEqual(['00:00', '06:00', '12:00', '18:00']);
  await expect(page.getByLabel('Start time')).toHaveValue('00:00');
  // the end cannot be before the start
  await expect(page.getByLabel('End date')).toHaveValue('2026-11-16');
  expect((await optionTexts('End date'))[0]).toBe('2026-11-16');

  await page.getByRole('button', { name: 'corridor', exact: true }).click();
  await expect(page.getByLabel('End date')).toHaveValue('2026-11-16');
});
