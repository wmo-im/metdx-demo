// EDR results on the map (mock project): the live ECMWF samples served by mockFetch (`?mock=1`) for position, area
// and trajectory; param/time switching, clearing and a 40k-point performance run on routed synthetic CoverageJSON.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screens');
const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const RECORD_TITLE = 'ECMWF IFS Global Deterministic Forecast (Destination Earth)';
const EDR_BASE = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu';
const COLLECTION = `${EDR_BASE}/collections/operational-data`;

const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, any>;

test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

/* ------------------------------------------------------------------ helpers */

/** The map without a basemap: its canvases stay untainted (pixels can be read) and the run is offline-proof. */
async function blockTiles(page: Page) {
  await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());
}

async function openEdrMock(page: Page, mode: string) {
  await page.goto('/?mock=1');
  await page.getByLabel('Search datasets').fill('Deterministic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
  await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
  await page.getByRole('link', { name: 'EDR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
  await chooseMode(page, mode);
  await page.getByRole('button', { name: /2t/ }).first().click();
}

async function chooseMode(page: Page, mode: string) {
  if (mode !== 'position') await page.getByRole('button', { name: mode, exact: true }).click();
}

async function mapBox(page: Page) {
  const box = await page.getByTestId('map').boundingBox();
  if (!box) throw new Error('map not visible');
  return box;
}

/** Draw the geometry of `mode` (point: click; bbox: drag; line: click, click, double-click) around the map centre. */
async function drawGeometry(page: Page, mode: string) {
  await page.getByRole('button', { name: `Draw ${mode}` }).click();
  const box = await mapBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (mode === 'position') {
    await page.mouse.click(cx, cy);
  } else if (mode === 'area' || mode === 'cube') {
    await page.mouse.move(cx - 150, cy - 80);
    await page.mouse.down();
    await page.mouse.move(cx, cy, { steps: 5 });
    await page.mouse.move(cx + 150, cy + 80, { steps: 5 });
    await page.mouse.up();
  } else {
    await page.mouse.click(cx - 150, cy + 60);
    await page.mouse.click(cx + 100, cy - 60);
    await page.mouse.dblclick(cx + 150, cy);
  }
  await expect(page.getByTestId('edr-geometry')).toContainText(/\d/);
  await expect(page.getByLabel('Request URL')).toHaveValue(new RegExp(`/${mode}\\?`));
}

const dataState = (page: Page) => page.getByTestId('map').getAttribute('data-data');

async function expectDrawn(page: Page) {
  await expect(page.getByTestId('map')).toHaveAttribute('data-data', /^(drawn|loaded)$/);
}

/** Click the Contours / Points toggle of the result panel and wait for the map to report that style. */
async function chooseStyle(page: Page, style: 'Contours' | 'Points') {
  await page.getByTestId('edr-style-toggle').getByRole('button', { name: style, exact: true }).click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-style', style.toLowerCase());
  await page.waitForTimeout(300); // let OpenLayers render the change
}

/** Counts of map pixels near the viridis colour stops (the data colours); needs {@link blockTiles}. */
const VIRIDIS_STOPS: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];
async function dataPixels(page: Page) {
  return page.evaluate((stops) => {
    const hits = stops.map(() => 0);
    let sig = 0;
    for (const c of Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="map"] canvas'))) {
      if (!c.width || !c.height) continue;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let p = 0; p < d.length; p += 4) {
        if (d[p + 3] < 200) continue;
        for (let s = 0; s < stops.length; s++) {
          const dr = d[p] - stops[s][0];
          const dg = d[p + 1] - stops[s][1];
          const db = d[p + 2] - stops[s][2];
          if (dr * dr + dg * dg + db * db < 30 * 30) {
            hits[s]++;
            sig = (sig * 31 + p * (s + 1)) % 2147483647; // changes whenever the coloured pixels move or change class
            break;
          }
        }
      }
    }
    return { hits, sig, total: hits.reduce((a, b) => a + b, 0) };
  }, VIRIDIS_STOPS);
}

/**
 * Arms a stopwatch for the next user action: it starts at the `startEvent` (the Fetch click, or the keydown /
 * option click of a picker) and stops when the map reports `drawn`/`loaded`/`error` plus two animation frames
 * (the render OpenLayers schedules for the change has then run). Read it with {@link paintMs}.
 */
