import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_URL,
  getRecordsSource,
  loadConfig,
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
  it('defaults to local', () => {
    expect(resolveConfig(undefined)).toEqual({ recordsSource: 'local', proxy: true });
    expect(getRecordsSource()).toBe('local');
  });
  it('parses values case-insensitively and rejects others', () => {
    expect(parseRecordsSource('GDC')).toBe('gdc');
    expect(parseRecordsSource(' local ')).toBe('local');
    expect(parseRecordsSource('nope')).toBeUndefined();
    expect(parseRecordsSource(1)).toBeUndefined();
  });
  it('config file overrides the default, ?records= overrides the file', () => {
    expect(resolveConfig({ recordsSource: 'gdc' }).recordsSource).toBe('gdc');
    expect(resolveConfig({ recordsSource: 'gdc' }, '?records=local').recordsSource).toBe('local');
    expect(resolveConfig({ recordsSource: 'local' }, '?mock=1&records=gdc').recordsSource).toBe('gdc');
    expect(resolveConfig({ recordsSource: 'gdc' }, '?records=bogus').recordsSource).toBe('gdc');
    expect(resolveConfig('garbage', '').recordsSource).toBe('local');
  });
  it('loadConfig reads /config.json and applies the URL override', async () => {
    const cfg = await loadConfig(json({ recordsSource: 'gdc' }), '');
    expect(cfg.recordsSource).toBe('gdc');
    expect(getRecordsSource()).toBe('gdc');
    await loadConfig(json({ recordsSource: 'gdc' }), '?records=local');
    expect(getRecordsSource()).toBe('local');
  });
  it('loadConfig falls back to the default when the file is missing, invalid or unreachable', async () => {
    setRecordsSource('gdc');
    await loadConfig(json({}, 404), '');
    expect(getRecordsSource()).toBe('local');
    setRecordsSource('gdc');
    await loadConfig(async () => new Response('<html>', { status: 200 }), '');
    expect(getRecordsSource()).toBe('local');
    setRecordsSource('gdc');
    await loadConfig(async () => {
      throw new Error('offline');
    }, '');
    expect(getRecordsSource()).toBe('local');
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
