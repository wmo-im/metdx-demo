import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setFetchImpl, unproxyUrl, type FetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import position from '../../../test/fixtures/edr/position.json';
import { COL, DT_POS, fetchBtn, map, mock, queryCalls, ready, renderPage, urlBox } from '../../../test/edrPageHarness';

beforeEach(() => {
  setFetchImpl(null);
});
afterEach(() => {
  setFetchImpl(null);
});

describe('EDR page', () => {
  it('switching mode clears the drawing and URL; Clear does too', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(urlBox().value).toContain('/position?'));
    await user.click(screen.getByRole('button', { name: 'area' }));
    expect(urlBox()).toHaveValue('');
    expect(screen.getByTestId('edr-geometry')).toHaveTextContent('Nothing drawn yet');
  });

  it('parameters: All / None and chip toggling feed the URL', async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(await screen.findByRole('checkbox', { name: /Use specific instance/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() =>
      expect(urlBox().value).toContain(`${COL}/instances/2026-10-18T12:00:00Z/position?coords=POINT(10.0 50.0)`),
    );
    await waitFor(() => expect(mock.calls).toContain(`${COL}/instances/2026-10-18T12:00:00Z?f=json`));
    await waitFor(() => expect(screen.getByText(/Valid range: from 2026-10-19T00:00/)).toBeInTheDocument());
    // the instance's first step (+ 1 day for position) is the default (any range typed before is dropped)
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-19');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-10-20');
    expect(urlBox().value).toContain(`&datetime=${DT_POS}&f=json`);
    await user.click(screen.getByRole('checkbox', { name: /Use specific instance/ }));
    await waitFor(() => expect(urlBox().value).toContain(`${COL}/position?`));
    await waitFor(() => expect(screen.getByText(/Available: from/)).toBeInTheDocument());
  });

  it('Fetch without a parameter is refused', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    expect(await screen.findByTestId('edr-status')).toHaveTextContent('Select at least one parameter first');
    expect(queryCalls()).toHaveLength(0);
  });

  it('Fetch without a level for a level parameter is refused', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await user.click(screen.getByRole('button', { name: /^t \(/ }));
    await user.click(fetchBtn());
    expect(await screen.findByTestId('edr-status')).toHaveTextContent(/Select a pressure level for t/);
    expect(queryCalls()).toHaveLength(0);
  });

  it('Fetch runs the query and shows the JSON with a download button', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    expect(screen.queryByRole('dialog')).toBeNull(); // the JSON is opened on demand
    await user.click(screen.getByRole('button', { name: 'View JSON' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('result-json')).toHaveTextContent('"type": "Coverage"');
    expect(JSON.parse(within(dialog).getByTestId('result-json').textContent ?? '')).toEqual(position);
    expect(within(dialog).getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(queryCalls()).toEqual([
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT_POS}&f=json`,
    ]);
    expect(screen.getByTestId('edr-status')).toHaveTextContent(/Response received/);
  });

  it('the URL box is editable and Fetch uses the edited URL', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await ready();
    await user.click(screen.getByRole('button', { name: /^2t/ }));
    await user.click(screen.getByRole('button', { name: 'Draw position' }));
    await waitFor(() => expect(fetchBtn()).toBeEnabled());
    await user.type(urlBox(), '&extra=1');
    await user.click(fetchBtn());
    await screen.findByTestId('edr-result');
    expect(queryCalls()).toEqual([
      `${COL}/position?coords=POINT(10.0 50.0)&parameter-name=2t&datetime=${DT_POS}&f=json&extra=1`,
    ]);
  });

  it('a failing request shows an error result', async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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
    // The gateway "answered after 50 s": the handler moves the clock on instead of really waiting, so the
    // page sees a slow failure (not retried, see retryMaxElapsedMs) without any real delay.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    let attempts = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      const user = userEvent.setup({ delay: null });
      renderPage(
        COL,
        withQueryHandler(async () => {
          attempts++;
          skew += 50_000;
          return json({ error: 'upstream error: socket hang up (after 50 s)' }, 502);
        }),
      );
      await ready();
      await user.click(screen.getByRole('button', { name: /^2t/ }));
      await user.click(screen.getByRole('button', { name: 'Draw position' }));
      await waitFor(() => expect(fetchBtn()).toBeEnabled());
      await user.click(fetchBtn());
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/HTTP 502: upstream error: socket hang up \(after 50 s\)\. The server did not answer/)).toBeInTheDocument();
      expect(attempts).toBe(1); // not retried
    } finally {
      now.mockRestore();
    }
  });

  it('a response of hundreds of MB is refused with advice instead of freezing the page', async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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

});
