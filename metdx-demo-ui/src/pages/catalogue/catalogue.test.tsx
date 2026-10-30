import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../../App';
import { setFetchImpl, unproxyUrl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import { resetConfig, setDefaultQuery, setRecordsSource } from '../../lib/config';
import { clearServiceCache } from '../../lib/records';
import { clearRecordCache } from '../../shell';

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function Loc() {
  const l = useLocation();
  return <output data-testid="loc">{l.pathname + l.search}</output>;
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]} future={future}>
      <App />
      <Loc />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearRecordCache();
  clearServiceCache();
});
afterEach(() => {
  setFetchImpl(null);
  resetConfig();
});

describe('catalogue -> record (recordsSource catalogue, mock fixtures)', () => {
  beforeEach(() => {
    setRecordsSource('catalogue');
    setDefaultQuery(''); // list everything; the default query has its own tests below
  });

  it('shows the catalogue host as the indicator', async () => {
    setFetchImpl(createMockFetch());
    renderApp();
    await screen.findAllByTestId('result-card');
    expect(screen.getByTestId('records-source')).toHaveTextContent('wmo-resource-catalogue.labs.wis2dev.io');
  });

  it('lists fixtures with EDR / Maps badges only where detected', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    const cards = await screen.findAllByTestId('result-card');
    expect(cards).toHaveLength(3);
    expect(screen.getByTestId('results-header')).toHaveTextContent('Showing latest datasets (3 available)');
    expect(screen.getByTestId('page-info')).toHaveTextContent('1–3 of 3');

    const destine = cards.find((c) => c.textContent?.includes('Destination Earth'))!;
    const opendata = cards.find((c) => c.textContent?.includes('Open Data'))!;
    const msc = cards.find((c) => c.textContent?.includes('Weather Elements on the Grid'))!;
    await within(destine).findByTestId('badge-edr');
    expect(within(destine).getByTestId('badge-maps')).toHaveTextContent('OGC Maps');
    expect(within(destine).getByTestId('query-types')).toHaveTextContent(/position/);
    // keyword chips capped at 5
    expect(within(destine).getByText('weather')).toBeInTheDocument();
    expect(within(destine).queryByText('temperature')).not.toBeInTheDocument();
    expect(within(opendata).queryByTestId('badge-edr')).not.toBeInTheDocument();
    expect(within(opendata).queryByTestId('badge-maps')).not.toBeInTheDocument();
    // MSC: its collection (dev.api.weather.gc.ca) is unreachable here -> no badges, no error
    await waitFor(() => expect(mock.calls.some((u) => u.includes('dev.api.weather.gc.ca/collections/msc-weather-forecast'))).toBe(true));
    expect(within(msc).queryByTestId('badge-edr')).not.toBeInTheDocument();
    expect(within(msc).queryByTestId('badge-maps')).not.toBeInTheDocument();
    expect(screen.queryByText(/Error loading results/)).not.toBeInTheDocument();
  });

  it('searches with q, then opens a record and follows the EDR / Maps buttons', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    await screen.findAllByTestId('result-card');

    await userEvent.type(screen.getByLabelText('Search datasets'), 'destination{Enter}');
    await waitFor(() => expect(screen.getByTestId('results-header')).toHaveTextContent("Found 1 results for 'destination'"));
    expect(screen.getAllByTestId('result-card')).toHaveLength(1);
    expect(mock.calls.some((u) => u.includes('limit=10&offset=0&q=destination'))).toBe(true);
    expect(screen.getByTestId('loc')).toHaveTextContent('/?q=destination');

    await userEvent.click(screen.getByTestId('result-card').querySelector('a')!);
    expect(await screen.findByText(/ECMWF IFS Global Deterministic/)).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toMatch(/^\/record\/urn%3Awmo/);
    const meta = screen.getByTestId('record-metadata');
    expect(meta).toHaveTextContent('Destination Earth Data Access Policy');
    expect(meta).toHaveTextContent('January 01, 2026');
    expect(meta).toHaveTextContent('core');

    const edr = await screen.findByRole('link', { name: 'EDR' });
    const maps = screen.getByRole('link', { name: 'OGC Maps' });
    const edrHref = edr.getAttribute('href')!;
    expect(edrHref).toMatch(/\/edr\?col=/);
    expect(decodeURIComponent(edrHref.split('col=')[1])).toContain('/collections/operational-data?f=json');
    expect(maps.getAttribute('href')).toMatch(/\/maps\?col=/);
    expect(decodeURIComponent(maps.getAttribute('href')!.split('col=')[1])).toContain('/collections/operational_map_server');
    expect(screen.getByTestId('query-types')).toHaveTextContent('position');

    await userEvent.click(edr);
    expect(await screen.findByTestId('page-edr')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toMatch(/\/edr\?col=/);
  });

  it('record page without services has disabled buttons; Back returns to the search', async () => {
    setFetchImpl(createMockFetch());
    renderApp();
    const cards = await screen.findAllByTestId('result-card');
    await userEvent.click(cards.find((c) => c.textContent?.includes('Open Data'))!.querySelector('a')!);
    const edr = await screen.findByRole('button', { name: 'EDR' });
    expect(edr).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OGC Maps' })).toBeDisabled();
    expect(screen.getByTestId('record-description')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Back to results'));
    expect(await screen.findAllByTestId('result-card')).toHaveLength(3);
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/);
  });

  it('opens a record directly by URL (fetches it from the catalogue)', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp(`/record/${encodeURIComponent('urn:wmo:md:int-ecmwf:opendata')}`);
    expect(await screen.findByRole('heading', { name: /ECMWF Open Data/ })).toBeInTheDocument();
    expect(mock.calls.some((u) => u.includes('/items/urn%3Awmo%3Amd%3Aint-ecmwf%3Aopendata'))).toBe(true);
  });

  it('shows an error when the search fails', async () => {
    setFetchImpl(async () => new Response('{}', { status: 500 }));
    renderApp();
    expect(await screen.findByText(/Error loading results/)).toBeInTheDocument();
  });
});

