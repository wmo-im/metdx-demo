/**
 * Filled contours for scattered EDR point results (area / radius / cube → MultiPoint), in the style of
 * matplotlib `tricontourf` / earthkit-plots `contourf`. Pure: no OpenLayers / React / DOM.
 *
 * Pipeline: Delaunay triangulation of the points (lon/lat, cached per coordinate array) → barycentric linear
 * interpolation of one parameter onto a regular raster → d3-contour isobands. Raster cells outside the
 * triangulation, inside a triangle with a long edge (a hull that spans a gap, see {@link MAX_EDGE_FACTOR}) or inside
 * a triangle with a no-data vertex are no-data (`NaN`) and produce no polygon.
 *
 * The result is a set of *stacked* regions: band `k` is the region where `value >= levels[k]`. Drawing them in order,
 * each opaque in the colour of its band, gives the filled-contour picture without needing polygon differences.
 */
import { contours as d3Contours } from 'd3-contour';
import { Delaunay } from 'd3-delaunay';
import type { ColourScale, RGBA } from './covjsonTypes';

/** Above this many points the result is drawn as points instead (triangulating + contouring would be too slow). */
export const MAX_CONTOUR_POINTS = 50_000;
/** Default raster size: cells along the longer side of the data extent. */
export const DEFAULT_RASTER_PX = 512;
/** Default number of colour bands aimed for ({@link contourLevels} rounds to nice numbers: 7–14 in practice). */
export const DEFAULT_BAND_COUNT = 10;
/** A triangle with an edge longer than this many times the median edge is a gap-spanning sliver and is dropped. */
export const MAX_EDGE_FACTOR = 3;
/** A click further than this many median edges from the nearest point is "not on the data". */
export const NEAREST_EDGE_FACTOR = 2;

/** GeoJSON MultiPolygon coordinates `[polygon][ring][vertex] = [lon, lat]`. */
export type MultiPolygonCoords = number[][][][];

/** Triangulation of a point set: geometry only (no values), so it is reusable for every parameter and time. */
export interface Triangulation {
  /** Number of input points. */
  readonly n: number;
  /** `[west, south, east, north]` of the points. */
  readonly bbox: readonly [number, number, number, number];
  /** Vertex indices (into the points) of the kept triangles, three per triangle. */
  readonly triangles: Uint32Array;
  /** Median length (degrees) of the triangle edges; `0` when there are no triangles. */
  readonly medianEdge: number;
  /** Index of the point nearest to `lon, lat`, or `-1` when it is farther than {@link NEAREST_EDGE_FACTOR} median edges. */
  nearest(lon: number, lat: number): number;
}

/** Triangulate flat `[lon, lat, …]` pairs; drops triangles with an edge longer than `maxEdgeFactor` × the median edge. */
export function buildTriangulation(coords: Float64Array, maxEdgeFactor = MAX_EDGE_FACTOR): Triangulation {
  const n = coords.length >> 1;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let nn = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > nn) nn = y;
  }
  const bbox = [w, s, e, nn] as const;
  // d3-delaunay jiggles collinear input in place, so give it a copy: the caller's coordinates stay untouched.
  const delaunay = new Delaunay(coords.slice());
  const tris = delaunay.triangles;
  const nt = tris.length / 3;

  const edge = (a: number, b: number) => Math.hypot(coords[2 * a] - coords[2 * b], coords[2 * a + 1] - coords[2 * b + 1]);
  const lens = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = tris[3 * t];
    const b = tris[3 * t + 1];
    const c = tris[3 * t + 2];
    lens[3 * t] = edge(a, b);
    lens[3 * t + 1] = edge(b, c);
    lens[3 * t + 2] = edge(c, a);
  }
  const sorted = lens.slice().sort();
  const medianEdge = nt > 0 ? sorted[sorted.length >> 1] : 0;

  const limit = medianEdge * maxEdgeFactor;
  const keep: number[] = [];
  for (let t = 0; t < nt; t++) {
    if (lens[3 * t] > limit || lens[3 * t + 1] > limit || lens[3 * t + 2] > limit) continue;
    // d3-delaunay emits zero-area triangles for collinear input (so that `find` works): they carry no area.
    const a = tris[3 * t];
    const b = tris[3 * t + 1];
    const c = tris[3 * t + 2];
    const cross = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]);
    if (Math.abs(cross) <= 1e-12 * Math.max(lens[3 * t], lens[3 * t + 1], lens[3 * t + 2]) ** 2) continue;
    keep.push(a, b, c);
  }
  const maxNearest = medianEdge * NEAREST_EDGE_FACTOR;
  return {
    n,
    bbox,
    triangles: Uint32Array.from(keep),
    medianEdge,
    nearest(lon, lat) {
      if (n === 0 || nt === 0) return -1;
      const i = delaunay.find(lon, lat);
      return Math.hypot(coords[2 * i] - lon, coords[2 * i + 1] - lat) <= maxNearest ? i : -1;
    },
  };
}

