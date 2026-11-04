import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MERCATOR_MAX_LAT,
  mercatorBounds,
  mercatorHeight,
  mercatorY,
  remapRowsToMercator,
  reprojectImage,
  type Raster,
  type RasterSource,
} from './reproject';

/** Raster `w × h` whose pixel in source row r has red = r (so the source row of any output pixel can be read back). */
function rowRaster(w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) data[(r * w + x) * 4] = r;
  return { width: w, height: h, data };
}
const redOfRow = (data: Uint8ClampedArray, w: number, r: number): number => data[r * w * 4];

describe('mercatorBounds', () => {
  it('keeps an ordinary bbox', () => {
    expect(mercatorBounds([-10, 20, 30, 40])).toEqual({ west: -10, south: 20, east: 30, north: 40 });
  });

  it('clamps latitude to ±85.0511', () => {
    const b = mercatorBounds([-180, -90, 180, 90]);
    expect(b.north).toBeCloseTo(85.0511287798, 9);
    expect(b.south).toBeCloseTo(-85.0511287798, 9);
    expect(b).toMatchObject({ west: -180, east: 180 });
    expect(MERCATOR_MAX_LAT).toBeCloseTo(85.0511287798, 9);
  });

  it('unwraps a bbox crossing the antimeridian and cuts one wider than the world', () => {
    expect(mercatorBounds([170, 0, -170, 10])).toMatchObject({ west: 170, east: 190 });
    expect(mercatorBounds([-200, 0, 300, 10])).toMatchObject({ west: -200, east: 160 });
  });

  it('rejects boxes that are non-finite or empty in Mercator', () => {
    expect(() => mercatorBounds([0, 0, NaN, 10])).toThrow(RangeError);
    expect(() => mercatorBounds([0, 86, 10, 90])).toThrow(RangeError);
    expect(() => mercatorBounds([0, 10, 10, 10])).toThrow(RangeError);
    expect(() => mercatorBounds([5, 0, 5, 10])).toThrow(RangeError);
  });
});

