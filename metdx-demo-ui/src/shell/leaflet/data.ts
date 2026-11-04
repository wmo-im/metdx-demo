import * as L from 'leaflet';
import {
  MAX_CANVAS_DIM,
  isGridSpec,
  type ColourScale,
  type DataLayer,
  type DataSelectHandler,
  type GridSpec,
  type ParamInfo,
  type ShowDataOptions,
} from '../../lib/covjsonTypes';
import { bandColour, computeContours, contourSupport, getTriangulation, type ContourSet } from '../../lib/contour';
import type { BBox } from '../../lib/types';
import { reprojectImage } from './reproject';

/**
 * Data layers (points / trajectory / grid / contours) of the Leaflet engine; behaviour mirrors the OpenLayers
 * `mapController.ts` (which this module must not import: the Leaflet chunk is loaded on its own).
 *
 * - points: one canvas layer ({@link PointsCanvasLayer}) drawing every point from a shared colour-bucket array, so a
 *   parameter / time change only refills that array and redraws (no per-point Leaflet objects: 40k circle markers
 *   would be far too slow);
 * - trajectory: a halo + line polyline below the points;
 * - grid: painted to a canvas (one pixel per cell), reprojected 4326 -> 3857 ({@link reprojectImage}) and shown as an
 *   `L.imageOverlay`;
 * - contours: filled bands from `src/lib/contour.ts` (cached per `param|time`) as `L.geoJSON`, the points are hidden.
 *
 * Opacity is set on the pane element of each kind (one group opacity, like an OL layer). The state (data layer,
 * options, colours, contour cache) outlives the map, so data shown before `attach` is drawn once the map exists.
 */

const IMAGE_PANE = 'metdxDataImage';
const LINE_PANE = 'metdxDataLine';
const POINTS_PANE = 'metdxDataPoints';

/** Number of colour buckets used for points and the grid paint (value -> bucket -> colour). */
const COLOUR_STEPS = 256;
/** Click tolerance for points / trajectory vertices, in screen pixels. */
const HIT_TOLERANCE_PX = 8;
/** Contour sets kept per DataLayer (param x time combinations visited recently). */
const MAX_CONTOUR_CACHE = 12;

const DEFAULT_GRID_OPACITY = 0.85;
const DEFAULT_CONTOUR_OPACITY = 0.9;
const DEFAULT_POINTS_OPACITY = 1;

// ---- colour helpers (same maths as mapController.ts) --------------------------------------------------------------

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
 * Paint grid `values` (`nx * ny`, row-major from the south) into RGBA pixels `out` (`width * height * 4`, row 0 = north).
 * When `width < nx` or `height < ny` the grid is downsampled (nearest cell). NaN is transparent.
 */