async function armPaintTimer(page: Page, startEvent: 'click' | 'keydown') {
  await page.evaluate((ev) => {
    const el = document.querySelector('[data-testid="map"]')!;
    const w = window as unknown as Record<string, unknown>;
    w.__paint = new Promise<number>((resolve) => {
      let t0 = Number.NaN;
      document.addEventListener(ev, (e) => (t0 = e.timeStamp), { capture: true, once: true });
      const obs = new MutationObserver(() => {
        const s = el.getAttribute('data-data');
        if (Number.isNaN(t0) || !(s === 'drawn' || s === 'loaded' || s === 'error')) return;
        obs.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
      });
      obs.observe(el, { attributes: true, attributeFilter: ['data-data'] });
    });
  }, startEvent);
}
const paintMs = (page: Page) => page.evaluate(() => (window as unknown as { __paint: Promise<number> }).__paint);

/** Main-thread watchdog: the largest gap between 10 ms timer ticks and the longest long task while it ran. */
async function startProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    const st = { maxGap: 0, longTask: 0, last: performance.now(), stop: false };
    w.__probe = st;
    const tick = () => {
      const now = performance.now();
      st.maxGap = Math.max(st.maxGap, now - st.last);
      st.last = now;
      if (!st.stop) setTimeout(tick, 10);
    };
    setTimeout(tick, 10);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) st.longTask = Math.max(st.longTask, e.duration);
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* long tasks not supported: the timer gap alone is used */
    }
  });
}
async function stopProbe(page: Page) {
  return page.evaluate(() => {
    const st = (window as unknown as Record<string, any>).__probe as { maxGap: number; longTask: number; stop: boolean };
    st.stop = true;
    return { maxGap: st.maxGap, longTask: st.longTask };
  });
}

/** Viewport position of a data-coloured pixel nearest the map centre (readable canvases only, see {@link blockTiles}). */
async function findDataPixel(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate((stops) => {
    const map = document.querySelector('[data-testid="map"]')!.getBoundingClientRect();
    const cx = map.x + map.width / 2;
    const cy = map.y + map.height / 2;
    let best: { x: number; y: number; d: number } | null = null;
    for (const c of Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="map"] canvas'))) {
      if (!c.width || !c.height) continue;
      const r = c.getBoundingClientRect();
      const k = r.width / c.width;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let py = 0; py < c.height; py += 2) {
        for (let px = 0; px < c.width; px += 2) {
          const p = (py * c.width + px) * 4;
          if (d[p + 3] < 200) continue; // contour fills are drawn at 90 % opacity
          const hit = stops.some((s) => (d[p] - s[0]) ** 2 + (d[p + 1] - s[1]) ** 2 + (d[p + 2] - s[2]) ** 2 < 30 * 30);
          if (!hit) continue;
          const x = r.x + px * k;
          const y = r.y + py * k;
          const dist = Math.hypot(x - cx, y - cy);
          if (!best || dist < best.d) best = { x, y, d: dist };
        }
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }, VIRIDIS_STOPS);
}

/**
 * Click a drawn point and wait for the readout. OpenLayers reports `singleclick` 250 ms after the click (to tell it
 * from a double-click), so clicks must be spaced further apart than that. With a tainted canvas (basemap loaded)
 * the point cannot be located: scan around the map centre instead.
 */
async function clickDataPoint(page: Page) {
  const sel = page.getByTestId('edr-selected');
  const found = await findDataPixel(page).catch(() => null);
  if (found) {
    await page.mouse.click(found.x, found.y);
    try {
      await expect(sel).toBeVisible({ timeout: 3000 });
      return;
    } catch {
      console.log(`clickDataPoint: no readout after click at ${JSON.stringify(found)}, state ${await dataState(page)}`);
    }
    await page.mouse.click(found.x, found.y);
    await expect(sel).toBeVisible();
    return;
  }
  const box = await mapBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let r = 0; r <= 24; r += 4) {
    for (const [dx, dy] of r === 0 ? [[0, 0]] : [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      await page.mouse.click(cx + dx, cy + dy);
      await page.waitForTimeout(350);
      if (await sel.isVisible()) return;
    }
  }
  await expect(sel).toBeVisible();
}

