// Map-engine parametrisation of the mock e2e specs. Projects `mock-ol` and `mock-leaflet` (playwright.config.ts) set the
// `engine` option; every test then starts on that engine: the choice is put into sessionStorage (the key the app-bar
// toggle uses) before the page's scripts run. Tests that need an explicit `?map=` use it in their own URL.
// Everything that depends on how an engine renders (pixel probes, DOM markers) lives here, behind small helpers.
import { test as base, expect, type Page } from '@playwright/test';

export type EngineName = 'ol' | 'leaflet';

export const ENGINE_STORAGE_KEY = 'metdx.mapEngine';

/** `npm run e2e:leaflet`: the app under test was built with VITE_ENABLE_LEAFLET=1 (the default build is OpenLayers only). */
export const LEAFLET_BUILD = process.env.E2E_LEAFLET === '1';

export const test = base.extend<{ engine: EngineName }>({
  engine: ['ol', { option: true }],
  page: async ({ page, engine }, use) => {
    await page.addInitScript(
      ([key, name]) => {
        try {
          // only when nothing is chosen yet: a reload after the app-bar toggle keeps the toggled engine
          if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, name);
        } catch {
          /* storage unavailable */
        }
      },
      [ENGINE_STORAGE_KEY, engine] as const,
    );
    await use(page);
  },
});

export { expect };

/** Per-engine suffix of a screenshot name (OpenLayers keeps the historical names). */
export const shotName = (name: string, engine: EngineName) => (engine === 'ol' ? name : `${name}-${engine}`);

/** The map has rendered something (OL: a canvas; Leaflet: its tile pane, the container itself). */
export async function expectMapRendered(page: Page, engine: EngineName) {
  const map = page.getByTestId('map');
  await expect(map).toHaveAttribute('data-engine', engine);
  if (engine === 'ol') await expect(map.locator('canvas')).toBeVisible();
  else await expect(map.locator('.leaflet-tile-pane')).toBeAttached();
}

/** Viridis colour stops of the data colour ramp. */
export const VIRIDIS_STOPS: [number, number, number][] = [
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

/**
 * Screenshot of the Leaflet map as the data colours are read from it: with the data panes at full opacity (the 90 %
 * contours would otherwise blend with the background and drift from the colour stops) and without the map controls
 * and attribution (their blues are close to some stops).
 */
async function pictureOfMap(page: Page): Promise<Buffer> {
  const map = page.getByTestId('map');
  const restore = await map.evaluate((el) => {
    const panes = Array.from(el.querySelectorAll<HTMLElement>('.leaflet-pane')).filter((p) => p.style.opacity !== '');
    const before = panes.map((p) => p.style.opacity);
    panes.forEach((p) => (p.style.opacity = '1'));
    return before;
  });
  try {
    return await map.screenshot({ animations: 'disabled', style: '.leaflet-control-container { visibility: hidden !important; }' });
  } finally {
    await map.evaluate((el, before) => {
      const panes = Array.from(el.querySelectorAll<HTMLElement>('.leaflet-pane')).filter((p) => p.style.opacity !== '');
      panes.forEach((p, i) => (p.style.opacity = before[i] ?? ''));
    }, restore);
  }
}

interface Scan {
  hits: number[];
  sig: number;
  total: number;
}

/**
 * Pixels near the viridis stops. OpenLayers draws everything on canvases that can be read directly. Leaflet draws
 * contours as SVG, so for it the rendered picture is read instead: a screenshot of the map element, decoded in the page.
 * Both need the basemap blocked (no tiles: untainted canvases, plain background).
 */
export async function dataPixels(page: Page, engine: EngineName): Promise<Scan> {
  if (engine === 'ol') {
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
  const shot = (await pictureOfMap(page)).toString('base64');
  return page.evaluate(
    async ([b64, stops]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const hits = stops.map(() => 0);
      let sig = 0;
      for (let p = 0; p < d.length; p += 4) {
        for (let s = 0; s < stops.length; s++) {
          const dr = d[p] - stops[s][0];
          const dg = d[p + 1] - stops[s][1];
          const db = d[p + 2] - stops[s][2];
          if (dr * dr + dg * dg + db * db < 30 * 30) {
            hits[s]++;
            sig = (sig * 31 + p * (s + 1)) % 2147483647;
            break;
          }
        }
      }
      return { hits, sig, total: hits.reduce((a, b) => a + b, 0) };
    },
    [shot, VIRIDIS_STOPS] as const,
  );
}

/** Viewport position of a data-coloured pixel nearest the map centre (null: none found / canvas tainted). */
export async function findDataPixel(page: Page, engine: EngineName): Promise<{ x: number; y: number } | null> {
  if (engine === 'ol') {
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
  const box = await page.getByTestId('map').boundingBox();
  if (!box) return null;
  const shot = (await pictureOfMap(page)).toString('base64');
  return page.evaluate(
    async ([b64, stops, bx, by, bw, bh]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const k = bw / cv.width;
      const cx = bw / 2;
      const cy = bh / 2;
      let best: { x: number; y: number; d: number } | null = null;
      for (let py = 0; py < cv.height; py += 2) {
        for (let px = 0; px < cv.width; px += 2) {
          const p = (py * cv.width + px) * 4;
          const hit = stops.some((s) => (d[p] - s[0]) ** 2 + (d[p + 1] - s[1]) ** 2 + (d[p + 2] - s[2]) ** 2 < 30 * 30);
          if (!hit) continue;
          const dist = Math.hypot(px * k - cx, py * k - cy);
          if (!best || dist < best.d) best = { x: bx + px * k, y: by + py * k, d: dist };
        }
      }
      return best ? { x: best.x, y: best.y } : null;
    },
    [shot, VIRIDIS_STOPS, box.x, box.y, box.width, box.height] as const,
  );
}
