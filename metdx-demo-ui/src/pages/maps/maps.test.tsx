import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { MapController } from '../../shell/mapController';
import { MapProvider } from '../../shell/MapContext';
import { RequestBar, RequestBarProvider } from '../../shell/RequestBar';
import { setFetchImpl, unproxyUrl } from '../../lib/http';
import { createMockFetch, type MockFetch } from '../../lib/mockFetch';
import MapsPage from './index';

const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server?f=json';
const MAP = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/map';

let mock: MockFetch;
let ctrl: MapController;

function LeaveButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/elsewhere')}>leave page</button>;
}

function setup() {
  return render(
    <MemoryRouter
      initialEntries={[`/record/abc/maps?col=${encodeURIComponent(COL)}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <MapProvider controller={ctrl}>
        <RequestBarProvider>
          <Routes>
            <Route path="/record/:id/maps" element={<MapsPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
          <LeaveButton />
          <RequestBar />
        </RequestBarProvider>
      </MapProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock = createMockFetch();
  setFetchImpl(mock);
  ctrl = new MapController();
});
afterEach(() => {
  setFetchImpl(null);
  vi.restoreAllMocks();
});

const urlBox = () => screen.getByLabelText('Request URL') as HTMLInputElement;

describe('MapsPage', () => {
  it('fills instance/datetime/parameter from the schema and builds the URL', async () => {
    setup();
    await waitFor(() => expect(screen.queryByText('Loading schema...')).not.toBeInTheDocument());
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    expect(urlBox().value).toBe(
      `${MAP}?f=png&bbox=-180,-90,180,90&width=800&height=600&datetime=2026-10-19T00:00:00Z&parameter-name=2t`,
    );
    expect(screen.getByLabelText('Instance (run date)')).toBeInTheDocument();
    expect(screen.getByLabelText('Parameter')).toBeInTheDocument();
    expect(mock.calls).toContain(
      'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/schema?f=json',
    );
  });

  it('updates the URL for bbox, size and level', async () => {
    const user = userEvent.setup({ delay: null });
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    const bbox = screen.getByLabelText(/BBOX \(minLon/);
    await user.clear(bbox);
    await user.type(bbox, '-10,30,40,60');
    const w = screen.getByLabelText('Width');
    await user.clear(w);
    await user.type(w, '400');
    await user.click(screen.getByLabelText('Level (hPa)'));
    await user.click(await screen.findByRole('option', { name: '500' }));
    expect(urlBox().value).toBe(
      `${MAP}?f=png&bbox=-10,30,40,60&width=400&height=600&datetime=2026-10-19T00:00:00Z&parameter-name=2t&subset=z(500)`,
    );
  });

  it('sets the bbox field from a drawn rectangle', async () => {
    const user = userEvent.setup({ delay: null });
    vi.spyOn(ctrl, 'drawGeometry').mockResolvedValue({
      type: 'Polygon',
      coordinates: [[[5.1234, 40], [15, 40], [15, 55.5559], [5.1234, 55.5559], [5.1234, 40]]],
    });
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    await user.click(screen.getByRole('button', { name: /draw bbox/i }));
    await waitFor(() => expect(urlBox().value).toContain('bbox=5.123,40,15,55.556'));
    expect(ctrl.drawGeometry).toHaveBeenCalledWith('bbox');
  });

  it('fetches the PNG and overlays it on the map at the bbox', async () => {
    const user = userEvent.setup({ delay: null });
    const overlay = vi.spyOn(ctrl, 'setOverlay');
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    const bbox = screen.getByLabelText(/BBOX \(minLon/);
    await user.clear(bbox);
    await user.type(bbox, '-10,30,40,60');
    const expected = urlBox().value;
    await user.click(screen.getByRole('button', { name: /fetch/i }));
    await waitFor(() => expect(overlay).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), [-10, 30, 40, 60]));
    expect(mock.calls).toContain(expected);
    expect(screen.getByTestId('maps-status')).toHaveTextContent('Map rendered');
  });

  it('shows an error when the server fails', async () => {
    const user = userEvent.setup({ delay: null });
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    await user.click(urlBox());
    await user.type(urlBox(), '&fail=500');
    await user.click(screen.getByRole('button', { name: /fetch/i }));
    await waitFor(() => expect(screen.getByTestId('maps-status')).toHaveTextContent(/Failed: HTTP 500/));
  });

  it('an empty image response (204) shows a clear message, not an error', async () => {
    const user = userEvent.setup({ delay: null });
    const real = createMockFetch();
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    setFetchImpl((input, init) =>
      /[?&]bbox=/.test(unproxyUrl(input)) ? Promise.resolve(new Response(null, { status: 204 })) : real(input, init),
    );
    await user.click(screen.getByRole('button', { name: /fetch/i }));
    await waitFor(() => expect(screen.getByTestId('maps-status')).toHaveTextContent(/No map for this request/));
    expect(screen.getByTestId('maps-status')).not.toHaveTextContent(/Failed/);
  });

  it('a map request that never answers can be cancelled', async () => {
    const user = userEvent.setup({ delay: null });
    setFetchImpl((input, init) =>
      unproxyUrl(input).includes('/map?')
        ? new Promise<Response>((_res, rej) =>
            init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
          )
        : mock(input, init),
    );
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    await user.click(screen.getByRole('button', { name: /fetch/i }));
    expect(await screen.findByTestId('request-elapsed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('maps-status')).toHaveTextContent('Request cancelled'));
    expect(screen.queryByTestId('request-elapsed')).toBeNull();
    expect(screen.getByRole('button', { name: /fetch/i })).toBeEnabled();
  });

  it('navigating away aborts the active request and ignores a late completion', async () => {
    const user = userEvent.setup({ delay: null });
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const overlay = vi.spyOn(ctrl, 'setOverlay');
    // Ignores the abort signal on purpose: the image arrives after the page is gone.
    setFetchImpl((input, init) => {
      if (!unproxyUrl(input).includes('/map?')) return mock(input, init);
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        finish = () => resolve(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
      });
    });
    setup();
    await waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));
    await user.click(screen.getByRole('button', { name: /fetch/i }));
    expect(await screen.findByTestId('request-elapsed')).toBeInTheDocument();
    expect(signal?.aborted).toBe(false);

    await user.click(screen.getByRole('button', { name: 'leave page' }));
    expect(screen.getByText('elsewhere')).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByTestId('request-elapsed')).toBeNull(); // the bar is released

    finish?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(overlay).not.toHaveBeenCalledWith(expect.stringMatching(/^blob:/), expect.anything());
    expect(screen.queryByTestId('request-elapsed')).toBeNull();
  });

  it('asks for a collection when none is given', () => {
    render(
      <MemoryRouter initialEntries={['/record/abc/maps']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <MapProvider controller={ctrl}>
          <RequestBarProvider>
            <MapsPage />
          </RequestBarProvider>
        </MapProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/No collection selected/)).toBeInTheDocument();
  });
});

describe('MapsPage: Date and Time dropdowns', () => {
  const SCHEMA_URL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server/schema?f=json';
  const props = { '2t': { type: 'number' } };

  /** Serve this schema (server format: space + +00:00) in place of the fixture one. */
  function withSchema(datetime: string[] | null, instances: string[] = []) {
    const properties: Record<string, unknown> = { ...props };
    if (datetime) properties.datetime = { type: 'string', enum: datetime };
    if (instances.length) properties.instance_id = { type: 'string', enum: instances };
    setFetchImpl((input, init) =>
      unproxyUrl(input) === SCHEMA_URL
        ? Promise.resolve(new Response(JSON.stringify({ properties }), { headers: { 'content-type': 'application/json' } }))
        : mock(input, init),
    );
  }
  const SERVER_TIMES = [
    '2020-01-01 00:00:00+00:00',
    '2020-01-01 06:00:00+00:00',
    '2020-01-02 00:00:00+00:00',
    '2020-01-02 03:00:00+00:00',
    '2020-01-02 06:00:00+00:00',
    '2020-01-03 00:00:00+00:00',
    '2020-01-03 06:00:00+00:00',
  ];
  const INSTANCES = ['2020-01-01T00:00:00+00:00', '2020-01-02T00:00:00+00:00'];

  const optionsOf = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    await user.click(screen.getByRole('combobox', { name: label }));
    const opts = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    await user.keyboard('{Escape}');
    return opts;
  };
  const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  const ready = () => waitFor(() => expect(urlBox().value).toContain('parameter-name=2t'));

  it('defaults to the first time of the latest run; Date lists dates, Time the times of that date', async () => {
    const user = userEvent.setup({ delay: null });
    withSchema(SERVER_TIMES, INSTANCES);
    setup();
    await ready();
    expect(urlBox().value).toContain('datetime=2020-01-02T00:00:00Z&');
    expect(screen.queryByRole('combobox', { name: 'Forecast time' })).toBeNull();
    expect(screen.queryByLabelText('Datetime')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Date' })).toHaveValue('2020-01-02');
    expect(screen.getByRole('combobox', { name: 'Time' })).toHaveValue('00:00');
    expect(await optionsOf(user, 'Date')).toEqual(['2020-01-02', '2020-01-03']); // nothing before the run
    expect(await optionsOf(user, 'Time')).toEqual(['00:00', '03:00', '06:00']);
    await choose(user, 'Time', '03:00');
    expect(urlBox().value).toContain('datetime=2020-01-02T03:00:00Z&');
    await choose(user, 'Date', '2020-01-03');
    expect(await optionsOf(user, 'Time')).toEqual(['00:00', '06:00']);
  });

  it('keeps the time when the new date offers it, else takes its first time', async () => {
    const user = userEvent.setup({ delay: null });
    withSchema(SERVER_TIMES, INSTANCES);
    setup();
    await ready();
    await choose(user, 'Time', '06:00');
    await choose(user, 'Date', '2020-01-03');
    expect(urlBox().value).toContain('datetime=2020-01-03T06:00:00Z&');
    expect(screen.getByRole('combobox', { name: 'Time' })).toHaveValue('06:00');
    await choose(user, 'Date', '2020-01-02');
    await choose(user, 'Time', '03:00');
    await choose(user, 'Date', '2020-01-03'); // no 03:00 on the 3rd
    expect(urlBox().value).toContain('datetime=2020-01-03T00:00:00Z&');
    expect(screen.getByRole('combobox', { name: 'Time' })).toHaveValue('00:00');
  });

  it('only offers times at or after the selected run, and resets to its first time', async () => {
    const user = userEvent.setup({ delay: null });
    withSchema(SERVER_TIMES, INSTANCES);
    setup();
    await ready();
    await user.click(screen.getByLabelText('Instance (run date)'));
    await user.click(await screen.findByRole('option', { name: '2020-01-01T00:00:00Z' }));
    expect(urlBox().value).toContain('datetime=2020-01-01T00:00:00Z&');
    expect(await optionsOf(user, 'Date')).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
    expect(await optionsOf(user, 'Time')).toEqual(['00:00', '06:00']);
  });

  it('without schema datetimes: a free-text Datetime field, empty by default', async () => {
    const user = userEvent.setup({ delay: null });
    withSchema(null);
    setup();
    await ready();
    expect(screen.queryByRole('combobox', { name: 'Date' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Time' })).toBeNull();
    const field = screen.getByLabelText('Datetime') as HTMLInputElement;
    expect(field.value).toBe('');
    // The URL builder never omits the datetime (an empty one makes the server answer 500): it uses today 00:00Z.
    expect(urlBox().value).toMatch(/datetime=\d{4}-\d{2}-\d{2}T00:00:00Z&/);
    await user.type(field, '2020-05-06T12:00:00Z');
    expect(urlBox().value).toContain('datetime=2020-05-06T12:00:00Z&');
  });
});
