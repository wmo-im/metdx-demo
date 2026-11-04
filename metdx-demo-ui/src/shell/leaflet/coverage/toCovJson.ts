// Re-emits our normalised CovJsonLayer as standard CoverageJSON (x/y/t axes, valid axisNames, CRS84), the
// input leaflet-coverage / covjson-reader expect. One parameter and one time step per document.
import { isGridSpec, type DataLayer } from '../../../lib/covjsonTypes';

type Json = Record<string, unknown>;

const REFERENCING = [
  {
    coordinates: ['x', 'y'],
    system: {
      type: 'GeographicCRS',
      id: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    },
  },
  { coordinates: ['t'], system: { type: 'TemporalRS', calendar: 'Gregorian' } },
];

const num = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** The standard domain type the layer is emitted as (`MultiPoint` has no leaflet-coverage layer: a Point collection). */
export function standardDomainType(layer: DataLayer): 'Grid' | 'Trajectory' | 'PointSeries' | 'Point' | 'PointCollection' {
  if (layer.kind === 'grid') return 'Grid';
  if (layer.kind === 'trajectory') return 'Trajectory';
  const n = (layer.coords as Float64Array).length / 2;
  if (n > 1) return 'PointCollection';
  return layer.times.length > 1 ? 'PointSeries' : 'Point';
}

/** Standard CoverageJSON for `param` at `timeIndex` (a single Coverage, or a CoverageCollection of Points). */
export function toStandardCovJson(layer: DataLayer, param: string, timeIndex: number): Json {
  const info = layer.parameters.find((p) => p.key === param);
  if (!info) throw new RangeError(`Unknown parameter "${param}"`);
  const parameters = {
    [param]: {
      type: 'Parameter',
      observedProperty: { id: param, label: { en: info.label } },
      ...(info.unit ? { unit: { symbol: info.unit } } : {}),
    },
  };
  const time = layer.times.length ? layer.times[Math.min(timeIndex, layer.times.length - 1)] : undefined;
  const values = layer.values(param, timeIndex);
  const type = standardDomainType(layer);

  if (layer.kind === 'grid') {
    if (!isGridSpec(layer.coords)) throw new Error('grid layer without a grid');
    const { x, y } = layer.coords;
    return {
      type: 'Coverage',
      domain: {
        type: 'Domain',
        domainType: 'Grid',
        axes: {
          x: { values: Array.from(x) },
          y: { values: Array.from(y) },
          ...(time ? { t: { values: [time] } } : {}),
        },
        referencing: REFERENCING,
      },
      parameters,
      ranges: {
        [param]: {
          type: 'NdArray',
          dataType: 'float',
          axisNames: time ? ['t', 'y', 'x'] : ['y', 'x'],
          shape: time ? [1, y.length, x.length] : [y.length, x.length],
          values: Array.from(values, num),
        },
      },
    };
  }

  const xy = layer.coords as Float64Array;
  const n = xy.length / 2;

  if (layer.kind === 'trajectory') {
    // Trajectory times live in the composite axis of the source and are not kept by the normaliser: x/y only.
    const tuples: number[][] = [];
    for (let i = 0; i < n; i++) tuples.push([xy[2 * i], xy[2 * i + 1]]);
    return {
      type: 'Coverage',
      domain: {
        type: 'Domain',
        domainType: 'Trajectory',
        axes: {
          composite: {
            dataType: 'tuple',
            coordinates: ['x', 'y'],
            values: tuples,
          },
        },
        referencing: [{ coordinates: ['x', 'y'], system: REFERENCING[0].system }],
      },
      parameters,
      ranges: {
        [param]: {
          type: 'NdArray',
          dataType: 'float',
          axisNames: ['composite'],
          shape: [n],
          values: Array.from(values, num),
        },
      },
    };
  }

  if (n === 1) {
    const axes = { x: { values: [xy[0]] }, y: { values: [xy[1]] } };
    if (type === 'PointSeries') {
      const series = layer.times.map((_, ti) => num(layer.values(param, ti)[0]));
      return {
        type: 'Coverage',
        domain: {
          type: 'Domain',
          domainType: 'PointSeries',
          axes: { ...axes, t: { values: layer.times } },
          referencing: REFERENCING,
        },
        parameters,
        ranges: {
          [param]: {
            type: 'NdArray',
            dataType: 'float',
            axisNames: ['t'],
            shape: [layer.times.length],
            values: series,
          },
        },
      };
    }
    return {
      type: 'Coverage',
      domain: {
        type: 'Domain',
        domainType: 'Point',
        axes: { ...axes, ...(time ? { t: { values: [time] } } : {}) },
        referencing: REFERENCING,
      },
      parameters,
      ranges: {
        [param]: {
          type: 'NdArray',
          dataType: 'float',
          axisNames: [],
          shape: [],
          values: [num(values[0])],
        },
      },
    };
  }

  // MultiPoint: no leaflet-coverage layer, so one Point coverage per position in a collection.
  const coverages: Json[] = [];
  for (let i = 0; i < n; i++) {
    coverages.push({
      type: 'Coverage',
      domain: {
        type: 'Domain',
        domainType: 'Point',
        axes: {
          x: { values: [xy[2 * i]] },
          y: { values: [xy[2 * i + 1]] },
          ...(time ? { t: { values: [time] } } : {}),
        },
      },
      ranges: {
        [param]: {
          type: 'NdArray',
          dataType: 'float',
          axisNames: [],
          shape: [],
          values: [num(values[i])],
        },
      },
    });
  }
  return {
    type: 'CoverageCollection',
    domainType: 'Point',
    parameters,
    referencing: REFERENCING,
    coverages,
  };
}
