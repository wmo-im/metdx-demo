/**
 * CoverageJSON → {@link DataLayer} parser with a tolerant normaliser.
 *
 * Accepts a standard CoverageJSON `Coverage` or `CoverageCollection` and the ECMWF flavour of it:
 * - axes named `latitude` / `longitude` / `levelist` instead of `y` / `x` / `z`;
 * - a `composite` tuple axis whose element order comes from its `coordinates` (lat-lon, not x-y);
 * - range `axisNames` that are wrong (e.g. `["2t"]`): the order is then derived from the domain;
 * - `domainType` only on the collection (inherited by its coverages).
 *
 * Output follows the contract in `covjsonTypes.ts`. Inputs above {@link MAX_POINTS} /
 * {@link MAX_GRID_CELLS} throw {@link TooLargeToDraw}; shapes this parser cannot draw throw
 * {@link CovJsonError}.
 */
import {
  MAX_GRID_CELLS,
  MAX_POINTS,
  TooLargeToDraw,
  type DataLayer,
  type GridSpec,
  type ParamInfo,
} from './covjsonTypes';

/** Thrown for input that is not (drawable) CoverageJSON. `message` is fit to show to the user. */
export class CovJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CovJsonError';
  }
}

/** A {@link DataLayer} plus the vertical levels of the source (when the domain has a z axis). */
export interface CovJsonLayer extends DataLayer {
  /** Values of the z axis (e.g. `levelist`), `[]` when there is none. */
  levels: number[];
  /** Index into {@link levels} that {@link DataLayer.values} reads (always 0 when there is no z axis). */
  levelIndex: number;
}

