/**
 * Shared contract for drawing EDR CoverageJSON results on the map.
 *
 * - `src/lib/covjson.ts` (parser) produces a {@link DataLayer}; it rejects too-large input with
 *   {@link TooLargeToDraw}.
 * - `src/shell/mapController.ts` (renderer) consumes a {@link DataLayer} via `MapApi.showData`.
 * - `src/shell/Legend.tsx` renders a colour bar from {@link LegendProps}.
 *
 * Everything here is plain data (no OpenLayers / React imports) so both sides can be tested alone.
 */

/** Max number of points (points / trajectory layers). The parser rejects inputs above this. */
export const MAX_POINTS = 50_000;
/** Max number of grid cells (`x.length * y.length`). The parser rejects inputs above this. */
export const MAX_GRID_CELLS = 4_000_000;
/** Max canvas width/height in pixels for a painted grid. The renderer downsamples above this. */
export const MAX_CANVAS_DIM = 4096;

/** One drawable parameter (e.g. `2t`). `min`/`max` are over all times, ignoring NaN; both NaN if no data. */
export interface ParamInfo {
  /** Key in the CoverageJSON `parameters` object; the argument for {@link DataLayer.values}. */
  key: string;
  /** Human label (observedProperty label, else `key`). */
  label: string;
  /** Unit symbol (e.g. `K`), `''` if unknown. */
  unit: string;
  /** Smallest finite value over all times, for the colour scale / legend. */
  min: number;
  /** Largest finite value over all times. */
  max: number;
}

/**
 * Regular grid: cell centres at `(x[i], y[j])`, both axes strictly ascending (the parser flips
 * descending axes and their values). x is longitude, y is latitude, in EPSG:4326 degrees.
 */
export interface GridSpec {
  /** Longitudes, ascending, length nx. */
  x: Float64Array;
  /** Latitudes, ascending, length ny. */
  y: Float64Array;
}

/**
 * A normalised, drawable CoverageJSON result.
 *
 * Value layout returned by {@link DataLayer.values} (length is the same for every call):
 * - `points` / `trajectory`: one value per coordinate pair, index `i` ↔ `coords[2i], coords[2i+1]`.
 * - `grid`: `nx * ny` values, row-major from the south: index `j * nx + i` ↔ `(x[i], y[j])`.
 *
 * `NaN` means "no data" (CoverageJSON `null`) and is drawn transparent.
 */
export interface DataLayer {
  kind: 'points' | 'trajectory' | 'grid';
  /** Drawable parameters, at least one. */
  parameters: ParamInfo[];
  /** ISO 8601 time labels, one per time step; `[]` when there is no time axis (then `timeIndex` is 0). */
  times: string[];
  /**
   * Points/trajectory: flat `[lon0, lat0, lon1, lat1, …]` (EPSG:4326 degrees), trajectory in path order.
   * Grid: a {@link GridSpec}.
   */
  coords: Float64Array | GridSpec;
  /**
   * Values for `param` (a {@link ParamInfo.key}) at `timeIndex` (0 when `times` is empty).
   * May return a view onto internal storage: callers must not mutate it.
   * @throws RangeError for an unknown `param` or out-of-range `timeIndex`.
   */
  values(param: string, timeIndex: number): Float32Array;
}

/** Type guard: is `coords` a {@link GridSpec} (i.e. `layer.kind === 'grid'`)? */
export function isGridSpec(coords: DataLayer['coords']): coords is GridSpec {
  return !(coords instanceof Float64Array);
}

/**
 * Thrown (by the parser) when a result exceeds {@link MAX_POINTS} or {@link MAX_GRID_CELLS}.
 * The UI shows `message` and keeps the raw JSON available.
 */
export class TooLargeToDraw extends Error {
  /** Which limit was hit. */
  readonly what: 'points' | 'cells';
  /** How many points/cells the input has. */
  readonly count: number;
  /** The limit that was exceeded. */
  readonly limit: number;
  constructor(what: 'points' | 'cells', count: number, limit: number) {
    super(`Too large to draw: ${count.toLocaleString('en-GB')} ${what} (limit ${limit.toLocaleString('en-GB')})`);
    this.name = 'TooLargeToDraw';
    this.what = what;
    this.count = count;
    this.limit = limit;
  }
}

/** `[r, g, b, a]`, each an integer 0–255. */
export type RGBA = [number, number, number, number];

/** Maps a normalised value to a colour. */
export interface ColourScale {
  /** Short name, e.g. `viridis`. */
  name: string;
  /** `t` in [0, 1] (values outside are clamped) → colour. NaN handling is the caller's job (transparent). */
  fn(t: number): RGBA;
}

const VIRIDIS_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

/** Default colour scale: viridis-like (10-stop linear interpolation), opaque. */
export const VIRIDIS: ColourScale = {
  name: 'viridis',
  fn(t: number): RGBA {
    const last = VIRIDIS_STOPS.length - 1;
    const p = (Number.isNaN(t) ? 0 : Math.min(1, Math.max(0, t))) * last;
    const i = Math.min(last - 1, Math.floor(p));
    const f = p - i;
    const a = VIRIDIS_STOPS[i];
    const b = VIRIDIS_STOPS[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
      255,
    ];
  },
};

/** The colour scale used unless the page picks another. */
export const DEFAULT_COLOUR_SCALE: ColourScale = VIRIDIS;

/** Options for `MapApi.showData`. */
export interface ShowDataOptions {
  /** {@link ParamInfo.key} to draw; its `min`/`max` set the colour range. */
  param: string;
  /** Time step index into {@link DataLayer.times} (0 if none). */
  timeIndex: number;
  colourScale: ColourScale;
  /**
   * How a `points` layer is drawn (default `'points'`; ignored for `grid` and `trajectory`):
   * - `'points'`: one coloured disc per point.
   * - `'contours'`: filled contour bands interpolated between the points (like matplotlib `tricontourf`); the points
   *   are hidden. Falls back to `'points'` when the layer cannot be contoured (see `contourSupport` in `contour.ts`).
   * The map element's `data-style` attribute reports what is actually drawn.
   */
  style?: DataStyle;
  /**
   * Opacity (0-1) of the drawn data. Omitted = each layer's default (grid 0.85, contours 0.9, points 1). Changing only
   * this between two calls sets the layer opacity without recomputing or rebuilding anything. The map element's
   * `data-opacity` attribute reports the opacity of what is shown.
   */
  opacity?: number;
}

/** See {@link ShowDataOptions.style}. */
export type DataStyle = 'points' | 'contours';

/**
 * Called when the user clicks a drawn point / trajectory vertex / grid cell (in contour style: the nearest point).
 * @param index point index (points, trajectory) or flat cell index `j * nx + i` (grid); the same index
 *   into the array returned by {@link DataLayer.values}.
 * @param lonlat `[lon, lat]` of that point or cell centre.
 */
export type DataSelectHandler = (index: number, lonlat: [number, number]) => void;

/** Props of `src/shell/Legend.tsx`: a colour bar from `min` (left/bottom) to `max`. Owned by the EDR page. */
export interface LegendProps {
  min: number;
  max: number;
  /** Unit symbol shown next to the range, `''` for none. */
  unit: string;
  scale: ColourScale;
  /** Optional parameter label shown as a title. */
  label?: string;
  /**
   * Band edges (ascending, at least 2) of a contour map: the legend is then stepped, one colour per band
   * (see `bandColour` in `contour.ts`), labelled at the edges. `min`/`max` still set the colour range.
   */
  levels?: number[];
}
