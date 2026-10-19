# metdx-demo-ui-web

A browser UI for the metdx demo, styled after [ogcbrowser.rauhala.app](https://ogcbrowser.rauhala.app/)
(left sidebar, map in the centre, request bar at the bottom). It follows the same flow as the Flet app in
`../metdx-demo-ui`: catalogue search -> record page -> EDR query builder or Maps view.

Stack: React + TypeScript + Vite + MUI + OpenLayers. A small dependency-free Node server (`server/`) serves the
built app and an allow-listed CORS proxy at `/api/proxy?url=<upstream url>`.

Requires Node 22+.

## Development

Two processes: the proxy server (port 8551) and the Vite dev server (port 5173, which forwards `/api` to the proxy).

```sh
npm ci
node server/src/index.js     # terminal 1: proxy on :8551
npm run dev                  # terminal 2: app on http://localhost:5173
```

Set `METDX_PROXY_TARGET` to point the dev server at a different proxy.

### Mock mode (offline)

Open `http://localhost:5173/?mock=1` to replay the fixtures in `test/fixtures/` instead of calling the network
(a "mock data" chip shows in the app bar). The setting is remembered for the browser tab (sessionStorage), so it
survives in-app navigation and reloads. Use `?mock=0` to switch it off again. Building with `VITE_MOCK=1`
forces it on.

### Records source (local or live)

By default the catalogue searches the **records bundled with the app** (`src/data/records/*.json`, copies of the
Flet app's fixtures; like its `METDX_TEST` mode) instead of the live WIS2 Global Discovery Catalogue. Search is done
in the browser (case-insensitive; every word must occur in the title, description or keywords; empty = list all),
10 results per page, and a record page opens by id from the same set. EDR and OGC Maps calls are not affected: they
still go live through the proxy (unless `?mock=1`). The catalogue shows a "local records" / "WIS2 GDC" chip. To
add or change local records, edit the JSON files in `src/data/records/` and rebuild (`test/fixtures/records/` is a
separate copy used by the tests).

Switch with `recordsSource` in `config.json` or `?records=gdc|local` (see Configuration).

## Tests

```sh
npm test                      # vitest (unit + component tests), non-watch
npm --prefix server ci && npm --prefix server test   # proxy server tests (node:test)
```

## End-to-end tests

Playwright runs against a production build served by `vite preview`, in mock mode:

```sh
npx playwright install chromium   # once
npm run e2e
```

## Docker

Multi-stage image: Node builds the app, then a `node:22-alpine` runtime (non-root user `node`) runs the server with
`STATIC_DIR=/app/dist` on port 8550.

```sh
docker build -t metdx-demo-ui-web .
docker run --rm -p 8550:8550 metdx-demo-ui-web
# or, from the repository root, with the compose file:
docker compose up --build metdx-demo-ui-web
```

Then open <http://localhost:8550/>. Health check: `/healthz`.

## Configuration

Server environment variables (see `server/src/proxy.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8551` (image and compose: `8550`) | Listen port |
| `STATIC_DIR` | unset (image: `/app/dist`) | Directory of the built app to serve |
| `ALLOWED_HOSTS` | `wis2-gdc.weather.gc.ca,polytope-edr.lumi.apps.dte.destination-earth.eu` | Comma-separated upstream hosts (`host` or `host:port`) the proxy may call |
| `TRUSTED_INTERNAL_HOSTS` | `metdx-demo-api` | Hosts allowed even though they resolve to private addresses |
| `UPSTREAM_TIMEOUT_MS` | `150000` | Upstream timeout; exceeded -> 504 |

All other hosts, and any host resolving to a private, loopback or link-local address (also for redirect
targets), are rejected with 403. Redirects are not followed: a 3xx is returned as HTTP 200 JSON
`{status, location}` so the client can poll EDR jobs.

Runtime app config, `public/config.json` (copied to `dist/config.json`, read by the browser at startup, so it can
be edited in a deployed build or image without rebuilding; a missing or invalid file means the defaults):

| Key | Default | Meaning |
| --- | --- | --- |
| `recordsSource` | `"local"` | `"local"`: catalogue search uses the bundled records. `"gdc"`: live WIS2 GDC (through the proxy unless `proxy` is `false`). |
| `proxy` | `true` | `true`: upstream calls go through the same-origin `/api/proxy`. `false`: the browser calls the upstream servers directly (they must send CORS headers); redirects are then followed by the browser. Used by the GitHub Pages build. |

`?records=local` or `?records=gdc` in the URL overrides the file for that page load (it is not remembered across
reloads without the parameter). In the container, e.g.
`docker run -v ./my-config.json:/app/dist/config.json:ro -p 8550:8550 metdx-demo-ui-web`.

Build-time (Vite) settings, passed as Docker build args or env vars for `npm run build`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_BASEMAP_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | XYZ tile template for the basemap |
| `VITE_BASEMAP_ATTRIBUTION` | OpenStreetMap contributors | Attribution HTML shown on the map |
| `VITE_MOCK` | unset | `1` forces mock mode |
| `VITE_BASE` | `/` | Public base path the app is served under (assets and `config.json` are resolved against it) |
| `VITE_ROUTER` | unset | `hash`: use hash routing (`#/record/...`) so reloads and deep links work on static hosts |

```sh
docker build --build-arg VITE_BASEMAP_URL='https://tiles.example.com/{z}/{x}/{y}.png' \
  --build-arg VITE_BASEMAP_ATTRIBUTION='&copy; Example' -t metdx-demo-ui-web .
```

**Basemap and the OpenStreetMap tile usage policy.** The default basemap uses the public OSM tile servers, which
are for light use only (see <https://operations.osmfoundation.org/policies/tiles/>): no heavy use, no bulk
download, keep the attribution. For anything beyond a demo, set `VITE_BASEMAP_URL` to a tile provider or your own
tile server.

## GitHub Pages

The workflow `.github/workflows/publish-demo-ui-web.yaml` publishes the app next to the Flet demo, at
<https://wmo-im.github.io/metdx-demo/metdx-demo-ui-web/> (Flet demo: `.../metdx-demo-ui/`). On every push to `main`
that touches `metdx-demo-ui-web/**` (or manually, via *Run workflow*) it runs `npm ci`, `npm test` and
`npm run build:pages`, and deploys `dist/` to the `metdx-demo-ui-web` folder of the `gh-pages` branch. It shares the
`pages` concurrency group with the Flet workflow, so the two deployments never run at once.

GitHub Pages is static hosting, so `npm run build:pages` differs from the normal build:

- base path `/metdx-demo/metdx-demo-ui-web/` (`VITE_BASE`; override with `PAGES_BASE=/other/path/ npm run build:pages`);
- hash routing (`VITE_ROUTER=hash`): URLs look like `.../metdx-demo-ui-web/#/record/...`, so a reload never 404s.
  Query parameters such as `?records=gdc` or `?mock=1` go before the `#`: `.../metdx-demo-ui-web/?records=gdc`;
- `"proxy": false` in `dist/config.json`: there is no proxy on Pages, so the browser calls the WIS2 GDC and the
  EDR / OGC Maps server directly. This works because those servers answer with `Access-Control-Allow-Origin` for
  the `github.io` origin (including the Maps PNG, which the app fetches as a blob). Records are the bundled ones
  unless `recordsSource` is `gdc`. If a server stops sending CORS headers, requests fail in the browser with a
  network error.

To try it locally: `npm run build:pages`, copy `dist/` to `<tmp>/metdx-demo/metdx-demo-ui-web/` and serve `<tmp>`
(e.g. `python3 -m http.server`), then open `http://localhost:8000/metdx-demo/metdx-demo-ui-web/`. The Docker image
is unaffected: it keeps the default base `/`, history routing and `"proxy": true`.

## Running alongside the Flet app

The two UIs are independent and can run at the same time; both only talk to the same upstream services. This app
uses port 8550 (container) and 5173/8551 (dev). If you run the Flet app in web mode, give it a different port, e.g.
`flet run --web --port 8560 ./main.py` in `../metdx-demo-ui`. Inside the compose network the proxy reaches
`metdx-demo-api` directly (it is a trusted internal host); other compose services are not reachable unless added to
`TRUSTED_INTERNAL_HOSTS`.
