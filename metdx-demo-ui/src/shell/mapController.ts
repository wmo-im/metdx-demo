import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import ImageStatic from 'ol/source/ImageStatic';
import Draw, { createBox } from 'ol/interaction/Draw';
import { Fill, Stroke, Style, Circle as CircleStyle } from 'ol/style';
import Polygon, { fromExtent } from 'ol/geom/Polygon';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import MultiPolygon from 'ol/geom/MultiPolygon';
import type SimpleGeometry from 'ol/geom/SimpleGeometry';
import { fromLonLat, toLonLat } from 'ol/proj';
import type { BBox, DrawKind, Geometry, Position } from '../lib/types';
import type { MapBrowserEvent } from 'ol';
import type { EventsKey } from 'ol/events';
import { unByKey } from 'ol/Observable';
import {
  MAX_CANVAS_DIM,
  isGridSpec,
  type ColourScale,
  type DataLayer,
  type DataSelectHandler,
  type GridSpec,
  type ParamInfo,
  type ShowDataOptions,
} from '../lib/covjsonTypes';
import { bandColour, computeContours, contourSupport, getTriangulation, type ContourSet } from '../lib/contour';

/**
 * Basemap tiles. Carto Voyager (`basemaps.cartocdn.com/rastertiles/voyager`) now answers with an
 * "API KEY REQUIRED" placeholder tile, so the default is the OSM standard layer (attribution required,
 * light use only). Override at build time with `VITE_BASEMAP_URL` (an XYZ template) and, if needed,
 * `VITE_BASEMAP_ATTRIBUTION`.
 */
export const BASEMAP_URL: string = import.meta.env.VITE_BASEMAP_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION: string =
  import.meta.env.VITE_BASEMAP_ATTRIBUTION ||
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Rejection reason when a draw is cancelled (Escape, new draw, clear). */
export class DrawCancelledError extends Error {
  constructor() {
    super('Drawing cancelled');
    this.name = 'DrawCancelledError';
  }
}

/** The map API shared with the pages (via {@link useMap}). */
export interface MapApi {
  /** Let the user draw a geometry on the map; resolves in lon/lat. `bbox` yields a rectangle Polygon. */
  drawGeometry(kind: DrawKind): Promise<Geometry>;
  /** Show an image (URL) stretched over `bbox` (EPSG:4326); `null` removes it. */
  setOverlay(img: string | null, bbox?: BBox | null, opts?: { fit?: boolean; opacity?: number }): void;
  /** Remove drawn geometry, overlay, extent outline and cancel any draw in progress. */
  clear(): void;
  /** Show a geometry (e.g. the current query) without drawing; `null` hides it. */
  showGeometry(geometry: Geometry | null): void;
  /** Outline a collection extent (orange); `null` hides it. */
  showExtent(bbox: BBox | null): void;
  /**
   * Draw a normalised CoverageJSON result (points, trajectory or grid) coloured by `opts.param` at
   * `opts.timeIndex`, and zoom to its extent. Calling again with the same `layer` only recolours
   * (param/time/style change); with a different `layer` it replaces the previous one. `opts.style: 'contours'`
   * draws a point layer as filled contours instead of points (falls back to points if it cannot be contoured).
   */
  showData(layer: DataLayer, opts: ShowDataOptions): void;
  /** Remove the data layer and release its resources. */
  clearData(): void;
  /** Subscribe to clicks on drawn data; returns an unsubscribe function. */
  onDataSelect(cb: DataSelectHandler): () => void;
}

const ORANGE = '#f57c00';
const BLUE = '#1565c0';

