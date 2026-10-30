import { describe, expect, it } from 'vitest';
import { CovJsonError, parseCoverageJson, pointSeries } from './covjson';
import { MAX_GRID_CELLS, MAX_POINTS, TooLargeToDraw, isGridSpec, type GridSpec } from './covjsonTypes';
import livePosition from '../../test/fixtures/edr/live-position.json';
import liveArea from '../../test/fixtures/edr/live-area.json';
import liveTrajectory from '../../test/fixtures/edr/live-trajectory.json';

const grid = (l: { coords: unknown }) => l.coords as GridSpec;
const arr = (a: ArrayLike<number>) => Array.from(a);

/** Standard Grid coverage; `ranges.T.values` row-major over `axisNames`. */
function stdGrid(over: Record<string, unknown> = {}, axes: Record<string, unknown> = {}, range: Record<string, unknown> = {}) {
  return {
    type: 'Coverage',
    domain: {
      type: 'Domain',
      domainType: 'Grid',
      axes: { x: { values: [0, 10, 20] }, y: { values: [50, 60] }, ...axes },
    },
    parameters: { T: { type: 'Parameter', unit: { symbol: 'K' }, observedProperty: { id: 'T', label: { en: 'Temperature' } } } },
    ranges: { T: { type: 'NdArray', dataType: 'float', axisNames: ['y', 'x'], shape: [2, 3], values: [1, 2, 3, 4, 5, 6], ...range } },
    ...over,
  };
}

describe('live ECMWF samples', () => {
  it('position: PointSeries collection -> one point, one time', () => {
    const l = parseCoverageJson(livePosition);
    expect(l.kind).toBe('points');
    expect(l.times).toEqual(['2026-10-29T00:00:00Z']);
    expect(arr(l.coords as Float64Array)).toEqual([10.052356020942, 50.017573389756]); // lon, lat
    expect(l.parameters).toHaveLength(1);
    expect(l.parameters[0]).toMatchObject({ key: '2t', label: '2 metre temperature', unit: 'K' });
    expect(l.parameters[0].min).toBeCloseTo(276.1123, 3);
    expect(l.parameters[0].max).toBe(l.parameters[0].min);
    expect(l.values('2t', 0)[0]).toBeCloseTo(276.1123, 3);
    expect(l.levels).toEqual([0]);
  });

  it('area: MultiPoint with lat-lon composite -> 2408 lon/lat points', () => {
    const l = parseCoverageJson(liveArea);
    expect(l.kind).toBe('points');
    const c = l.coords as Float64Array;
    expect(c.length).toBe(2408 * 2);
    // first composite tuple is [45.026360945255, 5.031055900621, 0] = [lat, lon, levelist]
    expect(arr(c.subarray(0, 4))).toEqual([5.031055900621, 45.026360945255, 5.170807453416, 45.026360945255]);
    const v = l.values('2t', 0);
    expect(v).toHaveLength(2408);
    expect(v[0]).toBeCloseTo(281.6709, 3);
    expect(v[1]).toBeCloseTo(280.6026, 3);
    const { min, max } = l.parameters[0];
    expect(min).toBeLessThan(max);
    expect(Math.min(...v)).toBe(min);
    expect(Math.max(...v)).toBe(max);
  });

  it('trajectory: composite with t,lat,lon,levelist -> 15 vertices, no time steps', () => {
    const l = parseCoverageJson(liveTrajectory);
    expect(l.kind).toBe('trajectory');
    expect(l.times).toEqual([]);
    const c = l.coords as Float64Array;
    expect(c.length).toBe(30);
    expect(arr(c.subarray(0, 4))).toEqual([5.031055900621, 45.026360945255, 5.510204081633, 45.518452314711]);
    const v = l.values('2t', 0);
    expect(v).toHaveLength(15);
    expect(v[1]).toBeCloseTo(278.126, 3);
    expect(() => l.values('2t', 1)).toThrow(RangeError);
  });
});

