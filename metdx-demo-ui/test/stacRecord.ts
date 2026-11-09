/**
 * Test helpers for a WCMP2 record that also links a STAC Collection (rel=collection, application/json) next to
 * the EDR / OGC Maps collections: the record fixture with those links added, a stand-in STAC Collection document and a
 * fetch wrapper that serves them on top of the mock fetch.
 */
import { createMockFetch, type MockFetch } from '../src/lib/mockFetch';
import { unproxyUrl, type FetchImpl } from '../src/lib/http';
import type { OgcRecord } from '../src/lib/types';
import destine from './fixtures/records/ecmwf-destine-forecast.json';

export const STAC_HREF = 'https://6a6d74.github.io/ecmwf-stac/stac/collection.json';
export const STAC_TITLE = 'STAC catalog: root Collection (IFS 0.1° oper)';
export const STAC_BROWSER_TITLE = 'STAC Browser for this catalog';

export const STAC_LINK = {
  rel: 'collection',
  type: 'application/json',
  href: STAC_HREF,
  title: STAC_TITLE,
  profile: 'https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json',
};
export const STAC_BROWSER_LINK = {
  rel: 'related',
  type: 'text/html',
  href: 'https://6a6d74.github.io/ecmwf-stac/browser/',
  title: STAC_BROWSER_TITLE,
};

export const BASE_RECORD = destine as unknown as OgcRecord;

/** The ECMWF record with the STAC links added at the `start` or `end` of its links (the browser link stays last). */
export function recordWithStac(where: 'first' | 'last'): OgcRecord {
  const links = BASE_RECORD.links ?? [];
  return {
    ...BASE_RECORD,
    links: where === 'first' ? [STAC_LINK, ...links, STAC_BROWSER_LINK] : [...links, STAC_LINK, STAC_BROWSER_LINK],
  };
}

/** A STAC 1.1.0 Collection as the ECMWF catalogue serves it: no `data_queries`, no OGC Maps link. */
export const STAC_COLLECTION = {
  type: 'Collection',
  stac_version: '1.1.0',
  id: 'ecmwf-ifs-oper',
  description: 'IFS 0.1° operational forecast',
  license: 'CC-BY-4.0',
  extent: {
    spatial: { bbox: [[-180, -90, 180, 90]] },
    temporal: { interval: [['2024-02-01T00:00:00Z', null]] },
  },
  links: [
    { rel: 'root', href: './collection.json', type: 'application/json' },
    { rel: 'license', href: 'https://creativecommons.org/licenses/by/4.0/' },
    { rel: 'describedby', href: 'https://confluence.ecmwf.int/display/DAC/ECMWF+open+data', type: 'text/html' },
    { rel: 'cite-as', href: 'https://doi.org/10.21957/open-data' },
    { rel: 'related', href: 'https://6a6d74.github.io/ecmwf-stac/browser/', type: 'text/html' },
    { rel: 'child', href: './2024/collection.json', type: 'application/json' },
  ],
};

/** How the STAC host answers. */
export type StacBehaviour = 'ok' | '404' | '403' | 'network-error' | 'html';

export interface StacMock extends FetchImpl {
  mock: MockFetch;
  /** Upstream URLs asked of the STAC host. */
  stacCalls: string[];
}

/**
 * Mock fetch + STAC host + a catalogue that serves `record` instead of the fixture with the same id.
 * `network-error` throws a TypeError, as a browser does for a CORS / network failure.
 */
export function createStacMock(record: OgcRecord, stac: StacBehaviour = 'ok'): StacMock {
  const mock = createMockFetch();
  const stacCalls: string[] = [];
  const impl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const upstream = unproxyUrl(input);
    if (new URL(upstream, 'http://mock.local').host === '6a6d74.github.io') {
      stacCalls.push(upstream);
      switch (stac) {
        case 'ok':
          return new Response(JSON.stringify(STAC_COLLECTION), { status: 200, headers: { 'content-type': 'application/json' } });
        case '404':
          return new Response('Not Found', { status: 404 });
        case '403':
          return new Response('Forbidden', { status: 403 });
        case 'html':
          return new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } });
        case 'network-error':
          throw new TypeError('Failed to fetch');
      }
    }
    const res = await mock(input, init);
    if (!/\/collections\/wis2-discovery-metadata\/items/.test(upstream)) return res;
    const data = (await res.json()) as Record<string, any>;
    if (Array.isArray(data.features)) data.features = data.features.map((r: OgcRecord) => (r.id === record.id ? record : r));
    else if (data.id === record.id) return new Response(JSON.stringify(record), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as StacMock;
  impl.mock = mock;
  impl.stacCalls = stacCalls;
  return impl;
}