export interface ParseOptions {
  /** Which z-axis level to draw when the domain has several (default 0). Clamped to the axis. */
  levelIndex?: number;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Canon = 'x' | 'y' | 'z' | 't' | 'c';

const NAME_TO_CANON: Record<string, Canon> = {
  x: 'x',
  lon: 'x',
  lng: 'x',
  long: 'x',
  longitude: 'x',
  y: 'y',
  lat: 'y',
  latitude: 'y',
  z: 'z',
  level: 'z',
  levelist: 'z',
  height: 'z',
  t: 't',
  time: 't',
};

/** Order used to guess a range's dimension order when its `axisNames` are unusable. */
const FALLBACK_ORDER: Canon[] = ['t', 'z', 'y', 'x', 'c'];

function canonName(name: string): Canon | undefined {
  return NAME_TO_CANON[name.toLowerCase()];
}

interface Axis {
  /** Original key in `domain.axes`. */
  key: string;
  /** Declared number of values; known without expanding a compact `start`/`stop`/`num` axis. */
  length: number;
  /** The values; a compact axis is only expanded on first access (after the size checks). */
  readonly values: unknown[];
  /** For composite axes: canonical names of the tuple elements, in order. */
  tuple?: (Canon | undefined)[];
}

/** Declared length of an axis: explicit `values`, or `num` of a numeric `start`/`stop`/`num` range. */
function axisLength(key: string, a: Json): number {
  if (Array.isArray(a?.values)) return a.values.length;
  if (typeof a?.start === 'number' && typeof a?.stop === 'number' && Number.isInteger(a?.num) && a.num >= 1) return a.num;
  throw new CovJsonError(`Unsupported axis "${key}" (no values)`);
}

/** Expand an axis (explicit `values`, or a numeric `start`/`stop`/`num` range). Only call after the size checks. */
function expandAxis(a: Json): unknown[] {
  if (Array.isArray(a.values)) return a.values;
  const n: number = a.num;
  if (n === 1) return [a.start];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a.start + ((a.stop - a.start) * i) / (n - 1);
  return out;
}

/** Collect the domain's axes by canonical name. */
function readAxes(domain: Json): { axes: Partial<Record<Canon, Axis>>; keyToCanon: Map<string, Canon> } {
  const raw = domain?.axes;
  if (!raw || typeof raw !== 'object') throw new CovJsonError('Coverage has no domain axes');
  const axes: Partial<Record<Canon, Axis>> = {};
  const keyToCanon = new Map<string, Canon>();
  for (const [key, a] of Object.entries<Json>(raw)) {
    if (!a || typeof a !== 'object') continue;
    const isComposite = Array.isArray(a.values) && (a.dataType === 'tuple' || Array.isArray(a.coordinates));
    if (a.dataType === 'polygon') throw new CovJsonError('Polygon axes are not supported');
    const c: Canon | undefined = isComposite ? 'c' : canonName(key);
    if (!c || axes[c]) continue; // ignore unknown / duplicate axes
    const length = axisLength(key, a);
    let cache: unknown[] | undefined;
    const axis: Axis = {
      key,
      length,
      get values() {
        return (cache ??= expandAxis(a));
      },
    };
    if (isComposite) {
      const names: unknown = a.coordinates;
      axis.tuple = (Array.isArray(names) ? names : ['x', 'y', 'z']).map((n) => canonName(String(n)));
    }
    axes[c] = axis;
    keyToCanon.set(key, c);
  }
  return { axes, keyToCanon };
}

/** Last path segment of a (possibly URI-valued) domainType, e.g. `.../Grid` → `Grid`. */
function domainTypeOf(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return v.split(/[/#]/).filter(Boolean).pop();
}

type Kind = DataLayer['kind'];

function kindOf(domainType: string | undefined, axes: Partial<Record<Canon, Axis>>): Kind {
  switch (domainType) {
    case 'Grid':
      return 'grid';
    case 'Point':
    case 'PointSeries':
    case 'MultiPoint':
    case 'MultiPointSeries':
      return 'points';
    case 'Trajectory':
      return 'trajectory';
    case 'VerticalProfile':
    case 'Section':
    case 'PolygonSeries':
    case 'MultiPolygon':
    case 'MultiPolygonSeries':
      throw new CovJsonError(`Domain type ${domainType} cannot be drawn on the map`);
    default:
      break;
  }
  const c = axes.c;
  if (c) return c.tuple?.includes('t') ? 'trajectory' : 'points';
  return (axes.x?.length ?? 0) > 1 || (axes.y?.length ?? 0) > 1 ? 'grid' : 'points';
}

interface Dim {
  canon: Canon;
  size: number;
  stride: number;
}

/**
 * Dimensions (outermost first, with strides) of a range. Uses `axisNames` when they name domain axes
 * with matching sizes, else falls back to t, z, y, x, composite order over the axes longer than 1.
 */
function rangeDims(
  rangeKey: string,
  range: Json,
  axes: Partial<Record<Canon, Axis>>,
  keyToCanon: Map<string, Canon>,
): Dim[] {
  const shape: unknown = range.shape;
  if (!Array.isArray(shape) || !shape.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new CovJsonError(`Range "${rangeKey}" has no valid shape`);
  }
  const sizes = shape as number[];
  let order: Canon[] | undefined;
  const names: unknown = range.axisNames;
  if (Array.isArray(names) && names.length === sizes.length) {
    const cs = names.map((n) => keyToCanon.get(String(n)) ?? canonName(String(n)));
    const ok =
      cs.every((c, k) => c !== undefined && axes[c] !== undefined && axes[c]!.length === sizes[k]) &&
      new Set(cs).size === cs.length;
    if (ok) order = cs as Canon[];
  }
  let dims: { canon: Canon; size: number }[];
  if (order) {
    dims = order.map((canon, k) => ({ canon, size: sizes[k] }));
  } else {
    const guess = FALLBACK_ORDER.filter((c) => axes[c] && axes[c]!.length > 1);
    const big = sizes.filter((n) => n !== 1);
    if (guess.length !== big.length || guess.some((c, k) => axes[c]!.length !== big[k])) {
      throw new CovJsonError(`Cannot match range "${rangeKey}" (shape [${sizes.join(', ')}]) to the domain axes`);
    }
    dims = guess.map((canon) => ({ canon, size: axes[canon]!.length }));
  }
  const out: Dim[] = new Array(dims.length);
  let stride = 1;
  for (let k = dims.length - 1; k >= 0; k--) {
    out[k] = { ...dims[k], stride };
    stride *= dims[k].size;
  }
  return out;
}

/** The English (else first) string of a CoverageJSON i18n object, or a plain string. */
function i18n(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.en === 'string') return o.en;
    const first = Object.values(o).find((s) => typeof s === 'string');
    if (typeof first === 'string') return first;
  }
  return '';
}

function unitOf(p: Json | undefined): string {
  const u = p?.unit;
  if (!u) return '';
  if (typeof u === 'string') return u;
  const sym = u.symbol;
  if (typeof sym === 'string') return sym;
  if (sym && typeof sym === 'object' && typeof sym.value === 'string') return sym.value;
  return i18n(u.label);
}

/** One coverage, reduced to what is needed to extract values. */
interface Part {
  /** Number of spatial positions (points) or cells (grid). */
  spatial: number;
  /** Number of time steps (1 when none). */
  nTimes: number;
  /** Per-param raw range + dims. */
  ranges: Map<string, { raw: unknown[]; dims: Dim[] }>;
  /** Grid only: flip flags and sizes. */
  nx: number;
  ny: number;
  flipX: boolean;
  flipY: boolean;
}

function strictOrder(key: string, v: number[]): 'asc' | 'desc' {
  if (v.length < 2) return 'asc';
  const dir = v[1] > v[0] ? 'asc' : 'desc';
  for (let i = 1; i < v.length; i++) {
    if (!(dir === 'asc' ? v[i] > v[i - 1] : v[i] < v[i - 1])) {
      throw new CovJsonError(`Grid axis "${key}" is not strictly monotonic`);
    }
  }
  return dir;
}

/** The painter and click lookup assume equal spacing: reject axes whose steps differ by more than ~1e-3 of the step. */
function requireUniform(v: number[]): void {
  if (v.length < 3) return;
  const step = (v[v.length - 1] - v[0]) / (v.length - 1);
  const tol = Math.abs(step) * 1e-3;
  for (let i = 1; i < v.length; i++) {
    if (Math.abs(v[i] - v[i - 1] - step) > tol) throw new CovJsonError('non-uniform grid not supported');
  }
}

function numericAxis(a: Axis): number[] {
  const out = new Array<number>(a.values.length);
  for (let i = 0; i < out.length; i++) {
    const n = Number(a.values[i]);
    if (typeof a.values[i] === 'boolean' || a.values[i] === null || !Number.isFinite(n)) {
      throw new CovJsonError(`Axis "${a.key}" has a non-numeric value at index ${i}`);
    }
    out[i] = n;
  }
  return out;
}

/** Fill `out` with the values of one range for time step `ti` (and z level `zi`). */
function extract(part: Part, p: { raw: unknown[]; dims: Dim[] }, grid: boolean, ti: number, zi: number, out: Float32Array): void {
  let base = 0;
  let stT = 0;
  let stC = 0;
  let stY = 0;
  let stX = 0;
  for (const d of p.dims) {
    if (d.canon === 't') stT = d.stride;
    else if (d.canon === 'z') base += zi * d.stride;
    else if (d.canon === 'c') stC = d.stride;
    else if (d.canon === 'y') stY = d.stride;
    else stX = d.stride;
  }
  base += ti * stT;
  const raw = p.raw;
  const num = (v: unknown): number => (typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v));
  if (grid) {
    const { nx, ny, flipX, flipY } = part;
    for (let j = 0; j < ny; j++) {
      const rj = base + (flipY ? ny - 1 - j : j) * stY;
      const row = j * nx;
      for (let i = 0; i < nx; i++) out[row + i] = num(raw[rj + (flipX ? nx - 1 - i : i) * stX]);
    }
  } else {
    for (let s = 0; s < part.spatial; s++) out[s] = num(raw[base + s * stC]);
  }
}

