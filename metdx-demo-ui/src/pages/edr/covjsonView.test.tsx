import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import EdrPage from './index';
import { MapProvider, RequestBar, RequestBarProvider, ResultDialog } from '../../shell';
import { MapController } from '../../shell/mapController';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import type { Geometry } from '../../lib/types';
import type { DataLayer, DataSelectHandler, ShowDataOptions } from '../../lib/covjsonTypes';
import type { CovJsonLayer } from '../../lib/covjson';

const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';

class StubMap extends MapController {
  next: Geometry = { type: 'Point', coordinates: [10, 50] };
  calls: { layer: DataLayer; opts: ShowDataOptions }[] = [];
  clears = 0;
  selectCb: DataSelectHandler | null = null;
  drawGeometry(): Promise<Geometry> {
    return Promise.resolve(this.next);
  }
  showData(layer: DataLayer, opts: ShowDataOptions): void {
    this.calls.push({ layer, opts });
  }
  clearData(): void {
    this.clears++;
  }
  onDataSelect(cb: DataSelectHandler): () => void {
    this.selectCb = cb;
    return () => {
      if (this.selectCb === cb) this.selectCb = null;
    };
  }
  get last() {
    return this.calls[this.calls.length - 1];
  }
}

let map: StubMap;

function LeaveButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/elsewhere')}>leave page</button>;
}

/** `answer(url)` replaces the body of every EDR data query; `undefined` = the shared mock fixtures. */
function renderPage(answer?: (url: string) => unknown) {
  const real = createMockFetch();
  const impl: FetchImpl = async (input, init) => {
    const u = unproxyUrl(input);
    if (answer && /\/(position|area|trajectory|radius|cube|corridor)\?/.test(u)) {
      return new Response(JSON.stringify(answer(u)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input, init);
  };
  setFetchImpl(impl);
  map = new StubMap();
  return render(
    <MemoryRouter
      initialEntries={[`/record/abc/edr?col=${encodeURIComponent(COL)}`]}
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

const fetchBtn = () => screen.getByRole('button', { name: /fetch/i });
const polygon: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-10, 40],
      [20, 40],
      [20, 60],
      [-10, 60],
      [-10, 40],
    ],
  ],
};

/** Pick 2t, choose the mode, draw, and press Fetch. */
async function query(mode: 'position' | 'area' | 'trajectory') {
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'position' });
  await user.click(screen.getByRole('button', { name: /^2t/ }));
  if (mode !== 'position') await user.click(screen.getByRole('button', { name: mode }));
  map.next =
    mode === 'area'
      ? polygon
      : mode === 'trajectory'
        ? { type: 'LineString', coordinates: [[10, 50], [12, 52]] }
        : { type: 'Point', coordinates: [10, 50] };
  await user.click(screen.getByRole('button', { name: `Draw ${mode}` }));
  await waitFor(() => expect(fetchBtn()).toBeEnabled());
  await user.click(fetchBtn());
  return user;
}

// ---- synthetic CoverageJSON ------------------------------------------------------------------

const param = (label: string, unit: string) => ({
  type: 'Parameter',
  unit: { symbol: unit },
  observedProperty: { id: label, label: { en: label } },
});

/** 2×2 grid, two parameters, three times, `levels` z values. Value = 1000*p + 100*t + 10*z + cell. */
function gridCov(levels: number[]) {
  const times = ['2026-10-19T00:00:00Z', '2026-10-19T06:00:00Z', '2026-10-19T12:00:00Z'];
  const range = (p: number) => {
    const values: number[] = [];
    for (let t = 0; t < times.length; t++)
      for (let z = 0; z < levels.length; z++) for (let c = 0; c < 4; c++) values.push(1000 * p + 100 * t + 10 * z + c);
    return { type: 'NdArray', dataType: 'float', axisNames: ['t', 'z', 'y', 'x'], shape: [times.length, levels.length, 2, 2], values };
  };
  return {
    type: 'Coverage',
    domain: {
      type: 'Domain',
      domainType: 'Grid',
      axes: { x: { values: [10, 11] }, y: { values: [50, 51] }, z: { values: levels }, t: { values: times } },
    },
    parameters: { a: param('Alpha', 'K'), b: param('Beta', 'm') },
    ranges: { a: range(1), b: range(2) },
  };
}

beforeEach(() => setFetchImpl(null));
afterEach(() => setFetchImpl(null));