describe('standard CoverageJSON', () => {
  it('Grid: x/y ascending, rows from the south', () => {
    const l = parseCoverageJson(stdGrid());
    expect(l.kind).toBe('grid');
    expect(isGridSpec(l.coords)).toBe(true);
    expect(arr(grid(l).x)).toEqual([0, 10, 20]);
    expect(arr(grid(l).y)).toEqual([50, 60]);
    expect(l.times).toEqual([]);
    expect(arr(l.values('T', 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(l.parameters[0]).toEqual({ key: 'T', label: 'Temperature', unit: 'K', min: 1, max: 6 });
  });

  it('single-Coverage Point', () => {
    const l = parseCoverageJson({
      type: 'Coverage',
      domain: { type: 'Domain', domainType: 'Point', axes: { x: { values: [5] }, y: { values: [51] } } },
      ranges: { a: { type: 'NdArray', dataType: 'float', axisNames: [], shape: [], values: [3.5] } },
    });
    expect(l.kind).toBe('points');
    expect(arr(l.coords as Float64Array)).toEqual([5, 51]);
    expect(l.values('a', 0)[0]).toBe(3.5);
    expect(l.parameters[0]).toMatchObject({ label: 'a', unit: '' });
  });

  it('regular axes (start/stop/num)', () => {
    const l = parseCoverageJson(stdGrid({}, { x: { start: 0, stop: 20, num: 3 } }));
    expect(arr(grid(l).x)).toEqual([0, 10, 20]);
  });

  it('MultiPointSeries collection concatenates coverages', () => {
    const cov = (lon: number, vals: number[]) => ({
      type: 'Coverage',
      domain: { type: 'Domain', axes: { x: { values: [lon] }, y: { values: [40] }, t: { values: ['t0', 't1'] } } },
      ranges: { a: { type: 'NdArray', dataType: 'float', axisNames: ['t'], shape: [2], values: vals } },
    });
    const l = parseCoverageJson({ type: 'CoverageCollection', domainType: 'PointSeries', coverages: [cov(1, [1, 2]), cov(2, [3, 4])] });
    expect(l.kind).toBe('points');
    expect(arr(l.coords as Float64Array)).toEqual([1, 40, 2, 40]);
    expect(arr(l.values('a', 0))).toEqual([1, 3]);
    expect(arr(l.values('a', 1))).toEqual([2, 4]);
  });

  it('rejects things it cannot draw', () => {
    expect(() => parseCoverageJson(null)).toThrow(CovJsonError);
    expect(() => parseCoverageJson({ type: 'Feature' })).toThrow(CovJsonError);
    expect(() => parseCoverageJson({ type: 'CoverageCollection', coverages: [] })).toThrow(CovJsonError);
    expect(() => parseCoverageJson(stdGrid({}, {}, { values: [1, 2] }))).toThrow(/expected 6/);
    expect(() => parseCoverageJson(stdGrid({}, { x: { values: [0, 20, 10] } }))).toThrow(/monotonic/);
    const vp = stdGrid();
    (vp.domain as { domainType: string }).domainType = 'VerticalProfile';
    expect(() => parseCoverageJson(vp)).toThrow(/VerticalProfile/);
  });
});

describe('multi-time series and range ordering', () => {
  const times = ['t0', 't1', 't2'];

  it('PointSeries with several times', () => {
    const l = parseCoverageJson({
      type: 'Coverage',
      domain: { type: 'Domain', domainType: 'PointSeries', axes: { x: { values: [1] }, y: { values: [2] }, t: { values: times } } },
      ranges: { a: { type: 'NdArray', dataType: 'float', axisNames: ['t'], shape: [3], values: [10, null, 30] } },
    });
    expect(l.times).toEqual(times);
    expect(arr(l.values('a', 0))).toEqual([10]);
    expect(Number.isNaN(l.values('a', 1)[0])).toBe(true);
    expect(arr(l.values('a', 2))).toEqual([30]);
    expect(l.parameters[0]).toMatchObject({ min: 10, max: 30 });
    expect(pointSeries(l, 0, 'a')).toEqual([
      { time: 't0', value: 10 },
      { time: 't1', value: null },
      { time: 't2', value: 30 },
    ]);
    expect(() => l.values('a', 3)).toThrow(RangeError);
    expect(() => l.values('nope', 0)).toThrow(RangeError);
  });

  it('grid ranges follow axisNames order (t, x, y vs t, y, x)', () => {
    // 2 times, x=3, y=2. Layout [t][x][y]: value = 100*t + 10*x + y
    const v: number[] = [];
    for (let t = 0; t < 2; t++) for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) v.push(100 * t + 10 * x + y);
    const l = parseCoverageJson(
      stdGrid({}, { t: { values: ['a', 'b'] } }, { axisNames: ['t', 'x', 'y'], shape: [2, 3, 2], values: v }),
    );
    expect(l.times).toEqual(['a', 'b']);
    // output index j*nx+i, value 100t + 10i + j
    expect(arr(l.values('T', 0))).toEqual([0, 10, 20, 1, 11, 21]);
    expect(arr(l.values('T', 1))).toEqual([100, 110, 120, 101, 111, 121]);
  });

  it('bad axisNames fall back to t, z, y, x order of the domain axes', () => {
    const v: number[] = [];
    for (let t = 0; t < 2; t++) for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) v.push(100 * t + 10 * y + x);
    const l = parseCoverageJson(
      stdGrid({}, { t: { values: ['a', 'b'] } }, { axisNames: ['T'], shape: [2, 2, 3], values: v }),
    );
    expect(arr(l.values('T', 1))).toEqual([100, 101, 102, 110, 111, 112]);
  });

  it('several params: min/max are per parameter over all times', () => {
    const l = parseCoverageJson({
      type: 'Coverage',
      domain: { type: 'Domain', domainType: 'PointSeries', axes: { x: { values: [1] }, y: { values: [2] }, t: { values: times } } },
      parameters: { b: { unit: { symbol: 'm' } } },
      ranges: {
        a: { type: 'NdArray', dataType: 'float', axisNames: ['t'], shape: [3], values: [5, 7, 6] },
        b: { type: 'NdArray', dataType: 'float', axisNames: ['t'], shape: [3], values: [-1, null, 1] },
      },
    });
    expect(l.parameters.map((p) => [p.key, p.min, p.max, p.unit])).toEqual([
      ['a', 5, 7, ''],
      ['b', -1, 1, 'm'],
    ]);
  });

  it('z axis: draws levelIndex, exposes levels, ranges over the selected level', () => {
    const l0 = parseCoverageJson(stdGrid({}, { z: { values: [1000, 500] } }, { axisNames: ['z', 'y', 'x'], shape: [2, 2, 3], values: [1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16] }));
    expect(l0.levels).toEqual([1000, 500]);
    expect(arr(l0.values('T', 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(l0.parameters[0]).toMatchObject({ min: 1, max: 6 });
    const l1 = parseCoverageJson(
      stdGrid({}, { z: { values: [1000, 500] } }, { axisNames: ['z', 'y', 'x'], shape: [2, 2, 3], values: [1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16] }),
      { levelIndex: 1 },
    );
    expect(l1.levelIndex).toBe(1);
    expect(arr(l1.values('T', 0))).toEqual([11, 12, 13, 14, 15, 16]);
    expect(l1.parameters[0]).toMatchObject({ min: 11, max: 16 });
  });
});

describe('nulls and descending axes', () => {
  it('nulls become NaN and are ignored by min/max', () => {
    const l = parseCoverageJson(stdGrid({}, {}, { values: [null, 2, 3, 4, null, 6] }));
    const v = l.values('T', 0);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(Number.isNaN(v[4])).toBe(true);
    expect(v[1]).toBe(2);
    expect(l.parameters[0]).toMatchObject({ min: 2, max: 6 });
  });

  it('all-null parameter has NaN min/max', () => {
    const l = parseCoverageJson(stdGrid({}, {}, { values: [null, null, null, null, null, null] }));
    expect(Number.isNaN(l.parameters[0].min)).toBe(true);
    expect(Number.isNaN(l.parameters[0].max)).toBe(true);
  });

  it('descending y (north first, typical for rasters) is flipped with its values', () => {
    const l = parseCoverageJson(stdGrid({}, { y: { values: [60, 50] } }));
    expect(arr(grid(l).y)).toEqual([50, 60]);
    // raw rows: y=60 -> [1,2,3], y=50 -> [4,5,6]; after the flip the south row comes first
    expect(arr(l.values('T', 0))).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('descending x is flipped with its values', () => {
    const l = parseCoverageJson(stdGrid({}, { x: { values: [20, 10, 0] } }));
    expect(arr(grid(l).x)).toEqual([0, 10, 20]);
    expect(arr(l.values('T', 0))).toEqual([3, 2, 1, 6, 5, 4]);
  });

  it('both axes descending, with time', () => {
    const l = parseCoverageJson(
      stdGrid(
        {},
        { x: { values: [20, 10, 0] }, y: { values: [60, 50] }, t: { values: ['a', 'b'] } },
        { axisNames: ['t', 'y', 'x'], shape: [2, 2, 3], values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      ),
    );
    expect(arr(l.values('T', 0))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(arr(l.values('T', 1))).toEqual([12, 11, 10, 9, 8, 7]);
  });
});

describe('limits and performance', () => {
  function synthetic(n: number) {
    const values: number[][] = new Array(n);
    const range: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      values[i] = [40 + (i % 200) * 0.01, -10 + Math.floor(i / 200) * 0.01, 0];
      range[i] = 270 + (i % 50);
    }
    return {
      type: 'CoverageCollection',
      domainType: 'MultiPoint',
      coverages: [
        {
          type: 'Coverage',
          domain: {
            type: 'Domain',
            axes: {
              t: { values: ['2026-10-29T00:00:00Z'] },
              composite: { dataType: 'tuple', coordinates: ['latitude', 'longitude', 'levelist'], values },
            },
          },
          ranges: { '2t': { type: 'NdArray', dataType: 'float', shape: [n], axisNames: ['2t'], values: range } },
        },
      ],
      parameters: { '2t': { unit: { symbol: 'K' } } },
    };
  }

  it('rejects 100k points with TooLargeToDraw', () => {
    const data = synthetic(100_000);
    let err: unknown;
    try {
      parseCoverageJson(data);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TooLargeToDraw);
    expect(err).toMatchObject({ what: 'points', count: 100_000, limit: MAX_POINTS });
  });

  it('parses 40k points in < 500 ms', () => {
    const data = synthetic(40_000);
    const t0 = performance.now();
    const l = parseCoverageJson(data);
    const v = l.values('2t', 0);
    const ms = performance.now() - t0;
    expect(l.kind).toBe('points');
    expect((l.coords as Float64Array).length).toBe(80_000);
    expect(v).toHaveLength(40_000);
    expect(l.parameters[0]).toMatchObject({ min: 270, max: 319 });
    expect(ms).toBeLessThan(500);
  });

  it('accepts exactly MAX_POINTS and rejects MAX_POINTS + 1', () => {
    expect(parseCoverageJson(synthetic(MAX_POINTS)).values('2t', 0)).toHaveLength(MAX_POINTS);
    expect(() => parseCoverageJson(synthetic(MAX_POINTS + 1))).toThrow(TooLargeToDraw);
  });

  it('rejects grids above MAX_GRID_CELLS before reading values', () => {
    const n = 2001; // 2001 * 2001 > 4,000,000
    const g = stdGrid({ ranges: {} }, { x: { start: 0, stop: 1, num: n }, y: { start: 0, stop: 1, num: n } });
    let err: unknown;
    try {
      parseCoverageJson(g);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TooLargeToDraw);
    expect(err).toMatchObject({ what: 'cells', count: n * n, limit: MAX_GRID_CELLS });
  });

  it('rejects a compact axis with num 1e9 before expanding it', () => {
    const t0 = performance.now();
    for (const axes of [
      { x: { start: 0, stop: 1, num: 1e9 }, y: { start: 0, stop: 1, num: 1e9 } },
      { x: { start: 0, stop: 1, num: 1e9 } },
      { x: { start: 0, stop: 1, num: 3 }, t: { start: 0, stop: 1, num: 1e9 } },
    ]) {
      const g = stdGrid({ ranges: {} }, axes);
      expect(() => parseCoverageJson(g)).toThrow(TooLargeToDraw);
    }
    // a Point domain with a huge compact x axis is refused too, without allocating
    const p = stdGrid({ ranges: {} }, { x: { start: 0, stop: 1, num: 1e9 }, y: { values: [1] } });
    (p.domain as { domainType: string }).domainType = 'Point';
    expect(() => parseCoverageJson(p)).toThrow(TooLargeToDraw);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('rejects non-uniform grid axes and keeps uniform ones (also descending / compact)', () => {
    const range = { shape: [2, 4], values: [1, 2, 3, 4, 5, 6, 7, 8] };
    expect(() => parseCoverageJson(stdGrid({}, { x: { values: [0, 10, 20, 40] } }, range))).toThrow(
      new CovJsonError('non-uniform grid not supported'),
    );
    expect(() =>
      parseCoverageJson(stdGrid({}, { x: { values: [0, 1, 2] }, y: { values: [0, 1, 5] } }, { shape: [3, 3], values: new Array(9).fill(1) })),
    ).toThrow(new CovJsonError('non-uniform grid not supported'));
    expect(parseCoverageJson(stdGrid({}, { x: { values: [0, 10, 20, 30] } }, range)).kind).toBe('grid');
    expect(parseCoverageJson(stdGrid({}, { x: { values: [30, 20, 10, 0.00001] } }, range)).kind).toBe('grid');
    expect(parseCoverageJson(stdGrid({}, { x: { start: 0, stop: 1, num: 4 } }, range)).kind).toBe('grid');
  });

  it('parses a 1000 x 1000 grid', () => {
    const n = 1000;
    const vals = new Array<number>(n * n);
    for (let i = 0; i < vals.length; i++) vals[i] = i;
    const l = parseCoverageJson(
      stdGrid({}, { x: { start: 0, stop: 1, num: n }, y: { start: 1, stop: 0, num: n } }, { shape: [n, n], values: vals }),
    );
    const v = l.values('T', 0);
    expect(v).toHaveLength(n * n);
    expect(v[0]).toBe((n - 1) * n); // y flipped: the first output row is the last raw row
  });
});
