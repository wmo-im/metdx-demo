import * as L from 'leaflet';
import '@geoman-io/leaflet-geoman-free'; // needs the global `L` that Leaflet's UMD build sets; keep it after the Leaflet import
import type { BBox, DrawKind, Geometry, Position } from '../../lib/types';
import type { DataLayer, DataSelectHandler, ShowDataOptions } from '../../lib/covjsonTypes';
import {
  DrawCancelledError,
  EXTENT_FIT_MAX_ZOOM,
  MIN_ZOOM,
  WORLD_BBOX,
  type ExtentOptions,
  type MapApi,
  type MapCapabilities,
  type MapEngine,
} from '../mapApi';
import { renderCoverage, type CoverageHandle } from './coverageHook';
import { LeafletDataLayers } from './data';
import { mercatorBounds, reprojectImage } from './reproject';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

/**
 * The Leaflet {@link MapEngine}; it is its own {@link MapApi}. Must not import OpenLayers (or the OL controller):
 * the Leaflet build chunk is loaded on its own. Basemap settings mirror `mapController.ts`
 * (`VITE_BASEMAP_URL` / `VITE_BASEMAP_ATTRIBUTION`, OSM by default).
 */

const BASEMAP_URL: string = import.meta.env.VITE_BASEMAP_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION: string =
  import.meta.env.VITE_BASEMAP_ATTRIBUTION || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ORANGE = '#f57c00';
const BLUE = '#1565c0';

/** Panes: EPSG:4326 overlay image below, query / drawn geometry above (data panes come with the data layers). */
const IMAGE_PANE = 'metdxImage';
const VECTOR_PANE = 'metdxVector';

const GEOMETRY_PATH: L.PathOptions = {
  pane: VECTOR_PANE,
  color: BLUE,
  weight: 3,
  fillColor: BLUE,
  fillOpacity: 0.18,
  interactive: false,
};
const EXTENT_PATH: L.PathOptions = {
  pane: VECTOR_PANE,
  color: ORANGE,
  weight: 2,
  fillColor: ORANGE,
  fillOpacity: 0.12,
  interactive: false,
};
const POINT_MARKER: L.CircleMarkerOptions = {
  pane: VECTOR_PANE,
  radius: 7,
  color: '#fff',
  weight: 2,
  fillColor: BLUE,
  fillOpacity: 1,
  interactive: false,
};

/** `bbox` (west, south, east, north; latitudes clamped to Web Mercator's range) as Leaflet bounds. */
function latLngBounds(bbox: BBox): L.LatLngBounds {
  const [w, s, e, n] = bbox;
  const lat = (v: number) => Math.max(-85, Math.min(85, v));
  return L.latLngBounds([lat(s), w], [lat(n), e]);
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;
const clampLon = (lon: number): number => Math.min(180, Math.max(-180, lon));

/**
 * Leaflet repeats the world horizontally, so a click after panning has a longitude like 500 or -400. Shift all `lons` by
 * the same multiple of 360 so that the centre of their span lies in [-180, 180) (a shape keeps its width), then clamp
 * to [-180, 180]: a shape that straddles the antimeridian is cut off at it (a query bbox / polygon cannot wrap).
 */
export function normaliseLons(lons: number[]): number[] {
  if (!lons.length) return lons;
  const centre = (Math.min(...lons) + Math.max(...lons)) / 2;
  const shift = 360 * Math.floor((centre + 180) / 360);
  return lons.map((lon) => clampLon(lon - shift));
}

/** `positions` with the longitudes normalised together (see {@link normaliseLons}); latitudes are kept. */
function normalisePositions<P extends number[]>(positions: P[]): P[] {
  const lons = normaliseLons(positions.map((p) => p[0]));
  return positions.map((p, i) => [lons[i], ...p.slice(1)] as P);
}

/** Layer showing `g` (lon/lat) in the geometry style. */
function geometryLayer(g: Geometry): L.GeoJSON {
  const feature: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: g,
  };
  return L.geoJSON(feature, {
    pane: VECTOR_PANE,
    style: () => GEOMETRY_PATH,
    pointToLayer: (_f, ll) => L.circleMarker(ll, POINT_MARKER),
  });
}

