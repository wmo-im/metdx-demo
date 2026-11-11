import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_VALUE,
  availableDates,
  countSteps,
  describeEstimate,
  estimatePoints,
  estimateSize,
  knownGridSpacing,
  queryAreaDeg2,
  rangeBounds,
  responsePoints,
  spacingFromResponse,
  temporalStepAt,
  availableModes,
  buildEdrUrl,
  collectionBase,
  collectionJsonUrl,
  combineDatetime,
  defaultDatetime,
  defaultDatetimeFromTimes,
  defaultDatetimeLatest,
  lastTemporalInstant,
  parseLatestTime,
  describeSteps,
  expandTemporalValues,
  DEFAULT_CORRIDOR_HEIGHT,
  HEIGHT_UNITS,
  describePoints,
  drawKindFor,
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
  parseTemporalValues,
  pyFloat,
  queryGeometry,
  splitIso,
  timesOnDate,
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

  it('area as a free polygon: a closed ring in lon lat order, 3-decimal coordinates', () => {
    const tri: [number, number][] = [
      [-10, 40],
      [20.12345, 41.5],
      [5, 60],
    ];
    const expected = `${COL}/area?coords=POLYGON((-10.0 40.0,20.123 41.5,5.0 60.0,-10.0 40.0))&parameter-name=2t&datetime=${DT}&f=json`;
    expect(buildEdrUrl(q({ mode: 'area', areaShape: 'polygon', points: tri, params: ['2t'], datetime: DT }))).toBe(expected);
    // an already closed ring and repeated vertices (a double-click) give the same polygon
    expect(
      buildEdrUrl(q({ mode: 'area', areaShape: 'polygon', points: [tri[0], tri[1], tri[1], tri[2], tri[0]], params: ['2t'], datetime: DT })),
    ).toBe(expected);
    // not a bounding box: an L shape keeps its six vertices
    const l: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
    expect(buildEdrUrl(q({ mode: 'area', areaShape: 'polygon', points: l }))).toContain(
      'coords=POLYGON((0.0 0.0,4.0 0.0,4.0 1.0,1.0 1.0,1.0 3.0,0.0 3.0,0.0 0.0))',
    );
    // fewer than 3 distinct vertices is not a polygon yet
    expect(buildEdrUrl(q({ mode: 'area', areaShape: 'polygon', points: [tri[0], tri[1]] }))).toBeNull();
    expect(buildEdrUrl(q({ mode: 'area', areaShape: 'polygon', points: [tri[0], tri[0], tri[0]] }))).toBeNull();
    // the rectangle (default) is unchanged, and cube stays a bbox whatever the shape
    expect(buildEdrUrl(q({ mode: 'cube', areaShape: 'polygon', points: [[1, 2], [5, 6]] }))).toContain('/cube?bbox=1.0,2.0,5.0,6.0');
  });

  it('drawKindFor: only area can be drawn as a polygon', () => {
    expect(drawKindFor('area')).toBe('bbox');
    expect(drawKindFor('area', 'rectangle')).toBe('bbox');
    expect(drawKindFor('area', 'polygon')).toBe('polygon');
    expect(drawKindFor('cube', 'polygon')).toBe('bbox');
    expect(drawKindFor('trajectory', 'polygon')).toBe('line');
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
  it('polygon areas keep their vertices (open ring) and show them', () => {
    const ring: [number, number][] = [[0, 0], [4, 0.0004], [4, 1], [0, 0]];
    expect(geometryToPoints('area', { type: 'Polygon', coordinates: [ring] }, 'polygon')).toEqual([[0, 0], [4, 0], [4, 1]]);
    expect(queryGeometry('area', [[0, 0], [4, 0], [4, 1]], 'polygon')).toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0], [4, 0], [4, 1], [0, 0]]],
    });
    expect(describePoints([[0, 0], [4, 0], [4, 1]], 'area', 'polygon')).toBe('Polygon with 3 vertices');
    expect(describePoints([[0, 0], [4, 1]], 'area', 'rectangle')).toBe('0.0°N 0.0°E → 1.0°N 4.0°E');
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

