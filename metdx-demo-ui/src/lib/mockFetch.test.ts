import { afterEach, describe, expect, it } from 'vitest';
import { fetchBlob, fetchJson, fetchWithJob, setFetchImpl } from './http';
import { createMockFetch, isMockMode, MOCK_STORAGE_KEY } from './mockFetch';

const H = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu';
const GDC = 'https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items';

afterEach(() => setFetchImpl(null));

describe('mock fetch', () => {
  it('serves record search with paging and q', async () => {
    setFetchImpl(createMockFetch());
    const all = await fetchJson<any>(`${GDC}?limit=1&offset=0`);
    expect(all.numberMatched).toBe(3);
    expect(all.features).toHaveLength(1);
    const q = await fetchJson<any>(`${GDC}?limit=10&offset=0&q=destination`);
    expect(q.features.map((f: any) => f.id)).toEqual(['urn:wmo:md:int-ecmwf:weather.prediction.forecast.global']);
  });
  it('serves a record by id', async () => {
    setFetchImpl(createMockFetch());
    const id = 'urn:wmo:md:int-ecmwf:opendata';
    const rec = await fetchJson<any>(`${GDC}/${encodeURIComponent(id)}?f=json`);
    expect(rec.id).toBe(id);
  });
  it('serves collection, instances, schema', async () => {
    setFetchImpl(createMockFetch());
    const col = await fetchJson<any>(`${H}/collections/operational-data?f=json`);
    expect(Object.keys(col.data_queries)).toContain('position');
    const inst = await fetchJson<any>(`${H}/collections/operational-data/instances?f=json`);
    expect(inst.instances.length).toBeGreaterThan(0);
    const one = await fetchJson<any>(`${H}/collections/operational-data/instances/abc?f=json`);
    expect(one.id).toBe('abc');
    const schema = await fetchJson<any>(`${H}/collections/operational_map_server/schema?f=json`);
    expect(schema.properties.instance_id.enum.length).toBeGreaterThan(0);
  });
  it('serves EDR CoverageJSON and a PNG', async () => {
    setFetchImpl(createMockFetch());
    const cov = await fetchJson<any>(`${H}/collections/operational-data/position?coords=POINT(10 50)&f=json`);
    expect(cov.type).toBe('Coverage');
    const png = await fetchBlob(`${H}/collections/operational_map_server/map?f=png&bbox=0,0,1,1`);
    expect(png.type).toBe('image/png');
    const head = new Uint8Array(await png.arrayBuffer()).slice(1, 4);
    expect(String.fromCharCode(...head)).toBe('PNG');
  });
  it('runs the async job flow (303 -> running -> successful -> results)', async () => {
    const mock = createMockFetch({ runningPolls: 1 });
    setFetchImpl(mock);
    const data: any = await fetchWithJob(`${H}/collections/operational-data/position?coords=POINT(10 50)&async=true`, {
      pollIntervalMs: 1,
    });
    expect(data.type).toBe('Coverage');
    expect(mock.calls.filter((c) => c.endsWith('/jobs/job-1'))).toHaveLength(2);
  });
  it('404s for unknown things and honours fail=', async () => {
    setFetchImpl(createMockFetch());
    await expect(fetchJson(`${H}/collections/nope?f=json`)).rejects.toMatchObject({ status: 404 });
    await expect(fetchJson(`${H}/collections/operational-data?fail=500`)).rejects.toMatchObject({ status: 500 });
  });
});

describe('isMockMode persistence', () => {
  const setUrl = (search: string) => window.history.replaceState({}, '', `/${search}`);
  afterEach(() => {
    window.sessionStorage.clear();
    setUrl('');
  });

  it('is off by default', () => {
    setUrl('');
    expect(isMockMode()).toBe(false);
  });
  it('?mock=1 turns it on and survives the param disappearing', () => {
    setUrl('?mock=1');
    expect(isMockMode()).toBe(true);
    expect(window.sessionStorage.getItem(MOCK_STORAGE_KEY)).toBe('1');
    setUrl('');
    expect(isMockMode()).toBe(true);
    setUrl('?q=weather');
    expect(isMockMode()).toBe(true);
  });
  it('?mock=0 turns it off and clears the memory', () => {
    setUrl('?mock=1');
    expect(isMockMode()).toBe(true);
    setUrl('?mock=0');
    expect(isMockMode()).toBe(false);
    expect(window.sessionStorage.getItem(MOCK_STORAGE_KEY)).toBeNull();
    setUrl('');
    expect(isMockMode()).toBe(false);
  });
});