describe('EDR result on the map', () => {
  it('position: draws the data, shows the chart in the panel, no dialog; View JSON opens it', async () => {
    renderPage();
    const user = await query('position');
    const panel = await screen.findByTestId('edr-result');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(map.last.opts.param).toBe('2t');
    expect(map.last.layer.kind).toBe('points');
    expect(within(panel).getByTestId('legend')).toBeInTheDocument();
    expect(within(panel).getByTestId('chart-2t')).toHaveTextContent('2 metre temperature (K)');

    await user.click(within(panel).getByRole('button', { name: 'View JSON' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('edr-result')).toBeInTheDocument(); // the panel stays
  });

  it('area: the full live sample is drawn; clicking a point reads its value', async () => {
    renderPage();
    await query('area');
    const panel = await screen.findByTestId('edr-result');
    expect(map.last.layer.kind).toBe('points');
    expect((map.last.layer.coords as Float64Array).length / 2).toBe(2408);
    expect(map.selectCb).not.toBeNull();
    expect(within(panel).queryByTestId('edr-selected')).toBeNull();

    const expected = map.last.layer.values('2t', 0)[5];
    act(() => map.selectCb?.(5, [10.5, 50.25]));
    const readout = within(panel).getByTestId('edr-selected');
    expect(readout).toHaveTextContent('50.25°N 10.50°E');
    expect(readout).toHaveTextContent(String(Number(expected.toPrecision(6))));
    expect(readout).toHaveTextContent('K');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('trajectory: the live sample is drawn as a trajectory layer', async () => {
    renderPage();
    await query('trajectory');
    await screen.findByTestId('edr-result');
    expect(map.last.layer.kind).toBe('trajectory');
    expect(map.last.opts.style).toBe('points');
    expect(screen.queryByTestId('edr-style-toggle')).toBeNull();
  });

  it('area: defaults to contours with a stepped legend; the toggle switches to points and back without reparsing', async () => {
    renderPage();
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    const layer = map.last.layer;
    const clears = map.clears;
    expect(map.last.opts.style).toBe('contours');
    const toggle = within(panel).getByTestId('edr-style-toggle');
    expect(within(toggle).getByRole('button', { name: 'Contours' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(toggle).getByRole('button', { name: 'Points' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(panel).getAllByTestId('legend-step').length).toBeGreaterThanOrEqual(6);
    const min = Number(within(panel).getByTestId('legend-min').textContent);
    const max = Number(within(panel).getByTestId('legend-max').textContent);
    expect(min).toBeLessThan(max);

    await user.click(within(toggle).getByRole('button', { name: 'Points' }));
    expect(map.last.opts.style).toBe('points');
    expect(map.last.layer).toBe(layer);
    expect(within(toggle).getByRole('button', { name: 'Points' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).queryByTestId('legend-step')).toBeNull();
    expect(within(panel).getByTestId('legend-bar')).toBeInTheDocument();

    await user.click(within(toggle).getByRole('button', { name: 'Contours' }));
    expect(map.last.opts.style).toBe('contours');
    expect(map.last.layer).toBe(layer);
    expect(within(panel).getAllByTestId('legend-step').length).toBeGreaterThanOrEqual(6);
    expect(map.clears).toBe(clears);
  });

  it('opacity slider: starts at the style default (not sent), sets opacity, and keeps it across style / parameter / time changes', async () => {
    renderPage(() => gridCov([500]));
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    const first = map.last.layer;
    // a grid: default 85 %
    expect(within(panel).getByTestId('edr-opacity-label')).toHaveTextContent('Opacity: 85%');
    expect(map.last.opts.opacity).toBeUndefined();
    const slider = within(panel).getByRole('slider', { name: 'Opacity' });
    slider.focus();
    await user.keyboard('{ArrowLeft}');
    expect(map.last.opts.opacity).toBeCloseTo(0.8);
    expect(within(panel).getByTestId('edr-opacity-label')).toHaveTextContent('Opacity: 80%');
    expect(map.last.layer).toBe(first);

    await user.click(within(panel).getByLabelText('Show parameter'));
    await user.click(await screen.findByRole('option', { name: /^b/ }));
    expect(map.last.opts).toMatchObject({ param: 'b' });
    expect(map.last.opts.opacity).toBeCloseTo(0.8);
    const time = within(panel).getByRole('slider', { name: 'Time' });
    time.focus();
    await user.keyboard('{ArrowRight}');
    expect(map.last.opts).toMatchObject({ timeIndex: 1 });
    expect(map.last.opts.opacity).toBeCloseTo(0.8);
  });

  it('opacity slider on scattered points: contours default 90 %, points 100 %; a chosen value survives the style toggle', async () => {
    renderPage();
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    expect(within(panel).getByTestId('edr-opacity-label')).toHaveTextContent('Opacity: 90%');
    const toggle = within(panel).getByTestId('edr-style-toggle');
    await user.click(within(toggle).getByRole('button', { name: 'Points' }));
    expect(map.last.opts.opacity).toBeUndefined();
    expect(within(panel).getByTestId('edr-opacity-label')).toHaveTextContent('Opacity: 100%');
    await user.click(within(toggle).getByRole('button', { name: 'Contours' }));

    const slider = within(panel).getByRole('slider', { name: 'Opacity' });
    slider.focus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(map.last.opts.opacity).toBeCloseTo(0.8);
    await user.click(within(toggle).getByRole('button', { name: 'Points' }));
    expect(map.last.opts).toMatchObject({ style: 'points' });
    expect(map.last.opts.opacity).toBeCloseTo(0.8);
    expect(within(panel).getByTestId('edr-opacity-label')).toHaveTextContent('Opacity: 80%');
  });

  it('position: points only, no toggle', async () => {
    renderPage();
    await query('position');
    await screen.findByTestId('edr-result');
    expect(map.last.opts.style).toBe('points');
    expect(screen.queryByTestId('edr-style-toggle')).toBeNull();
    expect(screen.queryByTestId('legend-step')).toBeNull();
  });

  it('parameter, time and level pickers redraw; a clicked point shows its series when there are several times', async () => {
    renderPage(() => gridCov([500, 850]));
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    expect(map.last.layer.kind).toBe('grid');
    expect(map.last.opts).toMatchObject({ param: 'a', timeIndex: 0 });
    const first = map.last.layer as CovJsonLayer;
    expect(first.levelIndex).toBe(0);
    // legend follows the parameter: a = 1000..1213 K
    expect(within(panel).getByTestId('legend-unit')).toHaveTextContent('K');

    // parameter
    await user.click(within(panel).getByLabelText('Show parameter'));
    await user.click(await screen.findByRole('option', { name: /^b/ }));
    expect(map.last.opts.param).toBe('b');
    expect(map.last.layer).toBe(first); // recoloured, not re-parsed
    expect(within(panel).getByTestId('legend-unit')).toHaveTextContent('m');

    // time
    expect(within(panel).getByTestId('edr-time-label')).toHaveTextContent('2026-10-19T00:00:00Z');
    const slider = within(panel).getByRole('slider', { name: 'Time' });
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(map.last.opts.timeIndex).toBe(1);
    expect(within(panel).getByTestId('edr-time-label')).toHaveTextContent('2026-10-19T06:00:00Z');
    expect(map.last.layer).toBe(first);

    // readout follows the time step, and a multi-time layer gets the series chart of the clicked cell
    act(() => map.selectCb?.(2, [10, 51]));
    expect(within(panel).getByTestId('edr-selected')).toHaveTextContent('= 2102 m'); // b, t=1, z=0, cell 2
    const chart = within(panel).getByTestId('chart-b');
    expect(chart).toHaveTextContent('Beta (m)');
    expect(chart.querySelectorAll('circle')).toHaveLength(3);

    // level: re-parsed at the other level, same parameter and time
    await user.click(within(panel).getByLabelText('Level'));
    await user.click(await screen.findByRole('option', { name: '850' }));
    expect((map.last.layer as CovJsonLayer).levelIndex).toBe(1);
    expect(map.last.layer).not.toBe(first);
    expect(map.last.opts).toMatchObject({ param: 'b', timeIndex: 1 });
    expect(within(panel).getByTestId('edr-selected')).toHaveTextContent('= 2112 m');
  });

  it('is cleared by a new query, a mode change and leaving the page', async () => {
    renderPage();
    const user = await query('position');
    await screen.findByTestId('edr-result');
    const clears = map.clears;

    // new query: the old result goes away as soon as Fetch starts
    await user.click(fetchBtn());
    await waitFor(() => expect(map.clears).toBeGreaterThan(clears));
    await screen.findByTestId('edr-result'); // and the new one is drawn
    const drawn = map.calls.length;

    // mode change
    const before = map.clears;
    await user.click(screen.getByRole('button', { name: 'area' }));
    expect(screen.queryByTestId('edr-result')).toBeNull();
    expect(map.clears).toBeGreaterThan(before);
    expect(map.calls.length).toBe(drawn);

    // leaving the page (the parameter is still selected)
    map.next = polygon;
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    const beforeLeave = map.clears;
    await user.click(screen.getByRole('button', { name: 'leave page' }));
    expect(screen.getByText('elsewhere')).toBeInTheDocument();
    expect(map.clears).toBeGreaterThan(beforeLeave);
  });

  it('a result too large to draw shows a clear message and the JSON is still available', async () => {
    const big = gridCov([500]);
    big.domain.axes.x = { start: 0, stop: 100, num: 3000 } as never;
    big.domain.axes.y = { start: 0, stop: 100, num: 2000 } as never;
    renderPage(() => big);
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    expect(within(panel).getByTestId('edr-result-error')).toHaveTextContent(/Too large to draw: 6,000,000 cells/);
    expect(map.calls).toHaveLength(0);
    expect(within(panel).queryByTestId('legend')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'View JSON' }));
    expect(await within(await screen.findByRole('dialog')).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
  });

  it('an unknown shape shows a clear message and the JSON is still available', async () => {
    renderPage(() => ({ hello: 'world' }));
    const user = await query('area');
    const panel = await screen.findByTestId('edr-result');
    expect(within(panel).getByTestId('edr-result-error')).toHaveTextContent(/Cannot draw this response on the map/);
    expect(map.calls).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'View JSON' }));
    expect(await within(await screen.findByRole('dialog')).findByTestId('result-json')).toHaveTextContent('"hello": "world"');
  });
});
