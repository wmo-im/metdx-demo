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
  area: 'Draw a rectangle on the map',
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
  /** `[lon, lat]` points: position/radius 1, area/cube 2 corners, trajectory/corridor >= 2. */
  points: Position[];
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
export function queryGeometry(mode: EdrMode, points: Position[]): Geometry | null {
  if (!points.length) return null;
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
export function geometryToPoints(mode: EdrMode, g: Geometry): Position[] {
  const r = (p: Position): Position => [round3(p[0]), round3(p[1])];
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
export function describePoints(points: Position[]): string {
  const f = (p: Position) => `${pyFloat(p[1])}°N ${pyFloat(p[0])}°E`;
  if (!points.length) return 'Nothing drawn yet';
  if (points.length <= 2) return points.map(f).join(' → ');
  return `${points.length} points, ${f(points[0])} → ${f(points[points.length - 1])}`;
}

/* ----------------------------------------------------------------- datetime */

/** `YYYY-MM-DD` + `HH:MM` -> `YYYY-MM-DDTHH:MM:00Z` (time defaults to 00:00:00). */
export function makeIso(date?: string | null, time?: string | null): string | null {
  const d = date?.trim() ?? '';
  const t = time?.trim() ?? '';
  if (d && t) return `${d}T${t}:00Z`;
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
  if (start && end) return `${start}/${end}`;
  return start;
}

/** ISO timestamp -> `{date, time}` text-field values (`time` defaults to `00:00`). */
export function splitIso(ts: string): { date: string; time: string } {
  return { date: ts.slice(0, 10), time: ts.length > 11 ? ts.slice(11, 16) : '00:00' };
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
  const unknownQueries = queries.filter((q) => !isEdrMode(q));
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
