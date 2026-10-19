import { describe, expect, it } from 'vitest';
import {
  LruCache,
  bboxFromGeometry,
  bboxFromUrl,
  buildMapUrl,
  cleanDt,
  collectionExtent,
  collectionJsonUrl,
  defaultDatetime,
  defaultInstance,
  filterDatetimes,
  parseBbox,
  parseSchema,
  resolveMapUrl,
  schemaUrl,
} from './maps';
import schema from '../../test/fixtures/schema/operational_map_server.json';
import collection from '../../test/fixtures/collections/operational_map_server.json';

const MAP = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/map';
const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server?f=json';

describe('buildMapUrl (Flet format)', () => {
  it('emits params in the Flet order', () => {
    expect(
      buildMapUrl({
        mapUrl: MAP,
        bbox: '-10,30,40,60',
        width: '800',
        height: '600',
        datetime: '2026-10-19T00:00:00Z',
        parameter: '2t',
        level: '',
      }),
    ).toBe(`${MAP}?f=png&bbox=-10,30,40,60&width=800&height=600&datetime=2026-10-19T00:00:00Z&parameter-name=2t`);
  });

  it('adds subset=z(level) for a pressure level', () => {
    expect(buildMapUrl({ mapUrl: MAP, datetime: '2026-10-19T00:00:00Z', parameter: 't', level: '500' })).toBe(
      `${MAP}?f=png&datetime=2026-10-19T00:00:00Z&parameter-name=t&subset=z(500)`,
    );
  });

  it('drops an existing query string and empty/blank fields', () => {
    expect(buildMapUrl({ mapUrl: `${MAP}?f=json`, bbox: ' ', width: '', height: ' ', datetime: 'x', parameter: ' ' })).toBe(
      `${MAP}?f=png&datetime=x`,
    );
  });

  it('never omits the datetime', () => {
    expect(buildMapUrl({ mapUrl: MAP, datetime: '', fallbackDatetime: '2026-01-01T06:00:00Z' })).toBe(
      `${MAP}?f=png&datetime=2026-01-01T06:00:00Z`,
    );
    expect(buildMapUrl({ mapUrl: MAP })).toMatch(/\?f=png&datetime=\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  });
});

describe('datetimes', () => {
  it('cleans schema datetimes', () => {
    expect(cleanDt('2026-08-18 00:00:00+00:00')).toBe('2026-08-18T00:00:00Z');
    expect(cleanDt('2026-08-18T06:00:00Z')).toBe('2026-08-18T06:00:00Z');
    expect(cleanDt('2026-08-18 00:00:00 02:00')).toBe('2026-08-18T00:00:00+02:00');
    expect(cleanDt('')).toBe('');
  });

  it('picks today\'s instance, else the latest', () => {
    const now = new Date('2026-10-19T08:00:00Z');
    expect(defaultInstance(['2026-10-18T12:00:00Z', '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z'], now)).toBe('2026-10-19T00:00:00Z');
    expect(defaultInstance(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'], now)).toBe('2026-10-02T00:00:00Z');
    expect(defaultInstance([], now)).toBeUndefined();
  });

  it('keeps datetimes at or after the instance', () => {
    const dts = ['2026-10-18T12:00:00Z', '2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z'];
    expect(filterDatetimes(dts, '2026-10-19 00:00:00+00:00')).toEqual(['2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z']);
    expect(filterDatetimes(dts, undefined)).toEqual(dts);
  });

  it('defaults to today\'s datetime, else last, else midnight', () => {
    const now = new Date('2026-10-19T08:00:00Z');
    expect(defaultDatetime(['2026-10-19T06:00:00Z', '2026-10-19T12:00:00Z'], now)).toBe('2026-10-19T06:00:00Z');
    expect(defaultDatetime(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'], now)).toBe('2026-10-02T00:00:00Z');
    expect(defaultDatetime([], now)).toBe('2026-10-19T00:00:00Z');
  });
});

describe('collection + schema', () => {
  it('builds JSON and schema URLs', () => {
    expect(collectionJsonUrl('https://h/collections/c')).toBe('https://h/collections/c?f=json');
    expect(collectionJsonUrl(COL)).toBe(COL);
    expect(schemaUrl(COL)).toBe('https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/schema?f=json');
    expect(schemaUrl('https://h/collections/c/')).toBe('https://h/collections/c/schema?f=json');
  });

  it('finds the map link, resolving relative hrefs against the collection', () => {
    expect(resolveMapUrl(collection, COL)).toBe(MAP);
    expect(resolveMapUrl({ links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/map', href: '/collections/x/map' }] }, COL)).toBe(
      'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/x/map',
    );
    expect(resolveMapUrl({ links: [] }, 'https://h/collections/c?f=json')).toBe('https://h/collections/c/map');
    expect(resolveMapUrl(null, 'https://h/collections/c')).toBe('https://h/collections/c/map');
  });

  it('reads the extent', () => {
    expect(collectionExtent(collection)).toEqual([-180, -90, 180, 90]);
    expect(collectionExtent({})).toBeNull();
  });

  it('parses instances, datetimes and parameters from the schema', () => {
    expect(parseSchema(schema)).toEqual({
      instances: ['2026-10-18T12:00:00Z', '2026-10-19T00:00:00Z'],
      datetimes: ['2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z', '2026-10-19T12:00:00Z'],
      parameters: ['2t', '10u', 'msl'],
    });
    expect(parseSchema(null)).toEqual({ instances: [], datetimes: [], parameters: [] });
  });
});

describe('bbox', () => {
  it('parses and validates', () => {
    expect(parseBbox('-10, 30,40,60')).toEqual([-10, 30, 40, 60]);
    expect(parseBbox('1,2,3')).toBeNull();
    expect(parseBbox('a,2,3,4')).toBeNull();
    expect(parseBbox('10,2,3,4')).toBeNull();
    expect(parseBbox('1,,3,4')).toBeNull();
  });

  it('derives a bbox from a drawn rectangle, rounded and clamped', () => {
    expect(
      bboxFromGeometry({
        type: 'Polygon',
        coordinates: [[[-10.12345, 30], [40.98765, 30], [40.98765, 95], [-10.12345, 95], [-10.12345, 30]]],
      }),
    ).toEqual([-10.123, 30, 40.988, 90]);
  });

  it('reads the bbox of a (possibly edited) request URL', () => {
    expect(bboxFromUrl(`${MAP}?f=png&bbox=-10,30,40,60&width=1`)).toEqual([-10, 30, 40, 60]);
    expect(bboxFromUrl(`/api/proxy?url=${encodeURIComponent(`${MAP}?bbox=1,2,3,4`)}`)).toBeNull(); // bbox is inside the encoded url param
    expect(bboxFromUrl(`${MAP}?f=png`)).toBeNull();
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const evicted: string[] = [];
    const c = new LruCache<number>(2, (k) => evicted.push(k));
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now most recent
    c.set('c', 3);
    expect(evicted).toEqual(['b']);
    expect(c.get('b')).toBeUndefined();
    expect(c.size).toBe(2);
  });
});