/* ------------------------------------------------------ live samples via mockFetch */

test.describe('mock fixtures', () => {
  test('position: chart in the sidebar, point drawn, click reads the value, time picker redraws', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'position');
    await drawGeometry(page, 'position');
    await page.getByRole('button', { name: 'Fetch' }).click();

    const panel = page.getByTestId('edr-result');
    await expect(panel.locator('svg').first()).toBeVisible();
    await expect(panel.getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The data dot is drawn above the query marker, so its viridis colour is visible.
    await expect.poll(async () => (await dataPixels(page)).total).toBeGreaterThan(0);
    const before = await dataPixels(page);

    await clickDataPoint(page);
    const first = (await page.getByTestId('edr-selected').textContent()) ?? '';
    expect(first).toMatch(/= -?\d/);

    // 4 time steps: the slider moves the shown value
    await expect(page.getByTestId('edr-time-label')).toContainText('2026-10-19T00:00:00Z');
    await page.getByRole('slider', { name: 'Time' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('edr-time-label')).toContainText('2026-10-19T06:00:00Z');
    await expectDrawn(page);
    await expect(page.getByTestId('edr-selected')).not.toHaveText(first);
    // the visible result colour changes with the time step
    await expect.poll(async () => (await dataPixels(page)).sig).not.toBe(before.sig);
    expect((await dataPixels(page)).total).toBeGreaterThan(0);

    await panel.getByRole('button', { name: 'View JSON' }).click();
    await expect(page.getByRole('dialog').getByTestId('result-json')).toContainText('"type": "Coverage');
  });

  test('area: all 2408 points drawn and coloured, legend, click reads a value, JSON dialog', async ({ page }) => {
    const expected = fixture('edr/live-area.json').coverages[0].domain.axes.composite.values.length;
    expect(expected).toBe(2408);
    await blockTiles(page);
    await openEdrMock(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();

    const panel = page.getByTestId('edr-result');
    await expect(panel.getByTestId('legend')).toBeVisible();
    await expect(panel.getByTestId('legend-unit')).not.toHaveText('');
    const min = Number(await panel.getByTestId('legend-min').textContent());
    const max = Number(await panel.getByTestId('legend-max').textContent());
    expect(min).toBeLessThan(max);
    await expectDrawn(page);
    await expect(page.getByTestId('map')).toHaveAttribute('data-style', 'contours'); // area defaults to contours
    await chooseStyle(page, 'Points');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SCREENS}/edr-map-area-notiles.png` });
    const px = await dataPixels(page);
    // 2408 discs of radius 3.5 px with a white outline (~20 coloured pixels each), in several parts of the colour ramp
    expect(px.total).toBeGreaterThan(2408 * 2);
    expect(px.hits.filter((h) => h > 20).length).toBeGreaterThanOrEqual(3);
    await expect(panel.getByText('Click the map to read a value.')).toBeVisible();

    await clickDataPoint(page);
    const sel = await page.getByTestId('edr-selected').textContent();
    expect(sel).toMatch(/°N .*°E: .*= \d/);
    const value = Number(/= ([\d.]+)/.exec(sel ?? '')![1]);
    expect(value).toBeGreaterThanOrEqual(min - 0.01);
    expect(value).toBeLessThanOrEqual(max + 0.01);

    await panel.getByRole('button', { name: 'View JSON' }).click();
    await expect(page.getByRole('dialog').getByTestId('result-json')).toContainText('"type": "Coverage');
  });

  test('area: filled contours by default (stepped legend), click reads the nearest point, toggle to points and back', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();

    const panel = page.getByTestId('edr-result');
    await expectDrawn(page);
    const map = page.getByTestId('map');
    await expect(map).toHaveAttribute('data-style', 'contours');
    const toggle = panel.getByTestId('edr-style-toggle');
    await expect(toggle.getByRole('button', { name: 'Contours', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await panel.getByTestId('legend-step').count()).toBeGreaterThanOrEqual(6);
    const min = Number(await panel.getByTestId('legend-min').textContent());
    const max = Number(await panel.getByTestId('legend-max').textContent());
    expect(min).toBeLessThan(max);
    await page.waitForTimeout(500);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SCREENS}/edr-map-area-contours.png` });

    // filled areas in several bands of the colour ramp, far more coloured pixels than 2408 discs could cover
    const filled = await dataPixels(page);
    expect(filled.total).toBeGreaterThan(40_000);
    expect(filled.hits.filter((h) => h > 500).length).toBeGreaterThanOrEqual(3);

    // a click reads the nearest real point's value, within the legend range
    await clickDataPoint(page);
    const sel = await page.getByTestId('edr-selected').textContent();
    expect(sel).toMatch(/°N .*°E: .*= \d/);
    const value = Number(/= ([\d.]+)/.exec(sel ?? '')![1]);
    expect(value).toBeGreaterThanOrEqual(min - 0.01);
    expect(value).toBeLessThanOrEqual(max + 0.01);

    // points: discs again, plain gradient legend
    await chooseStyle(page, 'Points');
    await expect(panel.getByTestId('legend-step')).toHaveCount(0);
    await expect(panel.getByTestId('legend-bar')).toBeVisible();
    const points = await dataPixels(page);
    expect(points.total).toBeGreaterThan(2408 * 2);
    expect(points.total).toBeLessThan(filled.total / 2);

    // and back to contours, the same picture as before
    await chooseStyle(page, 'Contours');
    expect(await panel.getByTestId('legend-step').count()).toBeGreaterThanOrEqual(6);
    expect((await dataPixels(page)).total).toBeGreaterThan(40_000);

    await panel.getByRole('button', { name: 'View JSON' }).click();
    await expect(page.getByRole('dialog').getByTestId('result-json')).toContainText('"type": "Coverage');
  });

  test('area with the basemap: screenshot', async ({ page }) => {
    await openEdrMock(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
    await clickDataPoint(page);
    await page.mouse.move(0, 0);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENS}/edr-map-area.png` });
  });

  test('trajectory: 15 vertices drawn with the line, click on a vertex reads its value', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'trajectory');
    await drawGeometry(page, 'trajectory');
    await page.getByRole('button', { name: 'Fetch' }).click();

    const panel = page.getByTestId('edr-result');
    await expect(panel.getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
    await page.waitForTimeout(400);
    const px = await dataPixels(page);
    expect(px.total).toBeGreaterThan(15 * 20);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SCREENS}/edr-map-trajectory-notiles.png` });

    await clickDataPoint(page);
    const sel = page.getByTestId('edr-selected');
    await expect(sel).toContainText(/= \d/);
  });

  test('trajectory with the basemap: screenshot', async ({ page }) => {
    test.setTimeout(90_000); // live OSM tiles
    await openEdrMock(page, 'trajectory');
    await drawGeometry(page, 'trajectory');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
    await page.mouse.move(0, 0);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENS}/edr-map-trajectory.png` });
  });

  test('position with the basemap: screenshot of point, legend and chart', async ({ page }) => {
    test.setTimeout(90_000); // live OSM tiles
    await openEdrMock(page, 'position');
    await drawGeometry(page, 'position');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('edr-result').locator('svg').first()).toBeVisible();
    await expectDrawn(page);
    await page.mouse.move(0, 0);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENS}/edr-map-position.png` });
  });

  test('cleared when the query type changes, on a new fetch and when leaving the page', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expectDrawn(page);
    await expect(page.getByTestId('legend')).toBeVisible();

    // another query type: result panel and drawing go away
    await page.getByRole('button', { name: 'trajectory', exact: true }).click();
    await expect(page.getByTestId('edr-result')).toHaveCount(0);
    await expect(page.getByTestId('legend')).toHaveCount(0);
    await expect(page.getByTestId('map')).not.toHaveAttribute('data-data', /.*/);
    await page.waitForTimeout(300);
    expect((await dataPixels(page)).total).toBe(0);

    // a new fetch replaces the old drawing: the map is cleared while it is running and shows the new data afterwards
    await page.getByRole('button', { name: 'area', exact: true }).click(); // the parameter selection is kept
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expectDrawn(page);
    const before = await page.getByTestId('edr-result').count();
    expect(before).toBe(1);
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('edr-status')).toContainText('Response received');
    await expectDrawn(page);
    await expect(page.getByTestId('edr-result')).toHaveCount(1);

    // leaving the page
    await page.getByRole('link', { name: 'Record', exact: true }).click();
    await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();
    await expect(page.getByTestId('map')).not.toHaveAttribute('data-data', /.*/);
    await page.waitForTimeout(300);
    expect((await dataPixels(page)).total).toBe(0);
  });
});

