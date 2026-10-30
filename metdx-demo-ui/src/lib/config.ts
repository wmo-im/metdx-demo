/**
 * Runtime configuration, loaded once at startup from `config.json` next to the
 * app (`<base>config.json`, served from `public/`, so it can be edited in a
 * deployed `dist/` without a rebuild).
 *
 * - `recordsSource`: where the catalogue search gets its records.
 *     "catalogue" (default): the live WMO resource catalogue (`catalogueUrl`).
 *                            "gdc" is accepted as an alias (older configs).
 *     "local":               the records bundled with the app (`src/data/records/`,
 *                            copies of `resources/metadata/discovery/`), searched in
 *                            the browser; for offline use and demos.
 *   Overridable per page load with `?records=catalogue|gdc|local`.
 * - `catalogueUrl`: the OGC API - Records collection to search (`<catalogueUrl>/items`).
 * - `defaultQuery`: search text used when the page is opened without `?q=` (the
 *   search box is prefilled with it); "" lists all records. A user who clears the
 *   box and searches gets the full list (the URL then carries an empty `q=`).
 * - `proxy`: true (default) routes upstream calls through the same-origin
 *            `/api/proxy`; false calls the upstream servers directly from the
 *            browser (static hosting such as GitHub Pages; needs CORS upstream).
 *
 * EDR and Maps calls are independent of this setting (live unless mock mode).
 */
export type RecordsSource = 'local' | 'catalogue';

export interface AppConfig {
  recordsSource: RecordsSource;
  catalogueUrl: string;
  defaultQuery: string;
  proxy: boolean;
}

/** The WMO resource catalogue's WIS2 discovery metadata collection. */
export const DEFAULT_CATALOGUE_URL = 'https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata';
export const DEFAULT_QUERY = 'metdx-demo';

export const DEFAULT_CONFIG: AppConfig = {
  recordsSource: 'catalogue',
  catalogueUrl: DEFAULT_CATALOGUE_URL,
  defaultQuery: DEFAULT_QUERY,
  proxy: true,
};

/** `config.json` under the Vite base path (`/` by default, a sub-path on GitHub Pages). */
export const CONFIG_URL = `${import.meta.env.BASE_URL ?? '/'}config.json`;

export function parseProxy(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'true' ? true : v === 'false' ? false : undefined;
}

export function parseRecordsSource(value: unknown): RecordsSource | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'local') return 'local';
  return v === 'catalogue' || v === 'gdc' ? 'catalogue' : undefined;
}

/** A valid http(s) URL without trailing slashes, else undefined. */
export function parseCatalogueUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? value.trim().replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export function parseDefaultQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Pure merge: defaults < config file < `?records=` in `search` (invalid values are ignored). */
export function resolveConfig(file: unknown, search = ''): AppConfig {
  const obj = file && typeof file === 'object' ? (file as Record<string, unknown>) : {};
  const fromFile = parseRecordsSource(obj.recordsSource);
  let fromUrl: RecordsSource | undefined;
  try {
    fromUrl = parseRecordsSource(new URLSearchParams(search).get('records'));
  } catch {
    /* ignore */
  }
  return {
    recordsSource: fromUrl ?? fromFile ?? DEFAULT_CONFIG.recordsSource,
    catalogueUrl: parseCatalogueUrl(obj.catalogueUrl) ?? DEFAULT_CONFIG.catalogueUrl,
    defaultQuery: parseDefaultQuery(obj.defaultQuery) ?? DEFAULT_CONFIG.defaultQuery,
    proxy: parseProxy(obj.proxy) ?? DEFAULT_CONFIG.proxy,
  };
}

let current: AppConfig = { ...DEFAULT_CONFIG };

export function getConfig(): AppConfig {
  return current;
}

/** Whether upstream calls go through the same-origin proxy (config `proxy`, default true). */
export function useProxy(): boolean {
  return current.proxy;
}

export function getRecordsSource(): RecordsSource {
  return current.recordsSource;
}

/** Items endpoint of the configured catalogue collection. */
export function catalogueItemsUrl(): string {
  return `${current.catalogueUrl}/items`;
}

/** Host of the configured catalogue (shown in the catalogue page's source chip). */
export function catalogueHost(): string {
  try {
    return new URL(current.catalogueUrl).host;
  } catch {
    return current.catalogueUrl;
  }
}

/** Search text used when the URL has no `?q=` ("" = none). */
export function getDefaultQuery(): string {
  return current.defaultQuery;
}

/** Override the records source (tests, or after {@link loadConfig}). */
export function setRecordsSource(source: RecordsSource): void {
  current = { ...current, recordsSource: source };
}

/** Override the default search text (tests). */
export function setDefaultQuery(query: string): void {
  current = { ...current, defaultQuery: query };
}

/** Back to the built-in defaults (tests). */
export function resetConfig(): void {
  current = { ...DEFAULT_CONFIG };
}

/**
 * Fetch `config.json` (a missing or malformed file falls back to the
 * defaults), apply `?records=` and make the result the current config.
 */
export async function loadConfig(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): Promise<AppConfig> {
  let file: unknown;
  try {
    const res = await fetchImpl(CONFIG_URL, { cache: 'no-store' });
    if (res.ok) file = await res.json();
  } catch {
    /* no config file: defaults */
  }
  current = resolveConfig(file, search);
  return current;
}
