import type { BBox, DrawKind, Geometry } from '../lib/types';
import type { DataLayer, DataSelectHandler, DataStyle, ShowDataOptions } from '../lib/covjsonTypes';

/**
 * The engine-neutral map contract. Pages only see {@link MapApi} (via `useMap`); each map engine
 * (OpenLayers in `mapController.ts`, Leaflet in `leaflet/`) implements {@link MapEngine}. This module must stay
 * free of any map-library import so it can be shared without pulling an engine into the bundle.
 */

/** Rejection reason when a draw is cancelled (Escape, new draw, clear, engine switch). */
export class DrawCancelledError extends Error {
  constructor() {
    super('Drawing cancelled');
    this.name = 'DrawCancelledError';
  }
}

/** The whole world (Web Mercator's usable latitudes): the initial map view. */
export const WORLD_BBOX: BBox = [-180, -85, 180, 85];

/** Lowest map zoom of both engines: negative, so the whole world fits a map shorter than 256 px. Basemap tiles start at zoom 0. */
export const MIN_ZOOM = -4;

/** Highest zoom {@link ExtentOptions.fit} zooms to (before zooming out): a point footprint is not shown at street level. */
export const EXTENT_FIT_MAX_ZOOM = 8;

/** Options of {@link MapApi.showExtent}. */
export interface ExtentOptions {
  /**
   * Also move the view to the extent: zoom to it (at most {@link EXTENT_FIT_MAX_ZOOM}), then out by `padLevels` so the
   * surroundings show. Never zooms out further than the whole world (a world-wide extent just shows the world).
   */
  fit?: boolean;
  /** Zoom levels to zoom out after fitting (default 1). */
  padLevels?: number;
}

/** The map API shared with the pages (via `useMap`). */
export interface MapApi {
  /** Let the user draw a geometry on the map; resolves in lon/lat. `bbox` yields a rectangle Polygon. */
  drawGeometry(kind: DrawKind): Promise<Geometry>;
  /** Show an image (URL) stretched over `bbox` (EPSG:4326); `null` removes it. */
  setOverlay(img: string | null, bbox?: BBox | null, opts?: { fit?: boolean; opacity?: number }): void;
  /** Remove drawn geometry, overlay, extent outline and cancel any draw in progress. */
  clear(): void;
  /** Show a geometry (e.g. the current query) without drawing; `null` hides it. */
  showGeometry(geometry: Geometry | null): void;
  /** Outline a collection extent (orange); `null` hides it. With `opts.fit` the view moves to it (see {@link ExtentOptions}). */
  showExtent(bbox: BBox | null, opts?: ExtentOptions): void;
  /**
   * Draw a normalised CoverageJSON result (points, trajectory or grid) coloured by `opts.param` at
   * `opts.timeIndex`, and zoom to its extent. Calling again with the same `layer` only recolours
   * (param/time/style change); with a different `layer` it replaces the previous one. `opts.style: 'contours'`
   * draws a point layer as filled contours instead of points (falls back to points if it cannot be contoured).
   */
  showData(layer: DataLayer, opts: ShowDataOptions): void;
  /** Remove the data layer and release its resources. */
  clearData(): void;
  /**
   * Optional: when the browser is idle, compute what `showData` will need for the time steps `timeIndices` of the shown
   * `layer` (filled contours), in that order, so stepping to them is instant. Returns a cancel function; the work
   * also stops when the data layer is cleared or replaced. A no-op for what cannot be precomputed.
   */
  prefetchData?(layer: DataLayer, opts: { param: string; timeIndices: readonly number[]; style?: DataStyle }): () => void;
  /** Subscribe to clicks on drawn data; returns an unsubscribe function. */
  onDataSelect(cb: DataSelectHandler): () => void;
  /**
   * Only with `capabilities.coverageRenderer`: draw `layer` with leaflet-coverage instead of `showData`
   * (replaces the previous coverage layer). Rejects if the library cannot render it.
   */
  showCoverage?(layer: DataLayer, param: string, timeIndex: number): Promise<void>;
  /** Remove the leaflet-coverage layer (if any). */
  clearCoverage?(): void;
}

/** Optional features an engine offers beyond {@link MapApi}. */
export interface MapCapabilities {
  /** The engine can render a CoverageJSON result with leaflet-coverage. */
  coverageRenderer?: boolean;
}

export type { MapEngineName } from '../lib/config';

/**
 * A map engine: owns the library's map object. `attach` creates the map in `el` (state set before attaching,
 * e.g. a geometry, is kept and shown); `detach` cancels a draw in progress and releases the map. Both are idempotent.
 */
export interface MapEngine {
  /** The engine's {@link MapApi}. */
  readonly api: MapApi;
  readonly capabilities: MapCapabilities;
  attach(el: HTMLElement): void;
  detach(): void;
  /** Cancel a draw in progress (its promise rejects with {@link DrawCancelledError}). */
  cancel(): void;
}
