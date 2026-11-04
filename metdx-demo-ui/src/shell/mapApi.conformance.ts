import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawCancelledError, type MapEngine } from './mapApi';
import type { BBox } from '../lib/types';
import { VIRIDIS, type DataLayer, type GridSpec, type ParamInfo } from '../lib/covjsonTypes';

/**
 * Engine-neutral conformance suite for {@link MapEngine} implementations (run it from `mapApi.<engine>.test.ts`).
 * It only uses the public contract and the `data-*` attributes mirrored on the map element
 * (`data-overlay`, `data-data`, `data-style`, `data-opacity`, `data-view`), never the engine's own objects.
 */
export interface ConformanceOptions {
  /** Also run the data-layer tests (showData / clearData / onDataSelect). Default true. */
  data?: boolean;
}

const PARAMS: ParamInfo[] = [{ key: 'a', label: 'Param A', unit: 'K', min: 0, max: 1 }];

function makeLayer(kind: DataLayer['kind'], coords: Float64Array | GridSpec, size: number): DataLayer {
  return {
    kind,
    parameters: PARAMS,
    times: ['2026-01-01T00:00:00Z'],
    coords,
    values: () => Float32Array.from({ length: size }, (_, i) => i / Math.max(1, size - 1)),
  };
}

/** 6x6 lattice of points (enough for contours). */
function pointsLayer(): DataLayer {
  const n = 36;
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    coords[2 * i] = (i % 6) * 2;
    coords[2 * i + 1] = Math.floor(i / 6) * 2;
  }
  return makeLayer('points', coords, n);
}

function gridLayer(): DataLayer {
  const x = Float64Array.from({ length: 4 }, (_, i) => i * 0.5);
  const y = Float64Array.from({ length: 3 }, (_, j) => j * 0.5);
  return makeLayer('grid', { x, y }, 12);
}

const opts = { param: 'a', timeIndex: 0, colourScale: VIRIDIS };