/**
 * Parse a CoverageJSON `Coverage` / `CoverageCollection` (standard or ECMWF-style) into a
 * {@link DataLayer}.
 * @throws TooLargeToDraw above {@link MAX_POINTS} / {@link MAX_GRID_CELLS}
 * @throws CovJsonError for anything that is not drawable CoverageJSON
 */
export function parseCoverageJson(json: unknown, options: ParseOptions = {}): CovJsonLayer {
  const root = json as Json;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new CovJsonError('Not a CoverageJSON object');

  let coverages: Json[];
  if (root.type === 'CoverageCollection') {
    coverages = Array.isArray(root.coverages) ? root.coverages : [];
  } else if (root.type === 'Coverage' || (root.domain && root.ranges)) {
    coverages = [root];
  } else {
    throw new CovJsonError('Not a CoverageJSON Coverage or CoverageCollection');
  }
  coverages = coverages.filter((c) => c && typeof c === 'object');
  if (!coverages.length) throw new CovJsonError('CoverageCollection has no coverages');

  const projected = (root.referencing ?? coverages[0].domain?.referencing) as Json[] | undefined;
  if (Array.isArray(projected) && projected.some((r) => r?.system?.type === 'ProjectedCRS')) {
    throw new CovJsonError('Projected coordinate systems are not supported (expected longitude/latitude)');
  }

  // ---- Per-coverage structure -------------------------------------------------------------
  interface Cov {
    cov: Json;
    kind: Kind;
    axes: Partial<Record<Canon, Axis>>;
    keyToCanon: Map<string, Canon>;
  }
  const covs: Cov[] = coverages.map((cov) => {
    const domain = cov.domain as Json;
    const { axes, keyToCanon } = readAxes(domain);
    const kind = kindOf(domainTypeOf(domain?.domainType) ?? domainTypeOf(cov.domainType) ?? domainTypeOf(root.domainType), axes);
    return { cov, kind, axes, keyToCanon };
  });
  const kind = covs[0].kind;
  if (covs.some((c) => c.kind !== kind)) throw new CovJsonError('Coverages of different domain types cannot be combined');
  if (kind === 'grid' && covs.length > 1) throw new CovJsonError('Collections of several grids are not supported');

  // ---- Size checks (before any heavy work) ------------------------------------------------
  if (kind === 'grid') {
    const { x, y } = covs[0].axes;
    if (!x || !y) throw new CovJsonError('Grid needs x (longitude) and y (latitude) axes');
    const cells = x.length * y.length;
    if (cells > MAX_GRID_CELLS) throw new TooLargeToDraw('cells', cells, MAX_GRID_CELLS);
  } else {
    let total = 0;
    for (const c of covs) {
      total += c.axes.c ? c.axes.c.length : 1;
      if (total > MAX_POINTS) throw new TooLargeToDraw('points', total, MAX_POINTS);
    }
  }

  // Every other axis (time, level, ...) is bounded too, so that no compact axis is expanded unchecked.
  for (const c of covs) {
    for (const a of Object.values(c.axes)) {
      if (a && a.length > MAX_GRID_CELLS) throw new TooLargeToDraw('cells', a.length, MAX_GRID_CELLS);
    }
  }

  // ---- Parameters -------------------------------------------------------------------------
  const meta: Record<string, Json> = { ...(root.parameters ?? {}), ...(covs[0].cov.parameters ?? {}) };
  const rangeKeys = Object.entries<Json>(covs[0].cov.ranges ?? {})
    .filter(([, r]) => r && typeof r === 'object' && Array.isArray(r.values) && r.dataType !== 'string')
    .map(([k]) => k);
  if (!rangeKeys.length) throw new CovJsonError('Coverage has no numeric data ranges');

  // ---- Time and level ---------------------------------------------------------------------
  const first = covs[0];
  const separateT = first.axes.t?.values ?? [];
  const compositeHasT = kind === 'trajectory' && !!first.axes.c?.tuple?.includes('t');
  const times: string[] = compositeHasT ? [] : separateT.map(String);
  const nTimes = Math.max(times.length, 1);
  const zAxis = first.axes.z;
  const levels = zAxis ? zAxis.values.map((v) => Number(v)) : [];
  const levelIndex = zAxis ? Math.min(Math.max(Math.trunc(options.levelIndex ?? 0) || 0, 0), levels.length - 1) : 0;

  // ---- Geometry and parts -----------------------------------------------------------------
  let coords: Float64Array | GridSpec;
  const parts: Part[] = [];
  let total = 0;

  const makePart = (c: Cov, spatial: number, g: Pick<Part, 'nx' | 'ny' | 'flipX' | 'flipY'>): Part => {
    const compTimes = c.kind === 'trajectory' && !!c.axes.c?.tuple?.includes('t');
    const n = compTimes ? 1 : Math.max(c.axes.t?.length ?? 0, 1);
    if (n !== nTimes) throw new CovJsonError('Coverages with different time axes cannot be combined');
    const ranges = new Map<string, { raw: unknown[]; dims: Dim[] }>();
    const rs = (c.cov.ranges ?? {}) as Record<string, Json>;
    for (const key of rangeKeys) {
      const r = rs[key];
      if (!r || !Array.isArray(r.values)) throw new CovJsonError(`Coverage is missing range "${key}"`);
      const dims = rangeDims(key, r, c.axes, c.keyToCanon);
      const expected = dims.reduce((a, d) => a * d.size, 1);
      if (r.values.length !== expected) {
        throw new CovJsonError(`Range "${key}" has ${r.values.length} values, expected ${expected}`);
      }
      ranges.set(key, { raw: r.values, dims });
    }
    return { spatial, nTimes: n, ranges, ...g };
  };

  if (kind === 'grid') {
    const c = covs[0];
    const xv = numericAxis(c.axes.x!);
    const yv = numericAxis(c.axes.y!);
    const flipX = strictOrder(c.axes.x!.key, xv) === 'desc';
    const flipY = strictOrder(c.axes.y!.key, yv) === 'desc';
    requireUniform(xv);
    requireUniform(yv);
    if (flipX) xv.reverse();
    if (flipY) yv.reverse();
    coords = { x: Float64Array.from(xv), y: Float64Array.from(yv) };
    parts.push(makePart(c, xv.length * yv.length, { nx: xv.length, ny: yv.length, flipX, flipY }));
    total = xv.length * yv.length;
  } else {
    for (const c of covs) total += c.axes.c ? c.axes.c.length : 1;
    const xy = new Float64Array(total * 2);
    let at = 0;
    for (const c of covs) {
      const comp = c.axes.c;
      let n = 1;
      if (comp) {
        const tuple = comp.tuple!;
        const xi = tuple.indexOf('x');
        const yi = tuple.indexOf('y');
        if (xi < 0 || yi < 0) throw new CovJsonError('Composite axis has no longitude/latitude coordinates');
        n = comp.length;
        for (let k = 0; k < n; k++) {
          const t = comp.values[k];
          if (!Array.isArray(t)) throw new CovJsonError(`Composite axis value ${k} is not a tuple`);
          const lon = typeof t[xi] === 'number' ? t[xi] : NaN;
          const lat = typeof t[yi] === 'number' ? t[yi] : NaN;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new CovJsonError(`Composite axis value ${k} has no valid position`);
          xy[(at + k) * 2] = lon;
          xy[(at + k) * 2 + 1] = lat;
        }
      } else {
        const { x, y } = c.axes;
        if (!x || !y) throw new CovJsonError('Coverage needs x (longitude) and y (latitude) axes');
        if (x.length !== 1 || y.length !== 1) {
          throw new CovJsonError('Point domain with several x/y values is not supported (use a composite axis)');
        }
        const lon = Number(x.values[0]);
        const lat = Number(y.values[0]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new CovJsonError('Point has no valid position');
        xy[at * 2] = lon;
        xy[at * 2 + 1] = lat;
      }
      parts.push(makePart(c, n, { nx: 0, ny: 0, flipX: false, flipY: false }));
      at += n;
    }
    coords = xy;
  }

  // ---- values() ---------------------------------------------------------------------------
  const isGrid = kind === 'grid';
  const key0 = rangeKeys;
  const cache = new Map<string, Float32Array>();
  const CACHE_MAX = 8;

  const fill = (param: string, ti: number): Float32Array => {
    const out = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
      const range = part.ranges.get(param)!;
      const view = out.subarray(at, at + part.spatial);
      extract(part, range, isGrid, ti, levelIndex, view);
      at += part.spatial;
    }
    return out;
  };

  const values = (param: string, timeIndex: number): Float32Array => {
    if (!key0.includes(param)) throw new RangeError(`Unknown parameter "${param}"`);
    if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= nTimes) {
      throw new RangeError(`timeIndex ${timeIndex} out of range (0..${nTimes - 1})`);
    }
    const ck = `${param}\u0000${timeIndex}`;
    const hit = cache.get(ck);
    if (hit) {
      cache.delete(ck);
      cache.set(ck, hit); // most recently used last
      return hit;
    }
    const arr = fill(param, timeIndex);
    cache.set(ck, arr);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return arr;
  };

  // ---- Parameter info (min/max over all times, ignoring NaN) -------------------------------
  const zMulti = levels.length > 1;
  const parameters: ParamInfo[] = rangeKeys.map((key) => {
    let min = Infinity;
    let max = -Infinity;
    const scan = (n: number) => {
      const v = Math.fround(n); // same precision as values()
      if (v < min) min = v;
      if (v > max) max = v;
    };
    if (!zMulti && !isGrid) {
      // Raw scan: every raw value is used exactly once.
      for (const part of parts) for (const v of part.ranges.get(key)!.raw) if (typeof v === 'number' && Number.isFinite(v)) scan(v);
    } else {
      const buf = new Float32Array(total);
      for (let ti = 0; ti < nTimes; ti++) {
        buf.fill(NaN);
        let at = 0;
        for (const part of parts) {
          extract(part, part.ranges.get(key)!, isGrid, ti, levelIndex, buf.subarray(at, at + part.spatial));
          at += part.spatial;
        }
        for (let i = 0; i < buf.length; i++) if (Number.isFinite(buf[i])) scan(buf[i]);
      }
    }
    const m = meta[key];
    const found = min <= max;
    return {
      key,
      label: i18n(m?.observedProperty?.label) || i18n(m?.label) || key,
      unit: unitOf(m) || unitOf(covs[0].cov.ranges?.[key]),
      min: found ? min : NaN,
      max: found ? max : NaN,
    };
  });

  return { kind, parameters, times, coords, values, levels, levelIndex };
}

/**
 * The series of one point over all times of `layer` (for the point-series chart):
 * `{ time, value }` per time step, `value` null where the data is missing. `[]` for layers with no
 * time axis. For a grid layer `index` is the flat cell index.
 */
export function pointSeries(layer: DataLayer, index: number, param: string): { time: string; value: number | null }[] {
  return layer.times.map((time, ti) => {
    const v = layer.values(param, ti)[index];
    return { time, value: v === undefined || Number.isNaN(v) ? null : v };
  });
}
