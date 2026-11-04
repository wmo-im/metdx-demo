import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawCancelledError, type MapEngine } from './mapApi';
import { VIRIDIS, type DataLayer, type GridSpec, type ParamInfo } from '../lib/covjsonTypes';

/**
 * Engine-neutral conformance suite for {@link MapEngine} implementations (run it from `mapApi.<engine>.test.ts`).
 * It only uses the public contract and the `data-*` attributes mirrored on the map element
 * (`data-overlay`, `data-data`, `data-style`, `data-opacity`), never the engine's own objects.
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
      el.style.width = '400px';
      el.style.height = '300px';
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
