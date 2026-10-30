import { useEffect, useState } from 'react';
import { fetchJson, type HttpOptions } from '../lib/http';
import type { OgcRecord } from '../lib/types';
import { catalogueItemsUrl, getRecordsSource } from '../lib/config';
import { findLocalRecord } from '../lib/localRecords';

const cache = new Map<string, OgcRecord>();
const inflight = new Map<string, Promise<OgcRecord>>();

/** URL of one record in the configured catalogue. */
export function recordUrl(id: string): string {
  return `${catalogueItemsUrl()}/${encodeURIComponent(id)}?f=json`;
}

export function getCachedRecord(id: string): OgcRecord | undefined {
  return cache.get(id);
}

/** Store a record (keyed by `record.id`), e.g. from a search result page. */
export function cacheRecord(record: OgcRecord): void {
  cache.set(record.id, record);
}

export function cacheRecords(records: OgcRecord[]): void {
  records.forEach(cacheRecord);
}

export function clearRecordCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Cached record, else looked up by id in the bundled records (`recordsSource`
 * "local") or fetched from the catalogue (deduplicated while in flight).
 */
export function loadRecord(id: string, opts?: HttpOptions): Promise<OgcRecord> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  if (getRecordsSource() === 'local') {
    const local = findLocalRecord(id);
    if (!local) return Promise.reject(new Error(`Record not found in the local records: ${id}`));
    cacheRecord(local);
    return Promise.resolve(local);
  }
  let p = inflight.get(id);
  if (!p) {
    p = fetchJson<OgcRecord>(recordUrl(id), opts)
      .then((rec) => {
        cacheRecord({ ...rec, id: rec.id ?? id });
        return cache.get(id) ?? rec;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export interface UseRecord {
  record: OgcRecord | undefined;
  loading: boolean;
  error: string | undefined;
}

/** React hook over {@link loadRecord}. */
export function useRecord(id: string | undefined): UseRecord {
  const [state, setState] = useState<UseRecord>(() => ({
    record: id ? getCachedRecord(id) : undefined,
    loading: !!id && !getCachedRecord(id),
    error: undefined,
  }));
  useEffect(() => {
    if (!id) return;
    const hit = getCachedRecord(id);
    if (hit) {
      setState({ record: hit, loading: false, error: undefined });
      return;
    }
    let live = true;
    setState({ record: undefined, loading: true, error: undefined });
    loadRecord(id).then(
      (record) => live && setState({ record, loading: false, error: undefined }),
      (e) => live && setState({ record: undefined, loading: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return state;
}
