import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { EDR_JOB } from '../../lib/edr';
import { createMockFetch } from '../../lib/mockFetch';
import type { Geometry } from '../../lib/types';
import position from '../../../test/fixtures/edr/position.json';
import { COL, DT, fetchBtn, map, mock, queryCalls, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

describe('EDR page', () => {
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
      const user = userEvent.setup({ delay: null });
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
      const user = userEvent.setup({ delay: null });
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
      const user = userEvent.setup({ delay: null });
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
      const user = userEvent.setup({ delay: null });
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

    it('a point series response shows its chart in the result panel', async () => {
      const user = userEvent.setup({ delay: null });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.click(fetchBtn());
      const panel = await screen.findByTestId('edr-result');
      expect(screen.queryByRole('dialog')).toBeNull();
      const chart = await within(panel).findByTestId('chart-2t');
      expect(chart).toHaveTextContent('2 metre temperature (K)');
      expect(chart.querySelectorAll('circle')).toHaveLength(4);
      expect(chart.querySelectorAll('polyline')).toHaveLength(1);
    });

    it('async=true: 303 -> job polling -> result (with chart)', async () => {
      const user = userEvent.setup({ delay: null });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.type(urlBox(), '&async=true');
      await user.click(fetchBtn());

      const panel = await screen.findByTestId('edr-result');
      expect(within(panel).getByTestId('chart-2t')).toBeInTheDocument();
      await user.click(within(panel).getByRole('button', { name: 'View JSON' }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
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
      const user = userEvent.setup({ delay: null });
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