/* ------------------------------------ synthetic CoverageJSON through the proxy route */

interface SynthParam {
  key: string;
  unit: string;
  base: number;
  amp: number;
}

/** An ECMWF-style MultiPoint response with `n` points on a square lattice (10° wide), `nTimes` steps and the given parameters. */
function syntheticMultiPoint(n: number, nTimes: number, params: SynthParam[]) {
  const cols = Math.ceil(Math.sqrt(n));
  const step = 10 / cols;
  const lat = (i: number) => 40 + Math.floor(i / cols) * step;
  const lon = (i: number) => -5 + (i % cols) * step;
  const composite: number[][] = new Array(n);
  for (let i = 0; i < n; i++) composite[i] = [Number(lat(i).toFixed(5)), Number(lon(i).toFixed(5)), 0];
  const times = Array.from({ length: nTimes }, (_, t) => new Date(Date.UTC(2026, 9, 29, 6 * t)).toISOString().replace('.000Z', 'Z'));
  const ranges: Record<string, unknown> = {};
  const parameters: Record<string, unknown> = {};
  params.forEach((p, k) => {
    const values: number[] = new Array(nTimes * n);
    for (let t = 0; t < nTimes; t++) {
      for (let i = 0; i < n; i++) {
        values[t * n + i] = Number((p.base + p.amp * Math.sin(lon(i) * 0.6 + t * 0.9 + k) * Math.cos(lat(i) * 0.5) + t * 0.5).toFixed(3));
      }
    }
    ranges[p.key] = { type: 'NdArray', dataType: 'float', shape: [nTimes, n], axisNames: ['t', 'composite'], values };
    parameters[p.key] = {
      type: 'Parameter',
      description: { en: `Synthetic ${p.key}` },
      unit: { symbol: p.unit },
      observedProperty: { id: p.key, label: { en: `Synthetic ${p.key}` } },
    };
  });
  return {
    type: 'CoverageCollection',
    domainType: 'MultiPoint',
    coverages: [
      {
        type: 'Coverage',
        domain: {
          type: 'Domain',
          axes: { t: { values: times }, composite: { dataType: 'tuple', coordinates: ['latitude', 'longitude', 'levelist'], values: composite } },
        },
        ranges,
      },
    ],
    parameters,
  };
}

