import { describe, expect, it } from 'vitest';
import {
  ContourCache,
  MAX_CONTOUR_POINTS,
  bandColourT,
  buildTriangulation,
  computeContours,
  contourBytes,
  contourLevels,
  contourSupport,
  getTriangulation,
  interpolateToRaster,
  rasterSize,
  type ContourSet,
  type MultiPolygonCoords,
} from './contour';
import { parseCoverageJson } from './covjson';
import liveAreaFrance from '../../test/fixtures/edr/live-area-france.json';

/** nx × ny lattice over `[lon0, lon0 + (nx-1) dx] × [lat0, …]` with a deterministic jitter of `jitter` × spacing. */
function lattice(nx: number, ny: number, d = 0.1, jitter = 0, lon0 = 0, lat0 = 0): Float64Array {
  const c = new Float64Array(nx * ny * 2);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
      const k = (j * nx + i) * 2;
      c[k] = lon0 + i * d + (edge ? 0 : rnd() * jitter * d);
      c[k + 1] = lat0 + j * d + (edge ? 0 : rnd() * jitter * d);
    }
  }
  return c;
}

const linear = (c: Float64Array, f: (lon: number, lat: number) => number) =>
  Float32Array.from({ length: c.length / 2 }, (_, i) => f(c[2 * i], c[2 * i + 1]));