describe('temporal values', () => {
  const MIXED = [
    '2026-11-09T00:00:00Z/2026-11-12T18:00:00Z/PT1H',
    '2026-11-12T21:00:00Z/2026-11-15T00:00:00Z/PT3H',
    '2026-11-15T06:00:00Z/2026-11-19T00:00:00Z/PT6H',
  ];

  it('expands mixed steps, sorted and without duplicates', () => {
    const { times, capped } = expandTemporalValues(MIXED);
    expect(capped).toBe(false);
    expect(times[0]).toBe('2026-11-09T00:00:00Z');
    expect(times.at(-1)).toBe('2026-11-19T00:00:00Z');
    // 4 days hourly (+18 h) + 3-hourly 12 Nov 21:00 .. 15 Nov 00:00 + 6-hourly 15 Nov 06:00 .. 19 Nov 00:00
    expect(times).toHaveLength(3 * 24 + 19 + 17 + 17);
    expect([...times].sort()).toEqual(times);
    expect(expandTemporalValues([...MIXED, ...MIXED]).times).toEqual(times);
  });

  it('offers 1 h / 3 h / 6 h times per date, and handles the boundary dates', () => {
    const { times } = expandTemporalValues(MIXED);
    expect(availableDates(times)).toHaveLength(11);
    expect(availableDates(times)[0]).toBe('2026-11-09');
    expect(timesOnDate(times, '2026-11-10')).toHaveLength(24);
    // the day the step changes: hourly to 18:00, then 3-hourly
    expect(timesOnDate(times, '2026-11-12')).toEqual([...Array(19).keys()].map((h) => `${String(h).padStart(2, '0')}:00`).concat(['21:00']));
    expect(timesOnDate(times, '2026-11-13')).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
    // 15 Nov: 00:00 (3-hourly part), then the 6-hourly part starts at 06:00 (a gap, nothing at 03:00)
    expect(timesOnDate(times, '2026-11-15')).toEqual(['00:00', '06:00', '12:00', '18:00']);
    expect(timesOnDate(times, '2026-11-19')).toEqual(['00:00']);
    expect(timesOnDate(times, '2026-11-20')).toEqual([]);
    expect(timesOnDate(times, '2026-11-08')).toEqual([]);
  });

  it('accepts a plain list of instants and mixes it with intervals', () => {
    const { times } = expandTemporalValues(['2026-11-09T06:00:00Z', '2026-11-08T12:00:00Z', '2026-11-09T06:00:00Z', '2026-11-10T00:00:00Z/2026-11-10T02:00:00Z/PT1H']);
    expect(times).toEqual(['2026-11-08T12:00:00Z', '2026-11-09T06:00:00Z', '2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z', '2026-11-10T02:00:00Z']);
  });

  it('supports PTnM, PnD, P1DT6H and P1M durations, and instants without seconds / zone', () => {
    expect(expandTemporalValues(['2026-01-01T00:00Z/2026-01-01T01:00Z/PT30M']).times).toEqual(['2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', '2026-01-01T01:00:00Z']);
    expect(expandTemporalValues(['2026-01-01/2026-01-03/P1D']).times).toEqual(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z']);
    expect(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-03T00:00:00Z/P1DT6H']).times).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-02T06:00:00Z',
    ]);
    expect(expandTemporalValues(['2026-01-31T00:00:00Z/2026-04-30T00:00:00Z/P1M']).times).toEqual([
      '2026-01-31T00:00:00Z',
      '2026-02-28T00:00:00Z',
      '2026-03-31T00:00:00Z',
      '2026-04-30T00:00:00Z',
    ]);
    expect(expandTemporalValues(['2026-01-01T00:00:00', '2026-01-01T03:00:00+01:00']).times).toEqual(['2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z']);
  });

  it('ignores bad strings and invalid intervals', () => {
    const bad = [
      'nope',
      '',
      42,
      null,
      '2026-13-45T00:00:00Z',
      '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z', // no period
      '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/PT0H', // zero step
      '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/XYZ',
      '2026-01-02T00:00:00Z/2026-01-01T00:00:00Z/PT1H', // end before start
      '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/PT',
    ];
    expect(expandTemporalValues(bad)).toEqual({ times: [], capped: false });
    expect(expandTemporalValues([...bad, '2026-02-01T00:00:00Z']).times).toEqual(['2026-02-01T00:00:00Z']);
    expect(expandTemporalValues(undefined)).toEqual({ times: [], capped: false });
    expect(expandTemporalValues({})).toEqual({ times: [], capped: false });
  });

  it('caps huge expansions and flags it', () => {
    const r = expandTemporalValues(['2026-01-01T00:00:00Z/2036-01-01T00:00:00Z/PT1S']);
    expect(r.capped).toBe(true);
    expect(r.times).toHaveLength(20_000);
    expect(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-01T00:00:10Z/PT1S'], 5)).toMatchObject({ capped: true });
    expect(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-01T00:00:04Z/PT1S'], 5).capped).toBe(false);
  });

  it('terminates on huge / non-finite steps and dates (no endless loop)', () => {
    // P999999999M overflows the Date range -> NaN: only the start is offered
    expect(expandTemporalValues(['2026-01-01/2026-01-02/P999999999M'])).toEqual({ times: ['2026-01-01T00:00:00Z'], capped: false });
    expect(expandTemporalValues(['2026-01-01/2026-01-02/P999999999Y']).times).toEqual(['2026-01-01T00:00:00Z']);
    expect(expandTemporalValues(['2026-01-01/2026-01-02/P99999999999999999999D']).times).toEqual(['2026-01-01T00:00:00Z']);
    expect(expandTemporalValues([`2026-01-01/2026-01-02/P${'9'.repeat(400)}D`]).times).toEqual([]); // Infinity step: rejected
    // zero steps, non-finite / unparsable dates and an end before the start are ignored
    expect(expandTemporalValues(['2026-01-01/2026-01-02/P0D', '2026-01-01/2026-01-02/PT0S', '2026-01-01/2026-01-02/P0M']).times).toEqual([]);
    expect(expandTemporalValues(['NaN/2026-01-02/PT1H', '2026-01-01/Infinity/PT1H', '2026-01-02/2026-01-01/PT1H', '2026-01-01/2026-01-02/-PT1H']).times).toEqual([]);
  });

  it('a segment that would exceed the cap stops at it, even when other segments already filled the list', () => {
    const seg = '2026-01-01T00:00:00Z/2026-01-01T00:00:59Z/PT1S';
    const r = expandTemporalValues([seg, seg], 10);
    expect(r.capped).toBe(true);
    expect(r.times).toHaveLength(10);
    // a second segment re-offering the same (already counted) instants is not a reason to loop on
    expect(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-01T00:00:04Z/PT1S', '2026-01-01T00:00:00Z/2026-01-01T00:00:04Z/PT1S'], 5)).toEqual({
      times: ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z', '2026-01-01T00:00:04Z'],
      capped: false,
    });
  });

  it('keeps the seconds of an instant, down to the label and the URL value', () => {
    const { times } = expandTemporalValues(['2026-11-09T00:00:30Z', '2026-11-09T01:00:00Z', '2026-11-09T02:00:15.5Z']);
    expect(times).toEqual(['2026-11-09T00:00:30Z', '2026-11-09T01:00:00Z', '2026-11-09T02:00:15.500Z']);
    expect(timesOnDate(times, '2026-11-09')).toEqual(['00:00:30', '01:00', '02:00:15.500']);
    expect(splitIso('2026-11-09T00:00:30Z')).toEqual({ date: '2026-11-09', time: '00:00:30' });
    expect(splitIso('2026-11-09T00:00:00Z').time).toBe('00:00');
    // label -> URL value round trip
    for (const t of times) {
      const { date, time } = splitIso(t);
      expect(makeIso(date, time)).toBe(t);
    }
    expect(combineDatetime('2026-11-09', '00:00:30', '2026-11-09', '00:00:30')).toBe('2026-11-09T00:00:30Z');
    expect(defaultDatetimeFromTimes('area', times)).toMatchObject({ startTime: '00:00:30', endTime: '00:00:30' });
  });

  it('parseTemporalValues reads extent / extents, and is null without values', () => {
    expect(parseTemporalValues({ extent: { temporal: { values: ['2026-01-01T00:00:00Z'] } } })?.times).toEqual(['2026-01-01T00:00:00Z']);
    expect(parseTemporalValues({ extents: { temporal: { values: ['2026-01-02T00:00:00Z'] } } })?.times).toEqual(['2026-01-02T00:00:00Z']);
    expect(parseTemporalValues(collection)).toBeNull();
    expect(parseTemporalValues({ extent: { temporal: { values: ['junk'] } } })).toBeNull();
    expect(parseTemporalValues(null)).toBeNull();
  });

  it('defaultDatetimeFromTimes snaps to the available steps', () => {
    const { times } = expandTemporalValues(MIXED);
    expect(defaultDatetimeFromTimes('position', times)).toEqual({ startDate: '2026-11-09', startTime: '00:00', endDate: '2026-11-10', endTime: '00:00' });
    expect(defaultDatetimeFromTimes('area', times)).toEqual({ startDate: '2026-11-09', startTime: '00:00', endDate: '2026-11-09', endTime: '00:00' });
    // start + 1 day is not an available time: the latest one before it
    const sparse = ['2026-11-09T00:00:00Z', '2026-11-09T18:00:00Z', '2026-11-10T06:00:00Z'];
    expect(defaultDatetimeFromTimes('position', sparse)).toMatchObject({ endDate: '2026-11-09', endTime: '18:00' });
    expect(defaultDatetimeFromTimes('position', ['2026-11-09T00:00:00Z'])).toMatchObject({ endDate: '2026-11-09', endTime: '00:00' });
    expect(defaultDatetimeFromTimes('position', [])).toBeNull();
  });

  it('describeSteps summarises the step changes', () => {
    expect(describeSteps(expandTemporalValues(MIXED).times)).toBe('hourly to 12 Nov 18:00, then 3-hourly to 15 Nov 00:00, then 6-hourly');
    expect(describeSteps(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/PT6H']).times)).toBe('6-hourly');
    expect(describeSteps(expandTemporalValues(['2026-01-01/2026-01-03/P1D']).times)).toBe('daily');
    expect(describeSteps(expandTemporalValues(['2026-01-01T00:00:00Z/2026-01-01T01:00:00Z/PT15M']).times)).toBe('every 15 min');
    expect(describeSteps(['2026-01-01T00:00:00Z'])).toBe('');
  });

  it('lastTemporalInstant: the last step of a period segment, without expanding it', () => {
    // ERA5: 1940 -> 2026, hourly (~760k instants)
    expect(lastTemporalInstant(['1940-01-01T00:00:00Z/2026-10-01T23:00:00Z/PT1H'])).toEqual({ last: '2026-10-01T23:00:00Z', dayBefore: '2026-09-30T23:00:00Z' });
    // the end is not on a step: the last step <= end (and a day before it on the grid)
    expect(lastTemporalInstant(['2026-01-01T00:00:00Z/2026-01-10T07:30:00Z/PT6H'])).toEqual({ last: '2026-01-10T06:00:00Z', dayBefore: '2026-01-09T06:00:00Z' });
    expect(lastTemporalInstant(['2026-01-01T00:00:00Z/2026-01-10T07:30:00Z/PT5H'])).toEqual({ last: '2026-01-10T04:00:00Z', dayBefore: '2026-01-09T03:00:00Z' });
    // calendar months; a segment shorter than a day: its first step
    expect(lastTemporalInstant(['2026-01-31T00:00:00Z/2026-04-30T12:00:00Z/P1M'])?.last).toBe('2026-04-30T00:00:00Z');
    expect(lastTemporalInstant(['2026-01-01T00:00:00Z/2026-01-01T06:00:00Z/PT1H'])).toEqual({ last: '2026-01-01T06:00:00Z', dayBefore: '2026-01-01T00:00:00Z' });
    // explicit list / unordered mixed segments: the latest of everything
    expect(lastTemporalInstant(['2026-11-09T06:00:00Z', '2026-11-10T00:00:00Z', '2026-11-08T12:00:00Z'])?.last).toBe('2026-11-10T00:00:00Z');
    expect(lastTemporalInstant('2026-01-01T00:00:00Z,2026-01-05T00:00:00Z')).toEqual({ last: '2026-01-05T00:00:00Z', dayBefore: '2026-01-04T00:00:00Z' });
    expect(lastTemporalInstant(['2026-03-01T00:00:00Z/2026-03-02T00:00:00Z/PT1H', '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/P1D', '2026-02-10T00:00:00Z'])?.last).toBe('2026-03-02T00:00:00Z');
    // junk
    expect(lastTemporalInstant(undefined)).toBeNull();
    expect(lastTemporalInstant(['junk', '2026-01-02/2026-01-01/PT1H', '2026-01-01/2026-01-02/P0D'])).toBeNull();
    expect(parseLatestTime({ extent: { temporal: { values: ['2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/PT1H'] } } })?.last).toBe('2026-01-02T00:00:00Z');
  });

  it('defaultDatetimeLatest: position = last day, other modes = the last instant', () => {
    const latest = { last: '2026-10-01T23:00:00Z', dayBefore: '2026-09-30T23:00:00Z' };
    expect(defaultDatetimeLatest('position', latest)).toEqual({ startDate: '2026-09-30', startTime: '23:00', endDate: '2026-10-01', endTime: '23:00' });
    for (const m of ['area', 'radius', 'cube'] as const) {
      expect(defaultDatetimeLatest(m, latest)).toEqual({ startDate: '2026-10-01', startTime: '23:00', endDate: '2026-10-01', endTime: '23:00' });
    }
    // never before the extent start
    expect(defaultDatetimeLatest('position', latest, '2026-10-01T12:00:00Z')).toMatchObject({ startDate: '2026-10-01', startTime: '12:00' });
  });
});

describe('time range of area-type queries', () => {
  const hourly = Array.from({ length: 10 }, (_, i) => `2026-11-09T${String(i).padStart(2, '0')}:00:00Z`);

  const end = (start: string, src: Parameters<typeof rangeBounds>[1], move = true) => rangeBounds(start, src, move)?.end;
  const H = 3600_000;

  it('rangeBounds: the 6th available instant after the start, clamped to the last one', () => {
    expect(rangeBounds('2026-11-09T00:00:00Z', { times: hourly })).toEqual({ start: '2026-11-09T00:00:00Z', end: '2026-11-09T06:00:00Z' });
    expect(end('2026-11-09T02:00:00Z', { times: hourly })).toBe('2026-11-09T08:00:00Z');
    expect(end('2026-11-09T07:00:00Z', { times: hourly })).toBe('2026-11-09T09:00:00Z'); // only 2 follow
    // irregular list: counts instants, not time
    const irregular = ['2026-11-09T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-20T00:00:00Z'];
    expect(end('2026-11-09T00:00:00Z', { times: irregular })).toBe('2026-11-20T00:00:00Z');
  });

  it('rangeBounds: a start that is the last listed instant moves back to cover the last 7 instants', () => {
    expect(rangeBounds('2026-11-09T09:00:00Z', { times: hourly })).toEqual({ start: '2026-11-09T03:00:00Z', end: '2026-11-09T09:00:00Z' });
    // fewer than 7 instants: from the first one
    const few = hourly.slice(0, 3);
    expect(rangeBounds('2026-11-09T02:00:00Z', { times: few })).toEqual({ start: '2026-11-09T00:00:00Z', end: '2026-11-09T02:00:00Z' });
    expect(rangeBounds('2026-11-09T00:00:00Z', { times: hourly.slice(0, 1) })).toEqual({ start: '2026-11-09T00:00:00Z', end: '2026-11-09T00:00:00Z' });
    // not when the caller keeps the start (a start the user picked): just the end
    expect(rangeBounds('2026-11-09T09:00:00Z', { times: hourly }, false)).toEqual({ start: '2026-11-09T09:00:00Z', end: '2026-11-09T09:00:00Z' });
    // the 6th-after rule is unchanged one step before the last
    expect(rangeBounds('2026-11-09T08:00:00Z', { times: hourly })).toEqual({ start: '2026-11-09T08:00:00Z', end: '2026-11-09T09:00:00Z' });
  });

  it('rangeBounds, capped list: start + 6 x step, clamped to the last instant', () => {
    const last = '2026-11-09T12:00:00Z';
    const step = { months: 0, ms: 3 * H };
    expect(end('2026-11-09T00:00:00Z', { step, last })).toBe('2026-11-09T12:00:00Z'); // exactly 18 h would be 18:00: clamped
    expect(end('2026-11-08T00:00:00Z', { step, last })).toBe('2026-11-08T18:00:00Z');
    expect(end('2026-11-08T12:00:00Z', { step, last })).toBe('2026-11-09T06:00:00Z');
    expect(end('2026-11-08T21:00:00Z', { step, last })).toBe('2026-11-09T12:00:00Z');
    expect(end('2026-11-09T12:00:00Z', { step, last }, false)).toBe('2026-11-09T12:00:00Z');
  });

  it('rangeBounds, capped list: a start at the last instant moves back by 6 steps, not before the extent start', () => {
    const last = '2026-11-09T12:00:00Z';
    const step = { months: 0, ms: 3 * H };
    expect(rangeBounds(last, { step, last })).toEqual({ start: '2026-11-08T18:00:00Z', end: last });
    expect(rangeBounds(last, { step: null, last })).toEqual({ start: '2026-11-09T06:00:00Z', end: last }); // unknown step: 6 h
    expect(rangeBounds(last, { step: { months: 1, ms: 0 }, last })).toEqual({ start: '2026-05-09T12:00:00Z', end: last });
    expect(rangeBounds(last, { step, last, notBefore: '2026-11-09T00:00:00Z' })).toEqual({ start: '2026-11-09T00:00:00Z', end: last });
    expect(rangeBounds(last, { step, last, notBefore: '2026-01-01T00:00:00Z' })?.start).toBe('2026-11-08T18:00:00Z');
    expect(rangeBounds(last, { step, last }, false)).toEqual({ start: last, end: last });
  });

  it('rangeBounds, unknown list: start + 6 x step, or + 6 h; nothing to clamp to', () => {
    expect(end('2026-11-09T00:00:00Z', { step: { months: 0, ms: 3 * H } })).toBe('2026-11-09T18:00:00Z');
    expect(end('2026-11-09T00:00:00Z', { step: { months: 1, ms: 0 } })).toBe('2027-05-09T00:00:00Z');
    expect(end('2026-11-09T00:00:00Z', {})).toBe('2026-11-09T06:00:00Z');
    expect(end('2026-11-09T00:00:30Z', { step: { months: 0, ms: 1000 } })).toBe('2026-11-09T00:00:36Z');
    expect(rangeBounds('nope', {})).toBeNull();
  });

  it('temporalStepAt: the period of the segment holding the start', () => {
    const doc = { extent: { temporal: { values: ['2026-01-01T00:00:00Z/2026-01-02T00:00:00Z/PT1H', '2026-01-02T03:00:00Z/2026-01-05T00:00:00Z/PT3H', '2026-02-01T00:00:00Z'] } } };
    expect(temporalStepAt(doc, '2026-01-01T05:00:00Z')).toEqual({ months: 0, ms: 3600_000 });
    expect(temporalStepAt(doc, '2026-01-04T00:00:00Z')).toEqual({ months: 0, ms: 3 * 3600_000 });
    expect(temporalStepAt(doc, '2026-02-01T00:00:00Z')).toBeNull(); // a plain instant has no step
    expect(temporalStepAt(doc, '2027-01-01T00:00:00Z')).toBeNull();
    expect(temporalStepAt({}, '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('countSteps: inclusive, from the list or the step (hourly when unknown)', () => {
    expect(countSteps('2026-11-09T00:00:00Z', '2026-11-09T06:00:00Z', hourly, null)).toBe(7);
    expect(countSteps('2026-11-09T00:00:00Z', '2026-11-09T06:00:00Z', null, { months: 0, ms: 3 * 3600_000 })).toBe(3);
    expect(countSteps('2026-11-09T00:00:00Z', '2026-11-09T06:00:00Z', null, null)).toBe(7);
    expect(countSteps('2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z', null, null)).toBe(1);
    expect(countSteps('2026-11-09T06:00:00Z', '2026-11-09T00:00:00Z', hourly, null)).toBeNull();
  });

  it('queryAreaDeg2: box, polygon, circle', () => {
    const box = [[10, 50], [15, 55]] as [number, number][];
    expect(queryAreaDeg2('area', box, 'rectangle', null, 'degrees')).toBe(25);
    expect(queryAreaDeg2('cube', box, 'rectangle', null, 'degrees')).toBe(25);
    expect(queryAreaDeg2('area', [[0, 0], [4, 0], [0, 3]], 'polygon', null, 'degrees')).toBe(6);
    expect(queryAreaDeg2('area', [[0, 0], [4, 0]], 'polygon', null, 'degrees')).toBeNull();
    expect(queryAreaDeg2('radius', [[10, 50]], 'rectangle', 2, 'degrees')).toBeCloseTo(Math.PI * 4);
    expect(queryAreaDeg2('radius', [[10, 50]], 'rectangle', 222, 'km')).toBeCloseTo(Math.PI * 4);
    expect(queryAreaDeg2('radius', [[10, 50]], 'rectangle', null, 'km')).toBeNull();
    expect(queryAreaDeg2('area', [[10, 50]], 'rectangle', null, 'degrees')).toBeNull();
    expect(queryAreaDeg2('area', [[10, 50], [10, 55]], 'rectangle', null, 'degrees')).toBeNull(); // zero width
    expect(queryAreaDeg2('position', [[10, 50]], 'rectangle', null, 'degrees')).toBeNull();
  });

  it('points and size estimate: points x steps x parameters x 0.24 KB', () => {
    expect(knownGridSpacing('https://x/collections/operational-data?f=json')).toBe(0.1);
    expect(knownGridSpacing('https://x/collections/other')).toBeNull();
    expect(estimatePoints(25, 0.1)).toBe(2500);
    const size = estimateSize(2500, 7, 2);
    expect(size).toEqual({ steps: 7, bytes: 2500 * 7 * 2 * BYTES_PER_VALUE });
    expect(describeEstimate(size)).toBe('about 7 steps, ~8.4 MB');
    expect(describeEstimate(estimateSize(100_000, 25, 1))).toBe('about 25 steps, ~600 MB');
    expect(describeEstimate(estimateSize(null, 7, 1))).toBe('about 7 steps, size unknown');
    expect(describeEstimate(estimateSize(2500, 1, 0))).toBe('about 1 step, ~0.6 MB'); // no parameter yet counts as one
    expect(describeEstimate(estimateSize(null, 7, 1), true)).toBe('about 7 steps (hourly assumed), size unknown');
  });

  it('learns the grid spacing from a response (composite or x/y axes)', () => {
    const composite = { type: 'CoverageCollection', coverages: [{ domain: { axes: { composite: { values: new Array(2408).fill([0, 0]) } } } }] };
    expect(responsePoints(composite)).toBe(2408);
    expect(responsePoints({ domain: { axes: { x: { values: [1, 2, 3] }, y: { values: [1, 2] } } } })).toBe(6);
    expect(responsePoints({ type: 'Coverage', domain: { axes: { t: { values: ['a'] } } } })).toBeNull();
    expect(responsePoints(null)).toBeNull();
    expect(spacingFromResponse(25, 2408)).toBeCloseTo(0.102, 3);
    expect(spacingFromResponse(25, 4)).toBeNull(); // too few points to tell
  });
});
