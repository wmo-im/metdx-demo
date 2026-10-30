import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type VectorLayer from 'ol/layer/Vector';
import type ImageLayer from 'ol/layer/Image';
import type ImageSource from 'ol/source/Image';
import VectorSource from 'ol/source/Vector';
import type Feature from 'ol/Feature';
import type { Style } from 'ol/style';
import type { LineString } from 'ol/geom';
import { fromLonLat } from 'ol/proj';
import { MapController, gridCanvasSize, paintGridRGBA } from './mapController';
import { Legend, formatLegendValue } from './Legend';
import {
  MAX_CANVAS_DIM,
  VIRIDIS,
  type ColourScale,
  type DataLayer,
  type GridSpec,
  type ParamInfo,
} from '../lib/covjsonTypes';

// ---- hand-built DataLayers (no parser) -------------------------------------------------------

const PARAMS: ParamInfo[] = [
  { key: 'a', label: 'Param A', unit: 'K', min: 0, max: 1 },
  { key: 'b', label: 'Param B', unit: 'm', min: -5, max: 5 },
];

function makeLayer(kind: DataLayer['kind'], coords: Float64Array | GridSpec, size: number, nTimes: number): DataLayer {
  const cache = new Map<string, Float32Array>();
  return {
    kind,
    parameters: PARAMS,
    times: Array.from({ length: nTimes }, (_, t) => `2026-01-0${t + 1}T00:00:00Z`),
    coords,
    values(param, t) {
      const p = PARAMS.find((q) => q.key === param);
      if (!p || t < 0 || t >= Math.max(1, nTimes)) throw new RangeError('bad param/time');
      const key = `${param}|${t}`;
      let v = cache.get(key);
      if (!v) {
        v = new Float32Array(size);
        for (let i = 0; i < size; i++) v[i] = p.min + ((p.max - p.min) * (((i + t * 7) % size) / (size - 1 || 1)));
        cache.set(key, v);
      }
      return v;
    },
  };
}

/** `n` points on a lon/lat lattice with spacing `step` degrees (default 0.1; use ≥ 2 when clicking at zoom 3). */
function pointsLayer(n: number, nTimes = 3, step = 0.1): DataLayer {
  const coords = new Float64Array(n * 2);
  const perRow = Math.min(200, Math.max(1, Math.floor(100 / step)));
  for (let i = 0; i < n; i++) {
    coords[2 * i] = -10 + (i % perRow) * step; // lon
    coords[2 * i + 1] = 0 + Math.floor(i / perRow) * step * 0.25; // lat
  }
  return makeLayer('points', coords, n, nTimes);
}

function gridLayer(nx: number, ny: number, nTimes = 1): DataLayer {
  const x = Float64Array.from({ length: nx }, (_, i) => i * 0.5);
  const y = Float64Array.from({ length: ny }, (_, j) => -10 + j * 0.5);
  return makeLayer('grid', { x, y }, nx * ny, nTimes);
}

// ---- jsdom has no canvas: a recording 2D context ---------------------------------------------

interface FakeCtx {
  width: number;
  height: number;
  data: Uint8ClampedArray | null;
  puts: number;
}
let ctxs: FakeCtx[] = [];

