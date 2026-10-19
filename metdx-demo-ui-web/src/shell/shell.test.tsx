import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { setFetchImpl } from '../lib/http';
import { resetConfig, setRecordsSource } from '../lib/config';
import { createMockFetch } from '../lib/mockFetch';
import { MapController } from './mapController';
import { MapProvider, useMap } from './MapContext';
import { RequestBar, RequestBarProvider, useRegisterFetch, useRequestBar } from './RequestBar';
import { cacheRecord, clearRecordCache, getCachedRecord, loadRecord, useRecord } from './recordCache';
import { paths } from './routes';

afterEach(() => {
  setFetchImpl(null);
  clearRecordCache();
});

describe('routes', () => {
  it('builds encoded paths', () => {
    expect(paths.catalogue()).toBe('/');
    expect(paths.record('urn:wmo:md:x/y')).toBe('/record/urn%3Awmo%3Amd%3Ax%2Fy');
    expect(paths.edr('a', 'https://h/collections/c?f=json')).toBe(
      '/record/a/edr?col=https%3A%2F%2Fh%2Fcollections%2Fc%3Ff%3Djson',
    );
    expect(paths.maps('a')).toBe('/record/a/maps');
  });
});

describe('app shell', () => {
  const COL_EDR = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data?f=json';
  const COL_MAPS = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server?f=json';
  const REC = 'urn:wmo:md:int-ecmwf:weather.prediction.forecast.global';

  beforeEach(() => setFetchImpl(createMockFetch()));

  const at = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );

  // Each page loads its data asynchronously: wait for the last thing it loads, so no state update
  // happens outside act() after the assertions.
  const settled: [string, string, () => Promise<unknown>][] = [
    ['/', 'page-catalogue', async () => {
      await screen.findByTestId('results-header');
      // service badges are probed per card
      await waitFor(() => expect(screen.getAllByTestId('badge-edr').length).toBeGreaterThan(0));
    }],
    [`/record/${encodeURIComponent(REC)}`, 'page-record', async () => {
      await screen.findByRole('link', { name: 'EDR' });
      await screen.findByRole('link', { name: 'OGC Maps' });
    }],
    [`/record/${encodeURIComponent(REC)}/edr?col=${encodeURIComponent(COL_EDR)}`, 'page-edr', async () => {
      await screen.findByRole('heading', { name: 'Operational data' });
      await screen.findByLabelText('Use specific instance'); // instances loaded last
    }],
    [`/record/${encodeURIComponent(REC)}/maps?col=${encodeURIComponent(COL_MAPS)}`, 'page-maps', async () => {
      await waitFor(() => expect(screen.queryByText('Loading schema...')).not.toBeInTheDocument());
      await screen.findByLabelText('Parameter');
    }],
  ];

  it.each(settled)('renders %s with map and request bar', async (path, testId, settle) => {
    at(path);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(screen.getByLabelText('Request URL')).toBeInTheDocument();
    await settle();
    expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
  });

  it('unknown routes go to the catalogue', async () => {
    at('/nope/nothing');
    expect(screen.getByTestId('page-catalogue')).toBeInTheDocument();
    await screen.findByTestId('results-header');
    await waitFor(() => expect(screen.getAllByTestId('badge-edr').length).toBeGreaterThan(0));
  });
});

