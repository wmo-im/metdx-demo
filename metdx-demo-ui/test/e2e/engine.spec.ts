// Map-engine specific flows (mock project).
// Default build (`npm run e2e`): OpenLayers is the only engine: no app-bar toggle, `?map=leaflet` and a stored choice are
// ignored, and no Leaflet code is ever requested.
// Leaflet-enabled build (`npm run e2e:leaflet`, run once per engine): the lazy-load contract (a build only downloads the
// engine in use), switching the engine in the app bar (also in the middle of a draw), and, once, side-by-side
// screenshots of both engines for the same scenarios (test-results/screens/engine-*.png).
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, LEAFLET_BUILD, QUICK, settleMap, stubBasemap, test, type EngineName } from './engine';

const SCREENS = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screens');
const RECORD_TITLE = 'ECMWF IFS Global Deterministic Forecast (Destination Earth)';
const OTHER: Record<EngineName, EngineName> = { ol: 'leaflet', leaflet: 'ol' };
const LABEL: Record<EngineName, string> = { ol: 'OpenLayers', leaflet: 'Leaflet' };
/** Strings that only the code of that engine's library contains (checked in the downloaded scripts). */
const MARKER: Record<EngineName, string> = { ol: 'ol-viewport', leaflet: 'leaflet-pane' };
const VIEWPORT_CLASS: Record<EngineName, string> = { ol: '.ol-viewport', leaflet: '.leaflet-pane' };

test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

/** Search -> record -> the `kind` page (EDR / OGC Maps); EDR: query type `mode` with the first parameter selected. */
async function openRecordPage(page: Page, engine: EngineName, kind: 'EDR' | 'OGC Maps', mode = 'position') {
  await page.goto(`/?mock=1&map=${engine}`);
  await page.getByLabel('Search datasets').fill('Deterministic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
  await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
  await page.getByRole('link', { name: kind, exact: true }).click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-engine', engine);
  if (kind === 'EDR') {
    await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
    if (mode !== 'position') await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: /2t/ }).first().click();
  } else {
    await expect(page.getByTestId('page-maps')).toBeVisible();
  }
}

/** Draw a bounding box with a mouse drag around the map centre. */
async function dragBbox(page: Page, label: string) {
  await page.getByRole('button', { name: label }).click();
  const box = (await page.getByTestId('map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 150, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx + 150, cy + 80, { steps: 5 });
  await page.mouse.up();
}

const toggleTo = (page: Page, engine: EngineName) =>
  page.getByRole('group', { name: 'Map engine' }).getByRole('button', { name: LABEL[engine] }).click();

/** Scripts the page has downloaded so far (URL + text). */
function collectScripts(page: Page) {
  const scripts: { url: string; text: Promise<string> }[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() === 'script') scripts.push({ url: res.url(), text: res.text().catch(() => '') });
  });
  return async () => Promise.all(scripts.map(async (s) => ({ url: s.url, text: await s.text })));
}