const geometryStyle = new Style({
  stroke: new Stroke({ color: BLUE, width: 3 }),
  fill: new Fill({ color: 'rgba(21,101,192,0.18)' }),
  image: new CircleStyle({ radius: 7, fill: new Fill({ color: BLUE }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
});
const extentStyle = new Style({
  stroke: new Stroke({ color: ORANGE, width: 2 }),
  fill: new Fill({ color: 'rgba(245,124,0,0.12)' }),
});

/** Number of colour buckets used for points and the grid paint (value → bucket → colour). */
const COLOUR_STEPS = 256;
/** Click tolerance for points / trajectory vertices, in screen pixels. */
const HIT_TOLERANCE_PX = 8;
/** Contour sets kept per DataLayer (param × time combinations visited recently). */
const MAX_CONTOUR_CACHE = 12;

/** Canvas size for a grid of `nx × ny` cells: one pixel per cell, each side capped at {@link MAX_CANVAS_DIM}. */
export function gridCanvasSize(nx: number, ny: number): { width: number; height: number } {
  return { width: Math.max(1, Math.min(nx, MAX_CANVAS_DIM)), height: Math.max(1, Math.min(ny, MAX_CANVAS_DIM)) };
}

/** 256-entry RGBA lookup table of a colour scale. */
function colourTable(scale: ColourScale): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(COLOUR_STEPS * 4);
  for (let k = 0; k < COLOUR_STEPS; k++) lut.set(scale.fn(k / (COLOUR_STEPS - 1)), k * 4);
  return lut;
}

/** Bucket (0..255) of `v` in [min, max]; -1 for NaN. A flat range (min = max) maps to the middle. */
function bucketOf(v: number, min: number, range: number): number {
  if (Number.isNaN(v)) return -1;
  if (!(range > 0)) return COLOUR_STEPS >> 1;
  const k = Math.round(((v - min) / range) * (COLOUR_STEPS - 1));
  return k < 0 ? 0 : k > COLOUR_STEPS - 1 ? COLOUR_STEPS - 1 : k;
}

/**
 * Paint grid `values` (`nx * ny`, row-major from the south) into RGBA pixels `out` (`width * height * 4`,
 * row 0 = north). When `width < nx` or `height < ny` the grid is downsampled (nearest cell). NaN is transparent.
 */
export function paintGridRGBA(
  values: Float32Array,
  nx: number,
  ny: number,
  width: number,
  height: number,
  min: number,
  max: number,
  scale: ColourScale,
  out: Uint8ClampedArray,
): void {
  const lut = colourTable(scale);
  const range = max - min;
  const xs = new Int32Array(width);
  for (let px = 0; px < width; px++) xs[px] = Math.min(nx - 1, Math.floor(((px + 0.5) * nx) / width));
  for (let py = 0; py < height; py++) {
    const j = ny - 1 - Math.min(ny - 1, Math.floor(((py + 0.5) * ny) / height));
    const rowBase = j * nx;
    let o = py * width * 4;
    for (let px = 0; px < width; px++, o += 4) {
      const k = bucketOf(values[rowBase + xs[px]], min, range);
      if (k < 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        const l = k * 4;
        out[o] = lut[l];
        out[o + 1] = lut[l + 1];
        out[o + 2] = lut[l + 2];
        out[o + 3] = lut[l + 3];
      }
    }
  }
}

/** Index of the entry of ascending `a` nearest to `v`. */
function nearestIndex(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid;
    else hi = mid;
  }
  return hi > lo && Math.abs(a[hi] - v) < Math.abs(a[lo] - v) ? hi : lo;
}

/** Edge-to-edge extent `[w, s, e, n]` (EPSG:4326) of the cells of `grid`; latitudes clamped to ±90. */
function gridExtent(grid: GridSpec): BBox {
  const edge = (a: Float64Array, first: boolean): number => {
    const n = a.length;
    if (n === 1) return a[0] + (first ? -0.5 : 0.5);
    return first ? a[0] - (a[1] - a[0]) / 2 : a[n - 1] + (a[n - 1] - a[n - 2]) / 2;
  };
  const lat = (v: number) => Math.max(-90, Math.min(90, v));
  return [edge(grid.x, true), lat(edge(grid.y, true)), edge(grid.x, false), lat(edge(grid.y, false))];
}

/** Bounding box of flat `[lon, lat, …]` pairs. */
function coordsExtent(coords: Float64Array): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return w <= e ? [w, s, e, n] : null;
}