export function runMapConformance(name: string, create: () => MapEngine, options: ConformanceOptions = {}): void {
  const withData = options.data ?? true;

  describe(`MapEngine conformance: ${name}`, () => {
    let engine: MapEngine;
    let el: HTMLDivElement;
    const attach = () => engine.attach(el);
    /** jsdom has no layout: give the element the size its style asks for (the engines read it to fit the view). */
    const sizeEl = (width: number, height: number) => {
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      for (const [prop, value] of [['clientWidth', width], ['offsetWidth', width], ['clientHeight', height], ['offsetHeight', height]] as const) {
        Object.defineProperty(el, prop, { value, configurable: true });
      }
    };

    beforeEach(() => {
      // jsdom has no canvas 2D context: minimal recording stand-ins so grid painting can run.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
        return {
          createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => {},
          clearRect: () => {},
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        } as unknown as CanvasRenderingContext2D;
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,AAAA');
      engine = create();
      el = document.createElement('div');
      sizeEl(400, 300);
      document.body.appendChild(el);
    });
    afterEach(() => {
      engine.detach();
      el.remove();
      vi.restoreAllMocks();
    });

    describe('lifecycle', () => {
      it('exposes its api and capabilities', () => {
        expect(engine.capabilities).toBeTypeOf('object');
        for (const m of ['drawGeometry', 'setOverlay', 'clear', 'showGeometry', 'showExtent', 'showData', 'clearData', 'onDataSelect'] as const) {
          expect(engine.api[m]).toBeTypeOf('function');
        }
      });

      it('attach puts a map into the element and detach is idempotent', () => {
        attach();
        expect(el.childElementCount).toBeGreaterThan(0);
        engine.detach();
        engine.detach();
        attach();
        expect(el.childElementCount).toBeGreaterThan(0);
        attach(); // attaching twice replaces the map rather than stacking
        expect(el.childElementCount).toBeGreaterThan(0);
      });

      it('rejects drawing before it is attached, and the other methods do not throw', async () => {
        await expect(engine.api.drawGeometry('point')).rejects.toThrow(/not ready/);
        expect(() => {
          engine.api.showExtent([-10, -5, 10, 5]);
          engine.api.showGeometry({ type: 'Point', coordinates: [1, 2] });
          engine.api.setOverlay('blob:x', [0, 0, 10, 10]);
          engine.api.setOverlay(null);
          engine.api.clear();
          engine.api.clearData();
          engine.cancel();
          engine.detach();
        }).not.toThrow();
      });

      it('accepts state set before attach', () => {
        engine.api.setOverlay('blob:x', [0, 0, 10, 10], { fit: false });
        engine.api.showGeometry({ type: 'LineString', coordinates: [[0, 0], [5, 5]] });
        attach();
        expect(() => engine.api.clear()).not.toThrow();
      });
    });

    describe('overlay and geometry', () => {
      beforeEach(attach);

      it('mirrors the overlay state as data-overlay and removes it with null / clear()', () => {
        engine.api.setOverlay('blob:x', [0, 0, 10, 10]);
        expect(el.getAttribute('data-overlay')).toMatch(/^(loading|loaded|error)$/);
        engine.api.setOverlay(null);
        expect(el.hasAttribute('data-overlay')).toBe(false);
        engine.api.setOverlay('blob:y', [0, 0, 10, 10], { fit: false, opacity: 0.5 });
        expect(el.hasAttribute('data-overlay')).toBe(true);
        engine.api.clear();
        expect(el.hasAttribute('data-overlay')).toBe(false);
      });

      it('shows and hides geometries and extents', () => {
        expect(() => {
          engine.api.showGeometry({ type: 'Point', coordinates: [10, 50] });
          engine.api.showGeometry({ type: 'LineString', coordinates: [[0, 0], [10, 10]] });
          engine.api.showGeometry({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] });
          engine.api.showGeometry(null);
          engine.api.showExtent([-20, -10, 20, 10]);
          engine.api.showExtent(null);
        }).not.toThrow();
      });
    });

    describe('view', () => {
      /** The visible [west, south, east, north] mirrored as `data-view`. */
      const view = (): BBox => {
        const v = el.getAttribute('data-view');
        expect(v).toMatch(/^-?[\d.]+(,-?[\d.]+){3}$/);
        return v!.split(',').map(Number) as BBox;
      };
      const contains = (v: BBox, b: BBox) => v[0] <= b[0] && v[1] <= b[1] && v[2] >= b[2] && v[3] >= b[3];

      it('starts on the whole world', () => {
        attach();
        const v = view();
        expect(contains(v, [-180, -85, 180, 85])).toBe(true);
        expect(v[2] - v[0]).toBeLessThan(720); // not zoomed out beyond the world and its neighbours
      });

      it('showExtent without fit leaves the view alone', () => {
        attach();
        const before = el.getAttribute('data-view');
        engine.api.showExtent([-10, 40, 10, 50]);
        expect(el.getAttribute('data-view')).toBe(before);
      });

      it('showExtent with fit zooms to the extent and out by one level: it contains the extent with room around it', () => {
        attach();
        const bbox: BBox = [-10, 40, 10, 50];
        engine.api.showExtent(bbox, { fit: true });
        const v = view();
        expect(contains(v, bbox)).toBe(true);
        expect(v[2] - v[0]).toBeGreaterThan(20); // wider than the extent: context around it
        expect(v[2] - v[0]).toBeLessThan(360); // but zoomed in on it
        // one level further out than the fit shows (at least) twice the extent's width, and no more than four times
        expect(v[2] - v[0]).toBeLessThanOrEqual(20 * 4 * 1.01);
      });

      it('padLevels sets how far to zoom out (0: just fit)', () => {
        attach();
        const bbox: BBox = [-10, 40, 10, 50];
        engine.api.showExtent(bbox, { fit: true, padLevels: 0 });
        const fitted = view();
        engine.api.showExtent(bbox, { fit: true, padLevels: 2 });
        const out = view();
        expect(contains(fitted, bbox)).toBe(true);
        expect(out[2] - out[0]).toBeGreaterThan(fitted[2] - fitted[0]);
      });

      it('a point footprint is not zoomed to street level', () => {
        attach();
        engine.api.showExtent([5, 45, 5, 45], { fit: true });
        const v = view();
        expect(contains(v, [5, 45, 5, 45])).toBe(true);
        expect(v[2] - v[0]).toBeGreaterThan(1);
      });

      it('a world-wide footprint just shows the world', () => {
        attach();
        engine.api.showExtent([-180, -90, 180, 90], { fit: true });
        const v = view();
        expect(contains(v, [-180, -85, 180, 85])).toBe(true);
        expect(v[2] - v[0]).toBeLessThan(720);
      });

      it('an extent fitted before attach is applied once the map exists', () => {
        engine.api.showExtent([-10, 40, 10, 50], { fit: true });
        attach();
        const v = view();
        expect(contains(v, [-10, 40, 10, 50])).toBe(true);
        expect(v[2] - v[0]).toBeLessThan(360);
      });

      it('clear() forgets an extent that was waiting for the map', () => {
        engine.api.showExtent([-10, 40, 10, 50], { fit: true });
        engine.api.clear();
        attach();
        expect(contains(view(), [-180, -85, 180, 85])).toBe(true);
        expect(view()[2] - view()[0]).toBeGreaterThan(360);
      });
    });

    describe('view on a short map (400 x 200 px: the world is taller than the map at zoom 0)', () => {
      beforeEach(() => sizeEl(400, 200));
      const view = (): BBox => el.getAttribute('data-view')!.split(',').map(Number) as BBox;
      const contains = (v: BBox, b: BBox) => v[0] <= b[0] && v[1] <= b[1] && v[2] >= b[2] && v[3] >= b[3];

      it('starts on the whole world, poles included', () => {
        attach();
        const v = view();
        expect(contains(v, [-180, -85, 180, 85])).toBe(true);
        expect(v[2] - v[0]).toBeLessThan(800); // fitted, not zoomed out far beyond the world
      });

      it('a world-wide footprint shows the whole world', () => {
        attach();
        engine.api.showExtent([-180, -90, 180, 90], { fit: true });
        const v = view();
        expect(contains(v, [-180, -85, 180, 85])).toBe(true);
        expect(v[2] - v[0]).toBeLessThan(800);
      });

      it('a regional footprint is fitted with context and stays inside the world view', () => {
        attach();
        const world = view();
        engine.api.showExtent([-10, 40, 10, 50], { fit: true });
        const v = view();
        expect(contains(v, [-10, 40, 10, 50])).toBe(true);
        expect(v[2] - v[0]).toBeGreaterThan(20);
        expect(v[2] - v[0]).toBeLessThan(world[2] - world[0]);
      });
    });

    describe('drawing', () => {
      beforeEach(attach);

      it('clear() cancels a draw with DrawCancelledError', async () => {
        const p = engine.api.drawGeometry('bbox');
        const assertion = expect(p).rejects.toBeInstanceOf(DrawCancelledError);
        engine.api.clear();
        await assertion;
      });

      it('cancel() cancels, and a new draw cancels the previous one', async () => {
        const a = engine.api.drawGeometry('polygon');
        const aRejected = expect(a).rejects.toMatchObject({ name: 'DrawCancelledError' });
        engine.cancel();
        await aRejected;

        const b = engine.api.drawGeometry('line');
        const bRejected = expect(b).rejects.toMatchObject({ name: 'DrawCancelledError' });
        const c = engine.api.drawGeometry('point');
        const cRejected = expect(c).rejects.toMatchObject({ name: 'DrawCancelledError' });
        await bRejected;
        engine.detach();
        await cRejected;
      });

      it('Escape cancels the draw', async () => {
        const p = engine.api.drawGeometry('point');
        const assertion = expect(p).rejects.toBeInstanceOf(DrawCancelledError);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await assertion;
      });
    });

    if (withData) {
      describe('data', () => {
        beforeEach(attach);

        it('points: data-data, data-style, data-opacity; clearData removes them', () => {
          engine.api.showData(pointsLayer(), opts);
          expect(el.getAttribute('data-data')).toBe('drawn');
          expect(el.getAttribute('data-style')).toBe('points');
          expect(el.getAttribute('data-opacity')).toBe('1');
          engine.api.showData(pointsLayer(), { ...opts, opacity: 0.4 });
          expect(el.getAttribute('data-opacity')).toBe('0.4');
          engine.api.clearData();
          for (const a of ['data-data', 'data-style', 'data-opacity']) expect(el.hasAttribute(a)).toBe(false);
        });

        it('contours: data-style=contours; falls back to points for a non-contourable layer', () => {
          const layer = pointsLayer();
          engine.api.showData(layer, { ...opts, style: 'contours' });
          expect(el.getAttribute('data-style')).toBe('contours');
          expect(el.getAttribute('data-data')).toBe('drawn');
          engine.api.showData(layer, { ...opts, style: 'points' });
          expect(el.getAttribute('data-style')).toBe('points');
          engine.api.showData(makeLayer('points', new Float64Array([0, 0, 1, 1]), 2), { ...opts, style: 'contours' });
          expect(el.getAttribute('data-style')).toBe('points');
        });

        it('grid: reports a loading/loaded/drawn state and the default opacity 0.85', () => {
          engine.api.showData(gridLayer(), opts);
          expect(el.getAttribute('data-data')).toMatch(/^(loading|loaded|drawn)$/);
          expect(el.getAttribute('data-opacity')).toBe('0.85');
          engine.api.clearData();
          expect(el.hasAttribute('data-data')).toBe(false);
        });

        it('keeps data set before attach', () => {
          engine.detach();
          engine.api.showData(pointsLayer(), opts);
          attach();
          expect(el.getAttribute('data-data')).toBe('drawn');
        });

        it('rejects an unknown parameter and a kind/coords mismatch', () => {
          expect(() => engine.api.showData(pointsLayer(), { ...opts, param: 'zzz' })).toThrow(RangeError);
          expect(() => engine.api.showData(makeLayer('grid', new Float64Array([0, 0]), 1), opts)).toThrow(TypeError);
        });

        it('onDataSelect returns an unsubscribe function', () => {
          const cb = vi.fn();
          const off = engine.api.onDataSelect(cb);
          expect(off).toBeTypeOf('function');
          off();
          expect(cb).not.toHaveBeenCalled();
        });
      });
    }
  });
}