const triangulations = new WeakMap<Float64Array, Triangulation>();

/** {@link buildTriangulation} with the default options, cached per coordinate array (i.e. per DataLayer). */
export function getTriangulation(coords: Float64Array): Triangulation {
  let t = triangulations.get(coords);
  if (!t) {
    t = buildTriangulation(coords);
    triangulations.set(coords, t);
  }
  return t;
}

/** Whether `coords` can be drawn as contours, and if not why (for the UI note). */
export type ContourSupport = { ok: true } | { ok: false; reason: 'too-few' | 'too-many' | 'no-area' };

export function contourSupport(coords: Float64Array): ContourSupport {
  const n = coords.length >> 1;
  if (n < 3) return { ok: false, reason: 'too-few' };
  if (n > MAX_CONTOUR_POINTS) return { ok: false, reason: 'too-many' };
  return getTriangulation(coords).triangles.length > 0 ? { ok: true } : { ok: false, reason: 'no-area' };
}

/** Round-number step (1, 2 or 5 × 10^k) closest to `raw`. */
function niceStep(raw: number): number {
  const power = Math.floor(Math.log10(raw));
  const err = raw / 10 ** power;
  return (err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1) * 10 ** power;
}

const clean = (v: number) => Number(v.toPrecision(12));

/**
 * Ascending band edges at round numbers that cover `[min, max]`: `levels[0] <= min`, `levels[last] >= max`, about
 * `count` bands (`levels.length - 1`). Flat data (`min === max`) gets one band around the value; no finite range → `[]`.
 */
export function contourLevels(min: number, max: number, count = DEFAULT_BAND_COUNT): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  if (max === min) {
    const d = Math.abs(min) * 0.01 || 1;
    return [clean(min - d), clean(min + d)];
  }
  const step = niceStep((max - min) / Math.max(1, count));
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  const levels: number[] = [];
  for (let k = first; k <= last; k++) levels.push(clean(k * step));
  return levels;
}

/** Position in `[0, 1]` on the colour scale of the band `[lower, upper]` (its midpoint within `[min, max]`). */
export function bandColourT(lower: number, upper: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return Math.min(1, Math.max(0, ((lower + upper) / 2 - min) / (max - min)));
}

/** Colour of the band `[lower, upper]`. */
export function bandColour(scale: ColourScale, lower: number, upper: number, min: number, max: number): RGBA {
  return scale.fn(bandColourT(lower, upper, min, max));
}

/** Raster of linearly interpolated values; row 0 is the southernmost row, `NaN` = no data. */
export interface Raster {
  width: number;
  height: number;
  values: Float32Array;
  /** Longitude / latitude of cell `(0, 0)` and the cell spacing in degrees. */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
}

/** Raster dimensions for an extent: square cells in degrees, `maxPx` cells along the longer side, both sides ≥ 2. */
export function rasterSize(bbox: readonly [number, number, number, number], maxPx = DEFAULT_RASTER_PX): { width: number; height: number } {
  const ex = bbox[2] - bbox[0];
  const ey = bbox[3] - bbox[1];
  const cell = Math.max(ex, ey) / Math.max(1, maxPx - 1);
  if (!(cell > 0)) return { width: 2, height: 2 };
  return { width: Math.max(2, Math.round(ex / cell) + 1), height: Math.max(2, Math.round(ey / cell) + 1) };
}

/**
 * Barycentric linear interpolation of `values` (one per point) over the triangles of `tri` onto a raster whose cell
 * centres span the point extent edge to edge. Cells not inside a kept triangle with three valid vertices are `NaN`.
 */