/** A geoman-drawn layer as a rounded lon/lat geometry. */
function fromDrawn(layer: L.Layer): Geometry {
  const r = (c: number[]): Position => [round(c[0]), round(c[1])];
  if (layer instanceof L.Marker) {
    const ll = layer.getLatLng();
    return { type: 'Point', coordinates: r(normalisePositions([[ll.lng, ll.lat]])[0]) };
  }
  const g: GeoJSON.Geometry = (layer as L.Polyline | L.Polygon).toGeoJSON().geometry;
  if (g.type === 'LineString') return { type: 'LineString', coordinates: normalisePositions(g.coordinates).map(r) };
  if (g.type === 'Polygon') {
    // one shift for all rings, so the polygon stays in one piece
    const flat = normalisePositions(g.coordinates.flat());
    let i = 0;
    return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(() => r(flat[i++]))) };
  }
  throw new Error(`Unexpected drawn geometry ${g.type}`);
}

const GEOMAN_SHAPE = {
  point: 'Marker',
  line: 'Line',
  polygon: 'Polygon',
} as const;

export class LeafletController implements MapApi, MapEngine {
  readonly capabilities: MapCapabilities = { coverageRenderer: true };
  private coverage: CoverageHandle | null = null;
  /** Aborts the leaflet-coverage render in flight (a finished one is in `coverage`). */
  private coverageAbort: AbortController | null = null;
  private map: L.Map | null = null;
  private el: HTMLElement | null = null;
  private readonly extentGroup = L.layerGroup();
  private readonly geometryGroup = L.layerGroup();
  private readonly drawnGroup = L.layerGroup();
  private readonly overlayGroup = L.layerGroup();
  private readonly dataLayers = new LeafletDataLayers();
  private cancelDraw: (() => void) | null = null;
  /** An extent to fit that was requested before the map existed: applied on attach. */
  private pendingFit: { bbox: BBox; padLevels: number } | null = null;

  /** The overlay being loaded / shown; `overlaySeq` invalidates stale image loads. */
  private overlayImage: HTMLImageElement | null = null;
  private overlaySeq = 0;
  /** `data-overlay` state, re-applied when the map is (re)attached. */
  private overlayState: string | null = null;

  get api(): MapApi {
    return this;
  }

  /** The Leaflet map (for tests / advanced use). */
  getMap(): L.Map | null {
    return this.map;
  }

  /** Create the Leaflet map in `el`. Layer groups live as long as the controller, so state set before attaching is kept. */
  attach(el: HTMLElement): void {
    if (this.map) this.detach();
    const map = L.map(el, { center: [0, 0], zoom: 0, minZoom: MIN_ZOOM });
    map.attributionControl.setPrefix(false); // no "🇺🇦 Leaflet" prefix; the basemap attribution stays
    L.tileLayer(BASEMAP_URL, { attribution: ATTRIBUTION, minZoom: MIN_ZOOM, minNativeZoom: 0, maxZoom: 19 }).addTo(map);
    map.createPane(IMAGE_PANE).style.zIndex = '390'; // below the default overlay pane (400)
    map.createPane(VECTOR_PANE).style.zIndex = '450';
    for (const g of [this.overlayGroup, this.extentGroup, this.geometryGroup, this.drawnGroup]) g.addTo(map);
    this.map = map;
    this.el = el;
    this.dataLayers.attach(map, el);
    this.markOverlay(this.overlayState);
    this.fitWorld();
    if (this.pendingFit) this.fitExtent(this.pendingFit.bbox, this.pendingFit.padLevels);
    map.on('moveend zoomend', () => this.markView());
  }

  detach(): void {
    this.cancel();
    if (!this.map) return;
    this.clearCoverage();
    this.dataLayers.detach();
    this.el?.removeAttribute('data-view');
    this.map.remove();
    this.map = null;
    this.el = null;
  }