describe('remapRowsToMercator', () => {
  it('puts source row 0 (north) at output row 0 and the last row at the bottom', () => {
    const src = rowRaster(2, 4);
    const out = remapRowsToMercator(src, [0, 0, 10, 40], 8);
    expect(out.length).toBe(2 * 8 * 4);
    expect(redOfRow(out, 2, 0)).toBe(0);
    expect(redOfRow(out, 2, 7)).toBe(3);
    // Row order never goes back up.
    let prev = -1;
    for (let r = 0; r < 8; r++) {
      const v = redOfRow(out, 2, r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('spaces rows evenly in Mercator y, not latitude', () => {
    // Two source rows over lat 0..60: north half 30..60 = row 0, south half 0..30 = row 1.
    const src = rowRaster(1, 2);
    const H = 12;
    const out = remapRowsToMercator(src, [0, 0, 10, 60], H);
    const north = Array.from({ length: H }, (_, r) => redOfRow(out, 1, r)).filter((v) => v === 0).length;
    // Linear rows would give 6/6; Mercator y(30)/y(60) puts the boundary at 41.7% from the bottom => 7 north rows.
    const f = 1 - mercatorY(30) / mercatorY(60);
    expect(north).toBe(Math.round(f * H));
    expect(north).toBe(7);
  });

  it('copies whole source rows (columns are untouched)', () => {
    const src: Raster = { width: 3, height: 1, data: Uint8ClampedArray.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) };
    const out = remapRowsToMercator(src, [0, 0, 3, 3], 2);
    expect(Array.from(out)).toEqual([...src.data, ...src.data]);
  });

  it('clamps latitude: the top output row is the source row at ±85.0511, not at ±90', () => {
    const src = rowRaster(1, 180); // one row per degree, row 0 = 90..89
    const H = 400;
    const out = remapRowsToMercator(src, [-180, -90, 180, 90], H);
    // Top output row is centred just below 85.0511 => source row floor(90 - 85.05) = 4; bottom mirrors (175).
    expect(redOfRow(out, 1, 0)).toBe(4);
    expect(redOfRow(out, 1, H - 1)).toBe(175);
    // Rows 0..3 (90..86°) are cut off, never sampled.
    for (let r = 0; r < H; r++) expect(redOfRow(out, 1, r)).toBeGreaterThanOrEqual(4);
  });

  it('handles the whole world and a bbox that crosses the antimeridian', () => {
    const src = rowRaster(4, 6);
    expect(() => remapRowsToMercator(src, [-180, -90, 180, 90])).not.toThrow();
    const out = remapRowsToMercator(src, [170, -10, -170, 10], 6);
    expect(out.length).toBe(4 * 6 * 4);
    expect(redOfRow(out, 4, 0)).toBe(0);
    expect(redOfRow(out, 4, 5)).toBe(5);
  });

  it('is symmetric for a symmetric bbox', () => {
    const src = rowRaster(1, 10);
    const out = remapRowsToMercator(src, [0, -40, 10, 40], 10);
    for (let r = 0; r < 10; r++) expect(redOfRow(out, 1, r) + redOfRow(out, 1, 9 - r)).toBe(9);
  });
});

describe('mercatorHeight', () => {
  it('is about the source height for a small bbox, taller for a continent, and capped', () => {
    expect(mercatorHeight(100, [0, 0, 1, 1])).toBe(100);
    expect(mercatorHeight(100, [0, 0, 60, 60])).toBeGreaterThan(100);
    expect(mercatorHeight(100_000, [0, 0, 60, 60])).toBe(4096);
    expect(mercatorHeight(1, [0, 0, 1, 1])).toBeGreaterThanOrEqual(1);
  });
});

describe('reprojectImage', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Stand-in canvas context: records what is put and serves `pixels` for reads. */
  function mockCanvas(read: () => Raster): { put: Raster[] } {
    const put: Raster[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        drawImage: () => {},
        getImageData: () => read(),
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (d: Raster) => put.push({ width: d.width, height: d.height, data: Uint8ClampedArray.from(d.data) }),
      } as unknown as CanvasRenderingContext2D;
    } as never);
    return { put };
  }
  const fakeImage = (w: number, h: number) => ({ naturalWidth: w, naturalHeight: h, width: w, height: h }) as unknown as RasterSource;

  it('draws the remapped pixels and returns Leaflet bounds [[s,w],[n,e]] (clamped)', () => {
    const src = rowRaster(2, 4);
    const { put } = mockCanvas(() => src);
    const r = reprojectImage(fakeImage(2, 4), [-180, -90, 180, 90]);
    expect(r.bounds[0][0]).toBeCloseTo(-85.0511287798, 6);
    expect(r.bounds[1][0]).toBeCloseTo(85.0511287798, 6);
    expect(r.bounds[0][1]).toBe(-180);
    expect(r.bounds[1][1]).toBe(180);
    expect(r.canvas.width).toBe(2);
    expect(put).toHaveLength(1);
    expect(put[0].width).toBe(2);
    expect(redOfRow(put[0].data, 2, 0)).toBe(0); // north stays on top
    expect(redOfRow(put[0].data, 2, put[0].height - 1)).toBe(3);
  });

  it('propagates a SecurityError from a tainted canvas', () => {
    mockCanvas(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(() => reprojectImage(fakeImage(2, 2), [0, 0, 1, 1])).toThrow(/tainted/);
  });

  it('rejects an image without size and an empty bbox', () => {
    mockCanvas(() => rowRaster(1, 1));
    expect(() => reprojectImage(fakeImage(0, 0), [0, 0, 1, 1])).toThrow(RangeError);
    expect(() => reprojectImage(fakeImage(2, 2), [0, 89, 1, 90])).toThrow(RangeError);
  });
});
