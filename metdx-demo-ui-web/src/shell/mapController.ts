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
import type SimpleGeometry from 'ol/geom/SimpleGeometry';
import { fromLonLat, toLonLat } from 'ol/proj';
import type { BBox, DrawKind, Geometry, Position } from '../lib/types';

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

export class MapController implements MapApi {
  private map: Map | null = null;
  private readonly overlayLayer = new ImageLayer({ zIndex: 5, opacity: 0.8 });
  private readonly extentSource = new VectorSource();
  private readonly geometrySource = new VectorSource();
  private readonly drawnSource = new VectorSource();
  private draw: Draw | null = null;
  private cancelDraw: (() => void) | null = null;

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
  }

  detach(): void {
    this.cancel();
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