function paintGridRGBA(
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

/** Bounding box of flat `[lon, lat, ...]` pairs. */
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

// ---- points canvas layer ------------------------------------------------------------------------------------------

/** What {@link PointsCanvasLayer} draws; `idx` is the shared colour-bucket array (-1 = no data), `colours` the CSS colour per bucket. */
interface PointsSource {
  coords: Float64Array;
  idx: Int16Array;
  colours: string[];
  radius: number;
  stroke: boolean;
}

/** Fraction of the map size drawn beyond each edge, so a pan shows no blank border until the next redraw. */
const CANVAS_PADDING = 0.1;

/**
 * One canvas covering the map (plus padding) that draws all points of a {@link PointsSource}. Positioned like
 * Leaflet's own canvas renderer: repositioned and redrawn on `moveend` / `resize`, scaled during zoom animations.
 */
class PointsCanvasLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private source: PointsSource;
  private readonly paneName: string;
  private topLeft = L.point(0, 0);
  private topLeftLatLng = L.latLng(0, 0);
  private zoom = 0;
  private pixelRatio = 1;

  constructor(source: PointsSource, pane: string) {
    super();
    this.source = source;
    this.paneName = pane;
  }

  /** Swap the colours / geometry and redraw. */
  setSource(source: PointsSource): void {
    this.source = source;
    this.redraw();
  }

  /** The canvas, once added to a map. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  getEvents(): Record<string, L.LeafletEventHandlerFn> {
    const events: Record<string, L.LeafletEventHandlerFn> = {
      moveend: () => this.reset(),
      resize: () => this.reset(),
      viewreset: () => this.reset(),
    };
    if ((this._map as unknown as { _zoomAnimated?: boolean } | undefined)?._zoomAnimated) {
      events.zoomanim = ((e: L.ZoomAnimEvent) => this.animateZoom(e)) as L.LeafletEventHandlerFn;
    }
    return events;
  }

  onAdd(map: L.Map): this {
    const canvas = document.createElement('canvas');
    canvas.className = 'leaflet-layer metdx-points-canvas';
    canvas.style.pointerEvents = 'none';
    if ((map as unknown as { _zoomAnimated?: boolean })._zoomAnimated) canvas.classList.add('leaflet-zoom-animated');
    this.canvas = canvas;
    const pane = map.getPane(this.paneName);
    pane?.appendChild(canvas);
    this.reset();
    return this;
  }

  onRemove(): this {
    this.canvas?.remove();
    if (this.canvas) {
      this.canvas.width = 0; // releases the pixel buffer
      this.canvas.height = 0;
    }
    this.canvas = null;
    return this;
  }

  /** Reposition the canvas over the current view and redraw. */
  private reset(): void {
    const map = this._map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    const pad = size.multiplyBy(CANVAS_PADDING);
    const min = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round();
    const w = Math.ceil(size.x + 2 * pad.x);
    const h = Math.ceil(size.y + 2 * pad.y);
    this.topLeft = min;
    this.topLeftLatLng = map.layerPointToLatLng(min);
    this.zoom = map.getZoom();
    this.pixelRatio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * this.pixelRatio));
    canvas.height = Math.max(1, Math.round(h * this.pixelRatio));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    L.DomUtil.setPosition(canvas, min);
    this.draw();
  }

  private animateZoom(e: L.ZoomAnimEvent): void {
    const map = this._map as unknown as {
      getZoomScale(to: number, from: number): number;
      _latLngToNewLayerPoint(ll: L.LatLng, zoom: number, center: L.LatLng): L.Point;
    };
    if (!map || !this.canvas) return;
    const scale = map.getZoomScale(e.zoom, this.zoom);
    const offset = map._latLngToNewLayerPoint(this.topLeftLatLng, e.zoom, e.center);
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  /** Redraw with the current colours (no repositioning). */
  redraw(): void {
    if (this.canvas) this.draw();
  }

  private draw(): void {
    const map = this._map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const ctx = canvas.getContext('2d');
    // A missing or partial 2D context (headless environments) draws nothing.
    if (!ctx || typeof ctx.arc !== 'function' || typeof ctx.setTransform !== 'function') return;
    const { coords, idx, colours, radius, stroke } = this.source;
    const r = this.pixelRatio;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, canvas.width / r, canvas.height / r);
    const w = canvas.width / r;
    const h = canvas.height / r;
    const ox = this.topLeft.x;
    const oy = this.topLeft.y;
    const n = Math.min(idx.length, coords.length / 2);
    const squares = n > 10_000; // a filled square is much cheaper than an arc and indistinguishable at this size
    if (stroke) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
    }
    let last = -2;
    for (let i = 0; i < n; i++) {
      const k = idx[i];
      if (k < 0) continue;
      const p = map.latLngToLayerPoint([coords[2 * i + 1], coords[2 * i]]);
      const x = p.x - ox;
      const y = p.y - oy;
      if (x < -radius || y < -radius || x > w + radius || y > h + radius) continue;
      if (k !== last) {
        ctx.fillStyle = colours[k];
        last = k;
      }
      if (squares) {
        ctx.fillRect(x - radius, y - radius, 2 * radius, 2 * radius);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
        if (stroke) ctx.stroke();
      }
    }
  }
}

// ---- the data layers ----------------------------------------------------------------------------------------------

type Hit = { index: number; lonlat: [number, number] };

/** Leaflet objects of the data layers; they live as long as the map. */
interface MapLayers {
  map: L.Map;
  el: HTMLElement;
  onClick: (e: L.LeafletMouseEvent) => void;
  panes: Record<'image' | 'line' | 'points', HTMLElement>;
  points: PointsCanvasLayer | null;
  line: L.LayerGroup | null;
  contours: L.LayerGroup | null;
  grid: L.ImageOverlay | null;
}

