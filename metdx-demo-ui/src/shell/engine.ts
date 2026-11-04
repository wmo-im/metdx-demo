import { getMapEngine, parseMapEngine } from '../lib/config';
import type { BBox, DrawKind, Geometry } from '../lib/types';
import type { DataLayer, DataSelectHandler, ShowDataOptions } from '../lib/covjsonTypes';
import { DrawCancelledError, type MapApi, type MapCapabilities, type MapEngine, type MapEngineName } from './mapApi';

/**
 * Engine selection and loading. Each engine is a dynamic import, so a build only downloads the engine in use.
 * This is the only module (besides the engines themselves) that knows engine entry points; it must not import
 * a map library statically.
 */

export const ENGINE_STORAGE_KEY = 'metdx.mapEngine';

export const ENGINE_LABELS: Record<MapEngineName, string> = {
  ol: 'OpenLayers',
  leaflet: 'Leaflet',
};

/** Load (and instantiate) the engine `name`. Rejects if it cannot be loaded. */
export async function loadEngine(name: MapEngineName): Promise<MapEngine> {
  switch (name) {
    case 'ol': {
      const { MapController } = await import('./mapController');
      return new MapController();
    }
    case 'leaflet': {
      const { LeafletController } = await import('./leaflet/controller');
      return new LeafletController();
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Engine at startup: `?map=` of the page URL, else the app-bar choice kept in sessionStorage, else the config. */
export function resolveEngineName(search?: string): MapEngineName {
  try {
    const q = search ?? (typeof window === 'undefined' ? '' : window.location.search);
    const fromUrl = parseMapEngine(new URLSearchParams(q).get('map'));
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  return parseMapEngine(safeStorage()?.getItem(ENGINE_STORAGE_KEY)) ?? getMapEngine();
}

export type EngineStatus = 'loading' | 'ready' | 'error';

export interface EngineSnapshot {
  readonly name: MapEngineName;
  readonly status: EngineStatus;
  readonly error: Error | null;
  readonly capabilities: MapCapabilities;
}

interface PendingDraw {
  kind: DrawKind;
  resolve(g: Geometry): void;
  reject(e: unknown): void;
}

/**
 * The {@link MapApi} the pages talk to when the engine is chosen at runtime. It is stable across engine switches
 * and loads: calls made while an engine is loading (or after a switch) are remembered (query geometry, extent,
 * overlay, data) and replayed on the engine once it is attached. Switching cancels a draw in progress
 * ({@link DrawCancelledError}) and clears the data; the geometry, extent and overlay stay.
 */
export class EngineHost implements MapApi {
  private engine: MapEngine | null = null;
  private el: HTMLElement | null = null;
  private status: EngineStatus = 'loading';
  private error: Error | null = null;
  private name: MapEngineName;
  private token = 0;
  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();

  // Remembered state (replayed on a (re)attached engine).
  private geometry: Geometry | null = null;
  private extent: BBox | null = null;
  private overlay: {
    img: string;
    bbox: BBox;
    opts?: { fit?: boolean; opacity?: number };
  } | null = null;
  private data: { layer: DataLayer; opts: ShowDataOptions } | null = null;
  private readonly pendingDraws = new Set<PendingDraw>();
  private readonly selectHandlers = new Set<DataSelectHandler>();
  private unsubSelect: (() => void) | null = null;

  constructor(
    name: MapEngineName,
    private readonly load: (name: MapEngineName) => Promise<MapEngine> = loadEngine,
  ) {
    this.name = name;
    this.snapshot = this.makeSnapshot();
    void this.start(name);
  }

  // ---- external store (React) ---------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private makeSnapshot(): EngineSnapshot {
    return {
      name: this.name,
      status: this.status,
      error: this.error,
      capabilities: this.engine?.capabilities ?? {},
    };
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot();
    for (const l of [...this.listeners]) l();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Create the map in `el` (once the engine is loaded). */
  attach(el: HTMLElement): void {
    this.el = el;
    if (this.engine) this.mount(this.engine);
  }

  detach(): void {
    this.el = null;
    this.engine?.detach();
  }

  /** Switch engine: cancels a draw in progress, clears the data, then loads and mounts the new engine. */
  switchTo(name: MapEngineName): void {
    if (name === this.name) return;
    try {
      safeStorage()?.setItem(ENGINE_STORAGE_KEY, name);
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
    this.releaseEngine();
    this.name = name;
    void this.start(name);
  }

  private async start(name: MapEngineName): Promise<void> {
    const token = ++this.token;
    this.status = 'loading';
    this.error = null;
    this.publish();
    let engine: MapEngine;
    try {
      engine = await this.load(name);
    } catch (e) {
      if (token !== this.token) return;
      this.status = 'error';
      this.error = e instanceof Error ? e : new Error(String(e));
      this.publish();
      this.rejectPending(this.error);
      return;
    }
    if (token !== this.token) return;
    this.engine = engine;
    this.status = 'ready';
    this.publish();
    if (this.el) this.mount(engine);
  }

  private mount(engine: MapEngine): void {
    if (!this.el) return;
    engine.attach(this.el);
    const api = engine.api;
    if (!this.unsubSelect) this.unsubSelect = api.onDataSelect((i, ll) => this.selectHandlers.forEach((cb) => cb(i, ll)));
    api.showExtent(this.extent);
    api.showGeometry(this.geometry);
    if (this.overlay) api.setOverlay(this.overlay.img, this.overlay.bbox, this.overlay.opts);
    if (this.data) api.showData(this.data.layer, this.data.opts);
    const pending = [...this.pendingDraws];
    this.pendingDraws.clear();
    for (const p of pending) api.drawGeometry(p.kind).then(p.resolve, p.reject);
  }

  /** Stop using the current engine: cancel its draw, clear its data, detach it, and invalidate any load in flight. */
  private releaseEngine(): void {
    this.token++;
    const engine = this.engine;
    if (engine) {
      engine.cancel();
      engine.api.clearData();
      this.unsubSelect?.();
      engine.detach();
    }
    this.unsubSelect = null;
    this.engine = null;
    this.data = null;
    this.rejectPending(new DrawCancelledError());
  }

  private rejectPending(reason: unknown): void {
    const pending = [...this.pendingDraws];
    this.pendingDraws.clear();
    for (const p of pending) p.reject(reason);
  }

  // ---- MapApi -------------------------------------------------------------------------------

  drawGeometry(kind: DrawKind): Promise<Geometry> {
    if (this.engine && this.el) return this.engine.api.drawGeometry(kind);
    if (this.status === 'error') return Promise.reject(this.error ?? new Error('Map is not ready'));
    // Engine still loading (or the map element not mounted yet): draw as soon as it is there.
    this.rejectPending(new DrawCancelledError());
    return new Promise<Geometry>((resolve, reject) => {
      this.pendingDraws.add({ kind, resolve, reject });
    });
  }

  setOverlay(img: string | null, bbox?: BBox | null, opts?: { fit?: boolean; opacity?: number }): void {
    this.overlay = img && bbox ? { img, bbox, opts } : null;
    this.engine?.api.setOverlay(img, bbox, opts);
  }

  clear(): void {
    this.geometry = null;
    this.extent = null;
    this.overlay = null;
    this.rejectPending(new DrawCancelledError());
    this.engine?.api.clear();
  }

  showGeometry(geometry: Geometry | null): void {
    this.geometry = geometry;
    this.engine?.api.showGeometry(geometry);
  }

  showExtent(bbox: BBox | null): void {
    this.extent = bbox;
    this.engine?.api.showExtent(bbox);
  }

  showData(layer: DataLayer, opts: ShowDataOptions): void {
    this.engine?.api.showData(layer, opts); // may throw (bad param / kind): then nothing is remembered
    this.data = { layer, opts };
  }

  clearData(): void {
    this.data = null;
    this.engine?.api.clearData();
  }

  showCoverage(layer: DataLayer, param: string, timeIndex: number): Promise<void> {
    const show = this.engine?.api.showCoverage;
    return show
      ? show.call(this.engine?.api, layer, param, timeIndex)
      : Promise.reject(new Error('leaflet-coverage rendering is not available'));
  }

  clearCoverage(): void {
    this.engine?.api.clearCoverage?.();
  }

  onDataSelect(cb: DataSelectHandler): () => void {
    this.selectHandlers.add(cb);
    return () => {
      this.selectHandlers.delete(cb);
    };
  }
}
