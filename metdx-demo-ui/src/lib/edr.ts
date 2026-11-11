/**
 * EDR (OGC API - Environmental Data Retrieval) helpers: query-URL builder and
 * collection / instance metadata parsing. Port of `_build_edr_url` and the
 * metadata handling in the Flet app (`metdx-demo-ui/src/views/edr_map.py`).
 *
 * The builder is a pure function over {@link EdrQuery}. It already knows every
 * mode; the UI decides which modes it offers via {@link IMPLEMENTED_MODES}
 * (T3b adds trajectory/radius/corridor/cube there).
 *
 * Coordinates: `points` are `[lon, lat]` (same order as GeoJSON / the map
 * contract); the Flet app stored `(lat, lon)`. Output format is identical.
 */
import type { BBox, DrawKind, Geometry, Position } from './types';

export type EdrMode = 'position' | 'area' | 'trajectory' | 'radius' | 'cube' | 'corridor';

/** Same order as the Flet toolbar. */
export const EDR_MODES: readonly EdrMode[] = ['position', 'area', 'trajectory', 'radius', 'cube', 'corridor'];

/** Modes this UI can build and run (all of them since T3b). */
export const IMPLEMENTED_MODES: readonly EdrMode[] = EDR_MODES;

/** Units offered for the radius (`within-units`). The Flet app only had degrees. */
export const RADIUS_UNITS: readonly string[] = ['degrees', 'km', 'm', 'mi'];
/** Units offered for the corridor width (`width-units`). */
export const WIDTH_UNITS: readonly string[] = ['degrees', 'km', 'm', 'mi'];
/** Units offered for the optional corridor height (`height-units`). */
export const HEIGHT_UNITS: readonly string[] = ['m', 'km', 'hPa'];

/** Job polling (Flet: every 5 s, up to 60 times). Mutable so tests can speed it up. */
export const EDR_JOB: { pollIntervalMs: number; maxPolls: number } = { pollIntervalMs: 5_000, maxPolls: 60 };

export const MODE_HELP: Record<EdrMode, string> = {
  position: 'Draw a single point on the map',
  area: 'Draw a rectangle or a free polygon on the map',
  trajectory: 'Draw a path on the map (double-click to finish)',
  radius: 'Draw the centre on the map, then set the radius and its units',
  cube: "Draw the cube's bounding box on the map",
  corridor: 'Draw the corridor path on the map (double-click to finish), then set its width',
};

/** What the map should let the user draw for each mode. */
export const DRAW_KIND: Record<EdrMode, DrawKind> = {
  position: 'point',
  area: 'bbox',
  trajectory: 'line',
  radius: 'point',
  cube: 'bbox',
  corridor: 'line',
};

/** How an `area` query is drawn: a rectangle (two corners) or a free polygon (any number of vertices). */
export type AreaShape = 'rectangle' | 'polygon';
export const AREA_SHAPES: readonly AreaShape[] = ['rectangle', 'polygon'];

/** What the map should let the user draw: like {@link DRAW_KIND}, but `area` can be a free polygon (cube is bbox only). */
export function drawKindFor(mode: EdrMode, areaShape: AreaShape = 'rectangle'): DrawKind {
  return mode === 'area' && areaShape === 'polygon' ? 'polygon' : DRAW_KIND[mode];
}

/** ECMWF pressure-level parameters that need a vertical level (`z`). */
export const LEVEL_PARAMS: ReadonlySet<string> = new Set(['t', 'u', 'v', 'w', 'gh', 'r', 'q', 'd', 'vo', 'pv']);

/** Pressure levels (hPa) offered when a level parameter is selected. */
export const COMMON_LEVELS: readonly string[] = ['1000', '925', '850', '700', '500', '400', '300', '250', '200', '100', '50'];

export const DEFAULT_RADIUS_UNITS = 'degrees';
export const DEFAULT_WIDTH_UNITS = 'degrees';
/** Corridor height prefilled in the UI (with `m`): the live DestinE server fails without one. */
export const DEFAULT_CORRIDOR_HEIGHT = '10';

export function isEdrMode(s: string): s is EdrMode {
  return (EDR_MODES as readonly string[]).includes(s);
}

/** Does any selected parameter need a vertical level? */
export function needsLevel(params: readonly string[]): boolean {
  return params.some((p) => LEVEL_PARAMS.has(p));
}

/* ------------------------------------------------------------ number format */

/**
 * Format like Python's `str(float)` for the values we emit: whole numbers keep
 * a `.0` (`10.0`), everything else is the shortest round-trip form.
 */
export function pyFloat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  return String(n);
}

