import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { MapController, type MapApi } from './mapController';

export type { MapApi } from './mapController';
export { DrawCancelledError } from './mapController';

const Ctx = createContext<MapController | null>(null);

/** Owns the {@link MapController}; `MapView` attaches the OL map to it. */
export function MapProvider({ children, controller }: { children: ReactNode; controller?: MapController }) {
  const ctrl = useMemo(() => controller ?? new MapController(), [controller]);
  return <Ctx.Provider value={ctrl}>{children}</Ctx.Provider>;
}

/** Map contract for pages: `drawGeometry`, `setOverlay`, `clear` (+ `showGeometry`, `showExtent`). */
export function useMap(): MapApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMap must be used inside <MapProvider>');
  return c;
}

/** The OpenLayers canvas. Renders nothing if there is no provider. */
export function MapView() {
  const ctrl = useContext(Ctx);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctrl || !ref.current) return;
    ctrl.attach(ref.current);
    return () => ctrl.detach();
  }, [ctrl]);
  return <div ref={ref} data-testid="map" style={{ position: 'absolute', inset: 0 }} />;
}