export class LeafletDataLayers {
  private readonly selectHandlers = new Set<DataSelectHandler>();
  private ml: MapLayers | null = null;

  private data: DataLayer | null = null;
  /** Last showData call (`key` = `param|time|scale|style`), to skip a redraw on an opacity-only change. */
  private lastShow: { key: string; opts: ShowDataOptions } | null = null;
  /** What is drawn for the current point layer. */
  private activeStyle: 'points' | 'contours' | null = null;
  /** Colour bucket per point (-1 = no data), shared with the points layer. */
  private colourIdx: Int16Array | null = null;
  private pointsSource: PointsSource | null = null;
  private pointsKey = '';
  /** Contour sets of the current DataLayer by `param|time` (cleared with the layer). */
  private contourCache = new Map<string, ContourSet | null>();
  private contourKey = '';
  /** Values behind the contour picture / the grid (views onto the DataLayer's storage, for click lookup). */
  private contourValues: Float32Array | null = null;
  private gridValues: Float32Array | null = null;
  private paintSeq = 0;
  private dataState: string | null = null;
  private styleState: 'points' | 'contours' | null = null;
  private opacityState: string | null = null;

  /** The map was created in `el` (or recreated): create the panes, and draw the data shown so far. */
  attach(map: L.Map, el: HTMLElement): void {
    if (this.ml) this.detach();
    const pane = (name: string, z: number): HTMLElement => {
      const p = map.createPane(name);
      p.style.zIndex = String(z);
      return p;
    };
    // Grid / contours above the Maps overlay (390), trajectory line below the query geometry (450), points above it.
    const panes = { image: pane(IMAGE_PANE, 392), line: pane(LINE_PANE, 440), points: pane(POINTS_PANE, 460) };
    const onClick = (e: L.LeafletMouseEvent) => this.handleClick(e);
    map.on('click', onClick);
    this.ml = { map, el, onClick, panes, points: null, line: null, contours: null, grid: null };
    if (this.data && this.lastShow) this.render(this.data, this.lastShow.opts, true);
    else this.markAll();
  }

  /** The map is going away: the state is kept, the Leaflet objects are dropped. */
  detach(): void {
    const ml = this.ml;
    if (!ml) return;
    this.paintSeq++;
    ml.map.off('click', ml.onClick);
    this.ml = null;
    this.pointsKey = '';
    this.contourKey = '';
    // The colour array / source stay (they are plain data); the Leaflet layers die with the map.
  }

  showData(layer: DataLayer, opts: ShowDataOptions): void {
    const isNew = layer !== this.data;
    const showKey = `${opts.param}|${opts.timeIndex}|${opts.colourScale.name}|${opts.style ?? 'points'}`;
    // Only the opacity changed: set it on the panes, nothing is recomputed or rebuilt.
    if (!isNew && this.lastShow && this.lastShow.key === showKey && this.lastShow.opts.opacity !== opts.opacity) {
      this.lastShow = { key: showKey, opts };
      this.applyOpacity(layer, opts.opacity);
      return;
    }
    if (!layer.parameters.some((p) => p.key === opts.param)) throw new RangeError(`Unknown parameter "${opts.param}"`);
    if (isNew) {
      if ((layer.kind === 'grid') !== isGridSpec(layer.coords)) {
        throw new TypeError(`DataLayer kind "${layer.kind}" does not match its coords`);
      }
      this.clearData();
      this.data = layer;
    }
    this.render(layer, opts, isNew);
  }

  /** Draw `layer` for `opts`. `isNew`: zoom to its extent. */
  private render(layer: DataLayer, opts: ShowDataOptions, isNew: boolean): void {
    const param = layer.parameters.find((p) => p.key === opts.param);
    if (!param) throw new RangeError(`Unknown parameter "${opts.param}"`);
    const values = layer.values(opts.param, opts.timeIndex);
    if (layer.kind === 'grid') this.showGrid(layer, values, param, opts.colourScale, isNew);
    else if (opts.style === 'contours' && layer.kind === 'points' && this.showContours(layer, values, param, opts, isNew)) {
      /* drawn as contours */
    } else {
      this.hideContours();
      this.showPoints(layer, values, param, opts.colourScale, isNew);
    }
    this.lastShow = { key: `${opts.param}|${opts.timeIndex}|${opts.colourScale.name}|${opts.style ?? 'points'}`, opts };
    this.applyOpacity(layer, opts.opacity);
  }

