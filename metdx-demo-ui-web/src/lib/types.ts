/** Shared data types. Kept loose on purpose: upstream servers vary a lot. */

/** [minLon, minLat, maxLon, maxLat] in EPSG:4326. */
export type BBox = [number, number, number, number];

export type Position = [number, number];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}
export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}
/** Geometries the map can draw (lon/lat order). */
export type Geometry = PointGeometry | LineStringGeometry | PolygonGeometry;

/** What the user can ask the map to draw. `bbox` yields a Polygon (rectangle). */
export type DrawKind = 'point' | 'line' | 'polygon' | 'bbox';

export interface RecordLink {
  rel?: string;
  href: string;
  type?: string;
  title?: string;
  channel?: string;
  [k: string]: unknown;
}

export interface RecordContact {
  organization?: string;
  name?: string;
  emails?: { value: string }[];
  phones?: { value: string }[];
  [k: string]: unknown;
}

/** An OGC API Record (WCMP2 discovery metadata) feature. */
export interface OgcRecord {
  id: string;
  type?: string;
  geometry?: Geometry | null;
  time?: { interval?: (string | null)[]; resolution?: string } | null;
  properties: {
    title?: string;
    description?: string;
    keywords?: string[];
    created?: string;
    updated?: string;
    contacts?: RecordContact[];
    rights?: string;
    license?: string;
    wmo?: { dataPolicy?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  links: RecordLink[];
  [k: string]: unknown;
}

export interface RecordsPage {
  type?: string;
  numberMatched?: number;
  numberReturned?: number;
  features: OgcRecord[];
  links?: RecordLink[];
}