describe('RequestBar contract', () => {
  it('setUrl shows in the bar and Fetch calls the registered handler with the (edited) URL', async () => {
    const handler = vi.fn();
    function Page() {
      const bar = useRequestBar();
      useRegisterFetch(handler);
      return <button onClick={() => bar.setUrl('https://x/y')}>seturl</button>;
    }
    render(
      <RequestBarProvider>
        <Page />
        <RequestBar />
      </RequestBarProvider>,
    );
    const fetchBtn = screen.getByRole('button', { name: /fetch/i });
    expect(fetchBtn).toBeDisabled();
    await userEvent.click(screen.getByText('seturl'));
    expect(screen.getByLabelText('Request URL')).toHaveValue('https://x/y');
    expect(fetchBtn).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Request URL'), '&f=json');
    await userEvent.click(fetchBtn);
    expect(handler).toHaveBeenCalledWith('https://x/y&f=json');
  });

  it('a throwing handler becomes an error result', async () => {
    function Page() {
      const bar = useRequestBar();
      useRegisterFetch(() => {
        throw new Error('boom');
      });
      return (
        <>
          <button onClick={() => bar.setUrl('u')}>seturl</button>
          <output data-testid="res">{bar.result ? JSON.stringify(bar.result) : ''}</output>
        </>
      );
    }
    render(
      <RequestBarProvider>
        <Page />
        <RequestBar />
      </RequestBarProvider>,
    );
    await userEvent.click(screen.getByText('seturl'));
    await userEvent.click(screen.getByRole('button', { name: /fetch/i }));
    await waitFor(() => expect(screen.getByTestId('res')).toHaveTextContent('"kind":"error"'));
    expect(screen.getByTestId('res')).toHaveTextContent('boom');
  });

  it('while busy shows elapsed seconds and a Cancel button that calls the registered cancel', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const cancel = vi.fn();
      function Page() {
        const bar = useRequestBar();
        useRegisterFetch(() => {
          bar.setBusy(true);
          bar.setCancel(cancel);
        });
        return <button onClick={() => bar.setUrl('u')}>seturl</button>;
      }
      render(
        <RequestBarProvider>
          <Page />
          <RequestBar />
        </RequestBarProvider>,
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
      await user.click(screen.getByText('seturl'));
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      expect(screen.getByTestId('request-elapsed')).toHaveTextContent('0 s');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByTestId('request-elapsed')).toHaveTextContent('5 s');
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregistering the handler disables Fetch', async () => {
    function Registered() {
      useRegisterFetch(() => {});
      return null;
    }
    function SetUrl() {
      const bar = useRequestBar();
      return <button onClick={() => bar.setUrl('u')}>seturl</button>;
    }
    const ui = (on: boolean) => (
      <RequestBarProvider>
        <SetUrl />
        {on && <Registered />}
        <RequestBar />
      </RequestBarProvider>
    );
    const { rerender } = render(ui(true));
    await userEvent.click(screen.getByText('seturl'));
    expect(screen.getByRole('button', { name: /fetch/i })).toBeEnabled();
    rerender(ui(false));
    expect(screen.getByRole('button', { name: /fetch/i })).toBeDisabled();
  });

  it('throws outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useRequestBar())).toThrow(/RequestBarProvider/);
    spy.mockRestore();
  });
});

describe('Map contract', () => {
  it('exposes drawGeometry/setOverlay/clear and rejects drawing before the map exists', async () => {
    const ctrl = new MapController();
    const { result } = renderHook(() => useMap(), {
      wrapper: ({ children }) => <MapProvider controller={ctrl}>{children}</MapProvider>,
    });
    expect(typeof result.current.drawGeometry).toBe('function');
    expect(typeof result.current.setOverlay).toBe('function');
    expect(typeof result.current.clear).toBe('function');
    await expect(result.current.drawGeometry('point')).rejects.toThrow(/not ready/);
    expect(() => {
      result.current.setOverlay('blob:x', [0, 0, 10, 10]);
      result.current.showExtent([-180, -90, 180, 90]);
      result.current.showGeometry({ type: 'Point', coordinates: [1, 2] });
      result.current.setOverlay(null);
      result.current.clear();
    }).not.toThrow();
  });

  it('draw can be cancelled by clear()', async () => {
    const ctrl = new MapController();
    const div = document.createElement('div');
    document.body.appendChild(div);
    ctrl.attach(div);
    const p = ctrl.drawGeometry('bbox');
    const assertion = expect(p).rejects.toMatchObject({ name: 'DrawCancelledError' });
    ctrl.clear();
    await assertion;
    ctrl.detach();
    div.remove();
  });
});

describe('record cache', () => {
  beforeEach(() => setRecordsSource('gdc'));
  afterEach(() => resetConfig());

  it('with the local source, loads by id from the bundled records without fetching', async () => {
    setRecordsSource('local');
    const mock = createMockFetch();
    setFetchImpl(mock);
    const rec = await loadRecord('urn:wmo:md:int-ecmwf:opendata');
    expect(rec.id).toBe('urn:wmo:md:int-ecmwf:opendata');
    expect(getCachedRecord(rec.id)).toBe(rec);
    await expect(loadRecord('missing')).rejects.toThrow(/not found in the local records/);
    expect(mock.calls).toHaveLength(0);
  });
  it('caches by id and loads from the (mock) GDC once', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    const id = 'urn:wmo:md:int-ecmwf:opendata';
    const [a, b] = await Promise.all([loadRecord(id), loadRecord(id)]);
    expect(a.id).toBe(id);
    expect(b).toBe(a);
    expect(mock.calls).toHaveLength(1);
    expect(getCachedRecord(id)).toBe(a);
    await loadRecord(id);
    expect(mock.calls).toHaveLength(1);
  });
  it('cacheRecord seeds the cache (e.g. from search results)', async () => {
    cacheRecord({ id: 'r1', properties: { title: 'T' }, links: [] });
    await expect(loadRecord('r1')).resolves.toMatchObject({ properties: { title: 'T' } });
  });
  it('useRecord reports loading, record and error', async () => {
    setFetchImpl(createMockFetch());
    const ok = renderHook(() => useRecord('urn:wmo:md:int-ecmwf:opendata'));
    expect(ok.result.current.loading).toBe(true);
    await waitFor(() => expect(ok.result.current.record?.id).toBe('urn:wmo:md:int-ecmwf:opendata'));
    const bad = renderHook(() => useRecord('missing'));
    await waitFor(() => expect(bad.result.current.error).toMatch(/404/));
  });
});