  clearData(): void {
    this.paintSeq++;
    this.data = null;
    this.colourIdx = null;
    this.pointsSource = null;
    this.pointsKey = '';
    this.hideContours();
    this.contourCache.clear();
    this.activeStyle = null;
    this.lastShow = null;
    this.gridValues = null;
    this.contourValues = null;
    const ml = this.ml;
    if (ml) {
      if (ml.points) ml.map.removeLayer(ml.points);
      if (ml.line) ml.map.removeLayer(ml.line);
      if (ml.grid) ml.map.removeLayer(ml.grid);
      ml.points = ml.line = null;
      ml.grid = null;
    }
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

  /** What the current data layer is drawn as (`null` if none, or a grid); for tests. */
  getDataStyle(): 'points' | 'contours' | null {
    return this.activeStyle;
  }

  /** The canvas of the points layer (for tests); `null` unless points are shown. */
  getPointsCanvas(): HTMLCanvasElement | null {
    return this.ml?.points?.getCanvas() ?? null;
  }

  // ---- points / trajectory ----------------------------------------------------------------------------------------

  private showPoints(layer: DataLayer, values: Float32Array, param: ParamInfo, scale: ColourScale, isNew: boolean): void {
    const coords = layer.coords as Float64Array;
    const n = coords.length / 2;
    if (values.length !== n) throw new RangeError(`Expected ${n} values, got ${values.length}`);
    const trajectory = layer.kind === 'trajectory';

    // Colours: the bucket array is refilled in place; the CSS colour table only changes with the scale.
    const idx = this.colourIdx && this.colourIdx.length === n ? this.colourIdx : new Int16Array(n);
    const range = param.max - param.min;
    for (let i = 0; i < n; i++) idx[i] = bucketOf(values[i], param.min, range);
    this.colourIdx = idx;
    const key = `${scale.name}|${n}|${layer.kind}`;
    if (!this.pointsSource || key !== this.pointsKey) {
      this.pointsKey = key;
      this.pointsSource = {
        coords,
        idx,
        colours: this.cssColours(scale),
        radius: trajectory ? 5 : n > 10_000 ? 2.5 : n > 2_000 ? 3.5 : 5,
        stroke: n <= 5_000,
      };
    } else {
      this.pointsSource.idx = idx;
    }

    const ml = this.ml;
    if (ml) {
      if (!ml.points) {
        ml.points = new PointsCanvasLayer(this.pointsSource, POINTS_PANE);
        ml.points.addTo(ml.map);
      } else {
        ml.points.setSource(this.pointsSource);
        if (!ml.map.hasLayer(ml.points)) ml.points.addTo(ml.map);
      }
      if (trajectory && n > 1 && !ml.line) {
        const latlngs: L.LatLngTuple[] = [];
        for (let i = 0; i < n; i++) latlngs.push([coords[2 * i + 1], coords[2 * i]]);
        ml.line = L.layerGroup([
          L.polyline(latlngs, { pane: LINE_PANE, color: '#fff', opacity: 0.9, weight: 4, interactive: false }),
          L.polyline(latlngs, { pane: LINE_PANE, color: '#37474f', weight: 2, interactive: false }),
        ]).addTo(ml.map);
      }
      if (isNew) {
        const ext = coordsExtent(coords);
        if (ext) this.fit(ext);
      }
    }
    this.activeStyle = 'points';
    this.markStyle('points');
    this.markData('drawn');
  }

  private cssColours(scale: ColourScale): string[] {
    const lut = colourTable(scale);
    const out: string[] = [];
    for (let k = 0; k < COLOUR_STEPS; k++) {
      out.push(`rgba(${lut[4 * k]},${lut[4 * k + 1]},${lut[4 * k + 2]},${lut[4 * k + 3] / 255})`);
    }
    return out;
  }

  // ---- contours ---------------------------------------------------------------------------------------------------

  /**
   * Draw `layer` as filled contours of `values`. Returns false (nothing changed) when it cannot be contoured, so the
   * caller falls back to points. The points layer is only taken off the map: its colours are kept for a switch back.
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
    const ml = this.ml;
    if (ml) {
      if (isNew) {
        const ext = coordsExtent(coords);
        if (ext) this.fit(ext);
      }
      const key = `${ckey}|${opts.colourScale.name}|${param.min}|${param.max}`;
      if (key !== this.contourKey || !ml.contours) {
        if (ml.contours) ml.map.removeLayer(ml.contours);
        // Bands ascend and are opaque: a higher band paints over the lower ones, so the order of adding matters.
        const group = L.layerGroup();
        for (const band of set.bands) {
          if (band.coordinates.length === 0) continue;
          const [r, g, b] = bandColour(opts.colourScale, band.lower, band.upper, param.min, param.max);
          L.geoJSON(
            { type: 'MultiPolygon', coordinates: band.coordinates } as GeoJSON.MultiPolygon,
            { pane: IMAGE_PANE, style: () => ({ stroke: false, fillColor: `rgb(${r},${g},${b})`, fillOpacity: 1, interactive: false }) },
          ).addTo(group);
        }
        ml.contours = group.addTo(ml.map);
        this.contourKey = key;
      }
      if (ml.points && ml.map.hasLayer(ml.points)) ml.map.removeLayer(ml.points);
    }
    this.contourValues = values;
    this.activeStyle = 'contours';
    this.markStyle('contours');
    this.markData('drawn');
    return true;
  }

  /** Remove the contour picture. */
  private hideContours(): void {
    const ml = this.ml;
    if (ml?.contours) ml.map.removeLayer(ml.contours);
    if (ml) ml.contours = null;
    this.contourKey = '';
    this.contourValues = null;
  }

  // ---- grid -------------------------------------------------------------------------------------------------------

  private showGrid(layer: DataLayer, values: Float32Array, param: ParamInfo, scale: ColourScale, isNew: boolean): void {
    const grid = layer.coords as GridSpec;
    const nx = grid.x.length;
    const ny = grid.y.length;
    if (values.length !== nx * ny) throw new RangeError(`Expected ${nx * ny} values, got ${values.length}`);
    this.gridValues = values;
    this.activeStyle = null;
    this.markStyle(null);
    const ml = this.ml;
    const seq = ++this.paintSeq;
    if (!ml) {
      this.markData('loading');
      return;
    }
    const extent = gridExtent(grid);
    const width = Math.max(1, Math.min(nx, MAX_CANVAS_DIM));
    const height = Math.max(1, Math.min(ny, MAX_CANVAS_DIM));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is not available');
      const image = ctx.createImageData(width, height);
      paintGridRGBA(values, nx, ny, width, height, param.min, param.max, scale, image.data);
      ctx.putImageData(image, 0, 0);
      // 4326 -> 3857: rows are re-spaced evenly in Mercator y; Leaflet then stretches the image linearly.
      const r = reprojectImage(canvas, extent);
      const overlay = L.imageOverlay(r.canvas.toDataURL('image/png'), r.bounds, { pane: IMAGE_PANE, interactive: false });
      r.canvas.width = 0;
      r.canvas.height = 0;
      overlay.once('load', () => {
        if (seq === this.paintSeq) this.markData('loaded');
      });
      overlay.once('error', () => {
        if (seq === this.paintSeq) this.markData('error');
      });
      if (ml.grid) ml.map.removeLayer(ml.grid);
      ml.grid = overlay.addTo(ml.map);
      const img = overlay.getElement();
      if (img) img.style.imageRendering = 'pixelated'; // cells stay sharp (OL: interpolate false)
      this.markData('loading');
      if (isNew) this.fit(extent);
    } catch {
      this.markData('error');
    } finally {
      canvas.width = 0; // releases the pixel buffer
      canvas.height = 0;
    }
  }

