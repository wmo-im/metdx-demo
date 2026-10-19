/**
 * Mock-fetch layer: replays the fixtures in `test/fixtures/` instead of
 * calling the network. Used by vitest, by Playwright and by `?mock=1` in the
 * browser (or VITE_MOCK=1 at build/dev time).
 *
 * It understands the proxy envelope: requests arrive as
 * `/api/proxy?url=<encoded upstream url>` and a 3xx answer is returned in the
 * proxy's HTTP 200 `{status, location}` form.
 *
 * Fixtures: records/*.json (search + item lookup), collections/<id>.json,
 * instances/<col>.json (+ <col>.instance.json for any instance id),
 * schema/<col>.json, edr/<query-type>.json (falls back to position.json),
 * jobs/running.json + jobs/successful.json, maps/map.png.
 *
 * Behaviour switches (query params of the upstream URL):
 *  - `async=true` on an EDR query -> 303 to a job; the job reports `running`
 *    for the first {@link MockOptions.runningPolls} polls, then `successful`.
 *  - `fail=<status>` -> that HTTP status.
 */
import { proxyUrl, setFetchImpl, unproxyUrl, type FetchImpl } from './http';

const jsonFixtures = import.meta.glob('../../test/fixtures/**/*.json', { import: 'default' }) as Record<
  string,
  () => Promise<unknown>
