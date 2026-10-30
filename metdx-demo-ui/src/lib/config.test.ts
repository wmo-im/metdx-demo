import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_URL,
  DEFAULT_CATALOGUE_URL,
  catalogueHost,
  catalogueItemsUrl,
  getDefaultQuery,
  getRecordsSource,
  loadConfig,
  parseCatalogueUrl,
  parseDefaultQuery,
  parseProxy,
  parseRecordsSource,
  resetConfig,
  resolveConfig,
  setRecordsSource,
  useProxy,
} from './config';

afterEach(() => resetConfig());

const json = (data: unknown, status = 200) => async () =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('records source selection', () => {
  it('defaults to the live catalogue', () => {
    expect(resolveConfig(undefined)).toEqual({
      recordsSource: 'catalogue',
      catalogueUrl: DEFAULT_CATALOGUE_URL,
      defaultQuery: 'metdx-demo',
      proxy: true,
    });
    expect(getRecordsSource()).toBe('catalogue');
  });
  it('parses values case-insensitively, accepts "gdc" as an alias and rejects others', () => {
    expect(parseRecordsSource('Catalogue')).toBe('catalogue');
    expect(parseRecordsSource('GDC')).toBe('catalogue');
    expect(parseRecordsSource(' local ')).toBe('local');
    expect(parseRecordsSource('nope')).toBeUndefined();
    expect(parseRecordsSource(1)).toBeUndefined();
  });
  it('config file overrides the default, ?records= overrides the file', () => {
    expect(resolveConfig({ recordsSource: 'local' }).recordsSource).toBe('local');
    expect(resolveConfig({ recordsSource: 'gdc' }).recordsSource).toBe('catalogue');
    expect(resolveConfig({ recordsSource: 'catalogue' }, '?records=local').recordsSource).toBe('local');
    expect(resolveConfig({ recordsSource: 'local' }, '?mock=1&records=gdc').recordsSource).toBe('catalogue');
    expect(resolveConfig({ recordsSource: 'local' }, '?records=bogus').recordsSource).toBe('local');
    expect(resolveConfig('garbage', '').recordsSource).toBe('catalogue');
  });
  it('loadConfig reads /config.json and applies the URL override', async () => {
    const cfg = await loadConfig(json({ recordsSource: 'local' }), '');
    expect(cfg.recordsSource).toBe('local');
    expect(getRecordsSource()).toBe('local');
    await loadConfig(json({ recordsSource: 'local' }), '?records=catalogue');
    expect(getRecordsSource()).toBe('catalogue');
  });
  it('loadConfig falls back to the default when the file is missing, invalid or unreachable', async () => {
    setRecordsSource('local');
    await loadConfig(json({}, 404), '');
    expect(getRecordsSource()).toBe('catalogue');
    setRecordsSource('local');
    await loadConfig(async () => new Response('<html>', { status: 200 }), '');
    expect(getRecordsSource()).toBe('catalogue');
    setRecordsSource('local');
    await loadConfig(async () => {
      throw new Error('offline');
    }, '');
    expect(getRecordsSource()).toBe('catalogue');
  });
});

describe('catalogue URL and default query', () => {
  it('default to the WMO resource catalogue and "metdx-demo"', () => {
    expect(catalogueItemsUrl()).toBe(`${DEFAULT_CATALOGUE_URL}/items`);
    expect(catalogueHost()).toBe('wmo-resource-catalogue.labs.wis2dev.io');
    expect(getDefaultQuery()).toBe('metdx-demo');
  });
  it('can be set in the config file; trailing slashes are dropped, invalid URLs ignored', () => {
    expect(resolveConfig({ catalogueUrl: 'https://example.org/collections/x/' }).catalogueUrl).toBe('https://example.org/collections/x');
    expect(resolveConfig({ catalogueUrl: 'ftp://example.org/x' }).catalogueUrl).toBe(DEFAULT_CATALOGUE_URL);
    expect(resolveConfig({ catalogueUrl: 'not a url' }).catalogueUrl).toBe(DEFAULT_CATALOGUE_URL);
    expect(resolveConfig({ catalogueUrl: 7 }).catalogueUrl).toBe(DEFAULT_CATALOGUE_URL);
    expect(parseCatalogueUrl(undefined)).toBeUndefined();
  });
  it('defaultQuery may be empty (no default); non-strings are ignored', () => {
    expect(resolveConfig({ defaultQuery: '' }).defaultQuery).toBe('');
    expect(resolveConfig({ defaultQuery: ' wind ' }).defaultQuery).toBe('wind');
    expect(resolveConfig({ defaultQuery: 3 }).defaultQuery).toBe('metdx-demo');
    expect(parseDefaultQuery(null)).toBeUndefined();
  });
  it('loadConfig applies them', async () => {
    await loadConfig(json({ catalogueUrl: 'https://example.org/collections/x', defaultQuery: '' }), '');
    expect(catalogueItemsUrl()).toBe('https://example.org/collections/x/items');
    expect(catalogueHost()).toBe('example.org');
    expect(getDefaultQuery()).toBe('');
  });
});

describe('proxy setting', () => {
  it('defaults to true; the config file can turn it off; invalid values are ignored', () => {
    expect(resolveConfig(undefined).proxy).toBe(true);
    expect(resolveConfig({ proxy: false }).proxy).toBe(false);
    expect(resolveConfig({ proxy: 'false' }).proxy).toBe(false);
    expect(resolveConfig({ proxy: 'maybe' }).proxy).toBe(true);
    expect(parseProxy(1)).toBeUndefined();
  });
  it('loadConfig applies it', async () => {
    expect(useProxy()).toBe(true);
    await loadConfig(json({ proxy: false }), '');
    expect(useProxy()).toBe(false);
    resetConfig();
    expect(useProxy()).toBe(true);
  });
  it('config.json is requested under the Vite base path', () => {
    expect(CONFIG_URL).toBe(`${import.meta.env.BASE_URL}config.json`);
  });
});
