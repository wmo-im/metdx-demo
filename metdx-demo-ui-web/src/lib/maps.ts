/**
 * OGC Maps helpers: map-link discovery, schema parsing and the request URL
 * builder. The URL format mirrors the Flet app (`views/ogc_map.py`
 * `build_url`): `{map}?f=png&bbox=..&width=..&height=..&datetime=..&parameter-name=..&subset=z(..)`.
 * Values are emitted verbatim (not percent-encoded), exactly like Flet.
 */
import type { BBox, Geometry } from './types';

export const OGC_MAP_REL = 'http://www.opengis.net/def/rel/ogc/1.0/map';

export const WORLD_BBOX: BBox = [-180, -90, 180, 90];
export const DEFAULT_BBOX_TEXT = '-180,-90,180,90';
export const DEFAULT_WIDTH = '800';
export const DEFAULT_HEIGHT = '600';

/** Pressure levels offered by the Flet app ("" = surface). */
export const LEVELS = ['1000', '925', '850', '700', '500', '300', '250', '200', '100', '50'] as const;

/** Number of rendered maps kept (Flet: `_MAP_CACHE_MAX`). */
export const MAP_CACHE_MAX = 12;

/* ---------------------------------------------------------------- datetimes */

/**
 * Normalise a schema datetime to ISO 8601 with `T` and `Z`:
 * `2026-08-18 00:00:00+00:00` -> `2026-08-18T00:00:00Z`.
 */
export function cleanDt(s: string): string {
  if (!s) return s;
  let out = s.trim();
  out = out.replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2');
  out = out.replace(/(\d{2}:\d{2}:\d{2}) (\d{2}:\d{2})$/, '$1+$2');
  out = out.replace(/\+00:00$/, 'Z');
  return out;
}

/** `YYYY-MM-DD` of `now` in UTC. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Today at 00:00Z, e.g. `2026-10-19T00:00:00Z`. */
export function todayAtMidnight(now: Date = new Date()): string {
  return `${utcDate(now)}T00:00:00Z`;
}

/** Instance to preselect: today's if present, otherwise the latest (last). */
export function defaultInstance(instances: string[], now: Date = new Date()): string | undefined {
  if (!instances.length) return undefined;
  const today = utcDate(now);
  return instances.find((i) => i.slice(0, 10) === today) ?? instances[instances.length - 1];
}

/** Datetimes at or after the instance (string comparison on normalised values). */
export function filterDatetimes(datetimes: string[], instance: string | undefined): string[] {
  if (!instance || !datetimes.length) return datetimes;
  const inst = cleanDt(instance);
  return datetimes.filter((dt) => dt >= inst);
}

/** Fallback datetime so a request never goes out without one (the server 500s). */
export function defaultDatetime(datetimes: string[], now: Date = new Date()): string {
  if (datetimes.length) {
    const today = utcDate(now);
    return datetimes.find((d) => d.slice(0, 10) === today) ?? datetimes[datetimes.length - 1];
  }
  return todayAtMidnight(now);
}

/* ------------------------------------------------------------ collection/map */

/** Collection URL as given, with `f=json` added when it has no query. */
export function collectionJsonUrl(col: string): string {
  return col.includes('?') ? col : `${col}?f=json`;
}

function collectionBase(col: string): string {
  return col.split('?')[0].replace(/\/+$/, '');
}

/** `{collection}/schema?f=json` */
export function schemaUrl(col: string): string {
  return `${collectionBase(col)}/schema?f=json`;
}

interface LinkLike {
  rel?: string;
  href?: string;
}

/**
 * The collection's map endpoint: href of the link with the OGC map relation,
 * resolved against the collection URL (Flet resolves `/path` against the
 * origin). Falls back to `{collection}/map` when there is no such link.
 */
export function resolveMapUrl(collection: unknown, col: string): string {
  const links = (collection as { links?: LinkLike[] } | null | undefined)?.links;
  const raw = Array.isArray(links) ? links : undefined;
  const href = raw?.find((l) => l.rel === OGC_MAP_REL && l.href)?.href;
  const base = collectionBase(col);
  if (!href) return `${base}/map`;
  try {
    return new URL(href, col).toString();
  } catch {
    return href;
  }
}

