import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfig } from '../lib/config';
import { ENGINE_STORAGE_KEY, leafletEnabled, loadEngine, resolveEngineName } from './engine';

// VITE_ENABLE_LEAFLET is a build-time constant (statically replaced by Vite); in tests it is read live, so it can be stubbed.
afterEach(() => {
  vi.unstubAllEnvs();
  sessionStorage.clear();
  resetConfig();
});

const configWithLeaflet = () => loadConfig(async () => new Response(JSON.stringify({ mapEngine: 'leaflet' })), '?map=leaflet');

describe('VITE_ENABLE_LEAFLET', () => {
  describe('off (default)', () => {
    it('is always OpenLayers, whatever ?map=, sessionStorage or the config say', async () => {
      vi.stubEnv('VITE_ENABLE_LEAFLET', '');
      expect(leafletEnabled()).toBe(false);
      await configWithLeaflet();
      sessionStorage.setItem(ENGINE_STORAGE_KEY, 'leaflet');
      expect(resolveEngineName('?map=leaflet')).toBe('ol');
      expect(resolveEngineName('')).toBe('ol');
    });

    it('does not load Leaflet', async () => {
      vi.stubEnv('VITE_ENABLE_LEAFLET', '');
      await expect(loadEngine('leaflet')).rejects.toThrow(/disabled/);
    });

    it('is off when the variable is not exactly "1"', () => {
      vi.stubEnv('VITE_ENABLE_LEAFLET', 'true');
      expect(leafletEnabled()).toBe(false);
    });
  });

  describe('on', () => {
    it('?map= beats sessionStorage, which beats the config', async () => {
      vi.stubEnv('VITE_ENABLE_LEAFLET', '1');
      expect(leafletEnabled()).toBe(true);
      expect(resolveEngineName('')).toBe('ol');
      await loadConfig(async () => new Response(JSON.stringify({ mapEngine: 'leaflet' })), '');
      expect(resolveEngineName('')).toBe('leaflet');
      sessionStorage.setItem(ENGINE_STORAGE_KEY, 'ol');
      expect(resolveEngineName('')).toBe('ol');
      expect(resolveEngineName('?map=leaflet')).toBe('leaflet');
      expect(resolveEngineName('?map=bogus')).toBe('ol');
    });

    it('loads the Leaflet engine', async () => {
      vi.stubEnv('VITE_ENABLE_LEAFLET', '1');
      const e = await loadEngine('leaflet');
      expect(e.capabilities.coverageRenderer).toBe(true);
    });
  });
});