/** Parse a number from a text field (Python `float()` semantics, minus nan/inf). */
export function parseNumber(s: string | null | undefined): number | null {
  if (s == null || s.trim() === '') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

/** Round to 3 decimals (the Flet app rounds tapped coordinates like this). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* --------------------------------------------------------------- URL builder */

export interface EdrQuery {
  /** Collection URL (any `?query` is dropped). */
  collectionUrl: string;
  mode: EdrMode;
  /**
   * `[lon, lat]` points: position/radius 1, area/cube 2 corners, trajectory/corridor >= 2.
   * An `area` with `areaShape: 'polygon'` takes the polygon's vertices instead (>= 3; the ring need not be closed).
   */
  points: Position[];
  /** `area` only (default `rectangle`). */
  areaShape?: AreaShape;
  params: readonly string[];
  /** ISO datetime or `start/end`. */
  datetime?: string | null;
  instanceId?: string | null;
  level?: string | null;
  radius?: number | null;
  radiusUnits?: string;
  corridorWidth?: number | null;
  widthUnits?: string;
  /** Optional (not emitted by Flet): `corridor-height` + `height-units`. */
  corridorHeight?: number | null;
  heightUnits?: string;
}

/** Collection URL without query string or trailing slash. */
export function collectionBase(collectionUrl: string): string {
  return collectionUrl.split('?')[0].replace(/\/+$/, '');
}

/** `<collection>?f=json` */
export function collectionJsonUrl(collectionUrl: string): string {
  return `${collectionBase(collectionUrl)}?f=json`;
}

/** `<collection>/instances?f=json` */
export function instancesUrl(collectionUrl: string): string {
  return `${collectionBase(collectionUrl)}/instances?f=json`;
}

/** `<collection>/instances/<id>?f=json` */
export function instanceUrl(collectionUrl: string, id: string): string {
  return `${collectionBase(collectionUrl)}/instances/${id}?f=json`;
}

/** Corner points -> min/max box. */
function cornerBox(points: Position[]): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) };
}

/**
 * Vertices of a free polygon as a closed ring (first point repeated last, as WKT requires): coordinates rounded to
 * 3 decimals, consecutive duplicates (e.g. from a double-click) dropped. Fewer than 4 entries = not a polygon yet.
 */
function polygonRing(points: Position[]): Position[] {
  const ring: Position[] = [];
  for (const p of points) {
    const r: Position = [round3(p[0]), round3(p[1])];
    const last = ring[ring.length - 1];
    if (!last || last[0] !== r[0] || last[1] !== r[1]) ring.push(r);
  }
  while (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  if (ring.length < 3) return [];
  return [...ring, ring[0]];
}

const wktLine = (points: Position[]): string => `LINESTRING(${points.map(([lon, lat]) => `${pyFloat(lon)} ${pyFloat(lat)}`).join(',')})`;
const wktPoint = ([lon, lat]: Position): string => `POINT(${pyFloat(lon)} ${pyFloat(lat)})`;

/**
 * Build the EDR query URL, or `null` while the query is incomplete (not enough
 * points, radius / corridor width missing). Output matches the Flet app.
 */
export function buildEdrUrl(q: EdrQuery): string | null {
  let base = collectionBase(q.collectionUrl);
  if (q.instanceId) base = `${base}/instances/${q.instanceId}`;
  const { points, params } = q;

  const tail = (): string => {
    let s = '';
    if (params.length) s += `&parameter-name=${params.join(',')}`;
    if (q.level && needsLevel(params)) s += `&z=${q.level}`;
    if (q.datetime) s += `&datetime=${q.datetime}`;
    return `${s}&f=json`;
  };

  let endpoint: string;
  let coords: string;
  let extra = '';

  switch (q.mode) {
    case 'position':
      if (points.length < 1) return null;
      endpoint = 'position';
      coords = wktPoint(points[0]);
      break;
    case 'area': {
      if (q.areaShape === 'polygon') {
        const ring = polygonRing(points);
        if (ring.length < 4) return null;
        endpoint = 'area';
        coords = `POLYGON((${ring.map(([lon, lat]) => `${pyFloat(lon)} ${pyFloat(lat)}`).join(',')}))`;
        break;
      }
      if (points.length < 2) return null;
      const { minLon, minLat, maxLon, maxLat } = cornerBox(points);
      const f = pyFloat;
      endpoint = 'area';
      coords =
        `POLYGON((${f(minLon)} ${f(minLat)},${f(maxLon)} ${f(minLat)},` +
        `${f(maxLon)} ${f(maxLat)},${f(minLon)} ${f(maxLat)},${f(minLon)} ${f(minLat)}))`;
      break;
    }
    case 'cube': {
      if (points.length < 2) return null;
      const { minLon, minLat, maxLon, maxLat } = cornerBox(points);
      // bbox=minLon,minLat,maxLon,maxLat (no WKT).
      return `${base}/cube?bbox=${pyFloat(minLon)},${pyFloat(minLat)},${pyFloat(maxLon)},${pyFloat(maxLat)}${tail()}`;
    }
    case 'trajectory':
      if (points.length < 2) return null;
      endpoint = 'trajectory';
      coords = wktLine(points);
      break;
    case 'corridor':
      if (points.length < 2 || q.corridorWidth == null) return null;
      endpoint = 'corridor';
      coords = wktLine(points);
      extra = `&corridor-width=${pyFloat(q.corridorWidth)}&width-units=${q.widthUnits ?? DEFAULT_WIDTH_UNITS}`;
      if (q.corridorHeight != null) {
        extra += `&corridor-height=${pyFloat(q.corridorHeight)}&height-units=${q.heightUnits ?? 'm'}`;
      }
      break;
    case 'radius':
      if (points.length < 1 || q.radius == null) return null;
      endpoint = 'radius';
      coords = wktPoint(points[0]);
      extra = `&within=${pyFloat(q.radius)}&within-units=${q.radiusUnits ?? DEFAULT_RADIUS_UNITS}`;
      break;
  }

  return `${base}/${endpoint}?coords=${coords}${extra}${tail()}`;
}

/* ----------------------------------------------------------------- geometry */

/** The geometry to draw on the map for the current points, or `null` if none. */
export function queryGeometry(mode: EdrMode, points: Position[], areaShape: AreaShape = 'rectangle'): Geometry | null {
  if (!points.length) return null;
  if (mode === 'area' && areaShape === 'polygon') {
    const ring = polygonRing(points);
    if (ring.length) return { type: 'Polygon', coordinates: [ring] };
    return points.length < 2 ? { type: 'Point', coordinates: points[0] } : { type: 'LineString', coordinates: points };
  }
  switch (mode) {
    case 'position':
    case 'radius':
      return { type: 'Point', coordinates: points[0] };
    case 'area':
    case 'cube': {
      if (points.length < 2) return { type: 'Point', coordinates: points[0] };
      const { minLon, minLat, maxLon, maxLat } = cornerBox(points);
      return {
        type: 'Polygon',
        coordinates: [
          [
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat],
          ],
        ],
      };
    }
    case 'trajectory':
    case 'corridor':
      return points.length < 2 ? { type: 'Point', coordinates: points[0] } : { type: 'LineString', coordinates: points };
  }
}

