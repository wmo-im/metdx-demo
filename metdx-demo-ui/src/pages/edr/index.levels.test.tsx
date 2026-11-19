import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import metOffice from '../../../test/fixtures/edr/metoffice-pressure-position.json';
import livePosition from '../../../test/fixtures/edr/live-position.json';
import { COMMON_LEVELS } from '../../lib/edr';
import { COL, fetchBtn, map, ready, renderPage, StubMap, urlBox } from '../../../test/edrPageHarness';
import EdrPage from './index';
import { MapProvider, RequestBar, RequestBarProvider, ResultDialog } from '../../shell';

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

const MO = 'https://other.example/collections/mo';
const MO2 = 'https://other.example/collections/mo2';
const INSTANCE = '2026-11-18T120000';

/** The EDR data queries (position) that reached the server. */
let queries: string[] = [];
beforeEach(() => {
  queries = [];
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A Met-Office-like collection (non-ECMWF parameter `air_temperature`); `vertical` is its `extent.vertical`, if any. */
function metOfficeLike(
  opts: { vertical?: unknown; instanceVertical?: unknown; respond?: (url: string) => unknown } = {},
): FetchImpl {
  const real = createMockFetch();
  const extent = (vertical: unknown) => ({
    spatial: { bbox: [[-10, 45, 5, 60]] },
    temporal: { interval: [['2026-11-18T12:00:00Z', '2026-11-19T12:00:00Z']] },
    ...(vertical ? { vertical } : {}),
  });
  return async (input, init) => {
    const u = unproxyUrl(input);
    if (!u.startsWith('https://other.example/')) return real(input, init);
    if (/\/position\?/.test(u)) {
      queries.push(u);
      return json(opts.respond ? opts.respond(u) : metOffice);
    }
    if (u.startsWith(`${MO}/instances/${INSTANCE}?`)) return json({ id: INSTANCE, extent: extent(opts.instanceVertical) });
    if (u.startsWith(`${MO}/instances?`)) return json({ instances: [{ id: INSTANCE }] });
    for (const [base, id] of [[MO, 'mo'], [MO2, 'mo2']]) {
      if (!u.startsWith(`${base}?`)) continue;
      return json({
        id,
        title: 'Met Office',
        data_queries: { position: {} },
        extent: extent(opts.vertical),
        parameter_names: { air_temperature: { observedProperty: { label: { en: 'Air temperature' } }, unit: { symbol: 'K' } } },
      });
    }
    return json({}, 404);
  };
}

/** The Met Office response cut down to the one pressure level at index `i` (what a `z=` query returns). */
function oneLevel(i: number) {
  const d = structuredClone(metOffice) as typeof metOffice;
  const levels = d.domain.axes.pressure.values;
  d.domain.axes.pressure.values = [levels[i]];
  const r = d.ranges.air_temperature;
  r.shape = [13, 1, 1, 1];
  r.values = Array.from({ length: 13 }, (_, t) => r.values[t * levels.length + i]);
  return d;
}

describe('EDR page: vertical level chooser', () => {
  it('no chooser for a non-ECMWF parameter while no levels are known; the first multi-level response teaches it', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, metOfficeLike());
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
    expect(urlBox().value).not.toContain('&z=');

    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    // the 37-level point series was drawn (one level at a time) without error
    expect(screen.queryByText(/Cannot draw this response/)).not.toBeInTheDocument();
    expect(map.drawn.length).toBeGreaterThan(0);
    expect(map.drawn.at(-1)!.times).toHaveLength(13);

    // the levels of the response are now offered, in the server's notation; none is chosen yet
    expect(await screen.findByText('Vertical level')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Vertical level (pressure)'));
    expect(await screen.findAllByRole('option')).toHaveLength(1 + 37); // "All levels" + 37
    await user.click(screen.getByRole('option', { name: '85000' }));
    await waitFor(() => expect(urlBox().value).toContain('&parameter-name=air_temperature&z=85000&datetime='));

    // chosen again: the next fetch carries it
    await user.click(fetchBtn());
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]).toContain('&z=85000&');
  });

  it('extent.vertical values of the collection are offered at once; "All levels" sends no z', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, metOfficeLike({ vertical: { interval: [[100000, 40]], values: [100000, 85000, 50000], vrs: 'Pa' } }));
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(await screen.findByLabelText('Vertical level (Pa)'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All levels', '100000', '85000', '50000']);
    await user.click(screen.getByRole('option', { name: '50000' }));
    await waitFor(() => expect(urlBox().value).toContain('&z=50000&'));
    await user.click(screen.getByLabelText('Vertical level (Pa)'));
    await user.click(screen.getByRole('option', { name: 'All levels' }));
    await waitFor(() => expect(urlBox().value).not.toContain('&z='));
  });

  it('the selected instance\u2019s extent.vertical wins over the collection\u2019s', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(
      MO,
      metOfficeLike({ vertical: { values: [1, 2] }, instanceVertical: { values: [850, 700], vrs: 'hPa' } }),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
    await user.click(await screen.findByLabelText('Vertical level (hPa)'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All levels', '850', '700']);
  });

  it('a first response with a single level does not teach the chooser', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, metOfficeLike({ respond: () => oneLevel(5) }));
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Vertical level (pressure)')).not.toBeInTheDocument();
  });

  /** The ECMWF collection of the page tests, answering every position query with `respond(url)`. */
  function ecmwfAnswering(respond: (url: string) => unknown): FetchImpl {
    const real = createMockFetch();
    return async (input, init) => {
      const u = unproxyUrl(input);
      if (/\/position\?/.test(u)) {
        queries.push(u);
        return json(respond(u));
      }
      return real(input, init);
    };
  }

  it('ECMWF: a surface (2t) response teaching levelist 0 leaves the fallback levels and the required-level warning', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, ecmwfAnswering(() => livePosition));
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    expect(queries).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    expect(screen.getByText(/require a pressure level/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', ...COMMON_LEVELS.map((l) => `${l} hPa`)]);
  });

  it('ECMWF: a first query sent with z=850 does not collapse the fallback levels', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, ecmwfAnswering(() => oneLevel(5)));
    await ready();
    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    await user.click(await screen.findByRole('option', { name: '850 hPa' }));
    await waitFor(() => expect(urlBox().value).toContain('&z=850&'));
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('&z=850&');

    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', ...COMMON_LEVELS.map((l) => `${l} hPa`)]);
  });

  it('a multi-level response to a query that sent z= does not teach the chooser either', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, ecmwfAnswering(() => metOffice));
    await ready();
    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    await user.click(await screen.findByRole('option', { name: '850 hPa' }));
    await waitFor(() => expect(urlBox().value).toContain('&z=850&'));
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    expect(queries).toHaveLength(1);

    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', ...COMMON_LEVELS.map((l) => `${l} hPa`)]);
  });

  it('a later single-level (z-filtered) response does not replace a learned multi-level list', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, metOfficeLike({ respond: (u) => (u.includes('&z=') ? oneLevel(5) : metOffice) }));
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await user.click(await screen.findByLabelText('Vertical level (pressure)'));
    await user.click(screen.getByRole('option', { name: '85000' }));
    await waitFor(() => expect(urlBox().value).toContain('&z=85000&'));

    await user.click(fetchBtn());
    await waitFor(() => expect(queries).toHaveLength(2));
    await waitFor(() => expect(map.drawn).toHaveLength(2));
    // the chooser still offers all 37 levels and keeps the selection
    await user.click(screen.getByLabelText('Vertical level (pressure)'));
    expect(await screen.findAllByRole('option')).toHaveLength(1 + 37);
    expect(urlBox().value).toContain('&z=85000&');
  });

  it('changing collection drops the learned levels and the selected level', async () => {
    const user = userEvent.setup({ delay: null });
    setFetchImpl(metOfficeLike());
    function Nav() {
      const navigate = useNavigate();
      const q = (c: string) => `/record/abc/edr?col=${encodeURIComponent(c)}`;
      return (
        <>
          <button onClick={() => navigate(q(MO2))}>to mo2</button>
          <button onClick={() => navigate(q(MO))}>to mo</button>
        </>
      );
    }
    render(
      <MemoryRouter
        initialEntries={[`/record/abc/edr?col=${encodeURIComponent(MO)}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <MapProvider controller={new StubMap()}>
          <RequestBarProvider>
            <Routes>
              <Route path="/record/:id/edr" element={<EdrPage />} />
            </Routes>
            <Nav />
            <RequestBar />
            <ResultDialog />
          </RequestBarProvider>
        </MapProvider>
      </MemoryRouter>,
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await user.click(await screen.findByLabelText('Vertical level (pressure)'));
    await user.click(screen.getByRole('option', { name: '85000' }));
    await waitFor(() => expect(urlBox().value).toContain('&z=85000&'));

    await user.click(screen.getByRole('button', { name: 'to mo2' }));
    await waitFor(() => expect(screen.getByLabelText('Request URL')).toBeInTheDocument());
    await ready();
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^air_temperature/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(urlBox().value).toContain('/collections/mo2/position?'));
    expect(urlBox().value).not.toContain('&z=');
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'to mo' }));
    await ready();
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
  });
});
