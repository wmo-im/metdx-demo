/**
 * Runtime configuration, loaded once at startup from `config.json` next to the
 * app (`<base>config.json`, served from `public/`, so it can be edited in a
 * deployed `dist/` without a rebuild).
 *
 * - `recordsSource`: where the catalogue search gets its records.
 *     "local" (default): the records bundled with the app (`src/data/records/`),
 *                        searched in the browser; like the Flet app's METDX_TEST mode.
 *     "gdc":             the live WIS2 Global Discovery Catalogue, through the proxy.
 *   Overridable per page load with `?records=local|gdc`.
 * - `proxy`: true (default) routes upstream calls through the same-origin
 *            `/api/proxy`; false calls the upstream servers directly from the
 *            browser (static hosting such as GitHub Pages; needs CORS upstream).
 *
 * EDR and Maps calls are independent of this setting (live unless mock mode).
 */
export type RecordsSource = 'local' | 'gdc';

export interface AppConfig {
  recordsSource: RecordsSource;
  proxy: boolean;
}

export const DEFAULT_CONFIG: AppConfig = { recordsSource: 'local', proxy: true };

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
  return v === 'local' || v === 'gdc' ? v : undefined;
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

/** Override the records source (tests, or after {@link loadConfig}). */
export function setRecordsSource(source: RecordsSource): void {
  current = { ...current, recordsSource: source };
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
