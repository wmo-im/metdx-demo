import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from './http';
import { createMockFetch } from './mockFetch';
import {
  OGC_MAP_REL,
  clearServiceCache,
  collectionUrls,
  detectServices,
  edrQueryTypes,
  formatCreated,
  hasEdr,
  hasMaps,
  pageInfo,
  probeServices,
  probeServicesCached,
  recordMeta,
  resolveHref,
  searchUrl,
  withJsonFormat,
} from './records';
import type { OgcRecord } from './types';
import destine from '../../test/fixtures/records/ecmwf-destine-forecast.json';
import opendata from '../../test/fixtures/records/ecmwf-opendata.json';

afterEach(() => {
  setFetchImpl(null);
  clearServiceCache();
});

describe('searchUrl', () => {
  it('uses limit=10 and offset, and q only when given', () => {
    expect(searchUrl('', 0)).toBe('https://wis2-gdc.weather.gc.ca/collections/wis2-discovery-metadata/items?limit=10&offset=0');
    expect(searchUrl(' ecmwf forecast ', 20)).toBe(
      'https://wis2-gdc.weather.gc.ca/collections/wis2-discovery-metadata/items?limit=10&offset=20&q=ecmwf%20forecast',
    );
    expect(searchUrl('', -5)).toContain('offset=0');
  });
  it('formats the page range', () => {
    expect(pageInfo(0, 10, 25)).toBe('1–10 of 25');
    expect(pageInfo(20, 5, 25)).toBe('21–25 of 25');
    expect(pageInfo(0, 0, 0)).toBe('0–0 of 0');
  });
});

describe('EDR / Maps detection', () => {
  it('EDR iff data_queries is present and non-empty (catalogue.py:148)', () => {
    expect(hasEdr({ data_queries: { position: {} } })).toBe(true);
    expect(hasEdr({ data_queries: {} })).toBe(false);
    expect(hasEdr({ data_queries: null })).toBe(false);
    expect(hasEdr({})).toBe(false);
    expect(edrQueryTypes({ data_queries: { position: {}, area: {} } })).toEqual(['position', 'area']);
    expect(edrQueryTypes({})).toEqual([]);
  });

  it('Maps iff a link has the OGC map relation (catalogue.py:156)', () => {
    expect(hasMaps({ links: [{ rel: 'self' }, { rel: OGC_MAP_REL, href: '/m' }] })).toBe(true);
    expect(hasMaps({ links: [{ rel: 'map' }, { rel: 'http://www.opengis.net/def/rel/ogc/1.0/map/extra' }] })).toBe(false);
    expect(hasMaps({})).toBe(false);
  });

  it('normalises collection hrefs to ?f=json', () => {
    expect(withJsonFormat('https://h/collections/c')).toBe('https://h/collections/c?f=json');
    expect(withJsonFormat('https://h/collections/c?x=1')).toBe('https://h/collections/c?x=1&f=json');
    expect(withJsonFormat('https://h/collections/c?f=json')).toBe('https://h/collections/c?f=json');
  });

  it('collectionUrls keeps json-looking rel=collection links only', () => {
    expect(
      collectionUrls({
        links: [
          { rel: 'collection', href: 'https://h/collections/a', type: 'text/html' },
          { rel: 'collection', href: 'https://h/x?f=json' },
          { rel: 'collection', href: 'https://h/y', type: 'application/json' },
          { rel: 'collection', href: 'https://h/z', type: 'text/html' },
          { rel: 'related', href: 'https://h/collections/b' },
        ],
      }),
    ).toEqual(['https://h/collections/a?f=json', 'https://h/x?f=json', 'https://h/y?f=json']);
    expect(collectionUrls(opendata as unknown as OgcRecord)).toEqual([]);
    expect(collectionUrls(destine as unknown as OgcRecord)).toHaveLength(2);
  });

  it('resolves root-relative map links against the collection', () => {
    expect(resolveHref('/collections/c/map', 'https://h:8/collections/c?f=json')).toBe('https://h:8/collections/c/map');
    expect(resolveHref('https://o/m', 'https://h/c')).toBe('https://o/m');
  });

  it('detectServices combines collections, first match wins, failures skipped', () => {
    const info = detectServices([
      { url: 'https://h/collections/bad?f=json', doc: null },
      {
        url: 'https://h/collections/a?f=json',
        doc: { data_queries: { position: {}, area: {} }, extent: { spatial: { bbox: [[1, 2, 3, 4]] } } },
      },
      { url: 'https://h/collections/b?f=json', doc: { data_queries: { area: {}, cube: {} } } },
      { url: 'https://h/collections/m?f=json', doc: { links: [{ rel: OGC_MAP_REL, href: '/collections/m/map' }] } },
    ]);
    expect(info).toEqual({
      edr: true,
      maps: true,
      queryTypes: ['position', 'area', 'cube'],
      edrCollection: 'https://h/collections/a?f=json',
      mapsCollection: 'https://h/collections/m?f=json',
      mapsLink: 'https://h/collections/m/map',
      extent: [1, 2, 3, 4],
    });
    expect(detectServices([{ url: 'u', doc: {} }])).toMatchObject({ edr: false, maps: false, queryTypes: [] });
    expect(detectServices([])).toMatchObject({ edr: false, maps: false });
  });
});