test.describe('default build: OpenLayers only', { tag: QUICK }, () => {
  test.skip(LEAFLET_BUILD, 'the build under test has Leaflet enabled');

  test('?map=leaflet, a stored choice and the toggle are gone; no Leaflet code is requested', async ({ page }) => {
    const scripts = collectScripts(page);
    const requested: string[] = [];
    page.on('request', (req) => requested.push(req.url()));
    await page.addInitScript(() => sessionStorage.setItem('metdx.mapEngine', 'leaflet'));
    await page.goto('/?mock=1&map=leaflet');
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', 'ol');
    await expect(page.getByTestId('map').locator('.ol-viewport').first()).toBeAttached();
    await expect(page.getByRole('group', { name: 'Map engine' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leaflet' })).toHaveCount(0);

    const loaded = await scripts();
    expect(loaded.some((s) => s.text.includes('ol-viewport'))).toBe(true);
    expect(loaded.filter((s) => /leaflet-pane|geoman/.test(s.text)).map((s) => s.url), 'Leaflet must not be requested').toEqual([]);
    expect(requested.filter((u) => /leaflet|geoman/i.test(new URL(u).pathname))).toEqual([]);
  });

  test('the app bar has a "Code on GitHub" link', async ({ page }) => {
    await page.goto('/?mock=1');
    const link = page.getByRole('link', { name: 'Code on GitHub' });
    await expect(link).toHaveAttribute('href', 'https://github.com/wmo-im/metdx-demo');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });
});

test.describe('engine selection', () => {
  test.skip(!LEAFLET_BUILD, 'needs a Leaflet-enabled build (npm run e2e:leaflet)');

  test('?map= loads only the chosen engine; the other one only arrives with the toggle', async ({ page, engine }) => {
    const other = OTHER[engine];
    const scripts = collectScripts(page);
    await page.goto(`/?mock=1&map=${engine}`);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', engine);
    await expect(page.getByTestId('map').locator(VIEWPORT_CLASS[engine]).first()).toBeAttached();

    let loaded = await scripts();
    expect(loaded.some((s) => s.text.includes(MARKER[engine])), `${engine} library downloaded`).toBe(true);
    expect(loaded.filter((s) => s.text.includes(MARKER[other])).map((s) => s.url), `${other} library must not be requested`).toEqual([]);
    const urls = loaded.map((s) => s.url);
    if (engine === 'leaflet') expect(urls.filter((u) => /vendor-ol|mapController/.test(u))).toEqual([]);

    // the app-bar toggle fetches the other engine, and remembers the choice for a reload
    await toggleTo(page, other);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', other);
    await expect(page.getByTestId('map').locator(VIEWPORT_CLASS[other]).first()).toBeAttached();
    loaded = await scripts();
    expect(loaded.some((s) => s.text.includes(MARKER[other])), `${other} library downloaded after the switch`).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('metdx.mapEngine'))).toBe(other);
  });

  test('without ?map= the stored app-bar choice applies, ?map= wins over it', async ({ page, engine }) => {
    const other = OTHER[engine];
    await page.goto('/?mock=1');
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', engine); // set by the project
    await toggleTo(page, other);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', other);
    await page.reload();
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', other);
    await page.goto(`/?mock=1&map=${engine}`);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', engine);
  });

  test('switching the engine in the middle of a draw cancels it; drawing works again on the new engine', async ({ page, engine }) => {
    const other = OTHER[engine];
    await openRecordPage(page, engine, 'OGC Maps');
    await page.getByRole('button', { name: 'Draw BBOX' }).click();
    await expect(page.getByRole('button', { name: 'Drawing...' })).toBeVisible();

    await toggleTo(page, other);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', other);
    await expect(page.getByTestId('maps-status')).toContainText('Drawing cancelled');
    await expect(page.getByRole('button', { name: 'Draw BBOX' })).toBeVisible();

    await dragBbox(page, 'Draw BBOX');
    await expect(page.getByTestId('maps-status')).toContainText('Bounding box set');
    await expect(page.getByLabel('Request URL')).toHaveValue(/bbox=/);
  });

  test('switching the engine clears the drawn data; a new fetch draws on the new engine', async ({ page, engine }) => {
    const other = OTHER[engine];
    await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());
    await openRecordPage(page, engine, 'EDR', 'area');
    await dragBbox(page, 'Draw area');
    await expect(page.getByTestId('edr-geometry')).toContainText(/\d/);
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('map')).toHaveAttribute('data-data', /^(drawn|loaded)$/);

    await toggleTo(page, other);
    await expect(page.getByTestId('map')).toHaveAttribute('data-engine', other);
    await expect(page.getByTestId('edr-result')).toHaveCount(0); // the result is dropped, not replayed on the new engine
    await page.waitForTimeout(500); // a (wrong) replay would draw within this time
    await expect(page.getByTestId('map')).not.toHaveAttribute('data-data', /.*/);

    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('map')).toHaveAttribute('data-data', /^(drawn|loaded)$/);
  });
});