  // ---- opacity ----------------------------------------------------------------------------------------------------

  /** Opacity of the drawn data (`undefined` = each kind's default); mirrored as `data-opacity` for tests/automation. */
  private applyOpacity(layer: DataLayer, opacity: number | undefined): void {
    const o = opacity === undefined || Number.isNaN(opacity) ? undefined : Math.min(1, Math.max(0, opacity));
    const grid = layer.kind === 'grid';
    const image = o ?? (grid ? DEFAULT_GRID_OPACITY : DEFAULT_CONTOUR_OPACITY);
    const points = o ?? DEFAULT_POINTS_OPACITY;
    const ml = this.ml;
    if (ml) {
      ml.panes.image.style.opacity = String(image);
      ml.panes.points.style.opacity = String(points);
      ml.panes.line.style.opacity = String(points);
    }
    this.markOpacity(String(grid || this.activeStyle === 'contours' ? image : points));
  }

  // ---- click ------------------------------------------------------------------------------------------------------

  /** Map click: pick the nearest drawn point within tolerance, else the grid cell / nearest point under the cursor. */
  private handleClick(e: L.LeafletMouseEvent): void {
    const ml = this.ml;
    if (!ml || !this.data || this.selectHandlers.size === 0) return;
    // A draw in progress owns the clicks (geoman's draw mode; the bbox draw turns map dragging off).
    if (ml.map.pm?.globalDrawModeEnabled() || !ml.map.dragging.enabled()) return;
    const hit =
      this.data.kind === 'grid' ? this.hitGrid(e.latlng) : this.activeStyle === 'contours' ? this.hitContour(e.latlng) : this.hitPoint(e.containerPoint);
    if (!hit) return;
    for (const cb of [...this.selectHandlers]) cb(hit.index, hit.lonlat);
  }