describe('Back from a record', () => {
  beforeEach(() => {
    setRecordsSource('catalogue');
    setDefaultQuery('');
  });
  const destineId = encodeURIComponent('urn:wmo:md:int-ecmwf:weather.prediction.forecast.global');

  it('returns to the search with its query, also after the EDR page and its Record link', async () => {
    setFetchImpl(createMockFetch());
    renderApp();
    await screen.findAllByTestId('result-card');
    await userEvent.type(screen.getByLabelText('Search datasets'), 'destination{Enter}');
    await waitFor(() => expect(screen.getByTestId('results-header')).toHaveTextContent("Found 1 results for 'destination'"));
    await userEvent.click(screen.getByTestId('result-card').querySelector('a')!);
    await userEvent.click(await screen.findByRole('link', { name: 'EDR' }));
    expect(await screen.findByTestId('page-edr')).toBeInTheDocument();

    // EDR -> Record (one step back, not a new entry) -> Back lands on the search, not on the EDR page again
    await userEvent.click(screen.getByRole('link', { name: 'Record' }));
    await screen.findByLabelText('Back to results');
    await userEvent.click(screen.getByLabelText('Back to results'));
    expect(await screen.findByTestId('page-catalogue')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('/?q=destination');
    expect(screen.getByLabelText('Search datasets')).toHaveValue('destination');
    expect(await screen.findAllByTestId('result-card')).toHaveLength(1);
  });

  it('a record opened directly goes to the catalogue, also via the EDR page', async () => {
    setFetchImpl(createMockFetch());
    renderApp(`/record/${destineId}`);
    await userEvent.click(await screen.findByRole('link', { name: 'EDR' }));
    expect(await screen.findByTestId('page-edr')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Record' }));
    await userEvent.click(await screen.findByLabelText('Back to results'));
    expect(await screen.findAllByTestId('result-card')).toHaveLength(3);
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/);
  });
});

describe('default query', () => {
  beforeEach(() => setRecordsSource('catalogue'));

  it('is used when the URL has no q: the box is prefilled and the catalogue is asked for it', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    await screen.findAllByTestId('result-card');
    expect(screen.getByLabelText('Search datasets')).toHaveValue('metdx-demo');
    expect(screen.getByTestId('results-header')).toHaveTextContent("Found 3 results for 'metdx-demo'");
    expect(mock.calls[0]).toContain('items?limit=10&offset=0&q=metdx-demo');
  });

  it('clearing the box lists everything (an empty q= in the URL), and Back from a record keeps it', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    await screen.findAllByTestId('result-card');
    await userEvent.clear(screen.getByLabelText('Search datasets'));
    await userEvent.type(screen.getByLabelText('Search datasets'), '{Enter}');
    await waitFor(() => expect(screen.getByTestId('results-header')).toHaveTextContent('Showing latest datasets (3 available)'));
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/\?q=$/);
    expect(screen.getByLabelText('Search datasets')).toHaveValue('');
    expect(mock.calls.some((u) => /items\?limit=10&offset=0$/.test(u))).toBe(true);

    await userEvent.click(screen.getAllByTestId('result-card')[0].querySelector('a')!);
    await userEvent.click(await screen.findByLabelText('Back to results'));
    expect(await screen.findAllByTestId('result-card')).toHaveLength(3);
    expect(screen.getByLabelText('Search datasets')).toHaveValue('');
  });

  it('an explicit q in the URL wins over the default', async () => {
    setFetchImpl(createMockFetch());
    renderApp('/?q=open%20data');
    await screen.findAllByTestId('result-card');
    expect(screen.getByLabelText('Search datasets')).toHaveValue('open data');
    expect(screen.getAllByTestId('result-card')).toHaveLength(1);
  });
});

