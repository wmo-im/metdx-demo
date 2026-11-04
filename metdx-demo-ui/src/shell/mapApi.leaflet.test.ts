import { vi } from 'vitest';

// jsdom has no SVGSVGElement.createSVGRect, so Leaflet would pick its canvas renderer (which needs a real 2D context).
// Define it before Leaflet is evaluated so the SVG renderer is used.
vi.hoisted(() => {
  const proto = SVGSVGElement.prototype as unknown as { createSVGRect?: () => object };
  proto.createSVGRect ??= () => ({});
  // Leaflet only allows fractional zoom levels (`zoomSnap`) where it detects 3D transforms (a real browser, not jsdom); the
  // fit-the-world tests on a short map need one, so let it detect them.
  (window as unknown as { WebKitCSSMatrix?: unknown }).WebKitCSSMatrix ??= class {
    m11 = 1;
  };
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeafletController } from './leaflet/controller';
import { DrawCancelledError } from './mapApi';
import { runMapConformance } from './mapApi.conformance';

runMapConformance('Leaflet', () => new LeafletController(), { data: true });

describe('LeafletController specifics', () => {
  let c: LeafletController;
  let el: HTMLDivElement;

  beforeEach(() => {
    c = new LeafletController();
    el = document.createElement('div');
    el.style.width = '400px';
    el.style.height = '300px';
    document.body.appendChild(el);
    c.attach(el);
  });
  afterEach(() => {
    c.detach();
    el.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers the leaflet-coverage renderer and mounts an OSM basemap with attribution', () => {
    expect(c.capabilities.coverageRenderer).toBe(true);
    expect(el.querySelector('.leaflet-tile-pane')).not.toBeNull();
    expect(el.querySelector('.leaflet-control-attribution')?.textContent).toMatch(/OpenStreetMap/);
  });

  it('draws geometries and extents as vector layers', () => {
    c.showGeometry({ type: 'Point', coordinates: [10, 50] });
    c.showGeometry({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] });
    c.showExtent([-10, -5, 10, 5]);
    expect(el.querySelectorAll('.leaflet-metdxVector-pane path').length).toBeGreaterThanOrEqual(2);
    c.showGeometry(null);
    c.showExtent(null);
    expect(el.querySelectorAll('.leaflet-metdxVector-pane path').length).toBe(0);
  });

  it.each(['point', 'line', 'polygon'] as const)('%s: geoman draw mode is entered and Escape cancels it', async (kind) => {
    const map = c.getMap()!;
    const p = c.drawGeometry(kind);
    expect(map.pm.globalDrawModeEnabled()).toBe(true);
    const rejected = expect(p).rejects.toBeInstanceOf(DrawCancelledError);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await rejected;
    expect(map.pm.globalDrawModeEnabled()).toBe(false);
  });

  it('point: resolves a rounded lon/lat Point when the map is clicked', async () => {
    const map = c.getMap()!;
    const p = c.drawGeometry('point');
    map.fire('pm:create', { shape: 'Marker', layer: new (await import('leaflet')).Marker([50.123456789, 10.987654321]) });
    await expect(p).resolves.toEqual({ type: 'Point', coordinates: [10.98765, 50.12346] });
  });

  it('line and polygon: resolve lon/lat geometries from the drawn layer', async () => {
    const L = await import('leaflet');
    const map = c.getMap()!;
    const line = c.drawGeometry('line');
    map.fire('pm:create', { shape: 'Line', layer: L.polyline([[1, 2], [3, 4]]) });
    await expect(line).resolves.toEqual({ type: 'LineString', coordinates: [[2, 1], [4, 3]] });
    const poly = c.drawGeometry('polygon');
    map.fire('pm:create', { shape: 'Polygon', layer: L.polygon([[0, 0], [0, 10], [10, 10]]) });
    await expect(poly).resolves.toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]],
    });
  });

  it('bbox: press-drag-release resolves a rectangle polygon; a click without a drag is ignored', async () => {
    const map = c.getMap()!;
    const { latLng } = await import('leaflet');
    const at = (type: string, lat: number, lng: number) =>
      map.fire(type, { latlng: latLng(lat, lng), originalEvent: new MouseEvent(type) });
    const p = c.drawGeometry('bbox');
    expect(map.dragging.enabled()).toBe(false);
    at('mousedown', 5, 5);
    document.dispatchEvent(new MouseEvent('mouseup')); // no movement: ignored
    at('mousedown', 10, 20);
    at('mousemove', 30, 40);
    document.dispatchEvent(new MouseEvent('mouseup'));
    await expect(p).resolves.toEqual({
      type: 'Polygon',
      coordinates: [[[20, 10], [20, 30], [40, 30], [40, 10], [20, 10]]],
    });
    expect(map.dragging.enabled()).toBe(true);
  });

  describe('longitudes in wrapped world copies', () => {
    const drawBbox = async (a: [number, number], b: [number, number]) => {
      const map = c.getMap()!;
      const { latLng } = await import('leaflet');
      const at = (type: string, [lat, lng]: [number, number]) => map.fire(type, { latlng: latLng(lat, lng), originalEvent: new MouseEvent(type) });
      const p = c.drawGeometry('bbox');
      at('mousedown', a);
      at('mousemove', b);
      document.dispatchEvent(new MouseEvent('mouseup'));
      return p;
    };
    const ringOf = (g: { coordinates: unknown }) => (g.coordinates as number[][][])[0];

    it('point: a click 3 world copies to the east / west is wrapped into [-180, 180]', async () => {
      const L = await import('leaflet');
      const map = c.getMap()!;
      for (const [lng, expected] of [
        [10 + 3 * 360, 10],
        [-170 - 2 * 360, -170],
        [-540, -180],
      ] as const) {
        const p = c.drawGeometry('point');
        map.fire('pm:create', { shape: 'Marker', layer: new L.Marker([50, lng]) });
        await expect(p).resolves.toEqual({ type: 'Point', coordinates: [expected, 50] });
      }
    });

    it('bbox: drawn after panning three worlds east, it keeps its width and lies in [-180, 180]', async () => {
      const g = await drawBbox([10, 3 * 360 + 20], [30, 3 * 360 + 40]);
      expect(ringOf(g)).toEqual([[20, 10], [20, 30], [40, 30], [40, 10], [20, 10]]);
    });

    it('bbox: the whole box moves by multiples of 360 so its centre is in range; one straddling the antimeridian is cut off there', async () => {
      const g = await drawBbox([0, -2 * 360 + 100], [10, -2 * 360 + 130]);
      expect(ringOf(g)).toEqual([[100, 0], [100, 10], [130, 10], [130, 0], [100, 0]]);
      const straddling = await drawBbox([0, 3 * 360 + 170], [10, 3 * 360 + 190]);
      const lons = ringOf(straddling).map((p) => p[0]);
      expect(Math.min(...lons)).toBeGreaterThanOrEqual(-180);
      expect(Math.max(...lons)).toBeLessThanOrEqual(180);
      expect(new Set(lons).size).toBe(2); // still a box, not collapsed onto one meridian
    });

    it('line and polygon: all vertices move together', async () => {
      const L = await import('leaflet');
      const map = c.getMap()!;
      const line = c.drawGeometry('line');
      map.fire('pm:create', { shape: 'Line', layer: L.polyline([[1, 360 + 2], [3, 360 + 4]]) });
      await expect(line).resolves.toEqual({ type: 'LineString', coordinates: [[2, 1], [4, 3]] });
      const poly = c.drawGeometry('polygon');
      map.fire('pm:create', { shape: 'Polygon', layer: L.polygon([[0, -720], [0, -710], [10, -710]]) });
      await expect(poly).resolves.toEqual({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] });
    });
  });

  it('bbox draw is cancelled by Escape and restores dragging', async () => {
    const map = c.getMap()!;
    const p = c.drawGeometry('bbox');
    const rejected = expect(p).rejects.toBeInstanceOf(DrawCancelledError);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await rejected;
    expect(map.dragging.enabled()).toBe(true);
  });

  // ---- overlay ----------------------------------------------------------------------------------

  /** Replace `Image` with a stand-in that settles after `src` is set. */
  function stubImage(outcome: 'load' | 'error'): void {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      naturalWidth = 4;
      naturalHeight = 4;
      width = 4;
      height = 4;
      set src(_v: string) {
        queueMicrotask(() => (outcome === 'load' ? this.onload : this.onerror)?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
  }
  function stubCanvas(opts: { tainted?: boolean } = {}): void {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          if (opts.tainted) throw new DOMException('The canvas has been tainted', 'SecurityError');
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,AAAA');
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('setOverlay: loads, reprojects onto an image overlay in the image pane, with opacity; null removes it', async () => {
    stubImage('load');
    stubCanvas();
    c.setOverlay('blob:x', [-180, -90, 180, 90], { fit: false, opacity: 0.5 });
    expect(el.getAttribute('data-overlay')).toBe('loading');
    await tick();
    const img = el.querySelector<HTMLImageElement>('.leaflet-metdxImage-pane img');
    expect(img).not.toBeNull();
    expect(img!.src).toContain('data:image/png');
    expect(img!.style.opacity).toBe('0.5');
    img!.dispatchEvent(new Event('load'));
    expect(el.getAttribute('data-overlay')).toBe('loaded');
    c.setOverlay(null);
    expect(el.hasAttribute('data-overlay')).toBe(false);
    expect(el.querySelector('.leaflet-metdxImage-pane img')).toBeNull();
  });

  it('setOverlay: a failed image load gives data-overlay=error', async () => {
    stubImage('error');
    c.setOverlay('blob:missing', [0, 0, 10, 10], { fit: false });
    await tick();
    expect(el.getAttribute('data-overlay')).toBe('error');
    expect(el.querySelector('.leaflet-metdxImage-pane img')).toBeNull();
  });

  it('setOverlay: a CORS-tainted image gives data-overlay=error', async () => {
    stubImage('load');
    stubCanvas({ tainted: true });
    c.setOverlay('https://example.invalid/m.png', [0, 0, 10, 10], { fit: false });
    await tick();
    expect(el.getAttribute('data-overlay')).toBe('error');
    expect(el.querySelector('.leaflet-metdxImage-pane img')).toBeNull();
  });

  it('setOverlay: an empty bbox (outside Web Mercator) gives data-overlay=error', () => {
    c.setOverlay('blob:x', [0, 88, 10, 90]);
    expect(el.getAttribute('data-overlay')).toBe('error');
  });

  it('setOverlay: a newer overlay supersedes a load in flight', async () => {
    stubImage('load');
    stubCanvas();
    c.setOverlay('blob:one', [0, 0, 10, 10], { fit: false });
    c.setOverlay('blob:two', [0, 0, 10, 10], { fit: false });
    await tick();
    expect(el.querySelectorAll('.leaflet-metdxImage-pane img')).toHaveLength(1);
  });

  it('keeps the overlay state when re-attached to a new element', async () => {
    stubImage('error');
    c.setOverlay('blob:missing', [0, 0, 10, 10], { fit: false });
    await tick();
    c.detach();
    const el2 = document.createElement('div');
    document.body.appendChild(el2);
    c.attach(el2);
    expect(el2.getAttribute('data-overlay')).toBe('error');
    c.detach();
    el2.remove();
  });
});
