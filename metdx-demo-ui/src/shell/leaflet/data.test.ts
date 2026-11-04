import { vi } from 'vitest';

// jsdom has no SVGSVGElement.createSVGRect, so Leaflet would pick its canvas renderer; define it before Leaflet loads.
vi.hoisted(() => {
  const proto = SVGSVGElement.prototype as unknown as { createSVGRect?: () => object };
  proto.createSVGRect ??= () => ({});
});

vi.mock('../../lib/contour', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/contour')>();
  return { ...orig, computeContours: vi.fn(orig.computeContours) };
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LatLng } from 'leaflet';
import { computeContours } from '../../lib/contour';
import { VIRIDIS, type ColourScale, type DataLayer, type GridSpec, type ParamInfo } from '../../lib/covjsonTypes';
import { LeafletController } from './controller';

const PARAMS: ParamInfo[] = [
  { key: 'a', label: 'A', unit: 'K', min: 0, max: 1 },
  { key: 'b', label: 'B', unit: 'K', min: 0, max: 1 },
];
const GREY: ColourScale = { name: 'grey', fn: (t) => [Math.round(t * 255), Math.round(t * 255), Math.round(t * 255), 255] };

function layer(kind: DataLayer['kind'], coords: Float64Array | GridSpec, size: number, nTimes = 2): DataLayer {
  return {
    kind,
    parameters: PARAMS,
    times: Array.from({ length: nTimes }, (_, i) => `2026-01-0${i + 1}T00:00:00Z`),
    coords,
    values: (param, t) =>
      Float32Array.from({ length: size }, (_, i) => {
        const v = i / Math.max(1, size - 1);
        return param === 'b' ? 1 - v : t === 1 ? Math.min(1, v + 0.5) : v;
      }),
  };
}
function lattice(nx: number, ny: number): Float64Array {
  const c = new Float64Array(nx * ny * 2);
  for (let i = 0; i < nx * ny; i++) {
    c[2 * i] = 10 + (i % nx) * 2;
    c[2 * i + 1] = 40 + Math.floor(i / nx) * 2;
  }
  return c;
}
const pointsLayer = (): DataLayer => layer('points', lattice(6, 6), 36);
const gridLayer = (): DataLayer =>
  layer('grid', { x: Float64Array.from({ length: 4 }, (_, i) => i * 0.5), y: Float64Array.from({ length: 3 }, (_, j) => j * 0.5) }, 12);

/** A recording 2D context per canvas. */
interface Rec {
  arcs: number;
  rects: number;
  fills: string[];
}
const recs = new WeakMap<HTMLCanvasElement, Rec>();

const opts = { param: 'a', timeIndex: 0, colourScale: VIRIDIS };

