// leaflet-coverage rendering of a normalised layer: re-emit as standard CoverageJSON, read it with covjson-reader,
// and add the matching leaflet-coverage layer to the map. Loaded lazily (see ../coverageHook.ts).
import type * as L from 'leaflet';
import { read } from 'covjson-reader';
import { dataLayer } from 'leaflet-coverage/src/layers/factory.js';
import { DEFAULT_COLOUR_SCALE, type DataLayer } from '../../../lib/covjsonTypes';
import { standardDomainType, toStandardCovJson } from './toCovJson';

export interface CoverageHandle {
  /** The leaflet-coverage layer type used. */
  domainType: string;
  remove(): void;
}

/** The app's colour scale as a leaflet-coverage palette (built directly: `linearPalette` needs a canvas gradient). */
function palette(steps = 256) {
  const red = new Uint8Array(steps);
  const green = new Uint8Array(steps);
  const blue = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) [red[i], green[i], blue[i]] = DEFAULT_COLOUR_SCALE.fn(i / (steps - 1));
  return { steps, red, green, blue };
}

/** Rejection reason of a render that was cancelled through its `signal`. */
export class CoverageCancelledError extends Error {
  constructor() {
    super('leaflet-coverage rendering cancelled');
    this.name = 'AbortError';
  }
}

/**
 * Draw `param` of `layer` at `timeIndex` with leaflet-coverage; rejects when the library cannot render it.
 * Aborting `signal` (map detached, result cleared or replaced) stops the render at its next step: nothing is added to the
 * map afterwards, a layer already added is removed again, and the promise rejects with {@link CoverageCancelledError}.
 */
export async function renderLayer(
  map: L.Map,
  layer: DataLayer,
  param: string,
  timeIndex: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<CoverageHandle> {
  const checkAborted = () => {
    if (signal.aborted) throw new CoverageCancelledError();
  };
  checkAborted();
  const info = layer.parameters.find((p) => p.key === param);
  if (!info) throw new RangeError(`Unknown parameter "${param}"`);
  const cov = await read(toStandardCovJson(layer, param, timeIndex));
  checkAborted();
  // A flat extent would divide by zero in the palette scaling; leaflet-coverage widens it the same way.
  const extent =
    Number.isFinite(info.min) && Number.isFinite(info.max)
      ? info.min === info.max
        ? [info.min - Math.abs(info.min) * 0.1 - 1e-9, info.max + Math.abs(info.max) * 0.1 + 1e-9]
        : [info.min, info.max]
      : 'full';
  const pal = palette();
  // PointCollection hands its children no palette until all of them have loaded (they would pick the default one and
  // an extent of their own value), so give them ours through pointOptionsFn.
  const time = layer.times.length ? new Date(layer.times[Math.min(timeIndex, layer.times.length - 1)]) : undefined;
  const l = dataLayer(cov, {
    parameter: param,
    time, // PointSeries and Grid pick their slice by time
    palette: pal,
    paletteExtent: extent,
    pointOptionsFn: () => ({ palette: pal, paletteExtent: extent }),
  });
  const removeLayer = () => {
    try {
      map.removeLayer(l);
    } catch {
      /* the map is already gone */
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new CoverageCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      l.once('afterAdd', () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      l.once('error', (e: { error?: Error; errors?: Error[] }) => {
        signal.removeEventListener('abort', onAbort);
        reject(e.error ?? e.errors?.[0] ?? new Error('leaflet-coverage could not render the coverage'));
      });
      l.addTo(map);
    });
    checkAborted();
  } catch (e) {
    removeLayer(); // failed or cancelled: leave nothing behind
    throw e;
  }
  if (typeof l.getBounds === 'function') {
    try {
      map.fitBounds(l.getBounds(), { maxZoom: 8 });
    } catch {
      /* no extent */
    }
  }
  return {
    domainType: standardDomainType(layer),
    remove: removeLayer,
  };
}
