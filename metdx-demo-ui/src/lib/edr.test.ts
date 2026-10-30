import { describe, expect, it } from 'vitest';
import {
  availableModes,
  buildEdrUrl,
  collectionBase,
  collectionJsonUrl,
  combineDatetime,
  defaultDatetime,
  DEFAULT_CORRIDOR_HEIGHT,
  HEIGHT_UNITS,
  describePoints,
  geometryToPoints,
  instanceUrl,
  instancesUrl,
  makeIso,
  needsLevel,
  parseCollection,
  parseInstances,
  parseNumber,
  parseTemporal,
  parseTimeSeries,
  paramLabel,
  pyFloat,
  queryGeometry,
  splitIso,
  type EdrQuery,
} from './edr';
import collection from '../../test/fixtures/collections/operational-data.json';
import instances from '../../test/fixtures/instances/operational-data.json';
import instance from '../../test/fixtures/instances/operational-data.instance.json';

const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';
const COL_F = `${COL}?f=json`;
const DT = '2026-10-19T00:00:00Z/2026-10-20T00:00:00Z';
const INST = '2026-10-19T00:00:00Z';

const q = (o: Partial<EdrQuery>): EdrQuery => ({ collectionUrl: COL_F, mode: 'position', points: [], params: [], ...o });

/*
 * Expected strings were produced by running the Flet `_build_edr_url`
 * (metdx-demo-ui/src/views/edr_map.py) on the same inputs; Flet points are
 * (lat, lon), here `[lon, lat]`.
 */