  drawGeometry(kind: DrawKind): Promise<Geometry> {
    const map = this.map;
    if (!map) return Promise.reject(new Error('Map is not ready'));
    this.cancel();
    this.drawnGroup.clearLayers();
    return new Promise<Geometry>((resolve, reject) => {
      const teardown: (() => void)[] = [];
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const t of teardown) t();
        if (this.cancelDraw === cancel) this.cancelDraw = null;
      };
      const complete = (g: Geometry) => {
        finish();
        this.drawnGroup.clearLayers();
        geometryLayer(g).addTo(this.drawnGroup);
        resolve(g);
      };
      const cancel = () => {
        finish();
        this.drawnGroup.clearLayers();
        reject(new DrawCancelledError());
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.cancel();
      };
      document.addEventListener('keydown', onKey);
      teardown.push(() => document.removeEventListener('keydown', onKey));
      this.cancelDraw = cancel;

      if (kind === 'bbox') this.startBoxDraw(map, teardown, complete);
      else this.startGeomanDraw(map, kind, teardown, complete);
    });
  }

  /** Point / line / polygon through geoman's draw mode. */
  private startGeomanDraw(map: L.Map, kind: Exclude<DrawKind, 'bbox'>, teardown: (() => void)[], complete: (g: Geometry) => void): void {
    const onCreate = (e: { layer: L.Layer }) => {
      const g = fromDrawn(e.layer);
      map.removeLayer(e.layer); // re-drawn below in our own style
      complete(g);
    };
    map.on('pm:create', onCreate as L.LeafletEventHandlerFn);
    teardown.push(() => {
      map.off('pm:create', onCreate as L.LeafletEventHandlerFn);
      map.pm.disableDraw();
    });
    map.pm.enableDraw(GEOMAN_SHAPE[kind], {
      snappable: false,
      continueDrawing: false,
      // Like the OpenLayers draw: a double-click finishes. Geoman finishes a line by a click on its last vertex, but a
      // polygon only by a click on the first vertex (its "same as the last vertex" test does not handle the nested ring).
      ...(kind === 'polygon' ? { finishOn: 'dblclick' as const } : {}),
      pathOptions: GEOMETRY_PATH,
      templineStyle: { color: BLUE, weight: 3 },
      hintlineStyle: { color: BLUE, weight: 3, dashArray: '5,5' },
      // The marker is replaced by a circle marker straight away; a div icon avoids loading Leaflet's default icon image.
      markerStyle: { icon: L.divIcon({ className: 'metdx-draw-marker' }) },
    });
  }

  /** Bbox: press, drag, release (geoman's rectangle needs two separate clicks). A press-release without a drag is ignored. */
  private startBoxDraw(map: L.Map, teardown: (() => void)[], complete: (g: Geometry) => void): void {
    const container = map.getContainer();
    const previousCursor = container.style.cursor;
    container.style.cursor = 'crosshair';
    const draggingWasOn = map.dragging.enabled();
    map.dragging.disable();
    let start: L.LatLng | null = null;
    let end: L.LatLng | null = null;
    let rect: L.Rectangle | null = null;

    const onDown = (e: L.LeafletMouseEvent) => {
      start = e.latlng;
      end = e.latlng;
      rect?.remove();
      rect = L.rectangle(L.latLngBounds(start, start), {
        ...GEOMETRY_PATH,
      }).addTo(this.drawnGroup);
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      if (!start || !rect) return;
      end = e.latlng;
      rect.setBounds(L.latLngBounds(start, end));
    };
    const onUp = () => {
      if (!start || !end) return;
      const a = start;
      const b = end;
      start = end = null;
      if (a.lat === b.lat || a.lng === b.lng) {
        rect?.remove();
        rect = null;
        return;
      }
      const [nsx, nex] = normaliseLons([a.lng, b.lng]);
      const [sx, sy, ex, ey] = [round(nsx), round(a.lat), round(nex), round(b.lat)];
      complete({
        type: 'Polygon',
        coordinates: [
          [
            [sx, sy],
            [sx, ey],
            [ex, ey],
            [ex, sy],
            [sx, sy],
          ],
        ],
      });
    };
    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    teardown.push(() => {
      map.off('mousedown', onDown);
      map.off('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      container.style.cursor = previousCursor;
      if (draggingWasOn) map.dragging.enable();
    });
  }

  /** Cancel a draw in progress (rejects its promise). */
  cancel(): void {
    this.cancelDraw?.();
  }

  setOverlay(img: string | null, bbox?: BBox | null, opts: { fit?: boolean; opacity?: number } = {}): void {
    this.clearOverlay();
    if (!img || !bbox) {
      this.markOverlay(null);
      return;
    }
    const seq = this.overlaySeq;
    this.markOverlay('loading');
    let bounds: L.LatLngBoundsExpression;
    try {
      const b = mercatorBounds(bbox);
      bounds = [
        [b.south, b.west],
        [b.north, b.east],
      ];
    } catch {
      this.markOverlay('error');
      return;
    }
    if (opts.fit !== false) this.map?.fitBounds(bounds, { padding: [20, 20], maxZoom: 10 });

    const fail = () => {
      if (seq === this.overlaySeq) this.markOverlay('error');
    };
    // The image is loaded (with CORS, so its pixels can be read), reprojected to Web Mercator on a canvas and then
    // shown as an ordinary image overlay. A failed load or a tainted canvas ends in data-overlay=error.
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (seq !== this.overlaySeq) return;
      try {
        const r = reprojectImage(image, bbox);
        const layer = L.imageOverlay(r.canvas.toDataURL('image/png'), r.bounds, {
          pane: IMAGE_PANE,
          opacity: opts.opacity ?? 0.8,
          interactive: false,
        });
        layer.once('load', () => {
          if (seq === this.overlaySeq) this.markOverlay('loaded');
        });
        layer.once('error', fail);
        this.overlayGroup.addLayer(layer);
      } catch {
        fail();
      }
    };
    image.onerror = fail;
    this.overlayImage = image;
    image.src = img;
  }

  /** Remove the overlay layer and abandon a load in flight. */
  private clearOverlay(): void {
    this.overlaySeq++;
    if (this.overlayImage) {
      this.overlayImage.onload = null;
      this.overlayImage.onerror = null;
      this.overlayImage = null;
    }
    this.overlayGroup.clearLayers();
  }

  showGeometry(geometry: Geometry | null): void {
    this.geometryGroup.clearLayers();
    if (geometry) geometryLayer(geometry).addTo(this.geometryGroup);
  }

  showExtent(bbox: BBox | null, opts: ExtentOptions = {}): void {
    this.extentGroup.clearLayers();
    this.pendingFit = null;
    if (!bbox) return;
    const [w, s, e, n] = bbox;
    L.rectangle(
      [
        [s, w],
        [n, e],
      ],
      EXTENT_PATH,
    ).addTo(this.extentGroup);
    if (!opts.fit) return;
    const padLevels = Math.max(0, opts.padLevels ?? 1);
    if (this.map) this.fitExtent(bbox, padLevels);
    else this.pendingFit = { bbox, padLevels };
  }

  showData(layer: DataLayer, opts: ShowDataOptions): void {
    this.clearCoverage();
    this.dataLayers.showData(layer, opts);
  }

  clearData(): void {
    this.clearCoverage();
    this.dataLayers.clearData();
  }

  async showCoverage(layer: DataLayer, param: string, timeIndex: number): Promise<void> {
    const map = this.map;
    if (!map) throw new Error('Map is not ready');
    this.dataLayers.clearData();
    this.clearCoverage();
    const abort = new AbortController();
    this.coverageAbort = abort;
    let handle: CoverageHandle;
    try {
      handle = await renderCoverage(map, layer, param, timeIndex, abort.signal);
    } catch (e) {
      if (abort.signal.aborted) return; // superseded, cleared or detached while rendering: nothing to report
      if (this.coverageAbort === abort) this.coverageAbort = null;
      throw e;
    }
    if (abort.signal.aborted || this.map !== map) {
      handle.remove(); // cancelled between the render's last check and here
      return;
    }
    this.coverageAbort = null;
    this.coverage = handle;
  }

  /** Cancel a render in flight and remove the coverage layer. */
  clearCoverage(): void {
    this.coverageAbort?.abort();
    this.coverageAbort = null;
    this.coverage?.remove();
    this.coverage = null;
  }

  onDataSelect(cb: DataSelectHandler): () => void {
    return this.dataLayers.onDataSelect(cb);
  }

  clear(): void {
    this.cancel();
    this.drawnGroup.clearLayers();
    this.geometryGroup.clearLayers();
    this.extentGroup.clearLayers();
    this.pendingFit = null;
    this.clearOverlay();
    this.markOverlay(null);
  }

  /** Run `fn` with fractional zoom allowed (`zoomSnap` 0): Leaflet otherwise rounds a fitted zoom down to a whole level. */
  private unsnapped<T>(map: L.Map, fn: () => T): T {
    const snap = map.options.zoomSnap;
    map.options.zoomSnap = 0;
    try {
      return fn();
    } finally {
      map.options.zoomSnap = snap;
    }
  }

  /**
   * The (fractional) zoom at which `bounds` just fits the map. `map.getBoundsZoom` is not used: it rounds to `zoomSnap`
   * levels (always whole ones without 3D transforms), which would leave a short map showing several worlds.
   */
  private boundsZoom(map: L.Map, bounds: L.LatLngBounds): number {
    const size = map.getSize();
    const nw = map.project(bounds.getNorthWest(), 0);
    const se = map.project(bounds.getSouthEast(), 0);
    const scale = Math.min(size.x / Math.abs(se.x - nw.x), size.y / Math.abs(se.y - nw.y));
    // 0.01 of a level (<1 %) less: Leaflet rounds the map's pixel origin, which would otherwise cut an exact fit by a pixel
    return Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), Math.log2(scale) - 0.01));
  }

  /** Initial view: the whole world ({@link WORLD_BBOX}) fitted to the map size (fractional zoom: a short map zooms out below 0). */
  private fitWorld(): void {
    const map = this.map;
    if (!map) return;
    const world = latLngBounds(WORLD_BBOX);
    this.unsnapped(map, () => map.setView(world.getCenter(), this.boundsZoom(map, world), { animate: false }));
    this.markView();
  }

  /**
   * Zoom so `bbox` fills the map (at most zoom {@link EXTENT_FIT_MAX_ZOOM}), then out by `padLevels`, but never
   * further out than the whole world. No animation: the view is final when this returns.
   */
  private fitExtent(bbox: BBox, padLevels: number): void {
    const map = this.map;
    if (!map) return;
    this.unsnapped(map, () => {
      const worldZoom = this.boundsZoom(map, latLngBounds(WORLD_BBOX));
      const fitZoom = Math.min(this.boundsZoom(map, latLngBounds(bbox)), EXTENT_FIT_MAX_ZOOM);
      const zoom = Math.max(fitZoom - padLevels, Math.min(worldZoom, fitZoom));
      map.setView(latLngBounds(bbox).getCenter(), zoom, { animate: false });
    });
    this.markView();
  }

  /** Mirrors the visible lon/lat extent as `data-view="west,south,east,north"` on the map element (tests / automation). */
  private markView(): void {
    const map = this.map;
    const el = this.el;
    if (!map || !el) return;
    const b = map.getBounds();
    // rounded outwards (to 0.001°): float noise must not make an exactly fitted extent look just outside the view
    const lo = (v: number) => Math.floor(v * 1e3) / 1e3;
    const hi = (v: number) => Math.ceil(v * 1e3) / 1e3;
    el.setAttribute('data-view', [lo(b.getWest()), lo(Math.max(-90, b.getSouth())), hi(b.getEast()), hi(Math.min(90, b.getNorth()))].join(','));
  }

  /** Mirrors the overlay state (`data-overlay`: loading | loaded | error) on the map element for tests/automation. */
  private markOverlay(state: string | null): void {
    this.overlayState = state;
    const el = this.el;
    if (!el) return;
    if (state) el.setAttribute('data-overlay', state);
    else el.removeAttribute('data-overlay');
  }
}