  /** Contour style: the nearest real point (Delaunay `find`), if it is near the data and has a value. */
  private hitContour(latlng: L.LatLng): Hit | null {
    const coords = this.data?.coords;
    if (!coords || isGridSpec(coords)) return null;
    const { lat, lng } = latlng.wrap();
    const i = getTriangulation(coords).nearest(lng, lat);
    if (i < 0 || Number.isNaN(this.contourValues?.[i] ?? NaN)) return null;
    return { index: i, lonlat: [coords[2 * i], coords[2 * i + 1]] };
  }

  private hitPoint(at: L.Point): Hit | null {
    const map = this.ml?.map;
    const coords = this.data?.coords;
    const idx = this.colourIdx;
    if (!map || !coords || isGridSpec(coords) || !idx) return null;
    let best = -1;
    let bestD = HIT_TOLERANCE_PX * HIT_TOLERANCE_PX;
    const n = Math.min(idx.length, coords.length / 2);
    for (let i = 0; i < n; i++) {
      if (idx[i] < 0) continue;
      const p = map.latLngToContainerPoint([coords[2 * i + 1], coords[2 * i]]);
      const d = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : { index: best, lonlat: [coords[2 * best], coords[2 * best + 1]] };
  }

  private hitGrid(latlng: L.LatLng): Hit | null {
    const grid = this.data?.coords;
    if (!this.data || !grid || !isGridSpec(grid)) return null;
    const { lat, lng } = latlng.wrap();
    const [w, s, e, n] = gridExtent(grid);
    if (lng < w || lng > e || lat < s || lat > n) return null;
    const i = nearestIndex(grid.x, lng);
    const j = nearestIndex(grid.y, lat);
    const index = j * grid.x.length + i;
    const v = this.gridValues?.[index];
    if (v === undefined || Number.isNaN(v)) return null;
    return { index, lonlat: [grid.x[i], grid.y[j]] };
  }

  // ---- map element attributes -------------------------------------------------------------------------------------

  private markAll(): void {
    this.markData(this.dataState);
    this.markStyle(this.styleState);
    this.markOpacity(this.opacityState);
  }

  /** `data-style`: `points` | `contours`. */
  private markStyle(style: 'points' | 'contours' | null): void {
    this.styleState = style;
    this.setAttr('data-style', style);
  }

  /** `data-data`: `loading` | `loaded` | `drawn` | `error`. */
  private markData(state: string | null): void {
    this.dataState = state;
    this.setAttr('data-data', state);
  }

  private markOpacity(state: string | null): void {
    this.opacityState = state;
    this.setAttr('data-opacity', state);
  }

  private setAttr(name: string, value: string | null): void {
    const el = this.ml?.el;
    if (!el) return;
    if (value) el.setAttribute(name, value);
    else el.removeAttribute(name);
  }

  private fit(bbox: BBox): void {
    const map = this.ml?.map;
    if (!map) return;
    const [w, s, e, n] = bbox;
    const lat = (v: number) => Math.max(-85, Math.min(85, v));
    map.fitBounds(
      [
        [lat(s), w],
        [lat(n), e],
      ],
      { padding: [20, 20], maxZoom: 10 },
    );
  }
}