describe('buildEdrUrl matches the Flet output', () => {
  it('position', () => {
    expect(buildEdrUrl(q({ points: [[10, 50]], params: ['2t'], datetime: DT }))).toBe(
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT}&f=json`,
    );
  });

  it('position with instance and level (z only for level parameters)', () => {
    expect(
      buildEdrUrl(q({ points: [[10.5, 50.123]], params: ['t', '2t'], datetime: DT, instanceId: INST, level: '850' })),
    ).toBe(
      `${COL}/instances/${INST}/position?coords=POINT(10.5 50.123)&parameter-name=t,2t&z=850&datetime=${DT}&f=json`,
    );
    expect(buildEdrUrl(q({ points: [[10, 50]], params: ['2t'], level: '850' }))).toBe(
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&f=json`,
    );
  });

  it('position without parameters still builds (validation is the caller\u2019s job)', () => {
    expect(buildEdrUrl(q({ points: [[10, 50]] }))).toBe(`${COL}/position?coords=POINT(10.0 50.0)&f=json`);
  });

  it('area uses the min/max box of the two corners', () => {
    expect(
      buildEdrUrl(
        q({
          mode: 'area',
          points: [
            [20.5, 60],
            [-10, 40.25],
          ],
          params: ['2t', '10u'],
          datetime: DT,
        }),
      ),
    ).toBe(
      `${COL}/area?coords=POLYGON((-10.0 40.25,20.5 40.25,20.5 60.0,-10.0 60.0,-10.0 40.25))&parameter-name=2t,10u&datetime=${DT}&f=json`,
    );
  });

  it('trajectory', () => {
    expect(
      buildEdrUrl(
        q({
          mode: 'trajectory',
          points: [
            [10, 50],
            [11, 51.5],
            [12.25, 52],
          ],
          params: ['2t'],
          datetime: DT,
        }),
      ),
    ).toBe(
      `${COL}/trajectory?coords=LINESTRING(10.0 50.0,11.0 51.5,12.25 52.0)&parameter-name=2t&datetime=${DT}&f=json`,
    );
  });

  it('radius (value + units)', () => {
    expect(buildEdrUrl(q({ mode: 'radius', points: [[10, 50]], params: ['2t'], datetime: DT, radius: 5 }))).toBe(
      `${COL}/radius?coords=POINT(10.0 50.0)&within=5.0&within-units=degrees&parameter-name=2t&datetime=${DT}&f=json`,
    );
    expect(
      buildEdrUrl(q({ mode: 'radius', points: [[10, 50]], params: ['2t'], datetime: DT, radius: 2.5, instanceId: INST })),
    ).toBe(
      `${COL}/instances/${INST}/radius?coords=POINT(10.0 50.0)&within=2.5&within-units=degrees&parameter-name=2t&datetime=${DT}&f=json`,
    );
    expect(buildEdrUrl(q({ mode: 'radius', points: [[10, 50]], radius: 100, radiusUnits: 'km' }))).toContain(
      '&within=100.0&within-units=km',
    );
  });

  it('corridor (width; optional height)', () => {
    const base = {
      mode: 'corridor' as const,
      points: [
        [10, 50],
        [11, 51],
      ] as [number, number][],
      params: ['2t'],
      datetime: DT,
      corridorWidth: 2,
    };
    expect(buildEdrUrl(q(base))).toBe(
      `${COL}/corridor?coords=LINESTRING(10.0 50.0,11.0 51.0)&corridor-width=2.0&width-units=degrees&parameter-name=2t&datetime=${DT}&f=json`,
    );
    expect(buildEdrUrl(q({ ...base, corridorHeight: 500, heightUnits: 'm' }))).toContain(
      '&corridor-width=2.0&width-units=degrees&corridor-height=500.0&height-units=m&parameter-name',
    );
  });

  it('the default corridor height is a number the live server accepts (10.0 m)', () => {
    expect(parseNumber(DEFAULT_CORRIDOR_HEIGHT)).toBe(10);
    expect(HEIGHT_UNITS[0]).toBe('m');
    const url = buildEdrUrl(
      q({
        mode: 'corridor',
        points: [
          [10, 50],
          [11, 51],
        ],
        params: ['2t'],
        corridorWidth: 1,
        corridorHeight: parseNumber(DEFAULT_CORRIDOR_HEIGHT),
        heightUnits: HEIGHT_UNITS[0],
      }),
    );
    expect(url).toContain('&corridor-height=10.0&height-units=m&');
  });

  it('cube uses bbox=minLon,minLat,maxLon,maxLat', () => {
    expect(
      buildEdrUrl(
        q({
          mode: 'cube',
          points: [
            [20.5, 60],
            [-10, 40.25],
          ],
          params: ['t'],
          datetime: DT,
          instanceId: INST,
          level: '500',
        }),
      ),
    ).toBe(`${COL}/instances/${INST}/cube?bbox=-10.0,40.25,20.5,60.0&parameter-name=t&z=500&datetime=${DT}&f=json`);
  });

  it('returns null while the query is incomplete', () => {
    expect(buildEdrUrl(q({ params: ['2t'] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'area', points: [[10, 50]] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'trajectory', points: [[10, 50]] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'radius', points: [[10, 50]] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'corridor', points: [[10, 50], [11, 51]] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'cube', points: [[10, 50]] }))).toBeNull();
  });

  it('drops query strings and trailing slashes from the collection URL', () => {
    expect(collectionBase(`${COL}/?f=json`)).toBe(COL);
    expect(buildEdrUrl(q({ collectionUrl: `${COL}/`, points: [[1, 2]] }))).toBe(`${COL}/position?coords=POINT(1.0 2.0)&f=json`);
  });
});