beforeEach(() => {
  ctxs = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const rec: FakeCtx = { width: this.width, height: this.height, data: null, puts: 0 };
    ctxs.push(rec);
    return {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => {
        rec.data = img.data;
        rec.width = img.width;
        rec.height = img.height;
        rec.puts++;
      },
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,AAAA');
});

let div: HTMLDivElement;
let ctrl: MapController;
beforeEach(() => {
  div = document.createElement('div');
  document.body.appendChild(div);
  ctrl = new MapController();
  ctrl.attach(div);
});
afterEach(() => {
  ctrl.detach();
  div.remove();
  vi.restoreAllMocks();
});

const opts = (param = 'a', timeIndex = 0, colourScale: ColourScale = VIRIDIS) => ({ param, timeIndex, colourScale });
const layerCount = () => ctrl.getMap()!.getLayers().getLength();
const layerAt = (z: number) => ctrl.getMap()!.getLayers().getArray().find((l) => l.getZIndex() === z) as VectorLayer<VectorSource>;
const pointsOl = () => layerAt(13);
const lineOl = () => layerAt(7);
const imageOl = () => layerAt(6) as unknown as ImageLayer<ImageSource>;
const styleOf = (f: Feature): Style | undefined => {
  const s = pointsOl().getStyleFunction()!(f, 1);
  return (Array.isArray(s) ? s[0] : s) as Style | undefined;
};
const fillOf = (s: Style | undefined) => (s?.getImage() as unknown as { getFill(): { getColor(): string } }).getFill().getColor();

describe('layer order', () => {
  it('grid/line layers sit above the basemap/overlay and below extent and drawn geometry; data points above the geometry', () => {
    const z = ctrl.getMap()!.getLayers().getArray().map((l) => l.getZIndex() ?? 0);
    const below = [6, 7];
    for (const d of [...below, 13]) expect(z).toContain(d);
    expect(Math.min(...z.filter((v) => v > 5 && v < 10))).toBe(6);
    expect(Math.max(...below)).toBeLessThan(Math.min(...z.filter((v) => v >= 10)));
    // a position result sits exactly under the drawn query marker (z 11 / 12): it must be drawn on top of it
    expect(13).toBeGreaterThan(Math.max(...z.filter((v) => v < 13)));
  });
});

describe('points', () => {
  it('draws 40k points and survives 10 param/time switches without rebuilding or adding layers', () => {
    const layer = pointsLayer(40_000);
    const before = layerCount();
    const t0 = performance.now();
    ctrl.showData(layer, opts('a', 0));
    const drawMs = performance.now() - t0;
    expect(layerCount()).toBe(before);
    const source = pointsOl().getSource()!;
    expect(source.getFeatures()).toHaveLength(40_000);
    const f0 = source.getFeatures().find((f) => f.get('i') === 40_000 - 7)!; // max at t=0, min at t=1
    const colourBefore = fillOf(styleOf(f0));

    const t1 = performance.now();
    for (let k = 0; k < 10; k++) {
      ctrl.showData(layer, opts(k % 2 ? 'b' : 'a', k % 3));
      expect(layerCount()).toBe(before);
      expect(pointsOl().getSource()).toBe(source); // same source, geometries not rebuilt
      expect(source.getFeatures()).toContain(f0);
    }
    const switchMs = (performance.now() - t1) / 10;
    expect(drawMs).toBeLessThan(3000);
    expect(switchMs).toBeLessThan(1000);
    expect(source.getFeatures()).toHaveLength(40_000);
    // The colour comes from the (re)computed array, so another time step recolours the same feature.
    ctrl.showData(layer, opts('a', 1));
    expect(fillOf(styleOf(f0))).not.toBe(colourBefore);
    expect(div.getAttribute('data-data')).toBe('drawn');
  });

  it('uses one shared style object per colour bucket, not one per feature', () => {
    const layer = pointsLayer(1000);
    ctrl.showData(layer, opts());
    const styles = new Set(pointsOl().getSource()!.getFeatures().map((f) => styleOf(f)));
    expect(styles.size).toBeLessThanOrEqual(256);
  });

  it('draws NaN values as nothing', () => {
    const layer = pointsLayer(10, 1);
    const v = layer.values('a', 0);
    v[3] = NaN;
    ctrl.showData(layer, opts());
    const fs = pointsOl().getSource()!.getFeatures();
    expect(styleOf(fs[3])).toBeUndefined();
    expect(styleOf(fs[4])).toBeDefined();
  });

  it('replaces the previous layer when given a different DataLayer', () => {
    ctrl.showData(pointsLayer(100), opts());
    ctrl.showData(pointsLayer(50), opts());
    expect(pointsOl().getSource()!.getFeatures()).toHaveLength(50);
  });

  it('rejects unknown parameters', () => {
    expect(() => ctrl.showData(pointsLayer(5), opts('zzz'))).toThrow(RangeError);
  });
});

describe('trajectory', () => {
  it('draws a line through all vertices plus the points', () => {
    const coords = Float64Array.from([0, 0, 1, 1, 2, 1.5, 3, 3]);
    const layer = makeLayer('trajectory', coords, 4, 1);
    ctrl.showData(layer, opts());
    expect(pointsOl().getSource()!.getFeatures()).toHaveLength(4);
    const lines = lineOl().getSource()!.getFeatures();
    expect(lines).toHaveLength(1);
    const line = lines[0].getGeometry() as LineString;
    expect(line.getCoordinates()).toHaveLength(4);
    expect(line.getCoordinates()[2]).toEqual(fromLonLat([2, 1.5]));
    // switching to points removes the line
    ctrl.showData(pointsLayer(3), opts());
    expect(lineOl().getSource()).toBeNull();
  });
});

describe('grid', () => {
  it('paints one pixel per cell, south row at the bottom, NaN transparent', () => {
    const layer = gridLayer(3, 2);
    const v = layer.values('a', 0);
    v[0] = 0; // (x0, south)
    v[2] = NaN; // (x2, south)
    v[3] = 1; // (x0, north)
    ctrl.showData(layer, opts());
    const canvas = ctrl.getDataCanvas()!;
    expect([canvas.width, canvas.height]).toEqual([3, 2]);
    const px = ctxs.at(-1)!.data!;
    const at = (x: number, row: number) => Array.from(px.slice((row * 3 + x) * 4, (row * 3 + x) * 4 + 4));
    expect(at(0, 1)).toEqual(VIRIDIS.fn(0)); // south-west: bottom-left, min colour
    expect(at(2, 1)[3]).toBe(0); // NaN
    expect(at(0, 0)).toEqual(VIRIDIS.fn(1)); // north-west: top-left, max colour
    expect(div.getAttribute('data-data')).toBe('loading');
    expect(imageOl().getSource()).not.toBeNull();
  });

  it('reuses the canvas for param/time changes and does not add layers', () => {
    const layer = gridLayer(20, 10, 3);
    const before = layerCount();
    ctrl.showData(layer, opts('a', 0));
    const canvas = ctrl.getDataCanvas();
    for (let k = 0; k < 10; k++) {
      ctrl.showData(layer, opts(k % 2 ? 'b' : 'a', k % 3));
      expect(ctrl.getDataCanvas()).toBe(canvas);
    }
    expect(layerCount()).toBe(before);
    expect(ctxs.at(-1)!.puts).toBeGreaterThan(0);
  });

  it('caps each canvas side at MAX_CANVAS_DIM (downsampling)', () => {
    expect(gridCanvasSize(5000, 10)).toEqual({ width: MAX_CANVAS_DIM, height: 10 });
    expect(gridCanvasSize(10, 9000)).toEqual({ width: 10, height: MAX_CANVAS_DIM });
    expect(gridCanvasSize(MAX_CANVAS_DIM, 1)).toEqual({ width: MAX_CANVAS_DIM, height: 1 });

    ctrl.showData(gridLayer(MAX_CANVAS_DIM + 104, 3), opts());
    expect([ctrl.getDataCanvas()!.width, ctrl.getDataCanvas()!.height]).toEqual([MAX_CANVAS_DIM, 3]);
    ctrl.showData(gridLayer(3, MAX_CANVAS_DIM + 104), opts());
    expect([ctrl.getDataCanvas()!.width, ctrl.getDataCanvas()!.height]).toEqual([3, MAX_CANVAS_DIM]);
    expect(ctxs.at(-1)!.data!.length).toBe(3 * MAX_CANVAS_DIM * 4);
  });

  it('downsampling keeps orientation and picks the right cells', () => {
    // 8 x 4 grid, value = cell index; downsample to 4 x 2.
    const nx = 8;
    const ny = 4;
    const values = Float32Array.from({ length: nx * ny }, (_, i) => i);
    const out = new Uint8ClampedArray(4 * 2 * 4);
    const scale: ColourScale = { name: 'id', fn: (t) => [Math.round(t * 255), 0, 0, 255] };
    paintGridRGBA(values, nx, ny, 4, 2, 0, 31, scale, out);
    // top-left pixel samples (x=0.. , north): cell (x=1, j=ny-1-floor(0.5*2)=2) -> value 17
    expect(out[0]).toBe(Math.round((17 / 31) * 255));
    // bottom-right pixel: x = floor(3.5*2)=7, j = ny-1-floor(1.5*2)=0 -> value 7
    expect(out[(1 * 4 + 3) * 4]).toBe(Math.round((7 / 31) * 255));
  });

  it('handles a flat range (min = max)', () => {
    const out = new Uint8ClampedArray(4);
    paintGridRGBA(Float32Array.of(5), 1, 1, 1, 1, 5, 5, VIRIDIS, out);
    expect(out[3]).toBe(255);
  });
});

/** `nx × ny` points on a lattice (0.5° spacing, from lon -10 / lat 40), values as in {@link makeLayer}. */
function latticeLayer(nx: number, ny: number, nTimes = 3): DataLayer {
  const coords = new Float64Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      coords[2 * (j * nx + i)] = -10 + i * 0.5;
      coords[2 * (j * nx + i) + 1] = 40 + j * 0.5;
    }
  }
  const layer = makeLayer('points', coords, nx * ny, nTimes);
  // smooth, distinct fields per param/time so the contours are real: a is a ramp in lon + lat, b its mirror
  const values = layer.values;
  const cache = new Map<string, Float32Array>();
  layer.values = (param, t) => {
    values(param, t); // validates arguments
    const key = `${param}|${t}`;
    let v = cache.get(key);
    if (!v) {
      const p = PARAMS.find((q) => q.key === param)!;
      v = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const u = (i / (nx - 1) + j / (ny - 1)) / 2;
          v[j * nx + i] = p.min + (p.max - p.min) * (param === 'a' ? u : 1 - u) * (1 - 0.1 * t);
        }
      }
      cache.set(key, v);
    }
    return v;
  };
  return layer;
}

