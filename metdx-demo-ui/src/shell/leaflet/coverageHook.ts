import type * as L from 'leaflet';
import type { DataLayer } from '../../lib/covjsonTypes';
import type { CoverageHandle } from './coverage/render';

export type { CoverageHandle };

/**
 * Render a normalised CoverageJSON result with leaflet-coverage (optional, see the engine's
 * `capabilities.coverageRenderer`). The library and the standard-CoverageJSON re-emitter are loaded on first use.
 * Rejects when the library cannot render the data, or with an `AbortError` when `signal` is aborted.
 */
export async function renderCoverage(
  map: L.Map,
  layer: DataLayer,
  param: string,
  timeIndex: number,
  signal: AbortSignal,
): Promise<CoverageHandle> {
  const { renderLayer } = await import('./coverage/render');
  return renderLayer(map, layer, param, timeIndex, signal); // checks the signal itself: the import may have taken a while
}