/** Serve the proxy: the bundled collection fixtures, and `edr` (called with the upstream URL) for data queries. */
async function routeProxy(page: Page, edr: (url: URL) => unknown | Promise<unknown>) {
  await page.route('**/api/proxy**', async (route) => {
    const upstream = new URL(new URL(route.request().url()).searchParams.get('url') ?? '');
    const path = upstream.pathname.replace(/\/+$/, '');
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (/\/collections\/operational-data$/.test(path)) return json(readFileSync(join(FIXTURES, 'collections/operational-data.json'), 'utf8'));
    if (/\/collections\/operational-data\/instances$/.test(path)) return json(readFileSync(join(FIXTURES, 'instances/operational-data.json'), 'utf8'));
    if (/\/collections\/operational-data\/instances\/[^/]+$/.test(path)) return json(readFileSync(join(FIXTURES, 'instances/operational-data.instance.json'), 'utf8'));
    if (/\/collections\/operational-data\/(position|area|trajectory|radius|cube|corridor)$/.test(path)) return json(await edr(upstream));
    return json({ code: 'NotFound', description: upstream.href }, 404);
  });
}

async function openEdrRouted(page: Page, mode: string) {
  await page.goto(`/record/${encodeURIComponent('urn:test:synthetic')}/edr?col=${encodeURIComponent(COLLECTION)}`);
  await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
  await chooseMode(page, mode);
  await page.getByRole('button', { name: /2t/ }).first().click();
}