describe('paging (catalogue)', () => {
  beforeEach(() => {
    setRecordsSource('catalogue');
    setDefaultQuery('');
  });
  const total = 25;
  const makeFetch = () => {
    const urls: string[] = [];
    const impl = async (input: string) => {
      const u = new URL(unproxyUrl(input));
      urls.push(u.search);
      const offset = Number(u.searchParams.get('offset'));
      const limit = Number(u.searchParams.get('limit'));
      const features = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
        id: `rec-${offset + i}`,
        properties: { title: `Dataset ${offset + i}` },
        links: [],
      }));
      return new Response(JSON.stringify({ numberMatched: total, features }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { impl, urls };
  };

  it('pages 10 at a time with Previous / Next', async () => {
    const { impl, urls } = makeFetch();
    setFetchImpl(impl);
    renderApp();
    expect(await screen.findByText('Dataset 0')).toBeInTheDocument();
    expect(screen.getAllByTestId('result-card')).toHaveLength(10);
    expect(screen.getByTestId('page-info')).toHaveTextContent('1–10 of 25');
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('Dataset 10')).toBeInTheDocument();
    expect(screen.getByTestId('page-info')).toHaveTextContent('11–20 of 25');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('Dataset 20')).toBeInTheDocument();
    expect(screen.getAllByTestId('result-card')).toHaveLength(5);
    expect(screen.getByTestId('page-info')).toHaveTextContent('21–25 of 25');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('Dataset 10')).toBeInTheDocument();
    expect(urls).toEqual(['?limit=10&offset=0', '?limit=10&offset=10', '?limit=10&offset=20', '?limit=10&offset=10']);
  });
});

describe('catalogue with the local records', () => {
  const RECORD_ID = 'urn:wmo:md:int-ecmwf:opendata';
  beforeEach(() => {
    setRecordsSource('local');
    setDefaultQuery('');
  });

  it('lists the bundled records without any network call, with the local indicator', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    const cards = await screen.findAllByTestId('result-card');
    expect(cards).toHaveLength(3);
    expect(screen.getByTestId('records-source')).toHaveTextContent('local records');
    expect(screen.getByTestId('results-header')).toHaveTextContent('Showing latest datasets (3 available)');
    expect(screen.getByTestId('page-info')).toHaveTextContent('1–3 of 3');
    expect(mock.calls.some((u) => u.includes('wis2-discovery-metadata'))).toBe(false);
    // EDR / Maps badges still come from live (here mocked) collection documents
    const destine = cards.find((c) => c.textContent?.includes('Destination Earth'))!;
    await within(destine).findByTestId('badge-edr');
    expect(mock.calls.some((u) => u.includes('/collections/operational-data'))).toBe(true);
  });

  it('searches client-side, then opens a record by id from the same set', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    renderApp();
    await screen.findAllByTestId('result-card');
    await userEvent.type(screen.getByLabelText('Search datasets'), 'destination{Enter}');
    await waitFor(() => expect(screen.getByTestId('results-header')).toHaveTextContent("Found 1 results for 'destination'"));
    expect(screen.getAllByTestId('result-card')).toHaveLength(1);
    expect(mock.calls.some((u) => u.includes('wis2-discovery-metadata'))).toBe(false);

    await userEvent.click(screen.getByTestId('result-card').querySelector('a')!);
    expect(await screen.findByText(/ECMWF IFS Global Deterministic/)).toBeInTheDocument();
  });

  it('opens a record directly by URL from the bundled set; unknown ids show an error', async () => {
    const mock = createMockFetch();
    setFetchImpl(mock);
    const { unmount } = renderApp(`/record/${encodeURIComponent(RECORD_ID)}`);
    expect(await screen.findByRole('heading', { name: /ECMWF Open Data/ })).toBeInTheDocument();
    expect(mock.calls.some((u) => u.includes('wis2-discovery-metadata'))).toBe(false);
    unmount();
    clearRecordCache();
    renderApp('/record/nope');
    expect(await screen.findByText(/not found in the local records/i)).toBeInTheDocument();
  });

  it('the record page lists the record links (data, ...) opening in a new tab', async () => {
    setFetchImpl(createMockFetch());
    renderApp(`/record/${encodeURIComponent(RECORD_ID)}`);
    const links = await screen.findByTestId('record-links');
    const a = within(links).getByRole('link', { name: 'ECMWF Open Data portal' });
    expect(a).toHaveAttribute('href', 'https://data.ecmwf.int/');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(within(links).getByText('data')).toBeInTheDocument();
  });
});