>;
const pngFixtures = import.meta.glob('../../test/fixtures/**/*.png', { query: '?inline', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

const FIXTURE_PREFIX = '../../test/fixtures/';

async function loadJson<T = unknown>(name: string): Promise<T | undefined> {
  const loader = jsonFixtures[`${FIXTURE_PREFIX}${name}`];
  return loader ? ((await loader()) as T) : undefined;
}

async function loadPng(name: string): Promise<Uint8Array | undefined> {
  const loader = pngFixtures[`${FIXTURE_PREFIX}${name}`];
  if (!loader) return undefined;
  const dataUrl = await loader();
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Names of all record fixtures. */
async function loadAllRecords(): Promise<Record<string, any>[]> {
  const names = Object.keys(jsonFixtures)
    .filter((k) => k.startsWith(`${FIXTURE_PREFIX}records/`))
    .sort();
  return Promise.all(names.map((n) => jsonFixtures[n]() as Promise<Record<string, any>>));
}

export interface MockOptions {
  /** Artificial latency per request (ms). */
  latencyMs?: number;
  /** How many job polls answer `running` before `successful`. Default 1. */
  runningPolls?: number;
}

export interface MockFetch extends FetchImpl {
  /** Upstream URLs requested so far (decoded from the proxy URL). */
  calls: string[];
  reset(): void;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function notFound(url: string): Response {
  return jsonResponse({ code: 'NotFound', description: `No fixture for ${url}` }, 404);
}

export function createMockFetch(opts: MockOptions = {}): MockFetch {
  const runningPolls = opts.runningPolls ?? 1;
  const jobPolls = new Map<string, number>();

  const impl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const upstream = unproxyUrl(input);
    mock.calls.push(upstream);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let u: URL;
    try {
      u = new URL(upstream, 'http://mock.local');
    } catch {
      return notFound(upstream);
    }
    const q = u.searchParams;
    const path = u.pathname.replace(/\/+$/, '');
    const origin = u.origin;
    const fail = q.get('fail');
    if (fail) return jsonResponse({ code: 'Mocked', description: `fail=${fail}` }, Number(fail));

    // Records search + lookup (GDC)
    let m = path.match(/\/collections\/wis2-discovery-metadata\/items(?:\/(.+))?$/);
    if (m) {
      const all = await loadAllRecords();
      if (m[1]) {
        const id = decodeURIComponent(m[1]);
        const rec = all.find((r) => r.id === id);
        return rec ? jsonResponse(rec) : notFound(upstream);
      }
      const text = (q.get('q') ?? '').trim().toLowerCase();
      const matched = text
        ? all.filter((r) =>
            JSON.stringify([r.properties?.title, r.properties?.description, r.properties?.keywords])
              .toLowerCase()
              .includes(text),
          )
        : all;
      const offset = Number(q.get('offset') ?? 0) || 0;
      const limit = Number(q.get('limit') ?? 10) || 10;
      const features = matched.slice(offset, offset + limit);
      return jsonResponse({
        type: 'FeatureCollection',
        numberMatched: matched.length,
        numberReturned: features.length,
        features,
        links: [],
      });
    }

    // Jobs
    m = path.match(/\/jobs\/([^/]+)(\/results)?$/);
    if (m) {
      if (m[2]) return jsonResponse(await loadJson('edr/position.json'));
      const n = (jobPolls.get(m[1]) ?? 0) + 1;
      jobPolls.set(m[1], n);
      const doc = await loadJson(n > runningPolls ? 'jobs/successful.json' : 'jobs/running.json');
      return jsonResponse(doc);
    }

    // Collection-level resources
    m = path.match(/\/collections\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const col = decodeURIComponent(m[1]);
      const rest = m[2] ?? '';
      if (rest === '') {
        const doc = await loadJson(`collections/${col}.json`);
        return doc ? jsonResponse(doc) : notFound(upstream);
      }
      if (rest === 'schema') {
        const doc = await loadJson(`schema/${col}.json`);
        return doc ? jsonResponse(doc) : notFound(upstream);
      }
      if (rest === 'instances') {
        const doc = await loadJson(`instances/${col}.json`);
        return doc ? jsonResponse(doc) : notFound(upstream);
      }
      const inst = rest.match(/^instances\/([^/]+)(?:\/(.*))?$/);
      if (inst && !inst[2]) {
        const doc = await loadJson<Record<string, unknown>>(`instances/${col}.instance.json`);
        return doc ? jsonResponse({ ...doc, id: decodeURIComponent(inst[1]) }) : notFound(upstream);
      }
      const queryType = (inst ? inst[2] : rest) ?? '';
      if (queryType === 'map' || q.get('f') === 'png') {
        const png = await loadPng('maps/map.png');
        return png ? new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) : notFound(upstream);
      }
      if (/^(position|area|trajectory|radius|cube|corridor|locations|items)$/.test(queryType)) {
        if (q.get('async') === 'true') {
          return jsonResponse({ status: 303, location: proxyUrl(`${origin}/jobs/job-1`) });
        }
        const doc = (await loadJson(`edr/${queryType}.json`)) ?? (await loadJson('edr/position.json'));
        return jsonResponse(doc);
      }
    }
    return notFound(upstream);
  }) as MockFetch;

  const mock = impl;
  mock.calls = [];
  mock.reset = () => {
    mock.calls.length = 0;
    jobPolls.clear();
  };
  return mock;
}

/** sessionStorage key remembering mock mode for the tab (the `?mock=1` param is lost on navigation). */
export const MOCK_STORAGE_KEY = 'metdx-mock';

/**
 * True when built with VITE_MOCK=1, or when the page was opened with `?mock=1`.
 * `?mock=1` is remembered in sessionStorage so it survives in-app navigation
 * and reloads; `?mock=0` turns it off again (and clears the memory).
 */
export function isMockMode(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  if (typeof window === 'undefined') return false;
  let param: string | null = null;
  try {
    param = new URLSearchParams(window.location.search).get('mock');
  } catch {
    /* ignore */
  }
  try {
    if (param === '1') {
      window.sessionStorage.setItem(MOCK_STORAGE_KEY, '1');
      return true;
    }
    if (param === '0') {
      window.sessionStorage.removeItem(MOCK_STORAGE_KEY);
      return false;
    }
    return window.sessionStorage.getItem(MOCK_STORAGE_KEY) === '1';
  } catch {
    // sessionStorage unavailable (privacy mode): fall back to the URL alone.
    return param === '1';
  }
}

/** Install the mock fetch into lib/http. Returns it for inspection. */
export function enableMockMode(opts?: MockOptions): MockFetch {
  const mock = createMockFetch(opts);
  setFetchImpl(mock);
  return mock;
}