/** Signed area (shoelace) of a ring. */
const ringArea = (r: number[][]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
/** Area of a MultiPolygon: exterior rings and holes have opposite orientation, so |signed sum| is the net area. */
const mpArea = (m: MultiPolygonCoords) => Math.abs(m.reduce((s, poly) => s + poly.reduce((t, ring) => t + ringArea(ring), 0), 0));

describe('contourLevels', () => {
  it('gives ascending round-number edges that cover the range, about 10 bands', () => {
    for (const [min, max] of [[250.3, 300.7], [0, 1], [-5.2, 7.9], [0.0012, 0.0097], [1e5, 1.07e5], [-30, 45]]) {
      const lv = contourLevels(min, max);
      expect(lv[0]).toBeLessThanOrEqual(min);
      expect(lv[lv.length - 1]).toBeGreaterThanOrEqual(max);
      expect(lv.length - 1).toBeGreaterThanOrEqual(6);
      expect(lv.length - 1).toBeLessThanOrEqual(16);
      const step = lv[1] - lv[0];
      for (let k = 1; k < lv.length; k++) expect(lv[k] - lv[k - 1]).toBeCloseTo(step, 9);
      expect(lv[0] - min).toBeGreaterThan(-step); // not more than one step of slack
      expect(min - lv[0]).toBeLessThan(step + 1e-12);
      // step is 1, 2 or 5 × 10^k
      const mant = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5].some((m) => Math.abs(mant - m) < 1e-9)).toBe(true);
    }
  });

  it('picks the documented values for a typical temperature range', () => {
    expect(contourLevels(250.3, 300.7)).toEqual([250, 255, 260, 265, 270, 275, 280, 285, 290, 295, 300, 305]);
    expect(contourLevels(0, 1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('honours the requested count and handles flat / invalid ranges', () => {
    expect(contourLevels(0, 100, 5).length - 1).toBe(5);
    expect(contourLevels(0, 100, 20).length - 1).toBe(20);
    expect(contourLevels(7, 7)).toEqual([6.93, 7.07]);
    expect(contourLevels(0, 0)).toEqual([-1, 1]);
    expect(contourLevels(NaN, NaN)).toEqual([]);
    expect(contourLevels(3, 1)).toEqual([]);
  });

  it('bandColourT is the midpoint position, clamped', () => {
    expect(bandColourT(0, 10, 0, 100)).toBeCloseTo(0.05);
    expect(bandColourT(90, 110, 0, 100)).toBe(1);
    expect(bandColourT(-20, -10, 0, 100)).toBe(0);
    expect(bandColourT(1, 2, 5, 5)).toBe(0.5);
  });
});

describe('triangulation', () => {
  it('keeps every triangle of a regular lattice, with the lattice spacing as median edge', () => {
    const c = lattice(20, 10);
    const tri = buildTriangulation(c);
    expect(tri.triangles.length / 3).toBe(2 * 19 * 9);
    expect(tri.medianEdge).toBeCloseTo(0.1, 6);
    expect(tri.bbox).toEqual([0, 0, expect.closeTo(1.9, 9), expect.closeTo(0.9, 9)]);
  });

  it('drops hull-spanning triangles across a gap', () => {
    const a = lattice(10, 10, 0.1, 0, 0, 0);
    const b = lattice(10, 10, 0.1, 0, 10, 0);
    const c = new Float64Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    const tri = buildTriangulation(c);
    // no kept triangle touches both clusters
    for (let t = 0; t < tri.triangles.length; t += 3) {
      const left = [0, 1, 2].map((k) => tri.triangles[t + k] < 100);
      expect(left.every(Boolean) || left.every((x) => !x)).toBe(true);
    }
    expect(tri.triangles.length / 3).toBe(2 * 2 * 9 * 9);
  });

  it('does not modify the caller\'s coordinates (d3-delaunay jiggles collinear input in place)', () => {
    const c = new Float64Array([0, 0, 1, 1, 2, 2, 3, 3]);
    buildTriangulation(c);
    expect(Array.from(c)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('is cached per coordinate array', () => {
    const c = lattice(5, 5);
    expect(getTriangulation(c)).toBe(getTriangulation(c));
    expect(getTriangulation(lattice(5, 5))).not.toBe(getTriangulation(c));
  });

  it('nearest finds the closest point only near the data', () => {
    const c = lattice(10, 10, 1);
    const tri = buildTriangulation(c);
    expect(tri.nearest(3.2, 4.1)).toBe(4 * 10 + 3);
    expect(tri.nearest(8.9, 0.1)).toBe(9);
    expect(tri.nearest(50, 50)).toBe(-1);
    expect(tri.nearest(4.5, 4.5)).toBeGreaterThanOrEqual(0); // cell centre: within 2 median edges
  });

  it('contourSupport explains why not', () => {
    expect(contourSupport(new Float64Array([0, 0, 1, 1]))).toEqual({ ok: false, reason: 'too-few' });
    expect(contourSupport(new Float64Array([0, 0, 1, 1, 2, 2, 3, 3]))).toEqual({ ok: false, reason: 'no-area' });
    expect(contourSupport(lattice(5, 5))).toEqual({ ok: true });
    expect(contourSupport(new Float64Array((MAX_CONTOUR_POINTS + 1) * 2))).toEqual({ ok: false, reason: 'too-many' });
  });
});

describe('interpolateToRaster', () => {
  it('reproduces a linear field exactly (jittered points, whole extent covered)', () => {
    const c = lattice(40, 30, 0.1, 0.4);
    const f = (lon: number, lat: number) => 3 * lon + 2 * lat + 1;
    const v = linear(c, f);
    const tri = buildTriangulation(c);
    const r = interpolateToRaster(tri, c, v, 200);
    expect(r.width * r.height).toBe(r.values.length);
    let finite = 0;
    for (let j = 0; j < r.height; j++) {
      for (let i = 0; i < r.width; i++) {
        const got = r.values[j * r.width + i];
        if (Number.isNaN(got)) continue;
        finite++;
        expect(got).toBeCloseTo(f(r.x0 + i * r.dx, r.y0 + j * r.dy), 4);
      }
    }
    expect(finite).toBe(r.values.length); // rectangle hull: every cell centre is inside
  });

  it('is NaN outside the hull (triangle-shaped data in a rectangular extent)', () => {
    // points of a lattice restricted to the lower-left triangle i + j <= 20
    const pts: number[] = [];
    for (let j = 0; j <= 20; j++) for (let i = 0; i <= 20 - j; i++) pts.push(i * 0.1, j * 0.1);
    const c = Float64Array.from(pts);
    const tri = buildTriangulation(c);
    const r = interpolateToRaster(tri, c, linear(c, (x, y) => x + y), 101);
    expect(Number.isNaN(r.values[0])).toBe(false); // south-west corner
    expect(Number.isNaN(r.values[r.width - 1])).toBe(false); // south-east corner is a data point
    expect(Number.isNaN(r.values[(r.height - 1) * r.width + r.width - 1])).toBe(true); // north-east corner: outside
    expect(Number.isNaN(r.values[(r.height - 1) * r.width + (r.width >> 1) + 5])).toBe(true);
  });

  it('is NaN in the gap between clusters and for triangles with a no-data vertex', () => {
    const a = lattice(10, 10, 0.1, 0, 0, 0);
    const b = lattice(10, 10, 0.1, 0, 10, 0);
    const c = new Float64Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    const v = linear(c, () => 5);
    const r = interpolateToRaster(buildTriangulation(c), c, v, 200);
    const at = (lon: number, lat: number) => r.values[Math.round((lat - r.y0) / r.dy) * r.width + Math.round((lon - r.x0) / r.dx)];
    expect(at(0.5, 0.5)).toBeCloseTo(5);
    expect(at(10.5, 0.5)).toBeCloseTo(5);
    expect(at(5, 0.5)).toBeNaN();

    // a no-data point leaves a hole of its surrounding triangles
    const d = lattice(11, 11, 0.1);
    const vd = linear(d, () => 1);
    vd[5 * 11 + 5] = NaN;
    const r2 = interpolateToRaster(buildTriangulation(d), d, vd, 101);
    expect(r2.values[50 * 101 + 50]).toBeNaN(); // at the missing point
    expect(r2.values[5 * 101 + 5]).toBeCloseTo(1);
  });

  it('rasterSize keeps square cells and caps the longer side', () => {
    expect(rasterSize([0, 0, 10, 5], 101)).toEqual({ width: 101, height: 51 });
    expect(rasterSize([0, 0, 1, 4], 101)).toEqual({ width: 26, height: 101 });
    expect(rasterSize([3, 3, 3, 3])).toEqual({ width: 2, height: 2 });
  });
});

describe('computeContours', () => {
  const c = lattice(40, 30, 0.1, 0.3);
  const f = (lon: number, lat: number) => 3 * lon + 2 * lat; // 0 … 3.9*3+2.9*2 = 17.5
  const v = linear(c, f);
  const tri = buildTriangulation(c);
  const [min, max] = [0, 17.5];
  const set = computeContours(tri, c, v, min, max)!;

  it('has one stacked band per pair of nice levels, with colours rising across the range', () => {
    expect(set.levels).toEqual(contourLevels(min, max));
    expect(set.bands).toHaveLength(set.levels.length - 1);
    set.bands.forEach((b, k) => {
      expect(b.lower).toBe(set.levels[k]);
      expect(b.upper).toBe(set.levels[k + 1]);
      if (k > 0) expect(b.t).toBeGreaterThan(set.bands[k - 1].t);
      expect(b.coordinates.length).toBeGreaterThan(0);
    });
  });

  it('boundary vertices lie on the iso-line of a linear field and the region areas match the analytic ones', () => {
    const [w, s, e, n] = tri.bbox;
    const dx = (e - w) / (set.width - 1);
    set.bands.forEach((b, k) => {
      for (const poly of b.coordinates) {
        for (const ring of poly) {
          for (const [x, y] of ring) {
            const onBorder = x <= w + 1e-9 || x >= e - 1e-9 || y <= s + 1e-9 || y >= n - 1e-9;
            if (!onBorder && k > 0) expect(Math.abs(f(x, y) - b.lower)).toBeLessThan(0.05);
          }
        }
      }
      // area of {f >= lower} within the extent, by fine sampling
      let inside = 0;
      const N = 400;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (f(w + ((i + 0.5) / N) * (e - w), s + ((j + 0.5) / N) * (n - s)) >= b.lower) inside++;
      const analytic = (inside / (N * N)) * (e - w) * (n - s);
      expect(Math.abs(mpArea(b.coordinates) - analytic)).toBeLessThan(0.02 * (e - w) * (n - s) + 2 * dx * dx);
    });
    // regions are nested: areas shrink with the level
    const areas = set.bands.map((b) => mpArea(b.coordinates));
    for (let k = 1; k < areas.length; k++) expect(areas[k]).toBeLessThanOrEqual(areas[k - 1] + 1e-9);
    // the lowest region is the whole extent
    expect(areas[0]).toBeCloseTo((tri.bbox[2] - tri.bbox[0]) * (tri.bbox[3] - tri.bbox[1]), 2);
  });

  it('puts no polygon across a gap or outside the hull', () => {
    const a = lattice(10, 10, 0.1, 0, 0, 0);
    const b = lattice(10, 10, 0.1, 0, 10, 0);
    const cc = new Float64Array(a.length + b.length);
    cc.set(a);
    cc.set(b, a.length);
    const vv = linear(cc, (x, y) => x + y);
    const r = computeContours(buildTriangulation(cc), cc, vv, 0, 11)!;
    for (const band of r.bands) {
      for (const poly of band.coordinates) {
        for (const ring of poly) {
          const lons = ring.map((p) => p[0]);
          // each ring stays within one cluster
          expect(Math.max(...lons) < 1 || Math.min(...lons) > 9.9).toBe(true);
        }
      }
    }
  });

  it('honours custom levels and raster size, and returns null when there is nothing to draw', () => {
    const r = computeContours(tri, c, v, min, max, { levels: [0, 8, 18], maxPx: 64 })!;
    expect(r.levels).toEqual([0, 8, 18]);
    expect(r.bands).toHaveLength(2);
    expect(Math.max(r.width, r.height)).toBe(64);
    expect(computeContours(tri, c, v, NaN, NaN)).toBeNull();
    const line = new Float64Array([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(computeContours(buildTriangulation(line), line, [1, 2, 3, 4], 1, 4)).toBeNull();
  });

  it('draws nothing for an all-NaN parameter (empty bands)', () => {
    const r = computeContours(tri, c, new Float32Array(c.length / 2).fill(NaN), 0, 1, { levels: [0, 0.5, 1] })!;
    expect(r.bands.every((b) => b.coordinates.length === 0)).toBe(true);
  });
});

describe('timing', () => {
  /** A jittered lattice with `n` points over a 1.6:1 extent. */
  function pointsOf(n: number) {
    const ny = Math.round(Math.sqrt(n / 1.6));
    const nx = Math.round(n / ny);
    return lattice(nx, ny, 0.05, 0.5);
  }
  const f = (lon: number, lat: number) => 280 + 10 * Math.sin(lon * 3) + 8 * Math.cos(lat * 4) + lon;

  for (const [n, budget] of [[2408, 1000], [40_000, 3000]] as const) {
    it(`triangulates, interpolates and contours ${n} points in under ${budget} ms`, () => {
      const c = pointsOf(n);
      const v = linear(c, f);
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of v) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      const t0 = performance.now();
      const tri = buildTriangulation(c);
      const t1 = performance.now();
      const set = computeContours(tri, c, v, lo, hi)!;
      const t2 = performance.now();
      // eslint-disable-next-line no-console
      console.log(`contour ${c.length / 2} points: triangulate ${(t1 - t0).toFixed(0)} ms, interpolate+contour ${(t2 - t1).toFixed(0)} ms`);
      expect(set.bands.length).toBeGreaterThanOrEqual(6);
      expect(t2 - t0).toBeLessThan(budget);
    });
  }
});

describe('area across 0° (polytope delivers 0..360)', () => {
  const layer = parseCoverageJson(liveAreaFrance);
  const coords = layer.coords as Float64Array;
  const param = layer.parameters[0];
  const values = layer.values(param.key, 0);

  it('triangulates into one block spanning 0°: the bbox is -5..8 and a cell at lon 0 has data', () => {
    const tri = getTriangulation(coords);
    expect(tri.bbox[0]).toBeCloseTo(-5, 0);
    expect(tri.bbox[2]).toBeCloseTo(8, 0);
    const r = interpolateToRaster(tri, coords, values, 256);
    const col = Math.round((0 - r.x0) / r.dx);
    const row = Math.round(((tri.bbox[1] + tri.bbox[3]) / 2 - r.y0) / r.dy);
    expect(Number.isNaN(r.values[row * r.width + col])).toBe(false);
    const finite = r.values.reduce((n, v) => n + (Number.isNaN(v) ? 0 : 1), 0);
    expect(finite / r.values.length).toBeGreaterThan(0.8); // a filled block, no gap in the middle
    // nearest() finds a point on both sides of 0°
    const mid = (tri.bbox[1] + tri.bbox[3]) / 2;
    expect(coords[2 * tri.nearest(-3, mid)]).toBeLessThan(-2);
    expect(coords[2 * tri.nearest(3, mid)]).toBeGreaterThan(2);
  });

  it('contour bands have polygons on both sides of 0° and join across it', () => {
    const set = computeContours(getTriangulation(coords), coords, values, param.min, param.max)!;
    expect(set).not.toBeNull();
    const lowest = set.bands.find((b) => b.coordinates.length)!;
    const lons = lowest.coordinates.flatMap((poly) => poly.flatMap((ring) => ring.map((p) => p[0])));
    expect(Math.min(...lons)).toBeLessThan(-4);
    expect(Math.max(...lons)).toBeGreaterThan(7);
    // the lowest band is one connected region (a single exterior ring crossing lon 0)
    const crossing = lowest.coordinates.filter((poly) => {
      const x = poly[0].map((p) => p[0]);
      return Math.min(...x) < 0 && Math.max(...x) > 0;
    });
    expect(crossing.length).toBeGreaterThanOrEqual(1);
    expect(mpArea(lowest.coordinates)).toBeGreaterThan(0.6 * 13 * (getTriangulation(coords).bbox[3] - getTriangulation(coords).bbox[1]));
  });
});

describe('ContourCache', () => {
  /** A set whose polygons hold `vertices` vertices in total (16 bytes each). */
  const setOf = (vertices: number): ContourSet => ({
    levels: [0, 1],
    width: 2,
    height: 2,
    bands: [{ lower: 0, upper: 1, t: 0.5, coordinates: [[Array.from({ length: vertices }, (_, i) => [i, i])]] }],
  });

  it('counts polygon coordinate bytes (16 per vertex; null is free)', () => {
    expect(contourBytes(setOf(10))).toBe(160);
    expect(contourBytes(null)).toBe(0);
  });

  it('evicts the least recently used entry beyond the entry cap, and a get refreshes recency', () => {
    const c = new ContourCache(1e9, 3);
    c.set('a', setOf(1));
    c.set('b', setOf(1));
    c.set('c', setOf(1));
    expect(c.get('a')).toBeDefined(); // a is now the most recent; b the oldest
    c.set('d', setOf(1));
    expect([c.has('a'), c.has('b'), c.has('c'), c.has('d')]).toEqual([true, false, true, true]);
    expect(c.size).toBe(3);
  });

  it('evicts by byte budget, tracks the total, and never stores one set larger than the budget', () => {
    const c = new ContourCache(480, 48); // 30 vertices
    c.set('a', setOf(10));
    c.set('b', setOf(10));
    c.set('c', setOf(10));
    expect(c.bytes).toBe(480);
    c.set('d', setOf(10)); // over budget: a goes
    expect([c.has('a'), c.has('b'), c.has('d')]).toEqual([false, true, true]);
    expect(c.bytes).toBe(480);
    c.set('b', setOf(5)); // replacing keeps the total consistent
    expect(c.bytes).toBe(160 + 160 + 80);
    c.set('huge', setOf(31));
    expect(c.has('huge')).toBe(false);
    expect(c.bytes).toBe(400);
    c.clear();
    expect([c.size, c.bytes]).toEqual([0, 0]);
  });

  it('caches "nothing to draw" (null) as distinct from absent', () => {
    const c = new ContourCache();
    c.set('x', null);
    expect(c.get('x')).toBeNull();
    expect(c.get('y')).toBeUndefined();
  });

  it('defaults: 64 MB and 48 entries', () => {
    const c = new ContourCache();
    expect([c.maxBytes, c.maxEntries]).toEqual([64 * 1024 * 1024, 48]);
  });
});