describe('LeafletDataLayers', () => {
  let c: LeafletController;
  let el: HTMLDivElement;

  const rec = (): Rec => recs.get(el.querySelector<HTMLCanvasElement>('.metdx-points-canvas')!)!;
  const pane = (name: string) => el.querySelector<HTMLElement>(`.leaflet-${name}-pane`)!;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      let r = recs.get(this);
      if (!r) recs.set(this, (r = { arcs: 0, rects: 0, fills: [] }));
      const state = r;
      let fill = '';
      return {
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        drawImage: () => {},
        setTransform: () => {},
        clearRect: () => {
          state.arcs = 0;
          state.rects = 0;
          state.fills = [];
        },
        beginPath: () => {},
        stroke: () => {},
        fill: () => state.fills.push(fill),
        arc: () => state.arcs++,
        fillRect: () => {
          state.rects++;
          state.fills.push(fill);
        },
        set fillStyle(v: string) {
          fill = v;
        },
        set strokeStyle(_v: string) {},
        set lineWidth(_v: number) {},
      } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,AAAA');
    c = new LeafletController();
    el = document.createElement('div');
    el.style.width = '400px';
    el.style.height = '300px';
    // jsdom does no layout: give the map a size, or every point lies outside the (empty) canvas.
    Object.defineProperty(el, 'clientWidth', { value: 400 });
    Object.defineProperty(el, 'clientHeight', { value: 300 });
    document.body.appendChild(el);
    c.attach(el);
  });
  afterEach(() => {
    c.detach();
    el.remove();
    vi.restoreAllMocks();
  });

  describe('points', () => {
    it('draws every point on one canvas in the points pane, with the shared colours', () => {
      c.showData(pointsLayer(), opts);
      expect(pane('metdxDataPoints').querySelectorAll('canvas')).toHaveLength(1);
      const r = rec();
      expect(r.arcs).toBeGreaterThan(0);
      expect(new Set(r.fills).size).toBeGreaterThan(1);
      expect(el.getAttribute('data-data')).toBe('drawn');
      expect(el.getAttribute('data-style')).toBe('points');
    });

    it('recolours on param / time change without rebuilding the layer', () => {
      const l = pointsLayer();
      c.showData(l, opts);
      const canvas = el.querySelector('.metdx-points-canvas');
      const before = [...rec().fills];
      c.showData(l, { ...opts, param: 'b' });
      expect(el.querySelector('.metdx-points-canvas')).toBe(canvas);
      expect(rec().fills).not.toEqual(before);
      const afterB = [...rec().fills];
      c.showData(l, { ...opts, timeIndex: 1 });
      expect(el.querySelector('.metdx-points-canvas')).toBe(canvas);
      expect(rec().fills).not.toEqual(afterB);
    });

    it('an opacity-only change only sets the pane opacity (no redraw)', () => {
      const l = pointsLayer();
      c.showData(l, opts);
      const r = rec();
      r.arcs = -1; // a redraw would clear and recount it
      c.showData(l, { ...opts, opacity: 0.3 });
      expect(r.arcs).toBe(-1);
      expect(pane('metdxDataPoints').style.opacity).toBe('0.3');
      expect(el.getAttribute('data-opacity')).toBe('0.3');
    });

    it('does not draw no-data (NaN) points', () => {
      const l = pointsLayer();
      const all = l.values;
      l.values = (p, t) => {
        const v = all(p, t);
        v.fill(NaN, 0, 6);
        return v;
      };
      c.showData(l, opts);
      expect(rec().arcs).toBe(30);
    });

    it('uses squares beyond 10k points', () => {
      const n = 100 * 101;
      c.showData(layer('points', lattice(100, 101), n), opts);
      expect(rec().rects).toBeGreaterThan(0);
      expect(rec().arcs).toBe(0);
    });

    it('clearData removes the layer and the attributes', () => {
      c.showData(pointsLayer(), opts);
      c.clearData();
      expect(el.querySelector('.metdx-points-canvas')).toBeNull();
      for (const a of ['data-data', 'data-style', 'data-opacity']) expect(el.hasAttribute(a)).toBe(false);
    });

    it('zooms to the extent of a new layer, not on a param change', () => {
      const fit = vi.spyOn(c.getMap()!, 'fitBounds');
      const l = pointsLayer();
      c.showData(l, opts);
      expect(fit).toHaveBeenCalledTimes(1);
      expect(fit).toHaveBeenCalledWith(
        [
          [40, 10],
          [50, 20],
        ],
        expect.objectContaining({ maxZoom: 10 }),
      );
      c.showData(l, { ...opts, param: 'b' });
      expect(fit).toHaveBeenCalledTimes(1);
    });

    it('draws data shown before attach once the map exists', () => {
      c.detach();
      c.showData(pointsLayer(), opts);
      c.attach(el);
      expect(rec().arcs).toBeGreaterThan(0);
      expect(el.getAttribute('data-style')).toBe('points');
    });
  });

  describe('trajectory', () => {
    it('draws the line (halo + line) below the points', () => {
      const l = layer('trajectory', Float64Array.from([0, 0, 5, 5, 10, 3]), 3);
      c.showData(l, opts);
      expect(pane('metdxDataLine').querySelectorAll('path')).toHaveLength(2);
      expect(rec().arcs).toBe(3);
      c.clearData();
      expect(pane('metdxDataLine').querySelectorAll('path')).toHaveLength(0);
    });
  });

  describe('contours', () => {
    const cOpts = { ...opts, style: 'contours' as const };

    it('draws bands as paths, hides the points, and switches back', () => {
      const l = pointsLayer();
      c.showData(l, opts);
      c.showData(l, cOpts);
      expect(el.getAttribute('data-style')).toBe('contours');
      expect(pane('metdxDataImage').querySelectorAll('path').length).toBeGreaterThan(0);
      expect(el.querySelector('.metdx-points-canvas')).toBeNull();
      expect(el.getAttribute('data-opacity')).toBe('0.9');
      c.showData(l, { ...opts, style: 'points' });
      expect(el.getAttribute('data-style')).toBe('points');
      expect(pane('metdxDataImage').querySelectorAll('path')).toHaveLength(0);
      expect(rec().arcs).toBeGreaterThan(0);
      expect(el.getAttribute('data-opacity')).toBe('1');
    });

    it('caches the contours per param|time', () => {
      const compute = vi.mocked(computeContours);
      compute.mockClear();
      const l = pointsLayer();
      c.showData(l, cOpts);
      c.showData(l, { ...cOpts, timeIndex: 1 });
      c.showData(l, cOpts);
      c.showData(l, { ...cOpts, opacity: 0.5 });
      c.showData(l, { ...cOpts, colourScale: GREY });
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('falls back to points for a layer that cannot be contoured', () => {
      c.showData(layer('points', Float64Array.from([0, 0, 1, 1]), 2), cOpts);
      expect(el.getAttribute('data-style')).toBe('points');
    });
  });

  describe('grid', () => {
    it('shows a reprojected image overlay; load / error events set data-data', () => {
      c.showData(gridLayer(), opts);
      const img = pane('metdxDataImage').querySelector<HTMLImageElement>('img')!;
      expect(img.src).toContain('data:image/png');
      expect(img.style.imageRendering).toBe('pixelated');
      expect(el.getAttribute('data-data')).toBe('loading');
      expect(el.getAttribute('data-opacity')).toBe('0.85');
      img.dispatchEvent(new Event('load'));
      expect(el.getAttribute('data-data')).toBe('loaded');
      c.showData(gridLayer(), opts);
      const img2 = pane('metdxDataImage').querySelector<HTMLImageElement>('img')!;
      expect(pane('metdxDataImage').querySelectorAll('img')).toHaveLength(1);
      img2.dispatchEvent(new Event('error'));
      expect(el.getAttribute('data-data')).toBe('error');
      c.clearData();
      expect(pane('metdxDataImage').querySelectorAll('img')).toHaveLength(0);
      expect(el.hasAttribute('data-data')).toBe(false);
    });

    it('a stale image load does not change the state of a newer grid', () => {
      c.showData(gridLayer(), opts);
      const stale = pane('metdxDataImage').querySelector<HTMLImageElement>('img')!;
      c.showData(gridLayer(), opts);
      stale.dispatchEvent(new Event('load'));
      expect(el.getAttribute('data-data')).toBe('loading');
    });
  });

  describe('selection', () => {
    const click = (lat: number, lng: number) => {
      const map = c.getMap()!;
      map.fire('click', { latlng: new LatLng(lat, lng), containerPoint: map.latLngToContainerPoint([lat, lng]) });
    };

    it('points: nearest real point within tolerance', () => {
      const l = pointsLayer();
      l.values = () => Float32Array.from({ length: 36 }, (_, i) => (i === 7 ? NaN : 0.5));
      c.showData(l, opts);
      const cb = vi.fn();
      const off = c.onDataSelect(cb);
      click(40, 10);
      expect(cb).toHaveBeenLastCalledWith(0, [10, 40]);
      click(40, 12); // index 1
      expect(cb).toHaveBeenLastCalledWith(1, [12, 40]);
      cb.mockClear();
      click(42, 12); // index 7 has no value and its neighbours are far away
      click(0, 0);
      expect(cb).not.toHaveBeenCalled();
      off();
      click(40, 10);
      expect(cb).not.toHaveBeenCalled();
    });

    it('contours: nearest point of the lattice', () => {
      c.showData(pointsLayer(), { ...opts, style: 'contours' });
      const cb = vi.fn();
      c.onDataSelect(cb);
      click(40.2, 10.3);
      expect(cb).toHaveBeenCalledWith(0, [10, 40]);
    });

    it('grid: the cell under the cursor, nothing outside the extent', () => {
      c.showData(gridLayer(), opts);
      const cb = vi.fn();
      c.onDataSelect(cb);
      click(0.5, 1); // y index 1, x index 2 -> 1 * 4 + 2
      expect(cb).toHaveBeenCalledWith(6, [1, 0.5]);
      cb.mockClear();
      click(20, 20);
      expect(cb).not.toHaveBeenCalled();
    });

    it('ignores clicks while a draw is in progress', async () => {
      c.showData(pointsLayer(), opts);
      const cb = vi.fn();
      c.onDataSelect(cb);
      const p = c.drawGeometry('bbox');
      const rejected = expect(p).rejects.toBeDefined();
      click(40, 10);
      expect(cb).not.toHaveBeenCalled();
      c.cancel();
      await rejected;
      click(40, 10);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});