describe('opacity', () => {
  const dataLayers = () => {
    const ls = ctrl.getMap()!.getLayers().getArray();
    return {
      image: ls.find((l) => l.getZIndex() === 6 && l.constructor.name === 'ImageLayer') as ImageLayer<ImageSource>,
      contour: ls.find((l) => l.getZIndex() === 6 && l.constructor.name === 'VectorLayer') as VectorLayer<VectorSource>,
      points: ls.find((l) => l.getZIndex() === 13) as VectorLayer<VectorSource>,
    };
  };

  it('defaults are unchanged (grid 0.85, contours 0.9, points 1) and reported as data-opacity', () => {
    const l = dataLayers();
    expect([l.image.getOpacity(), l.contour.getOpacity(), l.points.getOpacity()]).toEqual([0.85, 0.9, 1]);
    ctrl.showData(latticeLayer(30, 20), { ...opts(), style: 'contours' });
    expect(div.getAttribute('data-opacity')).toBe('0.9');
    ctrl.showData(latticeLayer(30, 20), opts());
    expect(div.getAttribute('data-opacity')).toBe('1');
    ctrl.showData(gridLayer(4, 4), opts());
    expect(div.getAttribute('data-opacity')).toBe('0.85');
    ctrl.clearData();
    expect(div.hasAttribute('data-opacity')).toBe(false);
  });

  it('an opacity-only change sets the layer opacity without re-contouring or rebuilding', () => {
    const layer = latticeLayer(30, 20);
    const styled = { ...opts(), style: 'contours' as const };
    ctrl.showData(layer, styled);
    const l = dataLayers();
    const src = l.contour.getSource();
    const feats = src!.getFeatures();
    const values = vi.spyOn(layer, 'values');
    const dispose = vi.spyOn(VectorSource.prototype, 'dispose');
    ctrl.showData(layer, { ...styled, opacity: 0.4 });
    expect(l.contour.getOpacity()).toBe(0.4);
    expect(div.getAttribute('data-opacity')).toBe('0.4');
    expect(l.contour.getSource()).toBe(src);
    expect(src!.getFeatures()).toEqual(feats);
    expect(values).not.toHaveBeenCalled(); // not even the values are read: nothing is recomputed
    expect(dispose).not.toHaveBeenCalled();
    ctrl.showData(layer, { ...styled, opacity: 0.7 });
    expect(l.contour.getOpacity()).toBe(0.7);
    expect(l.contour.getSource()).toBe(src);
    // switching the style keeps the chosen value; leaving it out restores the defaults
    ctrl.showData(layer, { ...opts(), opacity: 0.7 });
    expect(l.points.getOpacity()).toBe(0.7);
    ctrl.showData(layer, { ...opts() });
    expect([l.contour.getOpacity(), l.points.getOpacity()]).toEqual([0.9, 1]);
  });

  it('a grid is not repainted when only the opacity changes', () => {
    const layer = gridLayer(8, 8);
    ctrl.showData(layer, opts());
    const puts = ctxs.reduce((n, c) => n + c.puts, 0);
    const l = dataLayers();
    const src = l.image.getSource();
    ctrl.showData(layer, { ...opts(), opacity: 0.5 });
    expect(l.image.getOpacity()).toBe(0.5);
    expect(l.image.getSource()).toBe(src);
    expect(ctxs.reduce((n, c) => n + c.puts, 0)).toBe(puts);
    ctrl.showData(layer, { ...opts(), opacity: 7 }); // clamped
    expect(l.image.getOpacity()).toBe(1);
  });
});

