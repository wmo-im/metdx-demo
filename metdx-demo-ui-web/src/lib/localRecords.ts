/**
 * Records bundled with the app (`src/data/records/*.json`, copies of the Flet
 * app's fixtures) and a client-side search over them. Mirrors the Flet app's
 * METDX_TEST mode (`main.py`, `views/catalogue.py`).
 */
import type { OgcRecord, RecordsPage } from './types';

const files = import.meta.glob('../data/records/*.json', { eager: true, import: 'default' }) as Record<string, OgcRecord>;

/** All bundled records, ordered by file name. */
export const LOCAL_RECORDS: OgcRecord[] = Object.keys(files)
  .sort()
  .map((k) => files[k]);

/** Text a query is matched against: title, description and keywords, lower-cased. */
function haystack(r: OgcRecord): string {
  const p = r.properties ?? {};
  return [p.title, p.description, ...(p.keywords ?? [])].filter(Boolean).join('\n').toLowerCase();
}

/**
 * Case-insensitive search: every whitespace-separated term of `query` must
 * occur in the title, description or keywords. An empty query matches all.
 */
export function filterLocalRecords(query: string, records: OgcRecord[] = LOCAL_RECORDS): OgcRecord[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return records;
  return records.filter((r) => {
    const h = haystack(r);
    return terms.every((t) => h.includes(t));
  });
}

/** A page of local results in the OGC API - Records response shape. */
export function searchLocalRecords(
  query: string,
  offset: number,
  limit: number,
  records: OgcRecord[] = LOCAL_RECORDS,
): RecordsPage {
  const matched = filterLocalRecords(query, records);
  const start = Math.max(0, offset);
  const features = matched.slice(start, start + limit);
  return {
    type: 'FeatureCollection',
    numberMatched: matched.length,
    numberReturned: features.length,
    features,
    links: [],
  };
}

export function findLocalRecord(id: string, records: OgcRecord[] = LOCAL_RECORDS): OgcRecord | undefined {
  return records.find((r) => r.id === id);
}
