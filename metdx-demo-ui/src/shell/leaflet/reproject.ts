import { MAX_CANVAS_DIM } from '../../lib/covjsonTypes';
import type { BBox } from '../../lib/types';

/**
 * Reprojection of EPSG:4326 (equirectangular) rasters to Web Mercator for `L.imageOverlay`. Leaflet stretches an
 * image linearly between the projected corners, so rows must be spaced evenly in Mercator y, not in latitude.
 * Columns are unchanged (longitude is linear in both). No Leaflet import: this module is plain maths + canvas.
 */

/** Northern/southern limit of the Web Mercator square. */
export const MERCATOR_MAX_LAT = 85.0511287798;

/** The bbox as Leaflet wants it: latitude clamped to ±{@link MERCATOR_MAX_LAT}, east > west (antimeridian unwrapped). */
export interface MercatorBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Minimal raster (an `ImageData` without the class, so it can be built without a canvas). */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const RAD = Math.PI / 180;

/** Mercator y (radians on the unit sphere) of a latitude in degrees. */
export function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
}

/** Latitude (degrees) of a Mercator y. */
function inverseMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
}

const clampLat90 = (v: number): number => Math.max(-90, Math.min(90, v));

/**
 * Bounds of `bbox` in Mercator terms. A bbox crossing the antimeridian (`east < west`) gets `east + 360`; one wider than
 * the world is cut to 360°. Throws a RangeError if it is not a finite box or lies entirely outside the Mercator latitudes.
 */
export function mercatorBounds(bbox: BBox): MercatorBounds {
  const [w, s, e, n] = bbox;
  if (![w, s, e, n].every(Number.isFinite)) throw new RangeError('Overlay bbox is not finite');
  let east = e;
  if (east < w) east += 360;
  if (east - w > 360) east = w + 360;
  const south = Math.max(-MERCATOR_MAX_LAT, clampLat90(s));
  const north = Math.min(MERCATOR_MAX_LAT, clampLat90(n));
  if (!(north > south) || !(east > w)) throw new RangeError('Overlay bbox is empty in Web Mercator');
  return { south, west: w, north, east };
}

/** Rows of the reprojected raster for `src`: keeps the vertical detail at the equator, capped at {@link MAX_CANVAS_DIM}. */
export function mercatorHeight(srcHeight: number, bbox: BBox): number {
  const b = mercatorBounds(bbox);
  const [, s, , n] = bbox;
  const srcRows = (srcHeight * (b.north - b.south)) / (clampLat90(n) - clampLat90(s));
  const rows = (srcRows * (mercatorY(b.north) - mercatorY(b.south))) / ((b.north - b.south) * RAD);
  return Math.max(1, Math.min(MAX_CANVAS_DIM, Math.round(rows)));
}

/**
 * Resample `src` (row 0 = north edge of `bbox`, equally spaced in latitude) to `outHeight` rows equally spaced in
 * Mercator y over the clamped bounds (row 0 = north). Nearest row; each output row is a copy of one source row.
 * Returns the new RGBA pixels (`src.width * outHeight * 4`).
 */
export function remapRowsToMercator(src: Raster, bbox: BBox, outHeight: number = mercatorHeight(src.height, bbox)): Uint8ClampedArray {
  const b = mercatorBounds(bbox);
  const s = clampLat90(bbox[1]);
  const n = clampLat90(bbox[3]);
  const { width, height } = src;
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const yN = mercatorY(b.north);
  const yS = mercatorY(b.south);
  const rowBytes = width * 4;
  for (let r = 0; r < outHeight; r++) {
    const lat = inverseMercatorY(yN - ((r + 0.5) / outHeight) * (yN - yS));
    const sr = Math.max(0, Math.min(height - 1, Math.floor(((n - lat) / (n - s)) * height)));
    out.set(src.data.subarray(sr * rowBytes, (sr + 1) * rowBytes), r * rowBytes);
  }
  return out;
}

/** A source `reprojectImage` can draw: a loaded `HTMLImageElement` or a canvas. */
export type RasterSource = (HTMLImageElement | HTMLCanvasElement) & CanvasImageSource;

export interface Reprojected {
  canvas: HTMLCanvasElement;
  /** `[[south, west], [north, east]]` as Leaflet `LatLngBoundsLiteral`. */
  bounds: [[number, number], [number, number]];
}

/**
 * Reproject a loaded EPSG:4326 image covering `bbox` to Web Mercator. Reading the pixels throws a `SecurityError`
 * when the image is cross-origin without CORS (tainted canvas); callers treat any throw as an overlay error.
 */
export function reprojectImage(img: RasterSource, bbox: BBox): Reprojected {
  const natW = (img as HTMLImageElement).naturalWidth || img.width;
  const natH = (img as HTMLImageElement).naturalHeight || img.height;
  if (!(natW > 0 && natH > 0)) throw new RangeError('Overlay image has no size');
  const width = Math.min(natW, MAX_CANVAS_DIM);
  const height = Math.min(natH, MAX_CANVAS_DIM);
  const b = mercatorBounds(bbox);

  const src = document.createElement('canvas');
  src.width = width;
  src.height = height;
  const sctx = src.getContext('2d');
  if (!sctx) throw new Error('Canvas 2D is not available');
  sctx.drawImage(img, 0, 0, width, height);
  const pixels = sctx.getImageData(0, 0, width, height); // SecurityError if tainted

  const outHeight = mercatorHeight(height, bbox);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = outHeight;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas 2D is not available');
  const outData = octx.createImageData(width, outHeight);
  outData.data.set(remapRowsToMercator({ width, height, data: pixels.data }, bbox, outHeight));
  octx.putImageData(outData, 0, 0);
  // Release the intermediate buffer.
  src.width = 0;
  src.height = 0;
  return {
    canvas: out,
    bounds: [
      [b.south, b.west],
      [b.north, b.east],
    ],
  };
}
