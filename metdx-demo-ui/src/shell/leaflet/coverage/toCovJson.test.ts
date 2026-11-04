import { describe, expect, it } from 'vitest';
import { read } from 'covjson-reader';
import { readFileSync } from 'node:fs';
import { parseCoverageJson } from '../../../lib/covjson';
import type { DataLayer } from '../../../lib/covjsonTypes';
import { standardDomainType, toStandardCovJson } from './toCovJson';

const live = (name: string) => parseCoverageJson(JSON.parse(readFileSync(`test/fixtures/edr/live-${name}.json`, 'utf8')));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('toStandardCovJson (live ECMWF samples)', () => {
  it('position: a Point with standard x/y/t axes, readable by covjson-reader', async () => {
    const layer = live('position');
    expect(standardDomainType(layer)).toBe('Point');
    const json = toStandardCovJson(layer, '2t', 0) as Json;
    expect(json.type).toBe('Coverage');
    expect(json.domain.domainType).toBe('Point');
    expect(Object.keys(json.domain.axes).sort()).toEqual(['t', 'x', 'y']);
    expect(json.domain.axes.x.values[0]).toBeCloseTo(10.05, 1);
    expect(json.ranges['2t'].values).toHaveLength(1);
    const cov = await read(json);
    const range = await cov.loadRange('2t');
    expect(range.get({})).toBeCloseTo(276.11, 1);
  });

  it('area (MultiPoint): a collection of Point coverages, one per position', async () => {
    const layer = live('area');
    expect(standardDomainType(layer)).toBe('PointCollection');
    const json = toStandardCovJson(layer, '2t', 0) as Json;
    expect(json.type).toBe('CoverageCollection');
    expect(json.domainType).toBe('Point');
    expect(json.coverages).toHaveLength((layer.coords as Float64Array).length / 2);
    const first = json.coverages[0];
    expect(first.domain.axes.x.values).toEqual([(layer.coords as Float64Array)[0]]);
    expect(first.ranges['2t'].values).toEqual([layer.values('2t', 0)[0]]);
    const coll = await read(json);
    expect(coll.coverages).toHaveLength(json.coverages.length);
  });

  it('trajectory: a composite x/y axis in path order and a range over it', async () => {
    const layer = live('trajectory');
    const json = toStandardCovJson(layer, '2t', 0) as Json;
    expect(json.domain.domainType).toBe('Trajectory');
    const axis = json.domain.axes.composite;
    expect(axis.coordinates).toEqual(['x', 'y']);
    expect(axis.values).toHaveLength(15);
    expect(axis.values[0]).toEqual([(layer.coords as Float64Array)[0], (layer.coords as Float64Array)[1]]);
    expect(json.ranges['2t'].axisNames).toEqual(['composite']);
    expect(await read(json)).toBeTruthy();
  });
});

describe('toStandardCovJson (grid, point series)', () => {
  const info = [{ key: 'a', label: 'A', unit: 'K', min: 0, max: 1 }];
  const grid: DataLayer = {
    kind: 'grid',
    parameters: info,
    times: ['2026-01-01T00:00:00Z', '2026-01-01T06:00:00Z'],
    coords: { x: Float64Array.of(0, 1, 2), y: Float64Array.of(10, 11) }, // ascending (the parser flips descending ones)
    values: (_p, t) => Float32Array.from([0, 1, 2, 3, NaN, 5].map((v) => v + t)),
  };

  it('grid: y/x/t axes, row-major values for the chosen time, NaN as null', async () => {
    const json = toStandardCovJson(grid, 'a', 1) as Json;
    expect(json.domain.domainType).toBe('Grid');
    expect(json.domain.axes.t.values).toEqual(['2026-01-01T06:00:00Z']);
    expect(json.ranges.a.axisNames).toEqual(['t', 'y', 'x']);
    expect(json.ranges.a.shape).toEqual([1, 2, 3]);
    expect(json.ranges.a.values).toEqual([1, 2, 3, 4, null, 6]);
    const cov = await read(json);
    const range = await cov.loadRange('a');
    expect(range.get({ t: 0, y: 1, x: 2 })).toBe(6);
  });

  it('a single position with several times is a PointSeries carrying every time', () => {
    const series: DataLayer = { ...grid, kind: 'points', coords: Float64Array.of(5, 6), values: (_p, t) => Float32Array.of(t * 10) };
    expect(standardDomainType(series)).toBe('PointSeries');
    const json = toStandardCovJson(series, 'a', 0) as Json;
    expect(json.domain.axes.t.values).toHaveLength(2);
    expect(json.ranges.a.values).toEqual([0, 10]);
  });

  it('rejects an unknown parameter', () => {
    expect(() => toStandardCovJson(grid, 'nope', 0)).toThrow(RangeError);
  });
});
