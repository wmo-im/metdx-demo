import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import EdrPage from './index';
import { MapProvider, RequestBar, RequestBarProvider, ResultDialog } from '../../shell';
import { MapController } from '../../shell/mapController';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { EDR_JOB } from '../../lib/edr';
import { createMockFetch, type MockFetch } from '../../lib/mockFetch';
import type { DrawKind, Geometry } from '../../lib/types';
import position from '../../../test/fixtures/edr/position.json';

const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';
/** Default datetime: a single time, the first step of the collection extent. */
const DT = '2026-10-19T00:00:00Z';
const DT_RANGE = '2026-10-19T00:00:00Z/2026-10-29T00:00:00Z';

class StubMap extends MapController {
  next: Geometry = { type: 'Point', coordinates: [10, 50] };
  kinds: DrawKind[] = [];
  shown: (Geometry | null)[] = [];
  drawGeometry(kind: DrawKind): Promise<Geometry> {
    this.kinds.push(kind);
    return Promise.resolve(this.next);
  }
  showGeometry(g: Geometry | null): void {
    this.shown.push(g);
    super.showGeometry(g);
  }
}

let mock: MockFetch;
let map: StubMap;

function LeaveButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/elsewhere')}>leave page</button>;
}

function renderPage(col: string | null = COL, fetchImpl?: FetchImpl) {
  mock = createMockFetch();
  setFetchImpl(fetchImpl ?? mock);
  map = new StubMap();
  const search = col ? `?col=${encodeURIComponent(col)}` : '';
  return render(
    <MemoryRouter
      initialEntries={[`/record/abc/edr${search}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <MapProvider controller={map}>
        <RequestBarProvider>
          <Routes>
            <Route path="/record/:id/edr" element={<EdrPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
          <LeaveButton />
          <RequestBar />
          <ResultDialog />
        </RequestBarProvider>
      </MapProvider>
    </MemoryRouter>,
  );
}

const urlBox = () => screen.getByLabelText('Request URL') as HTMLInputElement;
const fetchBtn = () => screen.getByRole('button', { name: /fetch/i });
const ready = () => screen.findByRole('button', { name: 'position' });
const queryCalls = () => mock.calls.filter((c) => /\/(position|area|trajectory|radius|cube|corridor)\?/.test(c));

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

describe('EDR page', () => {
  it('asks for a collection when none is given', () => {
    renderPage(null);
    expect(screen.getByText(/No collection selected/)).toBeInTheDocument();
  });

  it('lists every advertised mode, and mentions unknown query types', async () => {
    renderPage();
    await ready();
    for (const m of ['position', 'area', 'trajectory', 'radius', 'cube', 'corridor']) {
      expect(screen.getByRole('button', { name: m })).toBeInTheDocument();
    }
  });

  it('hides modes the collection does not advertise', async () => {
    const real = createMockFetch();
    const only: FetchImpl = async (input, init) => {
      const u = unproxyUrl(input);
      if (u.startsWith('https://other.example/collections/c?')) {
        return new Response(
          JSON.stringify({ id: 'c', title: 'Only area', data_queries: { area: {}, items: {} }, parameter_names: { a: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.startsWith('https://other.example/')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      return real(input, init);
    };
    renderPage('https://other.example/collections/c', only);
    expect(await screen.findByRole('button', { name: 'area' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'position' })).not.toBeInTheDocument();
    expect(screen.getByText(/Also advertised.*items/)).toBeInTheDocument();
    // the current mode moved to the first available one
    expect(screen.getByRole('button', { name: 'area' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    ['only unsupported query types', { items: {}, locations: {} }],
    ['empty data_queries', {}],
  ])('shows a "no supported query types" message instead of mode buttons (%s)', async (_n, data_queries) => {
    const real = createMockFetch();
    const none: FetchImpl = async (input, init) => {
      const u = unproxyUrl(input);
      if (u.startsWith('https://other.example/collections/c?')) {
        return new Response(JSON.stringify({ id: 'c', title: 'None', data_queries, parameter_names: { a: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.startsWith('https://other.example/')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      return real(input, init);
    };
    renderPage('https://other.example/collections/c', none);
    expect(await screen.findByText(/No supported query types/)).toBeInTheDocument();
    for (const m of ['position', 'area', 'trajectory', 'radius', 'cube', 'corridor']) {
      expect(screen.queryByRole('button', { name: m })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^Draw / })).not.toBeInTheDocument();
  });

  it('prefills a single datetime (first step of the extent), not the whole range, and builds a position URL (Flet format)', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19'));
    expect(screen.getByLabelText('End date')).toHaveValue('');
    expect(screen.getByLabelText('End time')).toHaveValue('');
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(urlBox()).toHaveValue(''); // nothing drawn yet

    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() =>
      expect(urlBox()).toHaveValue(
        `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT}&f=json`,
      ),
    );
    expect(map.kinds).toEqual(['point']);
    expect(map.shown.at(-1)).toEqual({ type: 'Point', coordinates: [10, 50] });
    expect(screen.getByTestId('edr-geometry')).toHaveTextContent('50.0°N 10.0°E');
  });

  it('the user can still set a range by filling in the end date', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19'));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.type(screen.getByLabelText('End date'), '2026-10-29');
    await user.type(screen.getByLabelText('End time'), '00:00');
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT_RANGE}&f=json`));
  });

  it('area mode: a drawn rectangle becomes a POLYGON query', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'area' }));
    map.next = {
      type: 'Polygon',
      coordinates: [
        [
          [-10, 40.25],
          [20.5, 40.25],
          [20.5, 60],
          [-10, 60],
          [-10, 40.25],
        ],
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() =>
      expect(urlBox()).toHaveValue(
        `${COL}/area?coords=POLYGON((-10.0 40.25,20.5 40.25,20.5 60.0,-10.0 60.0,-10.0 40.25))&parameter-name=2t&datetime=${DT}&f=json`,
      ),
    );
    expect(map.kinds).toEqual(['bbox']);
  });

  it('switching mode clears the drawing and URL; Clear does too', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(urlBox().value).toContain('/position?'));
    await user.click(screen.getByRole('button', { name: 'area' }));
    expect(urlBox()).toHaveValue('');
    expect(screen.getByTestId('edr-geometry')).toHaveTextContent('Nothing drawn yet');
  });

  it('parameters: All / None and chip toggling feed the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(urlBox().value).toContain('&parameter-name=2t,10u,10v,t'));
    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(urlBox().value).not.toContain('parameter-name');
    await user.click(screen.getByRole('button', { name: /^10u/ }));
    expect(urlBox().value).toContain('&parameter-name=10u&');
  });

  it('pressure-level parameters ask for a level and add z', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    expect(screen.queryByText('Vertical level')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    expect(screen.getByText(/require a pressure level/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Pressure level (hPa)'));
    await user.click(await screen.findByRole('option', { name: '850 hPa' }));
    await waitFor(() => expect(urlBox().value).toContain('&parameter-name=t&z=850&datetime='));
    expect(screen.getByText(/Querying t at 850 hPa/)).toBeInTheDocument();
  });

  it('instance: switch + dropdown put the instance in the path and load its range', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() =>
      expect(urlBox().value).toContain(`${COL}/instances/2026-10-18T12:00:00Z/position?coords=POINT(10.0 50.0)`),
    );
    await waitFor(() => expect(mock.calls).toContain(`${COL}/instances/2026-10-18T12:00:00Z?f=json`));
    await waitFor(() => expect(screen.getByText(/Valid range: from 2026-10-19T00:00/)).toBeInTheDocument());
    // the instance's first step is the default single time (any range typed before is dropped)
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19');
    expect(screen.getByLabelText('End date')).toHaveValue('');
    expect(urlBox().value).toContain(`&datetime=${DT}&f=json`);
    await user.click(screen.getByRole('checkbox', { name: /Use specific instance/ }));
    await waitFor(() => expect(urlBox().value).toContain(`${COL}/position?`));
    await waitFor(() => expect(screen.getByText(/Available: from/)).toBeInTheDocument());
  });

  it('Fetch without a parameter is refused', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    expect(await screen.findByTestId('edr-status')).toHaveTextContent('Select at least one parameter first');
    expect(queryCalls()).toHaveLength(0);
  });

  it('Fetch without a level for a level parameter is refused', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    await user.click(fetchBtn());
    expect(await screen.findByTestId('edr-status')).toHaveTextContent(/Select a pressure level for t/);
    expect(queryCalls()).toHaveLength(0);
  });

  it('Fetch runs the query and shows the JSON with a download button', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
    expect(JSON.parse(within(dialog).getByTestId('result-json').textContent ?? '')).toEqual(position);
    expect(within(dialog).getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(queryCalls()).toEqual([
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT}&f=json`,
    ]);
    expect(screen.getByTestId('edr-status')).toHaveTextContent(/Response received/);
  });

  it('the URL box is editable and Fetch uses the edited URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.type(urlBox(), '&extra=1');
    await user.click(fetchBtn());
    await screen.findByRole('dialog');
    expect(queryCalls()).toEqual([
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT}&f=json&extra=1`,
    ]);
  });

  it('a failing request shows an error result', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.type(urlBox(), '&fail=400');
    await user.click(fetchBtn());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/HTTP 400.*fail=400/)).toBeInTheDocument();
    expect(screen.getByTestId('edr-status')).toHaveTextContent('Request failed');
  });
  /** Mock fetch whose EDR data queries are answered by `onQuery`; everything else goes to the shared mock. */
  const withQueryHandler = (onQuery: (u: string, init?: RequestInit) => Promise<Response>): FetchImpl => {
    const real = createMockFetch();
    return (input, init) => {
      const u = unproxyUrl(input);
      return /\/(position|corridor)\?/.test(u) ? onQuery(u, init) : real(input, init);
    };
  };
  const json = (data: unknown, status: number) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  it('a request that never answers can be cancelled; the bar shows elapsed time and the UI stops spinning', async () => {
    const user = userEvent.setup();
    renderPage(
      COL,
      withQueryHandler(
        (_u, init) =>
          new Promise<Response>((_res, rej) =>
            init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    expect(await screen.findByTestId('request-elapsed')).toHaveTextContent(/\d+ s/);
    expect(fetchBtn()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('edr-status')).toHaveTextContent('Request cancelled'));
    expect(screen.queryByTestId('request-elapsed')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchBtn()).toBeEnabled();
  });

  it('a 502 from a gateway that gave up explains that the server did not answer', async () => {
    const user = userEvent.setup();
    renderPage(
      COL,
      withQueryHandler(async () => json({ error: 'upstream error: socket hang up (after 50 s)' }, 502)),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 10_000 });
    expect(within(dialog).getByText(/HTTP 502: upstream error: socket hang up \(after 50 s\)\. The server did not answer/)).toBeInTheDocument();
  }, 20_000);

  it('a response of hundreds of MB is refused with advice instead of freezing the page', async () => {
    const user = userEvent.setup();
    renderPage(
      COL,
      withQueryHandler(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(309_149_904) } }),
      ),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Response is too large: 295 MB \(limit 60 MB\)\. Narrow the datetime range/)).toBeInTheDocument();
  });

  it('navigating away aborts the active request and ignores a late completion', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    // Ignores the abort signal on purpose: the answer arrives after the page is gone.
    renderPage(
      COL,
      withQueryHandler((_u, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          finish = () => resolve(json(position, 200));
        });
      }),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    expect(await screen.findByTestId('request-elapsed')).toBeInTheDocument();
    expect(signal?.aborted).toBe(false);

    await user.click(screen.getByRole('button', { name: 'leave page' }));
    expect(screen.getByText('elsewhere')).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByTestId('request-elapsed')).toBeNull(); // the bar is released

    finish?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('request-elapsed')).toBeNull();
  });

  it('a corridor 500 about a missing value hints at the corridor height', async () => {
    const user = userEvent.setup();
    renderPage(
      COL,
      withQueryHandler(async () =>
        json({ code: 'NoApplicableCode', description: "Query failed: float() argument must be a string or a real number, not 'NoneType'" }, 500),
      ),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'corridor' }));
    map.next = {
      type: 'LineString',
      coordinates: [
        [10, 50],
        [11, 51],
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Draw corridor' }));
    await user.type(screen.getByLabelText('Corridor width'), '2');
    await user.clear(screen.getByLabelText('Corridor height (optional)'));
    expect(screen.getByText(/Some servers .* require it/)).toBeInTheDocument(); // the hint is back once emptied
    await waitFor(() => expect(urlBox().value).not.toContain('corridor-height'));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This server needs a corridor height/)).toBeInTheDocument();
  });

  describe('remaining modes', () => {
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [10, 50],
        [11, 51.5],
        [12.25, 52],
      ],
    };

    it('trajectory: a drawn line becomes a LINESTRING query', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'trajectory' }));
      map.next = line;
      await user.click(screen.getByRole('button', { name: 'Draw trajectory' }));
      await waitFor(() =>
        expect(urlBox()).toHaveValue(
          `${COL}/trajectory?coords=LINESTRING(10.0 50.0,11.0 51.5,12.25 52.0)&parameter-name=2t&datetime=${DT}&f=json`,
        ),
      );
      expect(map.kinds).toEqual(['line']);
      expect(screen.getByTestId('edr-geometry')).toHaveTextContent('3 points');
    });

    it('radius: draws a centre, needs a value, honours units', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'radius' }));
      await user.click(screen.getByRole('button', { name: 'Draw radius' }));
      expect(map.kinds).toEqual(['point']);
      await waitFor(() => expect(screen.getByTestId('edr-geometry')).toHaveTextContent('50.0°N 10.0°E'));
      expect(urlBox()).toHaveValue(''); // radius missing
      expect(screen.getByText('Enter a radius to build the URL.')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Radius'), '5');
      await waitFor(() =>
        expect(urlBox()).toHaveValue(
          `${COL}/radius?coords=POINT(10.0 50.0)&within=5.0&within-units=degrees&parameter-name=2t&datetime=${DT}&f=json`,
        ),
      );
      expect(screen.getByText('≈ 555 km')).toBeInTheDocument();

      await user.click(screen.getByLabelText('Radius units'));
      await user.click(await screen.findByRole('option', { name: 'km' }));
      await waitFor(() => expect(urlBox().value).toContain('&within=5.0&within-units=km&'));
    });

    it('corridor: width + units, optional height + units', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'corridor' }));
      map.next = {
        type: 'LineString',
        coordinates: [
          [10, 50],
          [11, 51],
        ],
      };
      await user.click(screen.getByRole('button', { name: 'Draw corridor' }));
      await waitFor(() => expect(screen.getByTestId('edr-geometry')).toHaveTextContent('→'));
      expect(urlBox()).toHaveValue('');
      await user.type(screen.getByLabelText('Corridor width'), '2');
      await waitFor(() =>
        expect(urlBox()).toHaveValue(
          `${COL}/corridor?coords=LINESTRING(10.0 50.0,11.0 51.0)&corridor-width=2.0&width-units=degrees&corridor-height=10.0&height-units=m&parameter-name=2t&datetime=${DT}&f=json`,
        ),
      );
      expect(screen.getByLabelText('Corridor height (optional)')).toHaveValue('10');
      await user.click(screen.getByLabelText('Width units'));
      await user.click(await screen.findByRole('option', { name: 'km' }));
      const height = screen.getByLabelText('Corridor height (optional)');
      await user.clear(height);
      await user.type(height, '500');
      await waitFor(() =>
        expect(urlBox().value).toContain('&corridor-width=2.0&width-units=km&corridor-height=500.0&height-units=m&parameter-name=2t'),
      );
      await user.clear(height);
      await waitFor(() => expect(urlBox().value).not.toContain('corridor-height'));
    });

    it('cube: a drawn bbox becomes bbox=minLon,minLat,maxLon,maxLat', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'cube' }));
      map.next = {
        type: 'Polygon',
        coordinates: [
          [
            [-10, 40.25],
            [20.5, 40.25],
            [20.5, 60],
            [-10, 60],
            [-10, 40.25],
          ],
        ],
      };
      await user.click(screen.getByRole('button', { name: 'Draw cube' }));
      await waitFor(() =>
        expect(urlBox()).toHaveValue(`${COL}/cube?bbox=-10.0,40.25,20.5,60.0&parameter-name=2t&datetime=${DT}&f=json`),
      );
      expect(map.kinds).toEqual(['bbox']);
    });
  });

  describe('timeseries chart and async jobs', () => {
    const oldJob = { ...EDR_JOB };
    beforeEach(() => {
      EDR_JOB.pollIntervalMs = 5;
    });
    afterEach(() => {
      Object.assign(EDR_JOB, oldJob);
    });

    it('a point series response shows a chart above the JSON', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.click(fetchBtn());
      const dialog = await screen.findByRole('dialog');
      const chart = await within(dialog).findByTestId('chart-2t');
      expect(chart).toHaveTextContent('2 metre temperature (K)');
      expect(chart.querySelectorAll('circle')).toHaveLength(4);
      expect(chart.querySelectorAll('polyline')).toHaveLength(1);
    });

    it('async=true: 303 -> job polling -> result (with chart)', async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.type(urlBox(), '&async=true');
      await user.click(fetchBtn());

      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
      expect(within(dialog).getByTestId('chart-2t')).toBeInTheDocument();
      expect(JSON.parse(within(dialog).getByTestId('result-json').textContent ?? '')).toEqual(position);

      const origin = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu';
      const jobCalls = mock.calls.filter((c) => c.includes('/jobs/'));
      // first poll: running, second: successful, then the results link
      expect(jobCalls).toEqual([`${origin}/jobs/job-1`, `${origin}/jobs/job-1`, `${origin}/jobs/job-1/results`]);
      expect(queryCalls()).toHaveLength(1);
      expect(queryCalls()[0]).toContain('&async=true');
      expect(screen.getByTestId('edr-status')).toHaveTextContent(/Response received/);
    });

    it('a failed job shows an error result', async () => {
      const real = createMockFetch();
      const failing: FetchImpl = async (input, init) => {
        if (/\/jobs\/job-1$/.test(unproxyUrl(input))) {
          return new Response(JSON.stringify({ jobID: 'job-1', status: 'failed', message: 'boom' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return real(input, init);
      };
      const user = userEvent.setup();
      renderPage(COL, failing);
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.type(urlBox(), '&async=true');
      await user.click(fetchBtn());
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Job failed: boom/)).toBeInTheDocument();
      expect(screen.getByTestId('edr-status')).toHaveTextContent('Request failed');
    });
  });
});