const PARAMS: SynthParam[] = [
  { key: '2t', unit: 'K', base: 285, amp: 15 },
  { key: '10u', unit: 'm s-1', base: 0, amp: 12 },
];

async function pickParam(page: Page, key: string) {
  await page.getByRole('combobox', { name: /Show parameter/ }).click();
  const option = page.getByRole('option', { name: new RegExp(`^${key}`) });
  await armPaintTimer(page, 'click');
  await option.click();
  // the menu's backdrop would swallow a map click that comes before its close transition ends
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

test.describe('area polygon and opacity (mock fixtures)', () => {
  test('area as a free polygon: clicks + double-click give a closed, non-rectangular POLYGON in the request URL', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'area');
    await page.getByTestId('edr-area-shape').getByRole('button', { name: 'polygon', exact: true }).click();
    await page.getByRole('button', { name: 'Draw area' }).click();
    const box = await mapBox(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx - 150, cy + 80);
    await page.mouse.click(cx - 60, cy - 90);
    await page.mouse.click(cx + 120, cy - 40);
    await page.mouse.dblclick(cx + 30, cy + 100);
    await expect(page.getByTestId('edr-geometry')).toContainText('Polygon with 4 vertices');

    await expect(page.getByLabel('Request URL')).toHaveValue(/\/area\?coords=POLYGON/);
    const url = await page.getByLabel('Request URL').inputValue();
    const m = /\/area\?coords=POLYGON\(\(([^)]+)\)\)/.exec(url);
    expect(m, url).not.toBeNull();
    const ring = m![1].split(',').map((p) => p.split(' ').map(Number));
    expect(ring).toHaveLength(5); // 4 vertices + the closing one
    expect(ring[4]).toEqual(ring[0]);
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
    // not a rectangle: some vertex is not a corner of the bounding box of the ring
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const onCorner = (p: number[]) => (p[0] === Math.min(...lons) || p[0] === Math.max(...lons)) && (p[1] === Math.min(...lats) || p[1] === Math.max(...lats));
    expect(ring.slice(0, 4).some((p) => !onCorner(p))).toBe(true);
    expect(url).toMatch(/&f=json$/);

    // the query still runs and draws
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
  });

  test('the opacity slider changes the opacity of the data layer without redrawing it', async ({ page }) => {
    await blockTiles(page);
    await openEdrMock(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expectDrawn(page);
    const map = page.getByTestId('map');
    await expect(map).toHaveAttribute('data-style', 'contours');
    await expect(map).toHaveAttribute('data-opacity', '0.9');

    await page.getByRole('slider', { name: 'Opacity' }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(map).toHaveAttribute('data-opacity', '0.75');
    await expect(page.getByTestId('edr-opacity-label')).toContainText('75%');

    // kept when the style changes within the result
    await chooseStyle(page, 'Points');
    await expect(map).toHaveAttribute('data-opacity', '0.75');
  });
});

