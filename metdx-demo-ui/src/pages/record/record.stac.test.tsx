import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../App';
import { setFetchImpl } from '../../lib/http';
import { resetConfig, setDefaultQuery, setRecordsSource } from '../../lib/config';
import { clearServiceCache } from '../../lib/records';
import { clearRecordCache } from '../../shell';
import { STAC_BROWSER_LINK, STAC_BROWSER_TITLE, STAC_HREF, STAC_TITLE, createStacMock, recordWithStac } from '../../../test/stacRecord';

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;
const REC = 'urn:wmo:md:int-ecmwf:weather.prediction.forecast.global';

beforeEach(() => {
  clearRecordCache();
  clearServiceCache();
  setRecordsSource('catalogue');
  setDefaultQuery('');
});
afterEach(() => {
  setFetchImpl(null);
  resetConfig();
});

describe('record page of a record that also links a STAC Collection', () => {
  it.each([
    ['first', 'ok'],
    ['last', 'ok'],
    ['first', '403'],
    ['last', 'network-error'],
  ] as const)('STAC link %s, STAC host %s: Links lists both, EDR / OGC Maps stay enabled on the polytope collections', async (where, stac) => {
    setFetchImpl(createStacMock(recordWithStac(where), stac));
    render(
      <MemoryRouter initialEntries={[`/record/${encodeURIComponent(REC)}`]} future={future}>
        <App />
      </MemoryRouter>,
    );
    const edr = await screen.findByRole('link', { name: 'EDR' });
    const maps = screen.getByRole('link', { name: 'OGC Maps' });
    expect(decodeURIComponent(edr.getAttribute('href')!.split('col=')[1])).toBe(
      'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data?f=json',
    );
    expect(decodeURIComponent(maps.getAttribute('href')!.split('col=')[1])).toBe(
      'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server?f=json',
    );
    expect(screen.getByTestId('query-types')).toHaveTextContent('position');

    const links = screen.getByTestId('record-links');
    const stacLink = within(links).getByRole('link', { name: STAC_TITLE });
    expect(stacLink).toHaveAttribute('href', STAC_HREF);
    expect(within(stacLink.closest('li')!).getByTestId('record-link-rel')).toHaveTextContent('collection');
    const browser = within(links).getByRole('link', { name: STAC_BROWSER_TITLE });
    expect(browser).toHaveAttribute('href', STAC_BROWSER_LINK.href);
    expect(within(browser.closest('li')!).getByTestId('record-link-rel')).toHaveTextContent('related');
    // the record's own links are still there: 2 collections + 2 related + the 2 added
    expect(within(links).getAllByRole('listitem')).toHaveLength(6);
    // the STAC link is where the record put it
    const items = within(links).getAllByRole('listitem');
    expect(items[where === 'first' ? 0 : items.length - 2]).toHaveTextContent(STAC_TITLE);
  });

  it('the catalogue list shows the EDR / Maps badges for the modified record', async () => {
    setFetchImpl(createStacMock(recordWithStac('first'), '404'));
    render(
      <MemoryRouter initialEntries={['/']} future={future}>
        <App />
      </MemoryRouter>,
    );
    const cards = await screen.findAllByTestId('result-card');
    const card = cards.find((c) => c.textContent?.includes('Destination Earth'))!;
    await within(card).findByTestId('badge-edr');
    expect(within(card).getByTestId('badge-maps')).toBeInTheDocument();
    expect(screen.queryByText(/Error loading results/)).not.toBeInTheDocument();
  });
});