/* ------------------------------------------------------------ side-by-side screenshots */

type Scenario = { name: string; run: (page: Page, engine: EngineName) => Promise<void> };

const areaContours: Scenario['run'] = async (page, engine) => {
  await openRecordPage(page, engine, 'EDR', 'area');
  await dragBbox(page, 'Draw area');
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
  await expect(page.getByTestId('map')).toHaveAttribute('data-style', 'contours');
  await expect(page.getByTestId('map')).toHaveAttribute('data-data', /^(drawn|loaded)$/);
};

const SCENARIOS: Scenario[] = [
  { name: 'area-contours', run: areaContours },
  {
    name: 'area-points',
    run: async (page, engine) => {
      await areaContours(page, engine);
      await page.getByTestId('edr-style-toggle').getByRole('button', { name: 'Points', exact: true }).click();
      await expect(page.getByTestId('map')).toHaveAttribute('data-style', 'points');
    },
  },
  {
    name: 'trajectory',
    run: async (page, engine) => {
      await openRecordPage(page, engine, 'EDR', 'trajectory');
      await page.getByRole('button', { name: 'Draw trajectory' }).click();
      const box = (await page.getByTestId('map').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.click(cx - 150, cy + 60);
      await page.mouse.click(cx + 100, cy - 60);
      await page.mouse.dblclick(cx + 150, cy);
      await expect(page.getByTestId('edr-geometry')).toContainText(/\d/);
      await page.getByRole('button', { name: 'Fetch' }).click();
      await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
      await expect(page.getByTestId('map')).toHaveAttribute('data-data', /^(drawn|loaded)$/);
    },
  },
  {
    name: 'maps-overlay',
    run: async (page, engine) => {
      await openRecordPage(page, engine, 'OGC Maps');
      await dragBbox(page, 'Draw BBOX');
      await expect(page.getByTestId('maps-status')).toContainText('Bounding box set');
      await page.getByRole('button', { name: 'Fetch' }).click();
      await expect(page.getByTestId('map')).toHaveAttribute('data-overlay', 'loaded');
    },
  },
];

test.describe('engines side by side', () => {
  test.skip(!LEAFLET_BUILD, 'needs a Leaflet-enabled build (npm run e2e:leaflet)');
  test.skip(({ engine }) => engine !== 'ol', 'one run covers both engines');

  for (const scenario of SCENARIOS) {
    test(`screenshot: ${scenario.name}`, async ({ browser }) => {
      test.setTimeout(150_000);
      const shots: Partial<Record<EngineName, Buffer>> = {};
      await Promise.all(
        (['ol', 'leaflet'] as const).map(async (engine) => {
          const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          try {
            const page = await ctx.newPage();
            await stubBasemap(page);
            await scenario.run(page, engine);
            await settleMap(page);
            shots[engine] = await page.screenshot();
          } finally {
            await ctx.close();
          }
        }),
      );
      const ctx = await browser.newContext({ viewport: { width: 2000, height: 700 } });
      try {
        const page = await ctx.newPage();
        const img = (e: EngineName) =>
          `<figure><figcaption>${LABEL[e]}</figcaption><img src="data:image/png;base64,${shots[e]!.toString('base64')}"></figure>`;
        await page.setContent(
          `<style>body{margin:0;display:flex;gap:8px;background:#222;font:600 16px sans-serif;color:#fff}figure{margin:0;width:996px}` +
            `figcaption{padding:4px 8px}img{width:996px;display:block}</style>${img('ol')}${img('leaflet')}`,
        );
        await page.screenshot({ path: `${SCREENS}/engine-${scenario.name}.png`, fullPage: true });
      } finally {
        await ctx.close();
      }
    });
  }
});
