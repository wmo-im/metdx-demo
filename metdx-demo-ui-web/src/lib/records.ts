/**
 * Catalogue search + service detection for OGC Records (WIS2 GDC).
 * Mirrors the Flet app (`views/catalogue.py`, `views/record.py`).
 */
import { useEffect, useState } from 'react';
import { fetchJson, type HttpOptions } from './http';
import type { BBox, OgcRecord, RecordsPage } from './types';
import { GDC_ITEMS_URL } from '../shell/recordCache';
import { getRecordsSource } from './config';
import { searchLocalRecords } from './localRecords';

export const PAGE_SIZE = 10;

/** Link relation of an OGC API - Maps endpoint (catalogue.py:130). */
export const OGC_MAP_REL = 'http://www.opengis.net/def/rel/ogc/1.0/map';

/** Search URL: `?limit=10&offset=N[&q=text]` (catalogue.py:200). */
export function searchUrl(query: string, offset: number, limit = PAGE_SIZE): string {
  let url = `${GDC_ITEMS_URL}?limit=${limit}&offset=${Math.max(0, offset)}`;
  const q = query.trim();
  if (q) url += `&q=${encodeURIComponent(q)}`;
  return url;
}

export interface SearchPage {
  records: OgcRecord[];
  total: number;
  offset: number;
  query: string;
}

/**
 * One page of catalogue results from the configured source (`recordsSource`):
 * the bundled records searched in the browser, or the live GDC via the proxy.
 */
export async function searchRecords(query: string, offset: number, opts?: HttpOptions): Promise<SearchPage> {
  const data =
    getRecordsSource() === 'local'
      ? searchLocalRecords(query, offset, PAGE_SIZE)
      : await fetchJson<RecordsPage>(searchUrl(query, offset), opts);
  const records = data.features ?? [];
  return { records, total: data.numberMatched ?? records.length, offset, query: query.trim() };
}

/** "1–10 of 25" (en dash, as in the Flet app); "0–0 of 0" when empty. */
export function pageInfo(offset: number, count: number, total: number): string {
  const start = count > 0 ? offset + 1 : 0;
  return `${start}–${offset + count} of ${total}`;
}

/* ---------------------------------------------------------------- detection */

/** The `?f=json` form of a collection href (record.py:109). */
export function withJsonFormat(href: string): string {
  if (href.includes('?f=json')) return href;
  return href.includes('?') ? `${href}&f=json` : `${href}?f=json`;
}

/**
 * Collection document URLs of a record: links with rel=collection that look
 * like JSON (type contains "json", href ends with ?f=json, or has /collections/).
 */
export function collectionUrls(record: Pick<OgcRecord, 'links'>): string[] {
  const urls: string[] = [];
  for (const link of record.links ?? []) {
    if (link.rel !== 'collection') continue;
    const href = link.href ?? '';
    const type = link.type ?? '';
    if (!(type.includes('json') || href.endsWith('?f=json') || href.includes('/collections/'))) continue;
    urls.push(withJsonFormat(href));
  }
  return urls;
}

/** Collection JSON, as far as detection needs it. */
export interface CollectionDoc {
  data_queries?: Record<string, unknown> | null;
  links?: { rel?: string; href?: string }[];
  extent?: { spatial?: { bbox?: number[][] } };
  [k: string]: unknown;
}

/** EDR iff the collection has a non-empty `data_queries` (catalogue.py:148). */
export function hasEdr(doc: CollectionDoc): boolean {
  const dq = doc.data_queries;
  return !!dq && typeof dq === 'object' && Object.keys(dq).length > 0;
}

/** Advertised EDR query types, in document order. */
export function edrQueryTypes(doc: CollectionDoc): string[] {
  return hasEdr(doc) ? Object.keys(doc.data_queries as object) : [];
}

/** Href of the first link with the OGC Maps relation (catalogue.py:156), if any. */
export function mapsLink(doc: CollectionDoc): string | undefined {
  return (doc.links ?? []).find((l) => l.rel === OGC_MAP_REL)?.href ?? undefined;
}

export function hasMaps(doc: CollectionDoc): boolean {
  return (doc.links ?? []).some((l) => l.rel === OGC_MAP_REL);
}

/** Resolve a (possibly root-relative) link against the collection URL (record.py:165). */
export function resolveHref(href: string, collectionUrl: string): string {
  try {
    return new URL(href, collectionUrl).toString();
  } catch {
    return href;
  }
}

export interface ServiceInfo {
  edr: boolean;
  maps: boolean;
  /** Union of advertised EDR query types over all collections. */
  queryTypes: string[];
  /** First collection URL with `data_queries`. */
  edrCollection?: string;
  /** First collection URL with an OGC Maps link, and the resolved map link. */
  mapsCollection?: string;
  mapsLink?: string;
  /** Extent (first bbox) of the EDR collection, else the Maps one. */
  extent?: BBox;
}

