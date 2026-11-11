import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import { map, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

describe('EDR page: datetime dropdowns from the collection `values`', () => {
  // test/fixtures/collections/stepped-data.json: hourly 9 Nov 00:00 - 12 Nov 18:00, 3-hourly to 15 Nov 00:00, 6-hourly to 19 Nov.
  // Its instance fixture: 6-hourly 9 Nov 00:00 - 10 Nov 00:00, then daily at 12:00 from 10 to 13 Nov.
  const STEPPED = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/stepped-data';
  const valuesReady = () => screen.findByRole('combobox', { name: 'Start date' });

  const optionsOf = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const input = screen.getByRole('combobox', { name: label });
    await user.click(input);
    const opts = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    await user.keyboard('{Escape}');
    return opts;
  };
  const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  const hours = (n: number) => [...Array(n).keys()].map((h) => `${String(h).padStart(2, '0')}:00`);

  it('start date offers only available dates; start time only the times on that date', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    const dates = await optionsOf(user, 'Start date');
    expect(dates[0]).toBe('2026-11-09');
    expect(dates).toHaveLength(11);
    expect(dates.at(-1)).toBe('2026-11-19');
    expect(await optionsOf(user, 'Start time')).toEqual(hours(24)); // hourly day

    await choose(user, 'Start date', '2026-11-13');
    expect(await optionsOf(user, 'Start time')).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
    await choose(user, 'Start date', '2026-11-16');
    expect(await optionsOf(user, 'Start time')).toEqual(['00:00', '06:00', '12:00', '18:00']);
    await choose(user, 'Start date', '2026-11-12');
    expect(await optionsOf(user, 'Start time')).toEqual([...hours(19), '21:00']);
  });

  it('changing the start date keeps the time when available, else takes the first available', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    await choose(user, 'Start time', '06:00');
    await choose(user, 'Start date', '2026-11-13');
    expect(screen.getByLabelText('Start time')).toHaveValue('06:00');
    await choose(user, 'Start time', '03:00');
    await choose(user, 'Start date', '2026-11-16'); // 6-hourly: no 03:00
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
  });

  it('the end only offers instants >= the start, and follows a later start', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-11-10'));
    await choose(user, 'Start date', '2026-11-12');
    await choose(user, 'Start time', '15:00');
    // the position default end (2026-11-10) is before the new start: it moved to the start
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-12');
    expect(screen.getByLabelText('End time')).toHaveValue('15:00');
    const endDates = await optionsOf(user, 'End date');
    expect(endDates[0]).toBe('2026-11-12');
    expect(endDates).toHaveLength(8);
    expect(await optionsOf(user, 'End time')).toEqual(['15:00', '16:00', '17:00', '18:00', '21:00']);
    // a later end date: the time is kept when available, else the first one
    await choose(user, 'End time', '21:00');
    await choose(user, 'End date', '2026-11-13');
    expect(screen.getByLabelText('End time')).toHaveValue('21:00');
    expect(await optionsOf(user, 'End time')).toHaveLength(8);
    await choose(user, 'End date', '2026-11-16');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    // a later start pushes the end along
    await choose(user, 'Start date', '2026-11-18');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-18');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    expect(await optionsOf(user, 'End date')).toEqual(['2026-11-18', '2026-11-19']);
  });

  it('position defaults snap to the available steps: end = latest <= start + 1 day', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    expect(screen.getByLabelText('Start time')).toHaveValue('00:00');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-10');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() =>
      expect(urlBox()).toHaveValue(
        `${STEPPED}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=2026-11-09T00:00:00Z/2026-11-10T00:00:00Z&f=json`,
      ),
    );
  });

  it('other modes default to a single time; picking a start / end builds the range', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'area' }));
    await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-11-09'));
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    // picking a start/end builds the range (a single time when equal)
    map.next = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] };
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await choose(user, 'Start date', '2026-11-13');
    await choose(user, 'Start time', '03:00');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-11-13T03:00:00Z&f=json'));
    await choose(user, 'End date', '2026-11-15');
    await choose(user, 'End time', '06:00');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-11-13T03:00:00Z/2026-11-15T06:00:00Z&f=json'));
  });

  it('keeps the "Available" range and adds a hint on the step changes', async () => {
    renderPage(STEPPED);
    await valuesReady();
    const hint = await screen.findByText(/Available: from 2026-11-08T00:00 to 2026-11-23T00:00/);
    expect(hint).toHaveTextContent('Steps: hourly to 12 Nov 18:00, then 3-hourly to 15 Nov 00:00, then 6-hourly');
  });

  it("switching instance uses that instance's values (and the collection's again without one)", async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED);
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    expect((await optionsOf(user, 'Start date')).length).toBe(11);
    await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
    await waitFor(() => expect(screen.getByText(/Valid range: from 2026-11-09T00:00 to 2026-11-19T00:00/)).toBeInTheDocument());
    expect(screen.getByText(/Steps: 6-hourly to 10 Nov 00:00, then 12-hourly/)).toBeInTheDocument();
    expect(await optionsOf(user, 'Start date')).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    expect(await optionsOf(user, 'Start time')).toEqual(['00:00', '06:00', '12:00', '18:00']);
    // position default: latest <= start + 1 day
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-10');
    expect(screen.getByLabelText('End time')).toHaveValue('00:00');
    await choose(user, 'Start date', '2026-11-11');
    expect(await optionsOf(user, 'Start time')).toEqual(['12:00']);
    expect(screen.getByLabelText('Start time')).toHaveValue('12:00');

    await user.click(screen.getByRole('checkbox', { name: /Use specific instance/ }));
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-09'));
    expect((await optionsOf(user, 'Start date')).length).toBe(11);
  });

  /** The stepped collection with its temporal `values` (and optionally `interval`) replaced (the mock fetch serves everything else). */
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

  it('seconds-precision instants are offered with their seconds and reach the URL unchanged', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(STEPPED, withValues(['2026-11-09T00:00:30Z', '2026-11-09T01:00:00Z', '2026-11-09T01:00:45Z']));
    await valuesReady();
    await waitFor(() => expect(screen.getByLabelText('Start time')).toHaveValue('00:00:30'));
    expect(await optionsOf(user, 'Start time')).toEqual(['00:00:30', '01:00', '01:00:45']);
    await user.click(screen.getByRole('button', { name: 'area' }));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    map.next = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] };
    await user.click(screen.getByRole('button', { name: 'Draw area' }));
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-11-09T00:00:30Z&f=json'));
    await choose(user, 'End time', '01:00:45');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-11-09T00:00:30Z/2026-11-09T01:00:45Z&f=json'));
    await choose(user, 'Start time', '01:00');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-11-09T01:00:00Z/2026-11-09T01:00:45Z&f=json'));
  });

  it('a capped (incomplete) values list keeps the free-text fields and defaults to the latest times', async () => {
    // 10 years of PT1S exceeds the cap: offering a truncated dropdown would hide valid times
    renderPage(STEPPED, withValues(['2026-01-01T00:00:00Z/2036-01-01T00:00:00Z/PT1S']));
    await screen.findByRole('button', { name: 'position' });
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2035-12-31'));
    for (const l of ['Start date', 'Start time', 'End date', 'End time']) {
      expect(screen.getByLabelText(l)).not.toHaveAttribute('role', 'combobox');
    }
    expect(screen.queryByText(/Steps:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Available: from 2026-11-08T00:00/)).toBeInTheDocument();
  });

  describe('ERA5-like: ~760k hourly instants since 1940', () => {
    const ERA5 = ['1940-01-01T00:00:00Z/2026-10-01T23:00:00Z/PT1H'];
    const INTERVAL: [string, string] = ['1940-01-01T00:00:00Z', '2026-10-01T23:00:00Z'];

    it('defaults to the latest day (position) and the latest instant (area), with a hint', async () => {
      const user = userEvent.setup({ delay: null });
      renderPage(STEPPED, withValues(ERA5, INTERVAL));
      await screen.findByRole('button', { name: 'position' });
      await waitFor(() => expect(screen.getByLabelText('End date')).toHaveValue('2026-10-01'));
      expect(screen.getByLabelText('Start date')).toHaveValue('2026-09-30');
      expect(screen.getByLabelText('Start time')).toHaveValue('23:00');
      expect(screen.getByLabelText('End time')).toHaveValue('23:00');
      for (const l of ['Start date', 'Start time', 'End date', 'End time']) {
        expect(screen.getByLabelText(l)).not.toHaveAttribute('role', 'combobox');
      }
      const hint = screen.getByText(/Available: from 1940-01-01T00:00 to 2026-10-01T23:00/);
      expect(hint).toHaveTextContent('Too many times to list; defaulting to the latest');

      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() =>
        expect(urlBox()).toHaveValue(
          `${STEPPED}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=2026-09-30T23:00:00Z/2026-10-01T23:00:00Z&f=json`,
        ),
      );

      await user.click(screen.getByRole('button', { name: 'area' }));
      await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-01'));
      expect(screen.getByLabelText('End date')).toHaveValue('2026-10-01');
      expect(screen.getByLabelText('Start time')).toHaveValue('23:00');
      expect(screen.getByLabelText('End time')).toHaveValue('23:00');
      map.next = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] };
      await user.click(screen.getByRole('button', { name: 'Draw area' }));
      await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-10-01T23:00:00Z&f=json'));
    });
  });

  it('without `values` the free-text fields stay', async () => {
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19'));
    for (const l of ['Start date', 'Start time', 'End date', 'End time']) {
      expect(screen.getByLabelText(l)).not.toHaveAttribute('role', 'combobox');
    }
    expect(screen.queryByText(/Steps:/)).not.toBeInTheDocument();
  });
});
