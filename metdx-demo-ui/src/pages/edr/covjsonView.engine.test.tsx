import { vi } from 'vitest';

// jsdom has no SVGSVGElement.createSVGRect, so Leaflet would pick its canvas renderer; define it before Leaflet loads.
vi.hoisted(() => {
  const proto = SVGSVGElement.prototype as unknown as { createSVGRect?: () => object };
  proto.createSVGRect ??= () => ({});
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EdrPage from './index';
import { MapProvider, MapView, RequestBar, RequestBarProvider, useMapEngine } from '../../shell';
import { ENGINE_STORAGE_KEY } from '../../shell/engine';
import { ResultPanel } from './ResultPanel';
import { MapController } from '../../shell/mapController';
import { setFetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import type { Geometry } from '../../lib/types';
import type { DataLayer, DataSelectHandler, ShowDataOptions } from '../../lib/covjsonTypes';
import livePosition from '../../../test/fixtures/edr/live-position.json';

// The Leaflet / engine-switch part of the covjsonView tests, in its own file so vitest runs it in parallel with the rest.

const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';

class StubMap extends MapController {
  drawGeometry(): Promise<Geometry> {
    return Promise.resolve({ type: 'Point', coordinates: [10, 50] });
  }
  showData(_layer: DataLayer, _opts: ShowDataOptions): void {}
  clearData(): void {}
  onDataSelect(cb: DataSelectHandler): () => void {
    return () => void cb;
  }
}

const fetchBtn = () => screen.getByRole('button', { name: /fetch/i });

describe('leaflet-coverage renderer option', () => {
  const POSITION = { id: 1, data: livePosition, text: JSON.stringify(livePosition), filename: 'position.json' };
  const fills = () => [...document.querySelectorAll('.leaflet-overlay-pane path')].map((p) => p.getAttribute('fill') ?? '');

  beforeEach(() => {
    vi.stubEnv('VITE_ENABLE_LEAFLET', '1'); // Leaflet is off unless enabled at build time
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); // jsdom has no 2D canvas; the built-in layer then draws nothing
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sessionStorage.removeItem(ENGINE_STORAGE_KEY);
  });

  it('is not offered by an engine without the capability', async () => {
    render(
      <MapProvider controller={new StubMap()}>
        <ResultPanel result={POSITION} mode="position" onViewJson={() => {}} />
      </MapProvider>,
    );
    await screen.findByTestId('legend');
    expect(screen.queryByTestId('edr-renderer-toggle')).toBeNull();
  });

  it('Leaflet: draws the result with leaflet-coverage in the app colour scale, and back to the built-in drawing', async () => {
    sessionStorage.setItem(ENGINE_STORAGE_KEY, 'leaflet');
    const user = userEvent.setup({ delay: null });
    render(
      <MapProvider>
        <MapView />
        <ResultPanel result={POSITION} mode="position" onViewJson={() => {}} />
      </MapProvider>,
    );
    const toggle = await screen.findByTestId('edr-renderer-toggle', undefined, { timeout: 10_000 });
    expect(fills().some((f) => f.startsWith('rgb('))).toBe(false);

    await user.click(within(toggle).getByRole('button', { name: 'leaflet-coverage' }));
    await waitFor(() => expect(fills().some((f) => f.startsWith('rgb('))).toBe(true), { timeout: 10_000 });
    expect(screen.queryByTestId('edr-coverage-error')).toBeNull();
    expect(screen.queryByTestId('edr-opacity')).toBeNull(); // the built-in opacity does not apply

    await user.click(within(toggle).getByRole('button', { name: 'Built-in' }));
    await waitFor(() => expect(fills().some((f) => f.startsWith('rgb('))).toBe(false));
    expect(screen.getByTestId('edr-opacity')).toBeInTheDocument();
  });
});

describe('switching the map engine drops the result', () => {
  function SwitchTo({ to }: { to: 'ol' | 'leaflet' }) {
    const engine = useMapEngine();
    return <button onClick={() => engine?.switchEngine(to)}>{`switch to ${to}`}</button>;
  }

  /** The EDR page on a runtime-switchable engine; a position result is fetched with a hand-edited request URL. */
  async function fetchOn(start: 'ol' | 'leaflet', to: 'ol' | 'leaflet') {
    sessionStorage.setItem(ENGINE_STORAGE_KEY, start);
    setFetchImpl(createMockFetch());
    const user = userEvent.setup({ delay: null });
    render(
      <MemoryRouter
        initialEntries={[`/record/abc/edr?col=${encodeURIComponent(COL)}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <MapProvider>
          <RequestBarProvider>
            <Routes>
              <Route path="/record/:id/edr" element={<EdrPage />} />
            </Routes>
            <MapView />
            <SwitchTo to={to} />
            <RequestBar />
          </RequestBarProvider>
        </MapProvider>
      </MemoryRouter>,
    );
    const mapEl = () => screen.getByTestId('map');
    await screen.findByRole('button', { name: 'position' });
    const url = screen.getByRole('textbox', { name: 'Request URL' });
    await user.clear(url);
    await user.click(url);
    await user.paste(`${COL}/position?coords=POINT(10 50)&parameter-name=2t`);
    await waitFor(() => expect(mapEl()).toHaveAttribute('data-engine', start));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    await waitFor(() => expect(mapEl()).toHaveAttribute('data-data'), { timeout: 10_000 });
    return { user, mapEl };
  }

  beforeEach(() => {
    vi.stubEnv('VITE_ENABLE_LEAFLET', '1'); // Leaflet is off unless enabled at build time
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sessionStorage.removeItem(ENGINE_STORAGE_KEY);
  });

  it.each([
    ['leaflet', 'ol'],
    ['ol', 'leaflet'],
  ] as const)('%s -> %s: the old result is neither shown nor redrawn on the new engine', async (from, to) => {
    const { user, mapEl } = await fetchOn(from, to);
    await user.click(screen.getByRole('button', { name: `switch to ${to}` }));
    await waitFor(() => expect(mapEl()).toHaveAttribute('data-engine', to), { timeout: 10_000 });
    await waitFor(() => expect(mapEl().querySelector(to === 'ol' ? '.ol-viewport' : '.leaflet-tile-pane')).not.toBeNull(), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100)); // let a (wrong) replay happen
    expect(screen.queryByTestId('edr-result')).toBeNull();
    expect(mapEl()).not.toHaveAttribute('data-data');
  }, 30_000);

  it('leaflet-coverage -> ol: the coverage layer goes and is not redrawn', async () => {
    const { user, mapEl } = await fetchOn('leaflet', 'ol');
    await user.click(within(screen.getByTestId('edr-renderer-toggle')).getByRole('button', { name: 'leaflet-coverage' }));
    await waitFor(() => expect(mapEl().querySelectorAll('.leaflet-overlay-pane path[fill^="rgb("]').length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    await user.click(screen.getByRole('button', { name: 'switch to ol' }));
    await waitFor(() => expect(mapEl()).toHaveAttribute('data-engine', 'ol'), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId('edr-result')).toBeNull();
    expect(mapEl()).not.toHaveAttribute('data-data');
  }, 30_000);
});