function toOl(g: Geometry): SimpleGeometry {
  const t = (c: Position) => fromLonLat(c);
  switch (g.type) {
    case 'Point':
      return new Point(t(g.coordinates));
    case 'LineString':
      return new LineString(g.coordinates.map(t));
    case 'Polygon':
      return new Polygon(g.coordinates.map((r) => r.map(t)));
  }
}

function fromOl(geom: SimpleGeometry): Geometry {
  const ll = (c: number[]): Position => {
    const [x, y] = toLonLat(c);
    return [round(x), round(y)];
  };
  if (geom instanceof Point) return { type: 'Point', coordinates: ll(geom.getCoordinates()) };
  if (geom instanceof LineString) return { type: 'LineString', coordinates: geom.getCoordinates().map(ll) };
  return { type: 'Polygon', coordinates: (geom as Polygon).getCoordinates().map((r) => r.map(ll)) };
}

function round(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** Layer opacity of the drawn data when `ShowDataOptions.opacity` is not given. */
const DEFAULT_GRID_OPACITY = 0.85;
const DEFAULT_CONTOUR_OPACITY = 0.9;
const DEFAULT_POINTS_OPACITY = 1;

export class MapController implements MapApi {
  private map: Map | null = null;
  private readonly overlayLayer = new ImageLayer({ zIndex: 5, opacity: 0.8 });
  private readonly extentSource = new VectorSource();
  private readonly geometrySource = new VectorSource();
  private readonly drawnSource = new VectorSource();
  private draw: Draw | null = null;
  private cancelDraw: (() => void) | null = null;

  // Data layer (showData). The three OL layers live as long as the controller (so the layer count never
  // grows); only their sources are created per DataLayer and disposed on replace / clearData.
  private readonly dataImageLayer = new ImageLayer({ zIndex: 6, opacity: DEFAULT_GRID_OPACITY });
  private readonly dataLineLayer = new VectorLayer({
    zIndex: 7,
    style: [
      new Style({ stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 4 }) }),
      new Style({ stroke: new Stroke({ color: '#37474f', width: 2 }) }),
    ],
  });
  private readonly dataPointsLayer = new VectorLayer({
    // Above the query geometry layers (11 / 12): a position result sits exactly under the drawn marker and must stay visible.
    zIndex: 13,
    style: (feature) => this.pointStyle(feature),
  });
  /** Filled contour bands of a point layer (style `contours`); below the points, same slot as the grid image. */
  private readonly dataContourLayer = new VectorLayer({ zIndex: 6, opacity: DEFAULT_CONTOUR_OPACITY });
  /** Contour sets of the current DataLayer by `param|time` (cleared with the layer). */
  private contourCache = new globalThis.Map<string, ContourSet | null>();
  /** `param|time|scale` of the contour source currently shown. */
  private contourKey = '';
  /** Values behind the contour picture (for click lookup). */
  private contourValues: Float32Array | null = null;
  /** What is drawn for the current point layer. */
  private activeStyle: 'points' | 'contours' | null = null;
  private data: DataLayer | null = null;
  /** Colour bucket per point (-1 = no data); read by the points style function. */
  private colourIdx: Int16Array | null = null;
  private styleCache: Style[] = [];
  private styleKey = '';
  private canvas: HTMLCanvasElement | null = null;
  private imageData: ImageData | null = null;
  private paintSeq = 0;
  /** Values of the grid currently painted (view onto the DataLayer's storage; for click lookup). */
  private gridValues: Float32Array | null = null;
  private dataState: string | null = null;
  /** `param|time|scale|style` and opacity of the last showData (lets an opacity-only change skip the redraw). */
  private lastShow: { key: string; opacity: number | undefined } | null = null;
  private opacityState: string | null = null;
  private readonly selectHandlers = new Set<DataSelectHandler>();
  private clickKey: EventsKey | null = null;

  /** Create the OL map in `target`. Layers are created up-front so state set before mounting is kept. */
  attach(target: HTMLElement): void {
    if (this.map) this.detach();
    this.map = new Map({
      target,
      layers: [
        new TileLayer({ source: new XYZ({ url: BASEMAP_URL, attributions: ATTRIBUTION, maxZoom: 19 }) }),
        this.overlayLayer,
        new VectorLayer({ source: this.extentSource, style: extentStyle, zIndex: 10 }),
        new VectorLayer({ source: this.geometrySource, style: geometryStyle, zIndex: 11 }),
        new VectorLayer({ source: this.drawnSource, style: geometryStyle, zIndex: 12 }),
      ],
      view: new View({ center: fromLonLat([10, 50]), zoom: 3 }),
    });
    this.map.addLayer(this.dataImageLayer);
    this.map.addLayer(this.dataContourLayer);
    this.map.addLayer(this.dataLineLayer);
    this.map.addLayer(this.dataPointsLayer);
    this.clickKey = this.map.on('singleclick', (e) => this.handleClick(e));
    this.markData(this.dataState);
    this.markStyle(this.activeStyle);
    this.markOpacity(this.opacityState);
  }

  detach(): void {
    this.cancel();
    if (this.clickKey) unByKey(this.clickKey);
    this.clickKey = null;
    this.map?.setTarget(undefined);
    this.map = null;
  }

  /** The OL map (for tests / advanced use). */
  getMap(): Map | null {
    return this.map;
  }

  drawGeometry(kind: DrawKind): Promise<Geometry> {
    const map = this.map;
    if (!map) return Promise.reject(new Error('Map is not ready'));
    this.cancel();
    this.drawnSource.clear();
    return new Promise<Geometry>((resolve, reject) => {
      const draw = new Draw(
        kind === 'point'
          ? { source: this.drawnSource, type: 'Point' }
          : kind === 'line'
            ? { source: this.drawnSource, type: 'LineString' }
            : kind === 'polygon'
              ? { source: this.drawnSource, type: 'Polygon' }
              : // bbox: press, drag, release (freehand; without it OL's box needs two separate clicks)
                { source: this.drawnSource, type: 'Circle', geometryFunction: createBox(), freehand: true },
      );
      const finish = () => {
        map.removeInteraction(draw);
        document.removeEventListener('keydown', onKey);
        if (this.draw === draw) {
          this.draw = null;
          this.cancelDraw = null;
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.cancel();
      };
      draw.on('drawend', (e) => {
        const geom = e.feature.getGeometry() as SimpleGeometry;
        finish();
        resolve(fromOl(geom));
      });
      this.draw = draw;
      this.cancelDraw = () => {
        finish();
        this.drawnSource.clear();
        reject(new DrawCancelledError());
      };
      document.addEventListener('keydown', onKey);
      map.addInteraction(draw);
    });
  }

  /** Cancel a draw in progress (rejects its promise). */
  cancel(): void {
    this.cancelDraw?.();
  }

  setOverlay(img: string | null, bbox?: BBox | null, opts: { fit?: boolean; opacity?: number } = {}): void {
    if (!img || !bbox) {
      this.overlayLayer.setSource(null);
      this.markOverlay(null);
      return;
    }
    this.overlayLayer.setOpacity(opts.opacity ?? 0.8);
    const source = new ImageStatic({ url: img, imageExtent: bbox, projection: 'EPSG:4326' });
    // Overlay state is mirrored on the map element (data-overlay) so tests/automation can observe it.
    const mark = (state: string) => {
      if (this.overlayLayer.getSource() === source) this.markOverlay(state);
    };
    source.on('imageloadstart', () => mark('loading'));
    source.on('imageloadend', () => mark('loaded'));
    source.on('imageloaderror', () => mark('error'));
    this.overlayLayer.setSource(source);
    this.markOverlay('loading');
    if (opts.fit !== false) this.fit(bbox);
  }

  showGeometry(geometry: Geometry | null): void {
    this.geometrySource.clear();
    if (geometry) this.geometrySource.addFeature(new Feature(toOl(geometry)));
  }

  showExtent(bbox: BBox | null): void {
    this.extentSource.clear();
    if (bbox) {
      const poly = fromExtent(bbox);
      poly.transform('EPSG:4326', 'EPSG:3857');
      this.extentSource.addFeature(new Feature(poly));
    }
  }

  showData(layer: DataLayer, opts: ShowDataOptions): void {
    const isNew = layer !== this.data;
    const showKey = `${opts.param}|${opts.timeIndex}|${opts.colourScale.name}|${opts.style ?? 'points'}`;
    // Only the opacity changed: set it on the layers, nothing is recomputed or rebuilt.
    if (!isNew && this.lastShow && this.lastShow.key === showKey && this.lastShow.opacity !== opts.opacity) {
      this.lastShow.opacity = opts.opacity;
      this.applyOpacity(layer, opts.opacity);
      return;
    }
    const param = layer.parameters.find((p) => p.key === opts.param);
    if (!param) throw new RangeError(`Unknown parameter "${opts.param}"`);
    const values = layer.values(opts.param, opts.timeIndex);
    if (isNew) {
      if ((layer.kind === 'grid') !== isGridSpec(layer.coords)) {
        throw new TypeError(`DataLayer kind "${layer.kind}" does not match its coords`);
      }
      this.clearData();
      this.data = layer;
    }
    if (layer.kind === 'grid') this.showGrid(layer, values, param.min, param.max, opts.colourScale, isNew);
    else if (opts.style === 'contours' && layer.kind === 'points' && this.showContours(layer, values, param, opts, isNew)) {
      /* drawn as contours */
    } else {
      this.hideContours();
      this.showPoints(layer, values, param.min, param.max, opts.colourScale, isNew);
    }
    this.lastShow = { key: showKey, opacity: opts.opacity };
    this.applyOpacity(layer, opts.opacity);
  }

  /** Layer opacity of the drawn data (`undefined` = each layer's default); mirrored as `data-opacity` for tests/automation. */
  private applyOpacity(layer: DataLayer, opacity: number | undefined): void {
    const o = opacity === undefined ? undefined : Math.min(1, Math.max(0, opacity));
    this.dataImageLayer.setOpacity(o ?? DEFAULT_GRID_OPACITY);
    this.dataContourLayer.setOpacity(o ?? DEFAULT_CONTOUR_OPACITY);
    this.dataPointsLayer.setOpacity(o ?? DEFAULT_POINTS_OPACITY);
    this.dataLineLayer.setOpacity(o ?? DEFAULT_POINTS_OPACITY);
    const shown =
      layer.kind === 'grid' ? this.dataImageLayer : this.activeStyle === 'contours' ? this.dataContourLayer : this.dataPointsLayer;
    this.markOpacity(String(shown.getOpacity()));
  }

  private markOpacity(state: string | null): void {
    this.opacityState = state;
    const el = this.map?.getTargetElement();
    if (!el) return;
    if (state) el.setAttribute('data-opacity', state);
    else el.removeAttribute('data-opacity');
  }

  clearData(): void {
    this.paintSeq++;
    this.data = null;
    this.colourIdx = null;
    this.styleCache = [];
    this.styleKey = '';
    this.hideContours();
    this.contourCache.clear();
    this.activeStyle = null;
    this.lastShow = null;
    this.dataPointsLayer.setVisible(true);
    for (const l of [this.dataPointsLayer, this.dataLineLayer, this.dataImageLayer]) {
      const src = l.getSource();
      l.setSource(null);
      src?.dispose();
    }
    if (this.canvas) {
      this.canvas.width = 0; // releases the pixel buffer
      this.canvas.height = 0;
      this.canvas = null;
    }
    this.imageData = null;
    this.gridValues = null;
    this.contourValues = null;
    this.markStyle(null);
    this.markData(null);
    this.markOpacity(null);
  }

  onDataSelect(cb: DataSelectHandler): () => void {
    this.selectHandlers.add(cb);
    return () => {
      this.selectHandlers.delete(cb);
    };
  }

  /** The reused grid canvas (for tests); `null` unless a grid is shown. */
  getDataCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** What the current data layer is drawn as (`null` if none, or a grid); for tests. */
  getDataStyle(): 'points' | 'contours' | null {
    return this.activeStyle;
  }

  private showPoints(layer: DataLayer, values: Float32Array, min: number, max: number, scale: ColourScale, isNew: boolean): void {
    const coords = layer.coords as Float64Array;
    const n = coords.length / 2;
    if (values.length !== n) throw new RangeError(`Expected ${n} values, got ${values.length}`);
    // Geometries are built once per DataLayer, on first use as points (a layer drawn only as contours never
    // needs them); param/time changes only touch `colourIdx`.
    if (!this.dataPointsLayer.getSource()) {
      const features = new Array<Feature>(n);
      for (let i = 0; i < n; i++) {
        const f = new Feature(new Point(fromLonLat([coords[2 * i], coords[2 * i + 1]])));
        f.set('i', i, true);
        features[i] = f;
      }
      this.dataPointsLayer.setSource(new VectorSource({ features }));
      if (layer.kind === 'trajectory' && n > 1) {
        const line = new LineString(features.map((f) => (f.getGeometry() as Point).getCoordinates()));
        this.dataLineLayer.setSource(new VectorSource({ features: [new Feature(line)] }));
      }
    }
    if (isNew) {
      const ext = coordsExtent(coords);
      if (ext) this.fit(ext);
    }
    const key = `${scale.name}|${n}|${layer.kind}`;
    if (key !== this.styleKey || this.styleCache.length === 0) {
      this.styleKey = key;
      this.styleCache = this.makePointStyles(scale, n, layer.kind === 'trajectory');
    }
    const idx = this.colourIdx && this.colourIdx.length === n ? this.colourIdx : new Int16Array(n);
    const range = max - min;
    for (let i = 0; i < n; i++) idx[i] = bucketOf(values[i], min, range);
    this.colourIdx = idx;
    this.dataPointsLayer.setVisible(true);
    this.dataPointsLayer.changed();
    this.activeStyle = 'points';
    this.markStyle('points');
    this.markData('drawn');
  }

  /**
   * Draw `layer` as filled contours of `values`. Returns false (nothing changed) when it cannot be contoured, so the
   * caller falls back to points. The points layer is only hidden: its features are kept for a switch back.
   */
  private showContours(layer: DataLayer, values: Float32Array, param: ParamInfo, opts: ShowDataOptions, isNew: boolean): boolean {
    const coords = layer.coords as Float64Array;
    const n = coords.length / 2;
    if (values.length !== n) throw new RangeError(`Expected ${n} values, got ${values.length}`);
    if (!contourSupport(coords).ok) return false;
    const ckey = `${opts.param}|${opts.timeIndex}`;
    let set = this.contourCache.get(ckey);
    if (set === undefined) {
      set = computeContours(getTriangulation(coords), coords, values, param.min, param.max);
      if (this.contourCache.size >= MAX_CONTOUR_CACHE) this.contourCache.delete(this.contourCache.keys().next().value as string);
      this.contourCache.set(ckey, set);
    }
    if (!set) return false;
    if (isNew) {
      const ext = coordsExtent(coords);
      if (ext) this.fit(ext);
    }
    const key = `${ckey}|${opts.colourScale.name}|${param.min}|${param.max}`;
    if (key !== this.contourKey || !this.dataContourLayer.getSource()) {
      const features = set.bands.flatMap((band) => {
        if (band.coordinates.length === 0) return [];
        const [r, g, b] = bandColour(opts.colourScale, band.lower, band.upper, param.min, param.max);
        const f = new Feature(new MultiPolygon(band.coordinates).transform('EPSG:4326', 'EPSG:3857'));
        f.setStyle(new Style({ fill: new Fill({ color: `rgb(${r},${g},${b})` }) }));
        return [f];
      });
      const old = this.dataContourLayer.getSource();
      this.dataContourLayer.setSource(new VectorSource({ features }));
      old?.dispose();
      this.contourKey = key;
    }
    this.contourValues = values;
    this.dataContourLayer.setVisible(true);
    this.dataPointsLayer.setVisible(false);
    this.activeStyle = 'contours';
    this.markStyle('contours');
    this.markData('drawn');
    return true;
  }

  /** Remove the contour picture and release its source. */
  private hideContours(): void {
    const src = this.dataContourLayer.getSource();
    this.dataContourLayer.setSource(null);
    src?.dispose();
    this.contourKey = '';
    this.contourValues = null;
  }

  private makePointStyles(scale: ColourScale, n: number, trajectory: boolean): Style[] {
    const radius = trajectory ? 5 : n > 10_000 ? 2.5 : n > 2_000 ? 3.5 : 5;
    const stroke = n <= 5_000 ? new Stroke({ color: 'rgba(255,255,255,0.9)', width: 1 }) : undefined;
    const lut = colourTable(scale);
    const styles: Style[] = [];
    for (let k = 0; k < COLOUR_STEPS; k++) {
      const [r, g, b, a] = [lut[4 * k], lut[4 * k + 1], lut[4 * k + 2], lut[4 * k + 3] / 255];
      styles.push(
        new Style({ image: new CircleStyle({ radius, fill: new Fill({ color: `rgba(${r},${g},${b},${a})` }), stroke }) }),
      );
    }
    return styles;
  }

  /** The one style function of the points layer: a lookup into the precomputed colour array. */
  private pointStyle(feature: { get(key: string): unknown }): Style | undefined {
    const k = this.colourIdx?.[feature.get('i') as number];
    return k === undefined || k < 0 ? undefined : this.styleCache[k];
  }

  private showGrid(layer: DataLayer, values: Float32Array, min: number, max: number, scale: ColourScale, isNew: boolean): void {
    const grid = layer.coords as GridSpec;
    const nx = grid.x.length;
    const ny = grid.y.length;
    if (values.length !== nx * ny) throw new RangeError(`Expected ${nx * ny} values, got ${values.length}`);
    this.gridValues = values;
    const { width, height } = gridCanvasSize(nx, ny);
    if (!this.canvas) this.canvas = document.createElement('canvas');
    const canvas = this.canvas;
    if (canvas.width !== width || canvas.height !== height || !this.imageData) {
      canvas.width = width;
      canvas.height = height;
      this.imageData = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.imageData ??= ctx.createImageData(width, height);
    paintGridRGBA(values, nx, ny, width, height, min, max, scale, this.imageData.data);
    ctx.putImageData(this.imageData, 0, 0);

    const extent = gridExtent(grid);
    const source = new ImageStatic({
      url: canvas.toDataURL('image/png'),
      imageExtent: extent,
      projection: 'EPSG:4326',
      interpolate: false,
    });
    const seq = ++this.paintSeq;
    const mark = (state: string) => {
      if (seq === this.paintSeq) this.markData(state);
    };
    source.on('imageloadstart', () => mark('loading'));
    source.on('imageloadend', () => mark('loaded'));
    source.on('imageloaderror', () => mark('error'));
    const old = this.dataImageLayer.getSource();
    this.dataImageLayer.setSource(source);
    old?.dispose();
    this.markData('loading');
    if (isNew) this.fit(extent);
  }

  /** Map click: pick the nearest drawn point within tolerance, else the grid cell under the cursor. */
  private handleClick(e: Pick<MapBrowserEvent, 'coordinate'>): void {
    if (this.draw || !this.data || this.selectHandlers.size === 0) return;
    const hit =
      this.data.kind === 'grid' ? this.hitGrid(e.coordinate) : this.activeStyle === 'contours' ? this.hitContour(e.coordinate) : this.hitPoint(e.coordinate);
    if (!hit) return;
    for (const cb of [...this.selectHandlers]) cb(hit.index, hit.lonlat);
  }

  /** Contour style: the nearest real point (Delaunay `find`), if it is near the data and has a value. */
  private hitContour(coordinate: number[]): { index: number; lonlat: [number, number] } | null {
    const coords = this.data?.coords;
    if (!coords || isGridSpec(coords)) return null;
    const [lon, lat] = toLonLat(coordinate);
    const i = getTriangulation(coords).nearest(lon, lat);
    if (i < 0 || Number.isNaN(this.contourValues?.[i] ?? NaN)) return null;
    return { index: i, lonlat: [coords[2 * i], coords[2 * i + 1]] };
  }

  private hitPoint(coordinate: number[]): { index: number; lonlat: [number, number] } | null {
    const source = this.dataPointsLayer.getSource();
    const coords = this.data?.coords;
    const view = this.map?.getView();
    if (!source || !coords || isGridSpec(coords) || !view) return null;
    const idx = this.colourIdx;
    const f = source.getClosestFeatureToCoordinate(coordinate, (cand) => (idx?.[cand.get('i') as number] ?? -1) >= 0);
    if (!f) return null;
    const c = (f.getGeometry() as Point).getCoordinates();
    const tolerance = HIT_TOLERANCE_PX * (view.getResolution() ?? 1);
    if (Math.hypot(c[0] - coordinate[0], c[1] - coordinate[1]) > tolerance) return null;
    const i = f.get('i') as number;
    return { index: i, lonlat: [coords[2 * i], coords[2 * i + 1]] };
  }

  private hitGrid(coordinate: number[]): { index: number; lonlat: [number, number] } | null {
    const grid = this.data?.coords;
    if (!this.data || !grid || !isGridSpec(grid)) return null;
    const [lon, lat] = toLonLat(coordinate);
    const [w, s, e, n] = gridExtent(grid);
    if (lon < w || lon > e || lat < s || lat > n) return null;
    const i = nearestIndex(grid.x, lon);
    const j = nearestIndex(grid.y, lat);
    const index = j * grid.x.length + i;
    const v = this.gridValues?.[index];
    if (v === undefined || Number.isNaN(v)) return null;
    return { index, lonlat: [grid.x[i], grid.y[j]] };
  }

  /** Mirrors what a point layer is drawn as (`data-style`: `points` | `contours`) on the map element for tests/automation. */
  private markStyle(style: 'points' | 'contours' | null): void {
    const el = this.map?.getTargetElement();
    if (!el) return;
    if (style) el.setAttribute('data-style', style);
    else el.removeAttribute('data-style');
  }

  private markData(state: string | null): void {
    this.dataState = state;
    const el = this.map?.getTargetElement();
    if (!el) return;
    if (state) el.setAttribute('data-data', state);
    else el.removeAttribute('data-data');
  }

  clear(): void {
    this.cancel();
    this.drawnSource.clear();
    this.geometrySource.clear();
    this.extentSource.clear();
    this.overlayLayer.setSource(null);
    this.markOverlay(null);
  }

  private markOverlay(state: string | null): void {
    const el = this.map?.getTargetElement();
    if (!el) return;
    if (state) el.setAttribute('data-overlay', state);
    else el.removeAttribute('data-overlay');
  }

  private fit(bbox: BBox): void {
    if (!this.map) return;
    const [w, s, e, n] = bbox;
    const lat = (v: number) => Math.max(-85, Math.min(85, v));
    const ext = [...fromLonLat([w, lat(s)]), ...fromLonLat([e, lat(n)])];
    this.map.getView().fit(ext, { padding: [20, 20, 20, 20], duration: 250, maxZoom: 10 });
  }
}
