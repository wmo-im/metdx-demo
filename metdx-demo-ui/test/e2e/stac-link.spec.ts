// A WCMP2 record that also links a STAC Collection (rel=collection, application/json): the catalogue is routed to serve
// the ECMWF record with those links added, the polytope collections come from the fixtures and the STAC host answers
// (or fails). The record page must still enable EDR / OGC Maps and list both links. Offline; the ECMWF STAC catalogue is
// not reachable through the app's proxy in the Docker deployment unless its host is allow-listed, which this test does not cover.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './engine';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, any>;
const RECORD_TITLE = 'ECMWF IFS Global Deterministic Forecast (Destination Earth)';
const STAC_HREF = 'https://6a6d74.github.io/ecmwf-stac/stac/collection.json';
const STAC_TITLE = 'STAC catalog: root Collection (IFS 0.1° oper)';
const BROWSER_TITLE = 'STAC Browser for this catalog';

function modifiedRecord(where: 'first' | 'last') {
  const rec = fixture('records/ecmwf-destine-forecast.json');
  const stac = {
    rel: 'collection',
    type: 'application/json',
    href: STAC_HREF,
    title: STAC_TITLE,
    profile: 'https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json',
  };
  const browser = { rel: 'related', type: 'text/html', href: 'https://6a6d74.github.io/ecmwf-stac/browser/', title: BROWSER_TITLE };
  rec.links = where === 'first' ? [stac, ...rec.links, browser] : [...rec.links, stac, browser];
  return rec;
}

for (const where of ['first', 'last'] as const) {
  for (const stac of ['ok', '403'] as const) {
    test(`STAC collection link ${where}, STAC host ${stac}: EDR and OGC Maps stay enabled, both links listed`, async ({ page }) => {
      const record = modifiedRecord(where);
      const stacCalls: string[] = [];
      await page.route('**/api/proxy**', (route) => {
        const upstream = new URL(route.request().url()).searchParams.get('url') ?? '';
        const json = (body: unknown, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (upstream.includes('/collections/wis2-discovery-metadata/items')) {
          return upstream.includes(encodeURIComponent(record.id)) || upstream.includes(`/items/${record.id}`)
            ? json(record)
            : json({ type: 'FeatureCollection', numberMatched: 1, numberReturned: 1, features: [record], links: [] });
        }
        if (upstream.startsWith('https://6a6d74.github.io/')) {
          stacCalls.push(upstream);
          return stac === 'ok'
            ? json({ type: 'Collection', stac_version: '1.1.0', id: 'ecmwf-ifs-oper', links: [{ rel: 'root', href: './collection.json' }] })
            : route.fulfill({ status: 403, contentType: 'text/plain', body: 'Forbidden' });
        }
        const m = upstream.match(/\/collections\/(operational-data|operational_map_server)(\?|$)/);
        return m ? json(fixture(`collections/${m[1]}.json`)) : route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
      });
      await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());

      await page.goto('/');
      await page.getByTestId('result-card').filter({ hasText: RECORD_TITLE }).click();
      await expect(page.getByRole('heading', { name: RECORD_TITLE })).toBeVisible();

      const edr = page.getByRole('link', { name: 'EDR', exact: true });
      const maps = page.getByRole('link', { name: 'OGC Maps', exact: true });
      await expect(edr).toBeEnabled();
      await expect(maps).toBeEnabled();
      expect(decodeURIComponent((await edr.getAttribute('href')) ?? '')).toContain(
        'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data?f=json',
      );
      expect(decodeURIComponent((await maps.getAttribute('href')) ?? '')).toContain('/collections/operational_map_server?f=json');

      const links = page.getByTestId('record-links');
      await expect(links.getByRole('link', { name: STAC_TITLE })).toHaveAttribute('href', STAC_HREF);
      await expect(links.getByRole('link', { name: BROWSER_TITLE })).toBeVisible();
      expect(stacCalls.length).toBeGreaterThan(0);

      // and the EDR page still opens on the polytope collection
      await edr.click();
      await expect(page.getByRole('button', { name: 'position', exact: true })).toBeVisible();
    });
  }
}