/** Points (rounded to 3 decimals, `[lon, lat]`) for a geometry the user drew. */
export function geometryToPoints(mode: EdrMode, g: Geometry, areaShape: AreaShape = 'rectangle'): Position[] {
  const r = (p: Position): Position => [round3(p[0]), round3(p[1])];
  if (mode === 'area' && areaShape === 'polygon' && g.type === 'Polygon') return polygonRing(g.coordinates[0] ?? []).slice(0, -1);
  switch (g.type) {
    case 'Point':
      return [r(g.coordinates)];
    case 'LineString':
      return g.coordinates.map(r);
    case 'Polygon': {
      const ring = g.coordinates[0] ?? [];
      if (!ring.length) return [];
      const { minLon, minLat, maxLon, maxLat } = cornerBox(ring);
      // area/cube use two opposite corners; anything else keeps the ring.
      return mode === 'area' || mode === 'cube' ? [r([minLon, minLat]), r([maxLon, maxLat])] : ring.map(r);
    }
  }
}

/** Short human-readable summary of the current points. */
export function describePoints(points: Position[], mode?: EdrMode, areaShape: AreaShape = 'rectangle'): string {
  const f = (p: Position) => `${pyFloat(p[1])}°N ${pyFloat(p[0])}°E`;
  if (!points.length) return 'Nothing drawn yet';
  if (mode === 'area' && areaShape === 'polygon') return `Polygon with ${points.length} vert${points.length === 1 ? 'ex' : 'ices'}`;
  if (points.length <= 2) return points.map(f).join(' → ');
  return `${points.length} points, ${f(points[0])} → ${f(points[points.length - 1])}`;
}

/* ----------------------------------------------------------------- datetime */

/**
 * `YYYY-MM-DD` + `HH:MM` (or `HH:MM:SS[.fff]`, kept as is) -> `YYYY-MM-DDTHH:MM:SSZ`
 * (time defaults to 00:00:00).
 */
export function makeIso(date?: string | null, time?: string | null): string | null {
  const d = date?.trim() ?? '';
  const t = time?.trim() ?? '';
  if (d && t) return t.split(':').length > 2 ? `${d}T${t}Z` : `${d}T${t}:00Z`;
  if (d) return `${d}T00:00:00Z`;
  return null;
}

/** Start/end fields -> EDR `datetime` value: `start/end`, `start`, or null. */
export function combineDatetime(
  startDate?: string | null,
  startTime?: string | null,
  endDate?: string | null,
  endTime?: string | null,
): string | null {
  const start = makeIso(startDate, startTime);
  const end = makeIso(endDate, endTime);
  // start == end: a single time (`datetime=<start>`), so exactly one step is retrieved.
  if (start && end && start !== end) return `${start}/${end}`;
  return start;
}