/** First spatial bbox of a collection's extent, if valid. */
export function collectionExtent(collection: unknown): BBox | null {
  const bb = (collection as { extent?: { spatial?: { bbox?: unknown[] } } } | null)?.extent?.spatial?.bbox?.[0];
  if (Array.isArray(bb) && bb.length >= 4 && bb.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [bb[0], bb[1], bb[2], bb[3]] as BBox;
  }
  return null;
}

/* ------------------------------------------------------------------- schema */

export interface MapSchema {
  /** Normalised `instance_id` enum values. */
  instances: string[];
  /** Normalised `datetime` enum values. */
  datetimes: string[];
  /** All other properties (the plottable parameters). */
  parameters: string[];
}

const SKIP_KEYS = new Set(['geometry', 'instance_id', 'datetime']);

/** Pull instances, datetimes and parameters out of a collection `/schema`. */
export function parseSchema(schema: unknown): MapSchema {
  const props = ((schema as { properties?: Record<string, { enum?: unknown[] }> } | null)?.properties ?? {}) as Record<
    string,
    { enum?: unknown[] }
  >;
  const enumOf = (k: string) =>
    (Array.isArray(props[k]?.enum) ? (props[k].enum as unknown[]) : [])
      .filter((v): v is string => typeof v === 'string')
      .map(cleanDt);
  return {
    instances: enumOf('instance_id'),
    datetimes: enumOf('datetime'),
    parameters: Object.keys(props).filter((k) => !SKIP_KEYS.has(k)),
  };
}

/* --------------------------------------------------------------------- bbox */

/** Parse `minLon,minLat,maxLon,maxLat`; `null` if malformed or empty-area. */
export function parseBbox(text: string): BBox | null {
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length !== 4 || parts.some((p) => p === '')) return null;
  const n = parts.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, nn] = n;
  if (!(w < e) || !(s < nn)) return null;
  return [w, s, e, nn];
}

export function formatBbox(b: BBox): string {
  return b.join(',');
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Bounding box (3 decimals, clamped to the world) of a drawn geometry. */
export function bboxFromGeometry(g: Geometry): BBox {
  const pts =
    g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    round3(clamp(Math.min(...xs), -180, 180)),
    round3(clamp(Math.min(...ys), -90, 90)),
    round3(clamp(Math.max(...xs), -180, 180)),
    round3(clamp(Math.max(...ys), -90, 90)),
  ];
}

/** The `bbox` query parameter of a request URL (also for proxy-wrapped or edited URLs). */
export function bboxFromUrl(url: string): BBox | null {
  try {
    const raw = new URL(url, 'http://local.invalid').searchParams.get('bbox');
    return raw ? parseBbox(raw) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- URL */

export interface MapUrlParams {
  /** Map endpoint (any query string is dropped). */
  mapUrl: string;
  /** Raw `minLon,minLat,maxLon,maxLat` text. */
  bbox?: string;
  width?: string;
  height?: string;
  datetime?: string;
  /** Used when `datetime` is empty; defaults to today at 00:00Z. */
  fallbackDatetime?: string;
  parameter?: string;
  /** Pressure level in hPa; empty = surface (no `subset`). */
  level?: string;
}

/** Build the map image request URL, same parameter order as the Flet app. */
export function buildMapUrl(p: MapUrlParams): string {
  const base = p.mapUrl.split('?')[0];
  const params = ['f=png'];
  const bbox = (p.bbox ?? '').trim();
  if (bbox) params.push(`bbox=${bbox}`);
  const w = (p.width ?? '').trim();
  const h = (p.height ?? '').trim();
  if (w) params.push(`width=${w}`);
  if (h) params.push(`height=${h}`);
  // Always send a datetime: an empty one makes the server answer 500.
  const dt = (p.datetime ?? '').trim() || p.fallbackDatetime || todayAtMidnight();
  params.push(`datetime=${dt}`);
  const param = (p.parameter ?? '').trim();
  if (param) params.push(`parameter-name=${param}`);
  const level = (p.level ?? '').trim();
  if (level) params.push(`subset=z(${level})`);
  return `${base}?${params.join('&')}`;
}

/* -------------------------------------------------------------------- cache */

/** Small LRU keyed by the exact request URL (Flet caches the last 12 maps). */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(
    private readonly max = MAP_CACHE_MAX,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      const ov = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, ov);
    }
  }

  get size(): number {
    return this.map.size;
  }

  values(): V[] {
    return [...this.map.values()];
  }

  clear(): void {
    this.map.clear();
  }
}