function firstBbox(doc: CollectionDoc): BBox | undefined {
  const b = doc.extent?.spatial?.bbox?.[0];
  return b && b.length >= 4 && b.slice(0, 4).every((n) => typeof n === 'number') ? [b[0], b[1], b[2], b[3]] : undefined;
}

/** Combine already fetched collection documents (same order as `urls`). */
export function detectServices(docs: { url: string; doc: CollectionDoc | null }[]): ServiceInfo {
  const info: ServiceInfo = { edr: false, maps: false, queryTypes: [] };
  let mapsExtent: BBox | undefined;
  for (const { url, doc } of docs) {
    if (!doc) continue;
    if (hasEdr(doc)) {
      info.edr = true;
      for (const qt of edrQueryTypes(doc)) if (!info.queryTypes.includes(qt)) info.queryTypes.push(qt);
      if (!info.edrCollection) {
        info.edrCollection = url;
        info.extent = firstBbox(doc);
      }
    }
    const link = mapsLink(doc);
    if (hasMaps(doc)) {
      info.maps = true;
      if (!info.mapsCollection) {
        info.mapsCollection = url;
        info.mapsLink = link ? resolveHref(link, url) : undefined;
        mapsExtent = firstBbox(doc);
      }
    }
  }
  info.extent ??= mapsExtent;
  return info;
}

/** Fetch the record's collections (failures are skipped, as in Flet) and detect EDR / Maps. */
export async function probeServices(record: Pick<OgcRecord, 'links'>, opts?: HttpOptions): Promise<ServiceInfo> {
  return (await probeServicesRaw(record, opts)).info;
}

async function probeServicesRaw(record: Pick<OgcRecord, 'links'>, opts?: HttpOptions) {
  const urls = collectionUrls(record);
  const docs = await Promise.all(
    urls.map(async (url) => {
      try {
        return { url, doc: await fetchJson<CollectionDoc>(url, opts) };
      } catch {
        return { url, doc: null };
      }
    }),
  );
  return { info: detectServices(docs), allFailed: urls.length > 0 && docs.every((d) => !d.doc) };
}

const serviceCache = new Map<string, Promise<ServiceInfo>>();

export function clearServiceCache(): void {
  serviceCache.clear();
}

/** {@link probeServices} memoised per record id (list badges and the record page share it). */
export function probeServicesCached(record: OgcRecord, opts?: HttpOptions): Promise<ServiceInfo> {
  let p = serviceCache.get(record.id);
  if (!p) {
    p = probeServicesRaw(record, opts).then(({ info, allFailed }) => {
      if (allFailed) serviceCache.delete(record.id); // retry next time
      return info;
    });
    serviceCache.set(record.id, p);
  }
  return p;
}

/* ----------------------------------------------------------------- metadata */

export interface RecordMeta {
  title: string;
  description: string;
  keywords: string[];
  organization: string;
  license: string;
  created: string;
  dataPolicy: string;
  email: string;
  phone: string;
  /** Channel of the rel=items subscribe link, if any. */
  channel?: string;
}

/** "January 01, 2026" like Python's `%B %d, %Y`; falls back to the raw string. */
export function formatCreated(raw: string | undefined): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${month} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
}

/** Record metadata with the same defaults as the Flet record page (record.py:23-45). */
export function recordMeta(record: OgcRecord): RecordMeta {
  const p = record.properties ?? {};
  const contact = p.contacts?.[0];
  const policy = (p['wmo:dataPolicy'] as string | undefined) ?? p.wmo?.dataPolicy;
  const items = (record.links ?? []).find((l) => l.rel === 'items');
  return {
    title: p.title ?? 'No Title',
    description: p.description ?? 'No description available.',
    keywords: p.keywords ?? [],
    organization: contact ? (contact.organization ?? 'Unknown Organization') : 'Unknown',
    license: p.rights ?? 'Unknown License',
    created: formatCreated(p.created),
    dataPolicy: policy ?? 'Unknown',
    email: contact ? (contact.emails?.[0]?.value ?? 'No email') : 'N/A',
    phone: contact?.phones?.[0]?.value ?? '',
    channel: items ? (typeof items.channel === 'string' ? items.channel : 'N/A') : undefined,
  };
}

/** Probe state for a record: `undefined` while checking. */
export function useServices(record: OgcRecord | undefined): ServiceInfo | undefined {
  const [info, setInfo] = useState<ServiceInfo | undefined>();
  useEffect(() => {
    setInfo(undefined);
    if (!record) return;
    let live = true;
    void probeServicesCached(record).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [record]);
  return info;
}
