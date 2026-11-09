import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from './http';
import { clearServiceCache, collectionUrls, probeServices, probeServicesCached } from './records';
import {
  BASE_RECORD,
  STAC_BROWSER_LINK,
  STAC_HREF,
  createStacMock,
  recordWithStac,
  type StacBehaviour,
} from '../../test/stacRecord';

afterEach(() => {
  setFetchImpl(null);
  clearServiceCache();
});

const EDR = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data?f=json';
const MAPS = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational_map_server?f=json';

/** Services of the record as it is today (no STAC link): the reference every variant must equal. */
async function baseline() {
  setFetchImpl(createStacMock(BASE_RECORD));
  const info = await probeServices(BASE_RECORD);
  clearServiceCache();
  return info;
}

describe('a STAC rel=collection link in a WCMP2 record', () => {
  it('is picked up as a collection URL (with ?f=json), the browser rel=related link is not', () => {
    expect(collectionUrls(recordWithStac('first'))).toEqual([`${STAC_HREF}?f=json`, EDR, MAPS]);
    expect(collectionUrls(recordWithStac('last'))).toEqual([EDR, MAPS, `${STAC_HREF}?f=json`]);
    expect(collectionUrls({ links: [STAC_BROWSER_LINK] })).toEqual([]);
  });

  it.each(['first', 'last'] as const)('with the STAC link %s: EDR / Maps, collections, extent and query types unchanged', async (where) => {
    const ref = await baseline();
    expect(ref).toMatchObject({ edr: true, maps: true, edrCollection: EDR, mapsCollection: MAPS });
    expect(ref.extent).toHaveLength(4);

    const mock = createStacMock(recordWithStac(where));
    setFetchImpl(mock);
    const info = await probeServices(recordWithStac(where));
    expect(info).toEqual(ref);
    expect(info.edrCollection).toBe(EDR);
    expect(info.mapsCollection).toBe(MAPS);
    // the STAC document was fetched (and ignored): it advertises neither data_queries nor an OGC Maps link
    expect(mock.stacCalls).toEqual([`${STAC_HREF}?f=json`]);
  });

  it.each<StacBehaviour>(['404', '403', 'network-error', 'html'])(
    'a failing STAC fetch (%s) does not break detection, wherever the link is',
    async (behaviour) => {
      const ref = await baseline();
      for (const where of ['first', 'last'] as const) {
        clearServiceCache();
        const mock = createStacMock(recordWithStac(where), behaviour);
        setFetchImpl(mock);
        expect(await probeServices(recordWithStac(where))).toEqual(ref);
        expect(mock.stacCalls).toHaveLength(1);
      }
    },
  );

  it('the cached probe (list badges + record page) keeps the result and asks the STAC host once', async () => {
    const ref = await baseline();
    const record = recordWithStac('first');
    const mock = createStacMock(record, '403');
    setFetchImpl(mock);
    const [a, b] = await Promise.all([probeServicesCached(record), probeServicesCached(record)]);
    expect(a).toEqual(ref);
    expect(b).toBe(a);
    expect(mock.stacCalls).toHaveLength(1);
  });

  it('when only the STAC link is a collection and it fails, nothing is detected and nothing throws', async () => {
    setFetchImpl(createStacMock(BASE_RECORD, '404'));
    const only = { links: [recordWithStac('first').links![0]] };
    expect(await probeServices(only)).toEqual({ edr: false, maps: false, queryTypes: [] });
  });
});