describe('formatting helpers', () => {
  it('pyFloat keeps .0 on whole numbers like Python', () => {
    expect(pyFloat(10)).toBe('10.0');
    expect(pyFloat(-0.5)).toBe('-0.5');
    expect(pyFloat(50.123)).toBe('50.123');
  });
  it('parseNumber', () => {
    expect(parseNumber(' 5 ')).toBe(5);
    expect(parseNumber('2.5')).toBe(2.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
  it('level detection', () => {
    expect(needsLevel(['2t', '10u'])).toBe(false);
    expect(needsLevel(['2t', 't'])).toBe(true);
  });
  it('metadata URLs', () => {
    expect(collectionJsonUrl(`${COL}?f=json`)).toBe(`${COL}?f=json`);
    expect(instancesUrl(COL)).toBe(`${COL}/instances?f=json`);
    expect(instanceUrl(COL, INST)).toBe(`${COL}/instances/${INST}?f=json`);
  });
});

describe('datetime helpers', () => {
  it('makeIso / combineDatetime follow Flet', () => {
    expect(makeIso('2026-10-19', '06:30')).toBe('2026-10-19T06:30:00Z');
    expect(makeIso('2026-10-19', '')).toBe('2026-10-19T00:00:00Z');
    expect(makeIso('', '06:30')).toBeNull();
    expect(combineDatetime('2026-10-19', '00:00', '2026-10-20', '12:00')).toBe('2026-10-19T00:00:00Z/2026-10-20T12:00:00Z');
    expect(combineDatetime('2026-10-19', '00:00', '', '')).toBe('2026-10-19T00:00:00Z');
    expect(combineDatetime('', '', '2026-10-20', '')).toBeNull();
  });
  it('combineDatetime: start == end is a single datetime', () => {
    expect(combineDatetime('2026-10-19', '06:00', '2026-10-19', '06:00')).toBe('2026-10-19T06:00:00Z');
    expect(combineDatetime('2026-10-19', '', '2026-10-19', '00:00')).toBe('2026-10-19T00:00:00Z');
  });
  it('defaultDatetime: position = start + 1 day clamped to the extent end; other modes = start', () => {
    const t = { start: '2026-10-19T06:00:00Z', end: '2026-10-29T00:00:00Z' };
    expect(defaultDatetime('position', t)).toEqual({ startDate: '2026-10-19', startTime: '06:00', endDate: '2026-10-20', endTime: '06:00' });
    expect(defaultDatetime('position', { ...t, end: '2026-10-19T18:00:00Z' })).toEqual({
      startDate: '2026-10-19',
      startTime: '06:00',
      endDate: '2026-10-19',
      endTime: '18:00',
    });
    expect(defaultDatetime('position', { start: '2026-10-19T00:00:00Z', end: null })?.endDate).toBe('2026-10-20');
    for (const m of ['area', 'trajectory', 'radius', 'corridor', 'cube'] as const) {
      expect(defaultDatetime(m, t)).toEqual({ startDate: '2026-10-19', startTime: '06:00', endDate: '2026-10-19', endTime: '06:00' });
    }
    expect(defaultDatetime('area', { start: null, end: null })).toBeNull();
    expect(defaultDatetime('area', { start: null, end: null }, '2026-01-02T00:00:00Z')?.startDate).toBe('2026-01-02');
  });
  it('parseCollection hides `instances` from the unknown query types', () => {
    const c = parseCollection({ data_queries: { position: {}, instances: {}, items: {}, locations: {} } });
    expect(c.modes).toEqual(['position']);
    expect(c.unknownQueries).toEqual(['items', 'locations']);
  });
  it('splitIso', () => {
    expect(splitIso('2026-10-19T06:30:00Z')).toEqual({ date: '2026-10-19', time: '06:30' });
    expect(splitIso('2026-10-19')).toEqual({ date: '2026-10-19', time: '00:00' });
  });
});

describe('geometry helpers', () => {
  it('queryGeometry', () => {
    expect(queryGeometry('position', [])).toBeNull();
    expect(queryGeometry('position', [[1, 2]])).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(
      queryGeometry('area', [
        [5, 6],
        [1, 2],
      ]),
    ).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [1, 2],
          [5, 2],
          [5, 6],
          [1, 6],
          [1, 2],
        ],
      ],
    });
    expect(
      queryGeometry('trajectory', [
        [1, 2],
        [3, 4],
      ]),
    ).toEqual({
      type: 'LineString',
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    });
  });
  it('geometryToPoints rounds and reduces rectangles to two corners', () => {
    expect(geometryToPoints('position', { type: 'Point', coordinates: [10.123456, 50.987654] })).toEqual([[10.123, 50.988]]);
    expect(
      geometryToPoints('area', {
        type: 'Polygon',
        coordinates: [
          [
            [1, 2],
            [5, 2],
            [5, 6],
            [1, 6],
            [1, 2],
          ],
        ],
      }),
    ).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });
  it('describePoints', () => {
    expect(describePoints([])).toBe('Nothing drawn yet');
    expect(describePoints([[10, 50]])).toBe('50.0°N 10.0°E');
  });
});