test.describe('param and time switching (synthetic, 1500 points x 4 times x 2 parameters)', () => {
  test('pickers redraw: legend, colours and the clicked value change', async ({ page }) => {
    await blockTiles(page);
    await routeProxy(page, () => syntheticMultiPoint(1500, 4, PARAMS));
    await openEdrRouted(page, 'area');
    await drawGeometry(page, 'area');
    await page.getByRole('button', { name: 'Fetch' }).click();
    const panel = page.getByTestId('edr-result');
    await expect(panel.getByTestId('legend')).toBeVisible();
    await expectDrawn(page);
    await expect(panel.getByTestId('legend-label')).toContainText('2t');
    await expect(panel.getByTestId('legend-unit')).toHaveText('K');
    const minK = await panel.getByTestId('legend-min').textContent();
    await page.waitForTimeout(400);
    const px0 = await dataPixels(page);
    expect(px0.total).toBeGreaterThan(1500 * 5);
    await clickDataPoint(page);
    const val0 = await page.getByTestId('edr-selected').textContent();

    // time: same legend range (per parameter), different colours and value
    await expect(page.getByTestId('edr-time-label')).toContainText('2026-10-29T00:00:00Z');
    await page.getByRole('slider', { name: 'Time' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('edr-time-label')).toContainText('2026-10-29T06:00:00Z');
    await expect(page.getByTestId('edr-selected')).not.toHaveText(val0 ?? '');
    await page.waitForTimeout(400);
    const px1 = await dataPixels(page);
    expect(px1.total).toBeGreaterThan(1500 * 5);
    expect(px1.sig).not.toBe(px0.sig);
    await expect(panel.getByTestId('legend-min')).toHaveText(minK ?? '');
    await page.screenshot({ path: `${SCREENS}/edr-map-synthetic-time.png` });

    // parameter: legend label, unit and range change; the readout keeps its position
    await pickParam(page, '10u');
    await expect(panel.getByTestId('legend-label')).toContainText('10u');
    await expect(panel.getByTestId('legend-unit')).toHaveText('m s-1');
    await expect(panel.getByTestId('legend-min')).not.toHaveText(minK ?? '');
    await expect(page.getByTestId('edr-selected')).toContainText('10u');
    await page.waitForTimeout(400);
    const px2 = await dataPixels(page);
    expect(px2.sig).not.toBe(px1.sig);
    await page.screenshot({ path: `${SCREENS}/edr-map-synthetic-param.png` });

    // the clicked point's series over the 4 time steps is charted
    await expect(panel.locator('svg').first()).toBeVisible();
  });
});

/* -------------------------------------------------------------- 40k performance */

test.describe('performance with 40000 points', () => {
  test('draw < 3 s, param/time switches < 1 s each, main thread stays responsive', async ({ page }) => {
    test.setTimeout(120_000);
    const N = 40_000;
    await blockTiles(page);
    await routeProxy(page, () => syntheticMultiPoint(N, 3, PARAMS));
    await openEdrRouted(page, 'area');
    await drawGeometry(page, 'area');
    await page.waitForTimeout(500);

    await startProbe(page);

    // data submission (Fetch click) -> drawn + painted
    await armPaintTimer(page, 'click');
    await page.getByRole('button', { name: 'Fetch' }).click();
    const drawMs = await paintMs(page);
    await expect(page.getByTestId('edr-result').getByTestId('legend')).toBeVisible();
    await page.waitForTimeout(300);
    const px = await dataPixels(page);
    expect(px.total, 'coloured pixels of 40k points').toBeGreaterThan(20_000);

    // time switches (keyboard on the slider), param switches (select)
    const slider = page.getByRole('slider', { name: 'Time' });
    await slider.focus();
    const switches: Record<string, number> = {};
    await armPaintTimer(page, 'keydown');
    await page.keyboard.press('ArrowRight');
    switches['time +1'] = await paintMs(page);
    await armPaintTimer(page, 'keydown');
    await page.keyboard.press('ArrowRight');
    switches['time +2'] = await paintMs(page);
    await armPaintTimer(page, 'keydown');
    await page.keyboard.press('Home');
    switches['time home'] = await paintMs(page);

    await pickParam(page, '10u');
    switches['param 10u'] = await paintMs(page);
    await expect(page.getByTestId('legend-label')).toContainText('10u');
    await pickParam(page, '2t');
    switches['param 2t'] = await paintMs(page);
    await expect(page.getByTestId('legend-label')).toContainText('2t');

    // still interactive: a click on a point answers quickly (after the select menu has fully closed and settled)
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await clickDataPoint(page);
    const clickMs = Date.now() - t0;

    const probe = await stopProbe(page);
    const report = { drawMs: Math.round(drawMs), switches: Object.fromEntries(Object.entries(switches).map(([k, v]) => [k, Math.round(v)])), clickMs, ...probe };
    console.log(`40k perf: ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) });

    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SCREENS}/edr-map-40k.png` });

    expect(drawMs, 'draw from Fetch click to painted').toBeLessThan(3000);
    for (const [name, ms] of Object.entries(switches)) expect(ms, `switch: ${name}`).toBeLessThan(1000);
    expect(clickMs, 'a click on a point is answered').toBeLessThan(1500);
    expect(probe.maxGap, 'longest main-thread block (timer gap)').toBeLessThan(1500);
  });
});
