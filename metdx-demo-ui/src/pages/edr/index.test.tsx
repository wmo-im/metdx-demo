import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import { COL, DT, DT_POS, DT_RANGE, map, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

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

  it('position prefills start = first step and end = start + 1 day (not the whole range), and builds a position URL (Flet format)', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19'));
    expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(urlBox()).toHaveValue(''); // nothing drawn yet

    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() =>
      expect(urlBox()).toHaveValue(
        `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT_POS}&f=json`,
      ),
    );
    expect(map.kinds).toEqual(['point']);
    expect(map.shown.at(-1)).toEqual({ type: 'Point', coordinates: [10, 50] });
    expect(screen.getByTestId('edr-geometry')).toHaveTextContent('50.0°N 10.0°E');
  });

  it('the user can still set another range by editing the end date', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19'));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-10-29');
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT_RANGE}&f=json`));
  });

  it('changing the mode re-applies its datetime defaults unless the dates were edited', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20'));
    await user.click(screen.getByRole('button', { name: 'area' }));
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-19'));
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    await user.click(screen.getByRole('button', { name: 'position' }));
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20'));

    // once edited, a mode change keeps the user's dates
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-10-25');
    await user.click(screen.getByRole('button', { name: 'cube' }));
    expect(screen.getByLabelText('End date')).toHaveValue('2026-10-25');
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19');
  });

  it('start == end sends a single datetime (not start/start)', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'area' }));
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-19'));
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
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT}&f=json`));
    expect(urlBox().value).not.toContain(`${DT}/`);
  });

  it('switching instance re-applies the defaults, dropping edited dates', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20'));
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-10-25');
    await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
    await waitFor(() => expect(screen.getByText(/Valid range: from 2026-10-19T00:00/)).toBeInTheDocument());
    expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20');
  });

  it('does not list `instances` among the advertised-but-unsupported query types', async () => {
    const real = createMockFetch();
    const withInstances: FetchImpl = async (input, init) => {
      const u = unproxyUrl(input);
      if (u.startsWith('https://other.example/collections/c?')) {
        return new Response(
          JSON.stringify({ id: 'c', title: 'T', data_queries: { position: {}, instances: {}, items: {} }, parameter_names: { a: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.startsWith('https://other.example/')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      return real(input, init);
    };
    renderPage('https://other.example/collections/c', withInstances);
    const note = await screen.findByText(/Also advertised/);
    expect(note).toHaveTextContent('items');
    expect(note).not.toHaveTextContent('instances');
  });

  it('area mode: a drawn rectangle becomes a POLYGON query', async () => {
    const user = userEvent.setup({ delay: null });
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

  it('area mode: Rectangle is the default; Polygon draws a free polygon (vertex count shown) and cube stays a bbox', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    expect(screen.queryByTestId('edr-area-shape')).toBeNull(); // position: no shape choice
    await user.click(screen.getByRole('button', { name: 'area' }));
    const toggle = screen.getByTestId('edr-area-shape');
    expect(within(toggle).getByRole('button', { name: 'rectangle' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(toggle).getByRole('button', { name: 'polygon' }));
    expect(within(toggle).getByRole('button', { name: 'polygon' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/double-click to finish/)).toBeInTheDocument();

    map.next = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 40],
          [10, 40],
          [10, 50],
          [5, 45.55555],
          [0, 50],
          [0, 40],
        ],
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() =>
      expect(urlBox()).toHaveValue(
        `${COL}/area?coords=POLYGON((0.0 40.0,10.0 40.0,10.0 50.0,5.0 45.556,0.0 50.0,0.0 40.0))&parameter-name=2t&datetime=${DT}&f=json`,
      ),
    );
    expect(map.kinds).toEqual(['polygon']);
    expect(screen.getByTestId('edr-geometry')).toHaveTextContent('Polygon with 5 vertices');
    expect(map.shown[map.shown.length - 1]).toMatchObject({ type: 'Polygon' });

    // switching the shape drops the drawing; rectangle draws a bbox again
    await user.click(within(toggle).getByRole('button', { name: 'rectangle' }));
    expect(urlBox()).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    expect(map.kinds).toEqual(['polygon', 'bbox']);

    // cube: bbox only, no shape choice
    await user.click(screen.getByRole('button', { name: 'cube' }));
    expect(screen.queryByTestId('edr-area-shape')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Draw cube' }));
    expect(map.kinds).toEqual(['polygon', 'bbox', 'bbox']);
  });

});