describe('contour style', () => {
  const contourOl = () =>
    ctrl.getMap()!.getLayers().getArray().find((l) => l.getZIndex() === 6 && (l as unknown as VectorLayer<VectorSource>).getSource !== undefined && l.constructor.name === 'VectorLayer') as VectorLayer<VectorSource>;
  const styled = (extra = {}) => ({ ...opts(), style: 'contours' as const, ...extra });
  const bandColours = () => contourOl().getSource()!.getFeatures().map((f) => (f.getStyle() as Style).getFill()!.getColor() as string);

  it('draws filled bands in their own layer under the points, hides the points and reports data-style', () => {
    const n0 = layerCount();
    ctrl.showData(latticeLayer(30, 20), styled());
    expect(layerCount()).toBe(n0);
    const feats = contourOl().getSource()!.getFeatures();
    expect(feats.length).toBeGreaterThanOrEqual(6);
    expect(new Set(bandColours()).size).toBe(feats.length); // one distinct colour per band
    expect(feats[0].getGeometry()!.getType()).toBe('MultiPolygon');
    expect(contourOl().getZIndex()).toBeLessThan(pointsOl().getZIndex()!);
    expect(pointsOl().getVisible()).toBe(false);
    expect(div.getAttribute('data-style')).toBe('contours');
    expect(div.getAttribute('data-data')).toBe('drawn');
    expect(ctrl.getDataStyle()).toBe('contours');
  });

  it('contour polygons lie inside the data extent (EPSG:3857)', () => {
    ctrl.showData(latticeLayer(30, 20), styled());
    const [w, s, e, n] = [...fromLonLat([-10, 40]), ...fromLonLat([-10 + 29 * 0.5, 40 + 19 * 0.5])];
    for (const f of contourOl().getSource()!.getFeatures()) {
      const [x0, y0, x1, y1] = f.getGeometry()!.getExtent();
      expect(x0).toBeGreaterThanOrEqual(w - 1);
      expect(x1).toBeLessThanOrEqual(e + 1);
      expect(y0).toBeGreaterThanOrEqual(s - 1);
      expect(y1).toBeLessThanOrEqual(n + 1);
    }
  });

  it('switches contours <-> points repeatedly without adding layers or rebuilding the points, and frees the contour source', () => {
    const layer = latticeLayer(30, 20);
    const n0 = layerCount();
    ctrl.showData(layer, opts()); // points
    const pointSource = pointsOl().getSource();
    expect(pointSource!.getFeatures()).toHaveLength(600);
    const dispose = vi.spyOn(VectorSource.prototype, 'dispose');
    for (let k = 0; k < 10; k++) {
      ctrl.showData(layer, styled());
      expect(div.getAttribute('data-style')).toBe('contours');
      expect(pointsOl().getVisible()).toBe(false);
      expect(contourOl().getSource()).not.toBeNull();
      ctrl.showData(layer, opts());
      expect(div.getAttribute('data-style')).toBe('points');
      expect(pointsOl().getVisible()).toBe(true);
      expect(contourOl().getSource()).toBeNull(); // released as soon as it is not shown
      expect(pointsOl().getSource()).toBe(pointSource); // not rebuilt
    }
    expect(layerCount()).toBe(n0);
    expect(dispose).toHaveBeenCalledTimes(10); // one contour source per round trip
    // points coloured again after coming back
    const f = pointSource!.getFeatures()[300];
    expect(styleOf(f)).toBeDefined();
  });

  it('a layer shown straight as contours builds no point features until points are asked for', () => {
    const layer = latticeLayer(30, 20);
    ctrl.showData(layer, styled());
    expect(pointsOl().getSource()).toBeNull();
    ctrl.showData(layer, opts());
    expect(pointsOl().getSource()!.getFeatures()).toHaveLength(600);
  });

  it('param and time changes redraw the contours (one source at a time, same colours for the same data)', () => {
    const layer = latticeLayer(30, 20);
    const n0 = layerCount();
    ctrl.showData(layer, styled());
    const s0 = contourOl().getSource();
    const g0 = JSON.stringify(contourOl().getSource()!.getFeatures().map((f) => f.getGeometry()!.getExtent()));
    ctrl.showData(layer, styled({ param: 'b' }));
    expect(contourOl().getSource()).not.toBe(s0);
    expect(JSON.stringify(contourOl().getSource()!.getFeatures().map((f) => f.getGeometry()!.getExtent()))).not.toBe(g0);
    ctrl.showData(layer, styled({ timeIndex: 2 }));
    ctrl.showData(layer, styled()); // back: identical picture (cache hit)
    expect(JSON.stringify(contourOl().getSource()!.getFeatures().map((f) => f.getGeometry()!.getExtent()))).toBe(g0);
    // repeating the same call keeps the source
    const s1 = contourOl().getSource();
    ctrl.showData(layer, styled());
    expect(contourOl().getSource()).toBe(s1);
    expect(layerCount()).toBe(n0);
  });

  it('falls back to points when the layer cannot be contoured (too few points, collinear)', () => {
    ctrl.showData(pointsLayer(2), styled());
    expect(ctrl.getDataStyle()).toBe('points');
    expect(div.getAttribute('data-style')).toBe('points');
    expect(contourOl().getSource()).toBeNull();
    ctrl.showData(pointsLayer(40, 1, 2), styled()); // one lat row
    expect(ctrl.getDataStyle()).toBe('points');
    // trajectories and grids ignore the style
    const traj = makeLayer('trajectory', pointsLayer(20).coords, 20, 1);
    ctrl.showData(traj, styled());
    expect(ctrl.getDataStyle()).toBe('points');
    ctrl.showData(gridLayer(4, 4), styled());
    expect(contourOl().getSource()).toBeNull();
  });

  it('clearData releases the contours and the style marker, and a new layer starts clean', () => {
    const layer = latticeLayer(30, 20);
    ctrl.showData(layer, styled());
    ctrl.clearData();
    expect(contourOl().getSource()).toBeNull();
    expect(pointsOl().getSource()).toBeNull();
    expect(pointsOl().getVisible()).toBe(true);
    expect(div.hasAttribute('data-style')).toBe(false);
    expect(div.hasAttribute('data-data')).toBe(false);
    expect(ctrl.getDataStyle()).toBeNull();
    ctrl.showData(latticeLayer(10, 10), styled());
    expect(contourOl().getSource()!.getFeatures().length).toBeGreaterThan(0);
    // replacing the layer while in contour style
    ctrl.showData(latticeLayer(12, 12), styled());
    expect(layerCount()).toBeGreaterThan(0);
    expect(contourOl().getSource()!.getFeatures().length).toBeGreaterThan(0);
  });

  it('click in contour style reports the nearest real point; far away or no-data reports nothing', () => {
    const layer = latticeLayer(30, 20);
    layer.values('a', 0)[5 * 30 + 6] = NaN;
    const cb = vi.fn();
    ctrl.onDataSelect(cb);
    ctrl.showData(layer, styled());
    const click = (lon: number, lat: number) => ctrl.getMap()!.dispatchEvent({ type: 'singleclick', coordinate: fromLonLat([lon, lat]) } as never);
    // between points (3, 4) and its neighbours: nearest is (-10 + 3*0.5, 40 + 4*0.5) = (-8.5, 42)
    click(-8.45, 42.1);
    expect(cb).toHaveBeenCalledWith(4 * 30 + 3, [-8.5, 42]);
    cb.mockClear();
    click(-10 + 6 * 0.5 + 0.1, 40 + 5 * 0.5 - 0.1); // nearest point has no data
    expect(cb).not.toHaveBeenCalled();
    click(100, -60);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('clearData', () => {
  it('removes sources and canvas, and is safe to repeat', () => {
    ctrl.showData(gridLayer(4, 4), opts());
    expect(ctrl.getDataCanvas()).not.toBeNull();
    ctrl.clearData();
    expect(ctrl.getDataCanvas()).toBeNull();
    expect(imageOl().getSource()).toBeNull();
    expect(div.hasAttribute('data-data')).toBe(false);
    ctrl.showData(pointsLayer(10), opts());
    ctrl.clearData();
    expect(pointsOl().getSource()).toBeNull();
    expect(lineOl().getSource()).toBeNull();
    expect(() => ctrl.clearData()).not.toThrow();
  });

  it('works before the map is attached and leaves overlay/geometry state alone', () => {
    const c = new MapController();
    expect(() => c.clearData()).not.toThrow();
    ctrl.showGeometry({ type: 'Point', coordinates: [1, 2] });
    ctrl.showData(pointsLayer(5), opts());
    ctrl.clearData();
    ctrl.showData(pointsLayer(5), opts());
    ctrl.clear(); // existing behaviour: not about data
  });
});

describe('onDataSelect', () => {
  const click = (lon: number, lat: number) =>
    ctrl.getMap()!.dispatchEvent({ type: 'singleclick', coordinate: fromLonLat([lon, lat]) } as never);

  it('reports the index and lon/lat of a clicked point within the hit tolerance', () => {
    const cb = vi.fn();
    const off = ctrl.onDataSelect(cb);
    const layer = pointsLayer(40, 3, 2);
    ctrl.showData(layer, opts());
    const coords = layer.coords as Float64Array;
    click(coords[2 * 5], coords[2 * 5 + 1]);
    expect(cb).toHaveBeenCalledWith(5, [coords[10], coords[11]]);
    // a few pixels off still hits; far away does not
    const res = ctrl.getMap()!.getView().getResolution()!;
    const [x, y] = fromLonLat([coords[2 * 7], coords[2 * 7 + 1]]);
    cb.mockClear();
    ctrl.getMap()!.dispatchEvent({ type: 'singleclick', coordinate: [x + 4 * res, y] } as never);
    expect(cb).toHaveBeenCalledWith(7, [coords[14], coords[15]]);
    cb.mockClear();
    click(100, -60);
    expect(cb).not.toHaveBeenCalled();
    off();
    click(coords[2 * 5], coords[2 * 5 + 1]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores points without data', () => {
    const layer = pointsLayer(10, 1, 2);
    layer.values('a', 0)[2] = NaN;
    const cb = vi.fn();
    ctrl.onDataSelect(cb);
    ctrl.showData(layer, opts());
    const coords = layer.coords as Float64Array;
    click(coords[4], coords[5]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('reports the flat cell index and cell-centre of a clicked grid cell', () => {
    const cb = vi.fn();
    ctrl.onDataSelect(cb);
    const layer = gridLayer(6, 4); // x = 0..2.5 (0.5 steps), y = -10..-8.5
    ctrl.showData(layer, opts());
    click(1.1, -9.4); // nearest x = 1.0 (i=2), y = -9.5 (j=1)
    expect(cb).toHaveBeenCalledWith(1 * 6 + 2, [1, -9.5]);
    cb.mockClear();
    click(50, 50); // outside
    expect(cb).not.toHaveBeenCalled();
  });

  it('does nothing without data', () => {
    const cb = vi.fn();
    ctrl.onDataSelect(cb);
    click(0, 0);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('Legend', () => {
  it('shows min, max, unit and label with a colour bar', () => {
    render(createElement(Legend, { min: 250.123456, max: 310, unit: 'K', scale: VIRIDIS, label: '2 m temperature' }));
    expect(screen.getByTestId('legend-min')).toHaveTextContent('250.1');
    expect(screen.getByTestId('legend-max')).toHaveTextContent('310');
    expect(screen.getByTestId('legend-unit')).toHaveTextContent('K');
    expect(screen.getByTestId('legend-label')).toHaveTextContent('2 m temperature');
    expect(screen.getByTestId('legend-bar').getAttribute('style')).toContain('linear-gradient');
  });

  it('with band levels it is stepped: one colour block per band, edge labels at both ends', () => {
    const levels = [250, 255, 260, 265, 270, 275, 280, 285, 290, 295, 300, 305];
    render(createElement(Legend, { min: 252, max: 301, unit: 'K', scale: VIRIDIS, label: '2t', levels }));
    const steps = screen.getAllByTestId('legend-step');
    expect(steps).toHaveLength(levels.length - 1);
    const colours = steps.map((s) => (s as HTMLElement).style.background);
    expect(new Set(colours).size).toBe(steps.length);
    expect(screen.getByTestId('legend-min')).toHaveTextContent('250');
    expect(screen.getByTestId('legend-max')).toHaveTextContent('305');
    expect(screen.getByTestId('legend-unit')).toHaveTextContent('K');
    expect(screen.getByTestId('legend-label')).toHaveTextContent('2t');
    expect(screen.getAllByTestId('legend-tick').length).toBeGreaterThan(0);
  });

  it('omits unit and label when absent, and formats odd numbers', () => {
    render(createElement(Legend, { min: NaN, max: 1e-5, unit: '', scale: VIRIDIS }));
    expect(screen.queryByTestId('legend-unit')).toBeNull();
    expect(screen.queryByTestId('legend-label')).toBeNull();
    expect(screen.getByTestId('legend-min')).toHaveTextContent('–');
    expect(formatLegendValue(0)).toBe('0');
    expect(formatLegendValue(1e-5)).toBe('1.00e-5');
    expect(formatLegendValue(-12.5)).toBe('-12.5');
  });
});
