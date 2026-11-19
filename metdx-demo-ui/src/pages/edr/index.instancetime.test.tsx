import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import { ready, renderPage } from '../../../test/edrPageHarness';

beforeEach(() => setFetchImpl(null));
afterEach(() => setFetchImpl(null));

const MO = 'https://other.example/collections/mo';
const NO_RANGE = /Forecast run \(no time range advertised\): from 2026-11-18T12:00 to 2026-11-19T12:00/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/**
 * A Met-Office-like collection (like the live `mo-prslvl`) with one instance. `instance` is its instance document
 * (`null`: the request fails with a 404); the collection advertises a different time range, so a prefill
 * from the instance can be told from the collection's.
 */
function serve(instanceId: string, instance: unknown | null): FetchImpl {
  const real = createMockFetch();
  return async (input, init) => {
    const u = unproxyUrl(input);
    if (!u.startsWith('https://other.example/')) return real(input, init);
    if (u.startsWith(`${MO}/instances/${encodeURIComponent(instanceId)}?`) || u.startsWith(`${MO}/instances/${instanceId}?`)) {
      return instance === null ? json({ code: 'NotFound' }, 404) : json(instance);
    }
    if (u.startsWith(`${MO}/instances?`)) return json({ instances: [{ id: instanceId }] });
    if (u.startsWith(`${MO}?`)) {
      return json({
        id: 'mo',
        title: 'Met Office',
        data_queries: { position: {}, area: {} },
        extent: { spatial: { bbox: [[-10, 45, 5, 60]] }, temporal: { interval: [['2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z']] } },
        parameter_names: { air_temperature: { observedProperty: { label: { en: 'Air temperature' } }, unit: { symbol: 'K' } } },
      });
    }
    return json({}, 404);
  };
}

const fields = () => ['Start date', 'Start time', 'End date', 'End time'].map((l) => (screen.getByLabelText(l) as HTMLInputElement).value);

async function useInstance(user: ReturnType<typeof userEvent.setup>) {
  await ready();
  await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
}

describe('EDR page: datetime prefill from the instance id', () => {
  it('an instance document without an extent: start = the instance time, position end = +24 h', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', links: [] }));
    await useInstance(user);
    expect(await screen.findByText(NO_RANGE)).toBeInTheDocument();
    expect(fields()).toEqual(['2026-11-18', '12:00', '2026-11-19', '12:00']);
  });

  it('other modes default to the instance time only', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, serve('2026-11-18T120000', {}));
    await useInstance(user);
    await screen.findByText(NO_RANGE);
    await user.click(screen.getByRole('button', { name: 'area' }));
    await waitFor(() => expect(fields()).toEqual(['2026-11-18', '12:00', '2026-11-18', '12:00']));
  });

  it('an instance document that cannot be loaded falls back to the id too', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, serve('20261118T1200', null));
    await useInstance(user);
    expect(await screen.findByText(NO_RANGE)).toBeInTheDocument();
    expect(fields()).toEqual(['2026-11-18', '12:00', '2026-11-19', '12:00']);
    expect(screen.queryByText(/Could not load instance details/)).not.toBeInTheDocument();
  });

  it('an instance id that is not a datetime keeps the old behaviour: empty fields, no-temporal hint', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, serve('latest', {}));
    await useInstance(user);
    expect(await screen.findByText(/does not say which times it has/)).toBeInTheDocument();
    expect(fields()).toEqual(['', '', '', '']);
    expect(screen.queryByText(/Forecast run/)).not.toBeInTheDocument();
  });

  it('an unloadable instance with a non-datetime id still reports the error', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(MO, serve('latest', null));
    await useInstance(user);
    expect(await screen.findByText(/Could not load instance details/)).toBeInTheDocument();
  });

  it('an instance document with extent.temporal still wins over the id', async () => {
    const user = userEvent.setup({ delay: null });
    const extent = { temporal: { interval: [['2026-11-20T06:00:00Z', '2026-11-30T00:00:00Z']] } };
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', extent }));
    await useInstance(user);
    expect(await screen.findByText(/Valid range: from 2026-11-20T06:00 to 2026-11-30T00:00/)).toBeInTheDocument();
    expect(screen.queryByText(/Forecast run/)).not.toBeInTheDocument();
    expect(fields()).toEqual(['2026-11-20', '06:00', '2026-11-21', '06:00']);
  });

  it('an instance document with extent.temporal.values still wins over the id', async () => {
    const user = userEvent.setup({ delay: null });
    const extent = { temporal: { values: ['2026-11-20T06:00:00Z', '2026-11-20T12:00:00Z'] } };
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', extent }));
    await useInstance(user);
    await waitFor(() => expect(fields()).toEqual(['2026-11-20', '06:00', '2026-11-20', '12:00']));
    expect(screen.queryByText(/Forecast run/)).not.toBeInTheDocument();
  });

  it('an open-start interval [null, end] is an advertised range: it wins over the id', async () => {
    const user = userEvent.setup({ delay: null });
    const extent = { temporal: { interval: [[null, '2026-11-30T00:00:00Z']] } };
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', extent }));
    await useInstance(user);
    expect(await screen.findByText(/Valid range: to 2026-11-30T00:00/)).toBeInTheDocument();
    expect(screen.queryByText(/Forecast run/)).not.toBeInTheDocument();
  });

  it('an open-end interval [start, null] is an advertised range too', async () => {
    const user = userEvent.setup({ delay: null });
    const extent = { temporal: { interval: [['2026-11-20T06:00:00Z', null]] } };
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', extent }));
    await useInstance(user);
    expect(await screen.findByText(/Valid range: from 2026-11-20T06:00 to now/)).toBeInTheDocument();
    expect(screen.queryByText(/Forecast run/)).not.toBeInTheDocument();
  });

  it('an interval with neither bound advertises nothing: the id fallback applies', async () => {
    const user = userEvent.setup({ delay: null });
    const extent = { temporal: { interval: [[null, null]] } };
    renderPage(MO, serve('2026-11-18T120000', { id: '2026-11-18T120000', extent }));
    await useInstance(user);
    expect(await screen.findByText(NO_RANGE)).toBeInTheDocument();
  });
});