export interface DatetimeFields {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Default start/end fields for a query type, from the available temporal extent
 * (`start` overrides the extent's start, e.g. today when the extent has none).
 * - position (time series): start = first step, end = start + 1 day, clamped to the extent's end;
 * - every other type: end = start, so a single step is retrieved.
 * Returns `null` when there is no start to default from.
 */
export function defaultDatetime(mode: EdrMode, temporal: TemporalExtent, start?: string | null): DatetimeFields | null {
  const first = temporal.start ?? start ?? null;
  if (!first) return null;
  const s = splitIso(first);
  const fields: DatetimeFields = { startDate: s.date, startTime: s.time, endDate: s.date, endTime: s.time };
  if (mode !== 'position') return fields;
  const t0 = Date.parse(makeIso(s.date, s.time) ?? '');
  if (Number.isNaN(t0)) return fields;
  let t1 = t0 + DAY_MS;
  if (temporal.end) {
    const tEnd = Date.parse(temporal.end);
    if (!Number.isNaN(tEnd)) t1 = Math.max(t0, Math.min(t1, tEnd));
  }
  const e = splitIso(new Date(t1).toISOString());
  return { ...fields, endDate: e.date, endTime: e.time };
}

/* ------------------------------------------------ available times (temporal `values`) */

/** Upper bound on the expanded instants (a `PT1S` series over years would freeze the tab). */
export const MAX_TEMPORAL_VALUES = 20_000;

export interface ExpandedTimes {
  /** Sorted, de-duplicated `YYYY-MM-DDTHH:MM:SSZ` instants. */
  times: string[];
  /** The expansion hit {@link MAX_TEMPORAL_VALUES} and `times` is incomplete. */
  capped: boolean;
}

/** An ISO 8601 date-time (no zone = UTC) -> epoch ms, or `null`. */
function parseInstant(s: string): number | null {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(t)) return null;
  const ms = Date.parse(/T.*(Z|[+-]\d{2}:?\d{2})$/i.test(t) || !t.includes('T') ? t : `${t}Z`);
  return Number.isNaN(ms) ? null : ms;
}

const toIso = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

/** An ISO 8601 duration -> calendar months and fixed milliseconds; `null` when invalid or zero. */
function parseDuration(s: string): { months: number; ms: number } | null {
  const m = s.trim().match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m || /T$/i.test(s.trim())) return null;
  const n = (i: number) => (m[i] ? Number(m[i]) : 0);
  const months = n(1) * 12 + n(2);
  const ms = (n(3) * 7 + n(4)) * DAY_MS + n(5) * 3600_000 + n(6) * 60_000 + n(7) * 1000;
  if (!Number.isFinite(months) || !Number.isFinite(ms)) return null;
  return months > 0 || ms > 0 ? { months, ms } : null;
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * The instants a temporal `values` list (OGC EDR) offers. Each entry is an ISO instant or a
 * `start/end/period` interval (`PT1H`, `PT30M`, `P1D`, `P1DT6H`, ...); other entries are ignored.
 * Capped at {@link MAX_TEMPORAL_VALUES}.
 */
export function expandTemporalValues(values: unknown, max = MAX_TEMPORAL_VALUES): ExpandedTimes {
  const set = new Set<number>();
  let capped = false;
  const add = (ms: number): boolean => {
    if (set.size >= max && !set.has(ms)) {
      capped = true;
      return false;
    }
    set.add(ms);
    return true;
  };
  const entries = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
  for (const raw of entries) {
    if (typeof raw !== 'string') continue;
    for (const entry of raw.split(',')) {
      const parts = entry.trim().split('/');
      if (parts.length === 1) {
        const t = parseInstant(parts[0]);
        if (t != null) add(t);
      } else if (parts.length === 3) {
        const a = parseInstant(parts[0]);
        const b = parseInstant(parts[1]);
        const p = parseDuration(parts[2]);
        if (a == null || b == null || !p || !Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
        // Bounded (max + 1 points are enough to know the list is capped) and strictly increasing, so an
        // out-of-range / NaN step (e.g. `P999999999M`) ends the segment instead of looping forever.
        let prev = -Infinity;
        let done = false;
        for (let i = 0; i <= max + 1; i++) {
          const t = (p.months ? addMonths(a, p.months * i) : a) + p.ms * i;
          if (!Number.isFinite(t) || t <= prev || t > b) {
            done = true;
            break;
          }
          if (!add(t)) {
            done = true;
            break;
          }
          prev = t;
        }
        if (!done) capped = true;
      }
    }
  }
  const times = [...set]
    .sort((x, y) => x - y)
    .map(toIso)
    .filter((s) => /^\d{4}-/.test(s));
  return { times, capped };
}

/** The temporal `values` of a collection / instance document (`null` without any usable instant). */
export function parseTemporalValues(data: unknown): ExpandedTimes | null {
  const e = expandTemporalValues(rawTemporalValues(data));
  return e.times.length ? e : null;
}

function rawTemporalValues(data: unknown): unknown {
  const d = (data ?? {}) as Json;
  const ext = (d.extents ?? d.extent ?? {}) as Json;
  return ext.temporal?.values;
}

/** The latest instant of a temporal `values` list, and the step grid it sits on. */
export interface LatestTime {
  /** `YYYY-MM-DDTHH:MM:SSZ` */
  last: string;
  /** `last` - 1 day, snapped down to the step grid of the segment `last` belongs to (as is for a plain instant). */
  dayBefore: string;
}

/**
 * The latest instant a temporal `values` list offers, computed without expanding it (a `PT1H` series
 * from 1940 has ~760k instants): the end of a `start/end/period` segment is moved down to its last step
 * (`start + n * period <= end`). `null` without any usable entry.
 */
export function lastTemporalInstant(values: unknown): LatestTime | null {
  let best: { last: number; dayBefore: number } | null = null;
  const entries = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
  for (const raw of entries) {
    if (typeof raw !== 'string') continue;
    for (const entry of raw.split(',')) {
      const parts = entry.trim().split('/');
      let cand: { last: number; dayBefore: number } | null = null;
      if (parts.length === 1) {
        const t = parseInstant(parts[0]);
        if (t != null && Number.isFinite(t)) cand = { last: t, dayBefore: t - DAY_MS };
      } else if (parts.length === 3) {
        const a = parseInstant(parts[0]);
        const b = parseInstant(parts[1]);
        const p = parseDuration(parts[2]);
        if (a == null || b == null || !p || !Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
        const at = (i: number) => (p.months ? addMonths(a, p.months * i) : a) + p.ms * i;
        /** The largest step index with `at(i) <= limit` (`limit >= a`). */
        const indexAtOrBefore = (limit: number): number | null => {
          if (limit < a) return null;
          const approx = p.months * 30.4375 * DAY_MS + p.ms;
          let i = Math.floor((limit - a) / approx) + 1;
          if (!Number.isFinite(i)) return null;
          for (let n = 0; n < 64 && i > 0 && !(at(i) <= limit); n++) i--;
          for (let n = 0; n < 64 && at(i + 1) <= limit; n++) i++;
          return at(i) <= limit && Number.isFinite(at(i)) ? i : null;
        };
        const iLast = indexAtOrBefore(b);
        if (iLast == null) continue;
        const last = at(iLast);
        const iDay = indexAtOrBefore(last - DAY_MS);
        cand = { last, dayBefore: iDay == null ? a : at(iDay) }; // a day before the segment's start: its first step
      }
      if (cand && (!best || cand.last > best.last)) best = cand;
    }
  }
  return best && !Number.isNaN(new Date(best.last).getTime()) ? { last: toIso(best.last), dayBefore: toIso(best.dayBefore) } : null;
}

/** {@link lastTemporalInstant} of a collection / instance document's temporal `values`. */
export function parseLatestTime(data: unknown): LatestTime | null {
  return lastTemporalInstant(rawTemporalValues(data));
}

/**
 * Default start/end for a list too long to expand ({@link ExpandedTimes.capped}): the latest available
 * instants. position (time series): end = latest, start = a day before it on the step grid (not before the
 * extent's start); every other type: start = end = latest.
 */
export function defaultDatetimeLatest(mode: EdrMode, latest: LatestTime, extentStart?: string | null): DatetimeFields {
  const e = splitIso(latest.last);
  let startIso = latest.last;
  if (mode === 'position') {
    startIso = latest.dayBefore;
    const lo = extentStart ? Date.parse(extentStart) : NaN;
    if (!Number.isNaN(lo) && Date.parse(startIso) < lo) startIso = toIso(Math.min(lo, Date.parse(latest.last)));
  }
  const s = splitIso(startIso);
  return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

/** The distinct `YYYY-MM-DD` dates of a sorted instant list. */
export function availableDates(times: string[]): string[] {
  const out: string[] = [];
  for (const t of times) {
    const d = t.slice(0, 10);
    if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

/** The time labels (`HH:MM`, or `HH:MM:SS[.fff]` when the seconds are not zero) of a sorted instant list on `date` (`YYYY-MM-DD`). */
export function timesOnDate(times: string[], date: string): string[] {
  return times.filter((t) => t.startsWith(`${date}T`)).map((t) => splitIso(t).time);
}

/**
 * Default start/end for a query type from the available instants: start = first one;
 * position (time series): end = latest one <= start + 1 day; everything else: end = start.
 */
export function defaultDatetimeFromTimes(mode: EdrMode, times: string[]): DatetimeFields | null {
  if (!times.length) return null;
  const s = splitIso(times[0]);
  let end = times[0];
  if (mode === 'position') {
    const limit = Date.parse(times[0]) + DAY_MS;
    end = [...times].reverse().find((t) => Date.parse(t) <= limit) ?? times[times.length - 1];
  }
  const e = splitIso(end);
  return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

/* ------------------------------------------- time range of area-type queries (area, radius, cube) */

/** Query types that can return several time steps as a gridded result (the "Time steps" choice). */
export const RANGE_MODES: readonly EdrMode[] = ['area', 'radius', 'cube'];

/** A "Range" covers this many steps after the start (so 7 instants, the start included). */
export const RANGE_STEPS = 6;

/** The step of a time list: calendar months plus fixed milliseconds (an ISO 8601 duration). */
export interface TimeStep {
  months: number;
  ms: number;
}

/**
 * The step between instants at `startIso`, from the `start/end/period` segment of the temporal `values` that
 * contains it (not needing the list to be expanded). `null` when no segment does (a plain list of instants, no `values`).
 */
export function temporalStepAt(data: unknown, startIso: string): TimeStep | null {
  const t = parseInstant(startIso);
  if (t == null) return null;
  const raw = rawTemporalValues(data);
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const e of entries) {
    if (typeof e !== 'string') continue;
    for (const entry of e.split(',')) {
      const parts = entry.trim().split('/');
      if (parts.length !== 3) continue;
      const a = parseInstant(parts[0]);
      const b = parseInstant(parts[1]);
      const p = parseDuration(parts[2]);
      if (a != null && b != null && p && a <= t && t <= b) return p;
    }
  }
  return null;
}

/** The latest the end of a range can be when the step is unknown: start + 6 hours. */
const UNKNOWN_STEP_RANGE_MS = 6 * 3600_000;

/** What {@link rangeBounds} needs to know about the available times. */
export interface RangeSource {
  /** The full list of available instants (sorted), when it is known in full. */
  times?: string[] | null;
  /** The step at the start, for capped or unknown lists (default: 6 h in all). */
  step?: TimeStep | null;
  /** The last available instant of a capped list. */
  last?: string | null;
  /** The extent's start: a range moved back from the last instant does not start before it. */
  notBefore?: string | null;
}

/**
 * The start and end (`YYYY-MM-DDTHH:MM:SSZ`) of a time range of {@link RANGE_STEPS} steps from `startIso`.
 * - Full list of `times`: the end is the 6th instant after the start, or the last one when fewer follow.
 * - Capped list (`last` known): end = start + 6 x `step`, clamped to `last`.
 * - Unknown list: end = start + 6 x `step`, or + 6 h when the step is not known (nothing to clamp to).
 * When the start is already the last available instant and `moveStart` is set, the range is moved back to
 * cover the last 7 instants instead (the 7th from last in a full list; `last` - 6 x step, not before `notBefore`,
 * otherwise). `null` when the start is not a valid time.
 */
export function rangeBounds(startIso: string, src: RangeSource, moveStart = true): { start: string; end: string } | null {
  const s = parseInstant(startIso);
  if (s == null) return null;
  const { times, step, last, notBefore } = src;
  const keep = toIso(s);
  if (times) {
    if (!times.length) return { start: keep, end: keep };
    const after = times.filter((t) => Date.parse(t) > s);
    if (after.length) return { start: keep, end: after[Math.min(RANGE_STEPS, after.length) - 1] };
    const n = times.length;
    return moveStart ? { start: times[Math.max(0, n - 1 - RANGE_STEPS)], end: times[n - 1] } : { start: keep, end: keep };
  }
  const shift = (from: number, dir: 1 | -1): number | null => {
    const t = (step?.months ? addMonths(from, dir * step.months * RANGE_STEPS) : from) + dir * (step ? step.ms * RANGE_STEPS : UNKNOWN_STEP_RANGE_MS);
    return Number.isFinite(t) && !Number.isNaN(new Date(t).getTime()) ? t : null;
  };
  const lastMs = last ? parseInstant(last) : null;
  if (lastMs != null && s >= lastMs && moveStart) {
    let from = shift(lastMs, -1);
    const lo = notBefore ? parseInstant(notBefore) : null;
    if (from != null && lo != null && from < lo) from = Math.min(lo, lastMs);
    return from == null ? null : { start: toIso(from), end: toIso(lastMs) };
  }
  const end = shift(s, 1);
  if (end == null) return null;
  return { start: keep, end: toIso(lastMs != null ? Math.max(s, Math.min(end, lastMs)) : end) };
}

/**
 * How many instants `start..end` (inclusive) holds: counted in `times` when listed, else from `step`
 * (hourly when unknown). `null` for an invalid or reversed range.
 */
export function countSteps(startIso: string, endIso: string, times: string[] | null, step: TimeStep | null): number | null {
  const s = parseInstant(startIso);
  const e = parseInstant(endIso);
  if (s == null || e == null || e < s) return null;
  if (times) return times.filter((t) => {
    const ms = Date.parse(t);
    return ms >= s && ms <= e;
  }).length;
  const per = step ? step.months * 30.4375 * DAY_MS + step.ms : 3600_000;
  return Math.floor((e - s) / per) + 1;
}

/** Mean size of one value (a point, a step, a parameter) in a CoverageJSON response, in bytes (about 0.24 KB). */
export const BYTES_PER_VALUE = 240;
/** A request estimated above this many bytes gets a warning. */
export const WARN_BYTES = 30_000_000;

/** Grid spacing in degrees of collections whose spacing is known (the metadata does not say). */
const KNOWN_GRID_SPACING: Record<string, number> = { 'operational-data': 0.1 };

/** The known grid spacing (degrees) of a collection, from its id; `null` when unknown. */
export function knownGridSpacing(collectionUrl: string): number | null {
  const id = collectionBase(collectionUrl).split('/').pop() ?? '';
  return KNOWN_GRID_SPACING[id] ?? null;
}

/** The area, in square degrees, a query covers (rectangle/cube box, polygon, circle); `null` when it is not complete. */
export function queryAreaDeg2(
  mode: EdrMode,
  points: Position[],
  areaShape: AreaShape,
  radius: number | null,
  radiusUnits: string,
): number | null {
  let a: number | null = null;
  if (mode === 'radius') {
    if (points.length < 1 || radius == null) return null;
    const perDeg: Record<string, number> = { degrees: 1, km: 111, m: 111_000, mi: 111 / 1.609344 };
    const r = radius / (perDeg[radiusUnits] ?? 1);
    a = Math.PI * r * r;
  } else if (mode === 'area' && areaShape === 'polygon') {
    const ring = polygonRing(points);
    if (ring.length < 4) return null;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a = Math.abs(sum) / 2;
  } else if (mode === 'area' || mode === 'cube') {
    if (points.length < 2) return null;
    const b = cornerBox(points);
    a = (b.maxLon - b.minLon) * (b.maxLat - b.minLat);
  }
  return a != null && Number.isFinite(a) && a > 0 ? a : null;
}

/** The estimated number of grid points of an area of `areaDeg2` square degrees. */
export const estimatePoints = (areaDeg2: number, spacingDeg: number): number => Math.max(1, Math.round(areaDeg2 / (spacingDeg * spacingDeg)));

/** The grid spacing (degrees) a response implies for the area it was asked for (`null` when too few points to tell). */
export function spacingFromResponse(areaDeg2: number, points: number): number | null {
  return points >= 25 && areaDeg2 > 0 ? Math.sqrt(areaDeg2 / points) : null;
}

/** The grid points of one time step of a CoverageJSON response (composite axis, or x * y); `null` if not countable. */
export function responsePoints(data: unknown): number | null {
  const d = (data ?? {}) as Json;
  const cov: Json | undefined = d.type === 'CoverageCollection' ? (Array.isArray(d.coverages) ? d.coverages[0] : undefined) : d;
  const axes = cov?.domain?.axes as Json | undefined;
  if (!axes) return null;
  const len = (a: Json | undefined): number | null => (Array.isArray(a?.values) ? a.values.length : null);
  const comp = len(axes.composite);
  if (comp != null) return comp;
  const x = len(axes.x);
  const y = len(axes.y);
  return x != null && y != null ? x * y : null;
}

export interface SizeEstimate {
  steps: number;
  /** `null` when the grid spacing (so the points) is unknown. */
  bytes: number | null;
}

/** points x steps x parameters x {@link BYTES_PER_VALUE}; `bytes` is `null` without a points estimate. */
export function estimateSize(points: number | null, steps: number, parameters: number): SizeEstimate {
  return { steps, bytes: points == null ? null : points * steps * Math.max(1, parameters) * BYTES_PER_VALUE };
}

/** `about 7 steps, ~3.4 MB` (or `size unknown`). */
export function describeEstimate(e: SizeEstimate, assumedHourly = false): string {
  const n = `about ${e.steps} step${e.steps === 1 ? '' : 's'}${assumedHourly ? ' (hourly assumed)' : ''}`;
  if (e.bytes == null) return `${n}, size unknown`;
  const mb = e.bytes / 1e6;
  return `${n}, ~${mb < 0.1 ? '<0.1' : mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function stepLabel(ms: number): string {
  const min = ms / 60_000;
  if (ms % DAY_MS === 0) return ms === DAY_MS ? 'daily' : `${ms / DAY_MS}-daily`;
  if (min % 60 === 0) return min === 60 ? 'hourly' : `${min / 60}-hourly`;
  if (Number.isInteger(min)) return `every ${min} min`;
  return `every ${ms / 1000} s`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayHour = (t: string) => `${Number(t.slice(8, 10))} ${MONTHS[Number(t.slice(5, 7)) - 1]} ${t.slice(11, 16)}`;

/** Short description of how the step changes, e.g. `hourly to 12 Nov 18:00, then 3-hourly to 15 Nov 00:00, then 6-hourly`. */
export function describeSteps(times: string[]): string {
  if (times.length < 2) return '';
  const segs: { step: number; end: string }[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = Date.parse(times[i]) - Date.parse(times[i - 1]);
    const last = segs[segs.length - 1];
    if (last && last.step === gap) last.end = times[i];
    else segs.push({ step: gap, end: times[i] });
  }
  if (segs.length === 1) return stepLabel(segs[0].step);
  if (segs.length > 4) return 'irregular steps';
  return segs.map((s, i) => (i < segs.length - 1 ? `${stepLabel(s.step)} to ${dayHour(s.end)}` : stepLabel(s.step))).join(', then ');
}

/**
 * ISO timestamp -> `{date, time}` text-field values. `time` is `HH:MM` (default `00:00`), or
 * `HH:MM:SS[.fff]` when the seconds are not zero, so the instant is not truncated.
 */
export function splitIso(ts: string): { date: string; time: string } {
  const m = ts.slice(11).match(/^(\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?/);
  const secs = m?.[2];
  const time = !m ? '00:00' : secs && Number(secs) !== 0 ? `${m[1]}:${secs}` : m[1];
  return { date: ts.slice(0, 10), time };
}

/* ----------------------------------------------------------------- metadata */

export interface EdrParam {
  id: string;
  name: string;
  unit: string;
}

export interface TemporalExtent {
  start: string | null;
  end: string | null;
}

export interface EdrCollectionInfo {
  title?: string;
  /** Advertised query types we know how to build, in toolbar order. */
  modes: EdrMode[];
  /** Advertised query types we do not know (e.g. `items`, `locations`). */
  unknownQueries: string[];
  params: EdrParam[];
  bbox: BBox | null;
  temporal: TemporalExtent;
}

type Json = Record<string, any>;

/** Temporal extent from `extent` / `extents` (collections and instances). */
export function parseTemporal(data: unknown): TemporalExtent {
  const d = (data ?? {}) as Json;
  const ext = (d.extents ?? d.extent ?? {}) as Json;
  const interval = ext.temporal?.interval;
  const first = Array.isArray(interval) && Array.isArray(interval[0]) ? interval[0] : [];
  const s = first[0];
  const e = first[1];
  return { start: typeof s === 'string' && s ? s : null, end: typeof e === 'string' && e ? e : null };
}

function unitOf(p: Json): string {
  const sym = p.unit?.symbol;
  if (typeof sym === 'string') return sym;
  if (sym && typeof sym.value === 'string') return sym.value;
  const label = p.unit?.label;
  if (typeof label === 'string') return label;
  if (label && typeof label.en === 'string') return label.en;
  return '';
}

/** Chip label like the Flet app: `id (Name) [unit]`. */
export function paramLabel(p: EdrParam): string {
  let s = p.id === p.name ? p.id : `${p.id} (${p.name})`;
  if (p.unit) s += ` [${p.unit}]`;
  return s;
}

export function parseCollection(data: unknown): EdrCollectionInfo {
  const d = (data ?? {}) as Json;
  const queries = Object.keys((d.data_queries ?? {}) as Json);
  const modes = EDR_MODES.filter((m) => queries.includes(m));
  // `instances` is not a query type (it only advertises the instance list).
  const unknownQueries = queries.filter((q) => !isEdrMode(q) && q !== 'instances');
  const params: EdrParam[] = Object.entries((d.parameter_names ?? {}) as Record<string, Json>).map(([id, p]) => ({
    id,
    name: p?.observedProperty?.label?.en ?? id,
    unit: unitOf(p ?? {}),
  }));
  const bb = d.extent?.spatial?.bbox?.[0];
  const bbox: BBox | null = Array.isArray(bb) && bb.length >= 4 ? [bb[0], bb[1], bb[2], bb[3]] : null;
  return { title: typeof d.title === 'string' ? d.title : undefined, modes, unknownQueries, params, bbox, temporal: parseTemporal(d) };
}

/** Instance ids from a `/instances` response. */
export function parseInstances(data: unknown): string[] {
  const list = ((data ?? {}) as Json).instances;
  return Array.isArray(list) ? list.map((i: Json) => i?.id).filter((id): id is string => typeof id === 'string') : [];
}

/** Modes to offer: the advertised modes the UI implements (possibly none). */
export function availableModes(advertised: readonly EdrMode[], implemented: readonly EdrMode[] = IMPLEMENTED_MODES): EdrMode[] {
  return EDR_MODES.filter((m) => implemented.includes(m) && advertised.includes(m));
}

/* --------------------------------------------------------------- timeseries */

export interface TimeSeries {
  /** Parameter id (key in `ranges`). */
  id: string;
  /** Parameter label (`observedProperty.label.en`, else the id). */
  label: string;
  unit: string;
  /** Time-axis values as given by the server (ISO strings). */
  times: string[];
  /** One value per time; `null` for gaps. */
  values: (number | null)[];
}

/**
 * Point series out of a CoverageJSON response, like the Flet chart: a
 * `Coverage` (or the first coverage of a `CoverageCollection`) whose `t` axis
 * has the same length as a range's `values`. One series per range with at
 * least two non-null values; `[]` when the response is not chartable.
 */
export function parseTimeSeries(data: unknown): TimeSeries[] {
  const d = (data ?? {}) as Json;
  let cov: Json | undefined;
  if (d.type === 'CoverageCollection') cov = Array.isArray(d.coverages) ? d.coverages[0] : undefined;
  else if (d.type === 'Coverage' || (d.domain && d.ranges)) cov = d;
  if (!cov) return [];
  const times: unknown = cov.domain?.axes?.t?.values;
  const ranges = (cov.ranges ?? {}) as Record<string, Json>;
  if (!Array.isArray(times) || !times.length) return [];
  // Parameter metadata sits on the coverage, or on the collection for CoverageCollection.
  const meta = (cov.parameters ?? d.parameters ?? {}) as Record<string, Json>;
  const out: TimeSeries[] = [];
  for (const [id, r] of Object.entries(ranges)) {
    const raw: unknown = r?.values;
    if (!Array.isArray(raw) || raw.length !== times.length) continue;
    const values = raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    if (values.filter((v) => v !== null).length < 2) continue;
    const m = meta[id] ?? {};
    out.push({
      id,
      label: m.observedProperty?.label?.en ?? id,
      unit: unitOf(m) || unitOf(r ?? {}),
      times: times.map(String),
      values,
    });
  }
  return out;
}