export function interpolateToRaster(tri: Triangulation, coords: Float64Array, values: ArrayLike<number>, maxPx = DEFAULT_RASTER_PX): Raster {
  const { width, height } = rasterSize(tri.bbox, maxPx);
  const [x0, y0, x1, y1] = tri.bbox;
  const dx = (x1 - x0) / (width - 1);
  const dy = (y1 - y0) / (height - 1);
  const out = new Float32Array(width * height).fill(NaN);
  const T = tri.triangles;
  const EPS = 1e-9;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t];
    const b = T[t + 1];
    const c = T[t + 2];
    const va = values[a];
    const vb = values[b];
    const vc = values[c];
    if (Number.isNaN(va) || Number.isNaN(vb) || Number.isNaN(vc)) continue;
    const ax = coords[2 * a];
    const ay = coords[2 * a + 1];
    const bx = coords[2 * b];
    const by = coords[2 * b + 1];
    const cx = coords[2 * c];
    const cy = coords[2 * c + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / dx - EPS));
    const i1 = Math.min(width - 1, Math.floor((Math.max(ax, bx, cx) - x0) / dx + EPS));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / dy - EPS));
    const j1 = Math.min(height - 1, Math.floor((Math.max(ay, by, cy) - y0) / dy + EPS));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * dy;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * dx;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 >= -EPS && l2 >= -EPS && l3 >= -EPS) out[j * width + i] = l1 * va + l2 * vb + l3 * vc;
      }
    }
  }
  return { width, height, values: out, x0, y0, dx, dy };
}

/** One colour band of a {@link ContourSet}. */
export interface ContourBand {
  /** Band edges: the band is `lower <= value < upper` (the last band includes `upper`). */
  lower: number;
  upper: number;
  /** Position of the band midpoint in the data range, for the colour scale (see {@link bandColourT}). */
  t: number;
  /** Stacked region `value >= lower`, lon/lat. Empty when no cell reaches `lower`. */
  coordinates: MultiPolygonCoords;
}

export interface ContourSet {
  /** The band edges, ascending; `bands.length === levels.length - 1`. */
  levels: number[];
  /** Ascending; draw in this order, each polygon opaque, so higher bands paint over lower ones. */
  bands: ContourBand[];
  width: number;
  height: number;
}

export interface ContourOptions {
  /** Band edges (ascending, ≥ 2); default {@link contourLevels} of `min`, `max`. */
  levels?: number[];
  /** Raster cells along the longer side (default {@link DEFAULT_RASTER_PX}). */
  maxPx?: number;
}

/**
 * Filled contours of `values` (one per point of `coords`) over the triangulation `tri`. `min`/`max` is the data range
 * that sets the band edges and colours. Returns `null` when there is nothing to draw (no triangles, no finite range).
 */
export function computeContours(
  tri: Triangulation,
  coords: Float64Array,
  values: ArrayLike<number>,
  min: number,
  max: number,
  opts: ContourOptions = {},
): ContourSet | null {
  const levels = opts.levels ?? contourLevels(min, max);
  if (levels.length < 2 || tri.triangles.length === 0) return null;
  const r = interpolateToRaster(tri, coords, values, opts.maxPx);
  // d3-contour treats NaN as "below every threshold" and, when smoothing, puts the boundary on the valid sample.
  // (the typings only admit number[]; typed arrays work at runtime and avoid a 262k-element copy)
  const regions = d3Contours().size([r.width, r.height]).smooth(true).thresholds(levels.slice(0, -1))(r.values as unknown as number[]);
  const [west, south, east, north] = tri.bbox;
  // d3 coordinates: sample (i, j) sits at (i + 0.5, j + 0.5); the border ring may overshoot by half a cell: clamp.
  const toLon = (gx: number) => Math.min(east, Math.max(west, r.x0 + (gx - 0.5) * r.dx));
  const toLat = (gy: number) => Math.min(north, Math.max(south, r.y0 + (gy - 0.5) * r.dy));
  const bands: ContourBand[] = regions.map((g, k) => ({
    lower: levels[k],
    upper: levels[k + 1],
    t: bandColourT(levels[k], levels[k + 1], min, max),
    coordinates: g.coordinates.map((poly) => poly.map((ring) => ring.map((p) => [toLon(p[0]), toLat(p[1])]))),
  }));
  return { levels, bands, width: r.width, height: r.height };
}