describe('probeServices with fixtures', () => {
  it('finds EDR and Maps for the Destination Earth record, none for open data', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    const info = await probeServices(destine as unknown as OgcRecord);
    expect(info.edr).toBe(true);
    expect(info.maps).toBe(true);
    expect(info.queryTypes).toContain('position');
    expect(info.edrCollection).toContain('/collections/operational-data');
    expect(info.mapsCollection).toContain('/collections/operational_map_server');
    expect(info.mapsLink).toBe(
      'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/map',
    );
    expect(info.extent).toHaveLength(4);

    const none = await probeServices(opendata as unknown as OgcRecord);
    expect(none).toMatchObject({ edr: false, maps: false, queryTypes: [] });
  });

  it('cached probe fetches once per record', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    const r = destine as unknown as OgcRecord;
    await Promise.all([probeServicesCached(r), probeServicesCached(r)]);
    expect(mock.calls).toHaveLength(2);
    await probeServicesCached(r);
    expect(mock.calls).toHaveLength(2);
  });

  it('a failing collection is skipped, not fatal', async () => {
    setFetchImpl(async () => new Response('{}', { status: 404 }));
    const info = await probeServices(destine as unknown as OgcRecord);
    expect(info).toMatchObject({ edr: false, maps: false });
  });
});

describe('recordMeta', () => {
  it('reads the fixture and formats the date like Flet', () => {
    const m = recordMeta(destine as unknown as OgcRecord);
    expect(m.title).toContain('ECMWF IFS');
    expect(m.license).toBe('Destination Earth Data Access Policy');
    expect(m.dataPolicy).toBe('core');
    expect(m.created).toBe('January 01, 2026');
    expect(m.keywords).toContain('IFS');
  });
  it('uses the Flet defaults when fields are missing', () => {
    expect(recordMeta({ id: 'x', properties: {}, links: [] })).toEqual({
      title: 'No Title',
      description: 'No description available.',
      keywords: [],
      organization: 'Unknown',
      license: 'Unknown License',
      created: '',
      dataPolicy: 'Unknown',
      email: 'N/A',
      phone: '',
      channel: undefined,
    });
    const m = recordMeta({
      id: 'x',
      properties: { contacts: [{}] },
      links: [{ rel: 'items', href: 'mqtt://b', channel: 'a/b' }],
    });
    expect(m).toMatchObject({ organization: 'Unknown Organization', email: 'No email', channel: 'a/b' });
  });
  it('formatCreated falls back to the raw string', () => {
    expect(formatCreated('not a date')).toBe('not a date');
    expect(formatCreated('2024-03-01T00:00:00Z')).toBe('March 01, 2024');
  });
});
