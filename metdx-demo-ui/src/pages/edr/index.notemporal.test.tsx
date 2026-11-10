import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import operational from '../../../test/fixtures/collections/operational-data.json';
import mscPosition from '../../../test/fixtures/edr/msc-position.json';
import { COL, fetchBtn, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

beforeEach(() => setFetchImpl(null));
afterEach(() => setFetchImpl(null));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Like the live MSC collection: a spatial extent only, and no instances.
const { temporal: _drop, ...spatialOnly } = operational.extent;
void _drop;
const noTemporal = { ...operational, extent: spatialOnly };

/** The shared mock, except that the collection has no temporal extent and EDR queries go to `onQuery`. */
const serve = (onQuery: () => Response): FetchImpl => {
  const real = createMockFetch();
  return (input, init) => {
    const u = unproxyUrl(input);
    if (/\/position\?/.test(u)) return Promise.resolve(onQuery());
    if (u.startsWith(COL) && !u.includes('/instances') && !u.includes('/position')) return Promise.resolve(json(noTemporal));
    if (u.includes('/instances')) return Promise.resolve(json({ instances: [], links: [] }));
    return real(input, init);
  };
};

describe('EDR page: collection without temporal info', () => {
  it('leaves the dates empty, omits `datetime`, and says so', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, serve(() => json(mscPosition)));
    await ready();
    expect(await screen.findByText(/does not say which times it has/)).toBeInTheDocument();
    for (const l of ['Start date', 'Start time', 'End date', 'End time']) expect(screen.getByLabelText(l)).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getAllByRole('button', { name: /^AirTemp|^2t/ })[0]);
    await waitFor(() => expect(urlBox().value).toContain('/position?'));
    expect(urlBox().value).not.toContain('datetime');
    // the user can still type dates
    await user.type(screen.getByLabelText('Start date'), '2026-10-30');
    await waitFor(() => expect(urlBox().value).toContain('&datetime=2026-10-30T00:00:00Z'));
  });

  it('a 204 answer shows the "no data" message, not a JSON error or a failure dialog', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, serve(() => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } })));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    const st = await screen.findByTestId('edr-status');
    await waitFor(() =>
      expect(st).toHaveTextContent('No data for this request (the server returned no content). Try other dates or another location.'),
    );
    expect(screen.queryByText(/not valid JSON/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('an empty 200 body shows the same message', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(COL, serve(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await waitFor(() => expect(screen.getByTestId('edr-status')).toHaveTextContent(/No data for this request/));
  });
});
