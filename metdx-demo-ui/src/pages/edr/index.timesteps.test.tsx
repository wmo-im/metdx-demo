import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import type { Geometry } from '../../lib/types';
import { createMockFetch } from '../../lib/mockFetch';
import { COL, DT, fetchBtn, map, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

const STEPPED = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/stepped-data';
const square = (lon0: number, lat0: number, size: number): Geometry => ({
  type: 'Polygon',
  coordinates: [[[lon0, lat0], [lon0 + size, lat0], [lon0 + size, lat0 + size], [lon0, lat0 + size], [lon0, lat0]]],
});
const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const timeSteps = (name: 'Single' | 'Range') => screen.getByRole('button', { name });
const estimate = () => screen.queryByTestId('edr-estimate');

/** The stepped collection with its temporal `values` replaced. */
const withValues = (values: string[], interval?: [string, string]): FetchImpl => {
  const real = createMockFetch();
  return async (input, init) => {
    const res = await real(input, init);
    if (!/\/collections\/stepped-data\?/.test(unproxyUrl(input))) return res;
    const data = await res.json();
    data.extent.temporal.values = values;
    if (interval) data.extent.temporal.interval = [interval];
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};

describe('EDR page: time steps of area-type queries', () => {
  it('offers Single (default) / Range for area, radius and cube only', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    expect(screen.queryByTestId('edr-time-steps')).not.toBeInTheDocument(); // position
    for (const mode of ['area', 'radius', 'cube']) {
      await user.click(screen.getByRole('button', { name: mode }));
      expect(timeSteps('Single')).toHaveAttribute('aria-pressed', 'true');
      expect(timeSteps('Range')).toHaveAttribute('aria-pressed', 'false');
    }
    await user.click(screen.getByRole('button', { name: 'trajectory' }));
    expect(screen.queryByTestId('edr-time-steps')).not.toBeInTheDocument();
  });

  it('without a time list or step, a range ends 6 h after the start; Single takes it back', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'area' }));
    map.next = square(10, 50, 5);
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT}&f=json`));
    expect(estimate()).not.toBeInTheDocument(); // Single: no estimate line

    await user.click(timeSteps('Range'));
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT}/2026-10-19T06:00:00Z&f=json`));
    expect(screen.getByLabelText('End time')).toHaveValue('06:00');
    // 5 x 5 deg at the known 0.1 deg spacing = 2500 points x 7 steps (hourly assumed) x 1 parameter x 0.24 KB
    expect(estimate()).toHaveTextContent('about 7 steps (hourly assumed), ~4.2 MB');
    expect(screen.queryByTestId('edr-estimate-warning')).not.toBeInTheDocument();

    // typing a start moves the end; typing an end keeps it from following again
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-20');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-10-20T00:00:00Z/2026-10-20T06:00:00Z&f=json'));
    await user.clear(screen.getByLabelText('End time'));
    await user.type(screen.getByLabelText('End time'), '12:00');
    await waitFor(() => expect(estimate()).toHaveTextContent('about 13 steps'));
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-21');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-10-21T00:00:00Z/2026-10-20T12:00:00Z&f=json'));

    await user.click(timeSteps('Single'));
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-10-21T00:00:00Z&f=json'));
    expect(estimate()).not.toBeInTheDocument();
  });

  it('with a time list the end is the 6th available instant after the start, clamped to the last', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED); // hourly 9 Nov 00:00 - 12 Nov 18:00, 3-hourly to 15 Nov 00:00, 6-hourly to 19 Nov
    await screen.findByRole('combobox', { name: 'Start date' });
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(timeSteps('Range'));
    await waitFor(() => expect(screen.getByLabelText('End time')).toHaveValue('06:00'));
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-09');

    await choose(user, 'Start date', '2026-11-12');
    await choose(user, 'Start time', '16:00');
    // 17, 18, 21 (12 Nov), 00, 03, 06 (13 Nov): the 3-hourly steps count as steps
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-13');
    expect(screen.getByLabelText('End time')).toHaveValue('06:00');

    await choose(user, 'Start date', '2026-11-18');
    await choose(user, 'Start time', '12:00');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19'); // only 18:00 on the 18th and 00:00 on the 19th follow
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');

    // picking the last instant as the start keeps it (a single step); choosing Range then moves it back
    await choose(user, 'Start date', '2026-11-19');
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    await user.click(timeSteps('Single'));
    await user.click(timeSteps('Range'));
    // the last 7 instants: 17 Nov 12:00 ... 19 Nov 00:00
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-17');
    expect(screen.getByLabelText('Start time')).toHaveValue('12:00');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-19');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    await choose(user, 'Start date', '2026-11-18');
    await choose(user, 'Start time', '12:00');

    // picking an end by hand stops it following the start; Single resets it to the start
    await choose(user, 'End date', '2026-11-18');
    await choose(user, 'End time', '18:00');
    await choose(user, 'Start date', '2026-11-16');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
    expect(screen.getByLabelText('End time')).toHaveValue('18:00');
    await user.click(timeSteps('Single'));
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-16');
    expect(screen.getByLabelText('End time')).toHaveValue('12:00');
  });

  it('with a capped list, a Range ends at the last instant and starts 6 x the step before it', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED, withValues(['2026-01-01T00:00:00Z/2036-01-01T00:00:00Z/PT1S']));
    await screen.findByRole('button', { name: 'position' });
    await user.click(screen.getByRole('button', { name: 'area' }));
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2036-01-01')); // the default: the latest instant
    await user.click(timeSteps('Range'));
    // the start was the last instant: moved back 6 steps, so 7 instants end at the last one
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2035-12-31'));
    expect(screen.getByLabelText('Start time')).toHaveValue('23:59:54');
    expect(screen.getByLabelText('End date')).toHaveValue('2036-01-01');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
  });

  it('with a capped list of 3-hourly instants: 18 h back from the last, and an earlier start is clamped to it', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED, withValues(['2000-01-01T00:00:00Z/2036-01-01T00:00:00Z/PT3H']));
    await screen.findByRole('button', { name: 'position' });
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(timeSteps('Range'));
    await waitFor(() => expect(screen.getByLabelText('Start time')).toHaveValue('06:00'));
    expect(screen.getByLabelText('Start date')).toHaveValue('2035-12-31');
    expect(screen.getByLabelText('End date')).toHaveValue('2036-01-01');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    map.next = square(10, 50, 1);
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    // 7 steps; the grid spacing of this collection is not known
    await waitFor(() => expect(estimate()).toHaveTextContent('about 7 steps, size unknown'));

    // a start 3 steps before the last: the end stops at the last instant (4 steps)
    await user.clear(screen.getByLabelText('Start time'));
    await user.type(screen.getByLabelText('Start time'), '15:00');
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2035-12-31');
    await waitFor(() => expect(screen.getByLabelText('End time')).toHaveValue('00:00'));
    expect(screen.getByLabelText('End date')).toHaveValue('2036-01-01');
    await waitFor(() => expect(estimate()).toHaveTextContent('about 4 steps'));
    // a start the user typed stays, even when it is the last instant: the end is clamped to it
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2036-01-01');
    await user.clear(screen.getByLabelText('Start time'));
    await user.type(screen.getByLabelText('Start time'), '00:00');
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2036-01-01'));
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
  });

  it('a capped list: the moved-back start is not before the extent start', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED, withValues(['2026-01-01T00:00:00Z/2036-01-01T00:00:00Z/PT1H'], ['2035-12-31T21:00:00Z', '2036-01-01T00:00:00Z']));
    await screen.findByRole('button', { name: 'position' });
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(timeSteps('Range'));
    await waitFor(() => expect(screen.getByLabelText('Start time')).toHaveValue('21:00'));
    expect(screen.getByLabelText('Start date')).toHaveValue('2035-12-31');
    expect(screen.getByLabelText('End date')).toHaveValue('2036-01-01');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
  });

  it('warns above 30 MB and counts the parameters', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(timeSteps('Range'));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    map.next = square(0, 40, 10); // 10201-ish points: 10 x 10 / 0.01 = 10000 x 7 x 0.24 KB = 16.8 MB (shown rounded)
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() => expect(estimate()).toHaveTextContent('about 7 steps (hourly assumed), ~17 MB'));
    expect(screen.queryByTestId('edr-estimate-warning')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^10u/ }));
    await waitFor(() => expect(estimate()).toHaveTextContent('~34 MB'));
    expect(screen.getByTestId('edr-estimate-warning')).toHaveTextContent(/over 30 MB.*above 60 MB are refused/);
  });

  it('radius: the estimate uses the circle area; the end follows the same rule', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'radius' }));
    await user.click(screen.getByRole('button', { name: 'Draw radius' }));
    await user.type(screen.getByLabelText('Radius'), '1');
    await user.click(timeSteps('Range'));
    await waitFor(() => expect(urlBox().value).toContain(`&datetime=${DT}/2026-10-19T06:00:00Z&f=json`));
    // pi x 1^2 / 0.01 = 314 points x 7 x 0.24 KB
    await waitFor(() => expect(estimate()).toHaveTextContent('about 7 steps (hourly assumed), ~0.5 MB'));
    expect(COL).toContain('operational-data');
  });

  it('learns the grid spacing from a response when the collection does not say', async () => {
    const user = userEvent.setup({ delay: null });
    // 400 points over 5 x 5 degrees: 0.25 degrees apart
    const points = Array.from({ length: 400 }, (_, i) => [10 + (i % 20) * 0.25, 50 + Math.floor(i / 20) * 0.25]);
    const real = createMockFetch();
    const impl: FetchImpl = async (input, init) => {
      if (!/\/stepped-data\/area\?/.test(unproxyUrl(input))) return real(input, init);
      const body = {
        type: 'Coverage',
        domain: {
          type: 'Domain',
          domainType: 'MultiPoint',
          axes: {
            composite: { dataType: 'tuple', coordinates: ['x', 'y'], values: points },
            t: { values: ['2026-11-09T00:00:00Z'] },
          },
        },
        parameters: { '2t': { type: 'Parameter', observedProperty: { label: { en: '2t' } }, unit: { symbol: 'K' } } },
        ranges: { '2t': { type: 'NdArray', dataType: 'float', axisNames: ['t', 'composite'], shape: [1, 400], values: points.map(() => 280) } },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    renderPage(STEPPED, impl);
    await screen.findByRole('combobox', { name: 'Start date' });
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(timeSteps('Range'));
    map.next = square(10, 50, 5);
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() => expect(estimate()).toHaveTextContent('about 7 steps, size unknown'));
    await user.click(fetchBtn());
    // 25 deg2 / 0.25^2 = 400 points x 7 steps x 0.24 KB
    await waitFor(() => expect(estimate()).toHaveTextContent('about 7 steps, ~0.7 MB'));
  });
});