describe('metadata parsing (fixtures)', () => {
  it('parseCollection', () => {
    const c = parseCollection(collection);
    expect(c.title).toBe('Operational data');
    expect(c.modes).toEqual(['position', 'area', 'trajectory', 'radius', 'cube', 'corridor']);
    expect(c.unknownQueries).toEqual([]);
    expect(c.params.map((p) => p.id)).toEqual(['2t', '10u', '10v', 't']);
    expect(c.params[0]).toEqual({ id: '2t', name: '2 metre temperature', unit: 'K' });
    expect(paramLabel(c.params[0])).toBe('2t (2 metre temperature) [K]');
    expect(c.bbox).toEqual([-180, -90, 180, 90]);
    expect(c.temporal).toEqual({ start: '2026-10-19T00:00:00Z', end: '2026-10-29T00:00:00Z' });
  });
  it('splits advertised query types into known and unknown', () => {
    const c = parseCollection({ data_queries: { items: {}, area: {}, position: {} } });
    expect(c.modes).toEqual(['position', 'area']);
    expect(c.unknownQueries).toEqual(['items']);
  });
  it('unit symbol forms', () => {
    const c = parseCollection({ parameter_names: { a: { unit: { symbol: { value: 'K' } } }, b: { unit: { symbol: 'm' } } } });
    expect(c.params.map((p) => p.unit)).toEqual(['K', 'm']);
  });
  it('parseInstances / parseTemporal', () => {
    expect(parseInstances(instances)).toEqual(['2026-10-18T12:00:00Z', '2026-10-19T00:00:00Z']);
    expect(parseInstances({})).toEqual([]);
    expect(parseTemporal(instance)).toEqual({ start: '2026-10-19T00:00:00Z', end: '2026-10-29T00:00:00Z' });
    expect(parseTemporal({})).toEqual({ start: null, end: null });
  });
  it('availableModes filters advertised modes by what the UI implements', () => {
    expect(availableModes(['position', 'area', 'cube'])).toEqual(['position', 'area', 'cube']);
    expect(availableModes(['cube'])).toEqual(['cube']);
    expect(availableModes([])).toEqual([]);
    expect(availableModes(parseCollection({ data_queries: { locations: {} } }).modes)).toEqual([]);
    expect(availableModes(parseCollection({ data_queries: {} }).modes)).toEqual([]);
    expect(availableModes(['position', 'cube'], ['position'])).toEqual(['position']);
    expect(availableModes(['cube'], ['position'])).toEqual([]);
  });
});

describe('parseTimeSeries', () => {
  const cov = (values: (number | null)[], extra: Record<string, unknown> = {}) => ({
    type: 'Coverage',
    domain: { axes: { t: { values: ['2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z', '2026-10-19T12:00:00Z'] } } },
    parameters: { a: { unit: { symbol: 'K' }, observedProperty: { label: { en: 'Alpha' } } } },
    ranges: { a: { values } },
    ...extra,
  });
  it('reads label, unit, times and values from a Coverage', () => {
    expect(parseTimeSeries(cov([1, 2, 3]))).toEqual([
      { id: 'a', label: 'Alpha', unit: 'K', times: ['2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z', '2026-10-19T12:00:00Z'], values: [1, 2, 3] },
    ]);
  });
  it('keeps gaps as null and needs two real values', () => {
    expect(parseTimeSeries(cov([1, null, 3]))[0].values).toEqual([1, null, 3]);
    expect(parseTimeSeries(cov([1, null, null]))).toEqual([]);
  });
  it('uses the first coverage of a CoverageCollection, with collection-level parameters', () => {
    const c = cov([4, 5, 6]);
    const out = parseTimeSeries({ type: 'CoverageCollection', parameters: c.parameters, coverages: [{ ...c, parameters: undefined }, c] });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Alpha');
  });
  it('is empty for non-series data', () => {
    expect(parseTimeSeries(null)).toEqual([]);
    expect(parseTimeSeries({ type: 'FeatureCollection' })).toEqual([]);
    expect(parseTimeSeries(cov([1, 2]))).toEqual([]); // length mismatch with the time axis
  });
});
