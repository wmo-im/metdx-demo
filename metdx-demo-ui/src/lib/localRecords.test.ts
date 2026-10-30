import { afterEach, describe, expect, it } from 'vitest';
import { resetConfig, setRecordsSource } from './config';
import { LOCAL_RECORDS, filterLocalRecords, findLocalRecord, searchLocalRecords } from './localRecords';
import { PAGE_SIZE, searchRecords } from './records';
import type { OgcRecord } from './types';
import { setFetchImpl } from './http';

afterEach(() => {
  resetConfig();
  setFetchImpl(null);
});

const rec = (i: number, extra: Partial<OgcRecord['properties']> = {}): OgcRecord => ({
  id: `r${i}`,
  properties: { title: `Dataset ${i}`, description: `desc ${i}`, ...extra },
  links: [],
});

describe('bundled records', () => {
  it('are the demo discovery records of resources/metadata/discovery', () => {
    expect(LOCAL_RECORDS.map((r) => r.id)).toEqual([
      'urn:wmo:md:int-ecmwf:weather.prediction.forecast.global',
      'urn:wmo:md:int-ecmwf:opendata',
      'urn:wmo:md:ca-eccc-msc:msc-weather-forecast',
    ]);
    expect(LOCAL_RECORDS.every((r) => r.properties.keywords?.includes('metdx-demo'))).toBe(true);
    const msc = findLocalRecord('urn:wmo:md:ca-eccc-msc:msc-weather-forecast');
    expect(msc?.links.find((l) => l.rel === 'collection')?.href).toBe('https://dev.api.weather.gc.ca/collections/msc-weather-forecast');
    expect(findLocalRecord('urn:wmo:md:int-ecmwf:opendata')?.properties.title).toMatch(/Open Data/);
    expect(findLocalRecord('nope')).toBeUndefined();
  });
});

describe('local search', () => {
  const all = [rec(1, { keywords: ['Wind'] }), rec(2, { title: 'Sea Ice' }), rec(3, { description: 'Global forecast' })];
  it('empty or blank query lists everything', () => {
    expect(filterLocalRecords('', all)).toHaveLength(3);
    expect(filterLocalRecords('   ', all)).toHaveLength(3);
  });
  it('matches title, description and keywords case-insensitively', () => {
    expect(filterLocalRecords('sea ICE', all).map((r) => r.id)).toEqual(['r2']);
    expect(filterLocalRecords('forecast', all).map((r) => r.id)).toEqual(['r3']);
    expect(filterLocalRecords('wind', all).map((r) => r.id)).toEqual(['r1']);
    expect(filterLocalRecords('nothing', all)).toEqual([]);
  });
  it('requires every term, in any order', () => {
    expect(filterLocalRecords('ice sea', all).map((r) => r.id)).toEqual(['r2']);
    expect(filterLocalRecords('sea wind', all)).toEqual([]);
  });
  it('does not match other properties (e.g. ids, links)', () => {
    expect(filterLocalRecords('r1', [{ ...rec(1), id: 'r1', links: [{ rel: 'x', href: 'r1' }] }, rec(9)])).toEqual([]);
  });
  it('pages 10 at a time in the RecordsPage shape', () => {
    const many = Array.from({ length: 25 }, (_, i) => rec(i));
    const p3 = searchLocalRecords('', 20, PAGE_SIZE, many);
    expect(p3).toMatchObject({ type: 'FeatureCollection', numberMatched: 25, numberReturned: 5 });
    expect(p3.features.map((r) => r.id)).toEqual(['r20', 'r21', 'r22', 'r23', 'r24']);
    expect(searchLocalRecords('', 0, PAGE_SIZE, many).features).toHaveLength(10);
    expect(searchLocalRecords('', -5, PAGE_SIZE, many).features[0].id).toBe('r0');
    expect(searchLocalRecords('', 99, PAGE_SIZE, many).features).toEqual([]);
  });
});

describe('searchRecords source selection', () => {
  it('local does not call the network', async () => {
    setRecordsSource('local');
    let calls = 0;
    setFetchImpl(async () => {
      calls++;
      return new Response('{}');
    });
    const page = await searchRecords('', 0);
    expect(page.total).toBe(LOCAL_RECORDS.length);
    expect(page.records).toHaveLength(LOCAL_RECORDS.length);
    expect((await searchRecords(' Deterministic ', 0)).records).toHaveLength(1);
    expect(calls).toBe(0);
  });
  it('catalogue (default) fetches the catalogue items URL through the fetch layer', async () => {
    const urls: string[] = [];
    setFetchImpl(async (u) => {
      urls.push(decodeURIComponent(u));
      return new Response(JSON.stringify({ numberMatched: 1, features: [rec(1)] }), { headers: { 'content-type': 'application/json' } });
    });
    const page = await searchRecords('wind', 10);
    expect(page).toMatchObject({ total: 1, offset: 10, query: 'wind' });
    expect(urls[0]).toBe(
      '/api/proxy?url=https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items?limit=10&offset=10&q=wind',
    );
  });
});
