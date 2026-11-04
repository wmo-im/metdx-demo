import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Alert } from '@mui/material';
import { ENGINE_LABELS, EngineHost, resolveEngineName, type EngineSnapshot } from './engine';
import type { MapApi, MapCapabilities, MapEngine, MapEngineName } from './mapApi';

export type { MapApi, MapCapabilities, MapEngine, MapEngineName } from './mapApi';
export { DrawCancelledError } from './mapApi';
export type { DataLayer, DataSelectHandler, ShowDataOptions, ColourScale, ParamInfo, GridSpec, LegendProps } from '../lib/covjsonTypes';
export { TooLargeToDraw, MAX_POINTS, MAX_GRID_CELLS, MAX_CANVAS_DIM, DEFAULT_COLOUR_SCALE } from '../lib/covjsonTypes';

interface MapCtx {
  api: MapApi;
  attach(el: HTMLElement): void;
  detach(): void;
  /** The runtime-switchable engine host; `null` when an engine was injected (tests). */
  host: EngineHost | null;
}

const Ctx = createContext<MapCtx | null>(null);

const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => null;

function useSnapshot(host: EngineHost | null): EngineSnapshot | null {
  return useSyncExternalStore(host ? host.subscribe : NO_SUBSCRIBE, host ? host.getSnapshot : NO_SNAPSHOT);
}

/**
 * Owns the map engine. By default the engine is chosen at runtime (config `mapEngine`, `?map=`, the app-bar toggle)
 * and loaded lazily; `controller` injects a ready {@link MapEngine} instead (tests), which cannot be switched.
 * `MapView` attaches the engine's map to the page.
 */
export function MapProvider({ children, controller }: { children: ReactNode; controller?: MapEngine }) {
  const host = useMemo(() => (controller ? null : new EngineHost(resolveEngineName())), [controller]);
  const value = useMemo<MapCtx>(
    () =>
      host
        ? { api: host, attach: (el) => host.attach(el), detach: () => host.detach(), host }
        : { api: controller!.api, attach: (el) => controller!.attach(el), detach: () => controller!.detach(), host: null },
    [host, controller],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Map contract for pages: `drawGeometry`, `setOverlay`, `clear` (+ `showGeometry`, `showExtent`, data methods). */
export function useMap(): MapApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMap must be used inside <MapProvider>');
  return c.api;
}

export interface MapEngineState {
  name: MapEngineName;
  status: 'loading' | 'ready' | 'error';
  error: Error | null;
  capabilities: MapCapabilities;
  /** Switch engine (cancels a draw in progress, clears the data, remounts the map). */
  switchEngine(name: MapEngineName): void;
}

/** The current engine and a way to switch it; `null` without a provider or with an injected engine. */
export function useMapEngine(): MapEngineState | null {
  const host = useContext(Ctx)?.host ?? null;
  const snap = useSnapshot(host);
  return useMemo(() => (host && snap ? { ...snap, switchEngine: (n: MapEngineName) => host.switchTo(n) } : null), [host, snap]);
}

/** The map canvas of the current engine. Renders nothing if there is no provider. */
export function MapView() {
  const ctx = useContext(Ctx);
  const snap = useSnapshot(ctx?.host ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const name = snap?.name;
  useEffect(() => {
    if (!ctx || !ref.current) return;
    ctx.attach(ref.current);
    return () => ctx.detach();
  }, [ctx, name]);
  return (
    <>
      {/* keyed by engine: each engine gets a fresh element (libraries leave their DOM and listeners behind) */}
      <div key={name ?? 'injected'} ref={ref} data-testid="map" data-engine={name} style={{ position: 'absolute', inset: 0 }} />
      {snap?.status === 'error' && (
        <Alert severity="error" role="alert" sx={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 1000 }}>
          Could not start the {ENGINE_LABELS[snap.name]} map: {snap.error?.message}
        </Alert>
      )}
    </>
  );
}
