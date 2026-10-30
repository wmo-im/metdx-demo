import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isPrivateAddress } from '../src/ip.js';
import { configFromEnv } from '../src/proxy.js';
import { createServer } from '../src/server.js';

// 1x1 PNG with bytes that would be mangled by text decoding.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const BIG_BINARY = Buffer.from(Array.from({ length: 256 * 64 }, (_, i) => i % 256));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

describe('proxy', () => {
  let upstream;
  let upPort;
  const sockets = new Set();
  let staticDir;

  before(async () => {
    upstream = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      switch (u.pathname) {
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accept: req.headers.accept ?? null, q: u.search }));
          break;
        case '/image.png':
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(PNG);
          break;
        case '/big.bin':
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(BIG_BINARY);
          break;
        case '/job':
          res.writeHead(303, { location: '/jobs/42/results?x=1' });
          res.end();
          break;
        case '/job-abs':
          res.writeHead(302, { location: `http://127.0.0.1:${upPort}/abs` });
          res.end();
          break;
        case '/to-evil':
          res.writeHead(302, { location: 'http://evil.example/steal' });
          res.end();
          break;
        case '/to-private':
          res.writeHead(302, { location: `http://localhost:${upPort}/json` });
          res.end();
          break;
        case '/to-file':
          res.writeHead(302, { location: 'file:///etc/passwd' });
          res.end();
          break;
        case '/not-modified':
          res.writeHead(304);
          res.end();
          break;
        case '/missing':
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{"error":"nope"}');
          break;
        case '/slow':
          // never answers
          break;
        case '/hangup':
          // like a gateway giving up: close without any response
          setTimeout(() => req.socket.destroy(), 2100);
          break;
        default:
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('default');
      }
    });
    upstream.on('connection', (s) => sockets.add(s));
    upPort = await listen(upstream);

    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>spa</html>');
    fs.mkdirSync(path.join(staticDir, 'assets'));
    fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await close(upstream);
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  /** Start a proxy server with the config and return a fetch helper. */
  async function withProxy(config, fn) {
    const server = createServer({
      port: 0,
      staticDir: undefined,
      allowedHosts: [],
      trustedInternalHosts: [],
      upstreamTimeoutMs: 5000,
      ...config,
    });
    const port = await listen(server);
    try {
      await fn((p, init) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', ...init }));
    } finally {
      await close(server);
    }
  }
  const proxied = (target) => `/api/proxy?url=${encodeURIComponent(target)}`;
  const trusted = () => ({ trustedInternalHosts: ['127.0.0.1'] });

  it('fetches an allowed upstream and passes status, content-type and body', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/json?a=1&b=2`), {
        headers: { accept: 'application/geo+json' },
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await r.json(), { ok: true, accept: 'application/geo+json', q: '?a=1&b=2' });
    });
  });

  it('passes upstream error statuses through', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/missing`));
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'nope' });
    });
  });

  it('answers 502 with the waited time when the upstream drops the connection without a response', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/hangup`));
      assert.equal(r.status, 502);
      const body = await r.json();
      assert.match(body.error, /^upstream error: socket hang up \(after \d+ s\)$/);
      assert.ok(body.elapsedMs >= 2000);
    });
  });

  it('passes 3xx without location through unchanged', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/not-modified`));
      assert.equal(r.status, 304);
    });
  });

  it('connects to the vetted address for an allowed hostname (trusted + custom DNS)', async () => {
    const lookup = async (host) => {
      assert.equal(host, 'metdx-demo-api');
      return [{ address: '127.0.0.1', family: 4 }];
    };
    await withProxy({ trustedInternalHosts: ['metdx-demo-api'], lookup }, async (get) => {
      const r = await get(proxied(`http://metdx-demo-api:${upPort}/json`));
      assert.equal(r.status, 200);
      assert.equal((await r.json()).ok, true);
    });
  });

  it('rejects a host that is not in the allow-list with 403', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied('http://evil.example/x'));
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /not allowed/);
    });
  });

  it('rejects an allow-listed host that resolves to a private IP with 403', async () => {
    await withProxy({ allowedHosts: ['localhost'] }, async (get) => {
      const r = await get(proxied(`http://localhost:${upPort}/json`));
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /private/);
    });
  });

  it('checks the resolved IP, not the hostname (DNS pointing to private range)', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await withProxy({ allowedHosts: ['wis2-gdc.weather.gc.ca'], lookup }, async (get) => {
      const r = await get(proxied('https://wis2-gdc.weather.gc.ca/collections'));
      assert.equal(r.status, 403);
    });
  });

  it('rejects an allow-listed private IP literal with 403', async () => {
    await withProxy({ allowedHosts: ['127.0.0.1'] }, async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/json`));
      assert.equal(r.status, 403);
    });
  });

  it('rejects non-http protocols and bad input', async () => {
    await withProxy(trusted(), async (get) => {
      assert.equal((await get(proxied('file:///etc/passwd'))).status, 400);
      assert.equal((await get(proxied('not a url'))).status, 400);
      assert.equal((await get('/api/proxy')).status, 400);
      assert.equal((await get(proxied('http://user:pw@127.0.0.1/'))).status, 400);
    });
  });

  it('only accepts GET/HEAD', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/json`), { method: 'POST', body: 'x' });
      assert.equal(r.status, 405);
    });
  });

  it('turns a 303 into 200 JSON with the location rewritten to a proxy URL', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/job`));
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.status, 303);
      assert.equal(
        body.location,
        `/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/jobs/42/results?x=1`)}`,
      );
      // The rewritten location is directly usable.
      const follow = await get(body.location);
      assert.equal(follow.status, 200);
    });
  });

  it('rewrites absolute redirect locations too', async () => {
    await withProxy(trusted(), async (get) => {
      const body = await (await get(proxied(`http://127.0.0.1:${upPort}/job-abs`))).json();
      assert.equal(body.status, 302);
      assert.equal(body.location, `/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/abs`)}`);
    });
  });

  it('rejects a redirect to a disallowed host', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/to-evil`));
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /redirect rejected/);
    });
  });

  it('rejects a redirect to an allowed host that resolves to a private IP', async () => {
    await withProxy({ trustedInternalHosts: ['127.0.0.1'], allowedHosts: ['localhost'] }, async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/to-private`));
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /redirect rejected/);
    });
  });

  it('rejects a redirect to a non-http scheme', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/to-file`));
      assert.equal(r.status, 400);
    });
  });

  it('passes PNG bytes through unchanged', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/image.png`));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
    });
  });

  it('streams large binary bodies intact', async () => {
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${upPort}/big.bin`));
      assert.equal(r.headers.get('content-type'), 'application/octet-stream');
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(BIG_BINARY));
    });
  });

  it('answers 504 when the upstream does not respond in time', async () => {
    await withProxy({ ...trusted(), upstreamTimeoutMs: 150 }, async (get) => {
      const t0 = Date.now();
      const r = await get(proxied(`http://127.0.0.1:${upPort}/slow`));
      assert.equal(r.status, 504);
      assert.ok(Date.now() - t0 < 3000);
    });
  });

  it('answers 502 when the upstream is unreachable', async () => {
    const dead = http.createServer();
    const port = await listen(dead);
    await close(dead);
    await withProxy(trusted(), async (get) => {
      const r = await get(proxied(`http://127.0.0.1:${port}/`));
      assert.equal(r.status, 502);
    });
  });

  it('serves static files with SPA fallback and does not shadow /api', async () => {
    await withProxy({ staticDir }, async (get) => {
      let r = await get('/');
      assert.equal(r.status, 200);
      assert.equal(await r.text(), '<html>spa</html>');

      r = await get('/record/abc/edr?col=x');
      assert.equal(r.status, 200);
      assert.equal(await r.text(), '<html>spa</html>');

      r = await get('/assets/app.js');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /javascript/);

      assert.equal((await get('/assets/missing.js')).status, 404);
      assert.equal((await get('/api/unknown')).status, 404);
      // Path traversal is refused (or, if normalised by the client, falls back to the SPA page).
      for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd']) {
        const t = await get(p);
        assert.ok([200, 403].includes(t.status), p);
        assert.ok(!(await t.text()).includes('root:'), p);
      }
    });
  });
});

describe('isPrivateAddress', () => {
  it('flags private, loopback, link-local and mapped addresses', () => {
    for (const a of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
      'garbage',
    ]) {
      assert.equal(isPrivateAddress(a), true, a);
    }
  });
  it('allows public addresses', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPrivateAddress(a), false, a);
    }
  });
});

describe('configFromEnv', () => {
  it('has sane defaults', () => {
    const c = configFromEnv({});
    assert.equal(c.port, 8551);
    assert.equal(c.upstreamTimeoutMs, 150000);
    assert.equal(c.staticDir, undefined);
    assert.ok(c.allowedHosts.includes('wmo-resource-catalogue.labs.wis2dev.io'));
    assert.ok(c.allowedHosts.includes('dev.api.weather.gc.ca'));
    assert.ok(c.allowedHosts.includes('wis2-gdc.weather.gc.ca'));
    assert.ok(c.allowedHosts.includes('polytope-edr.lumi.apps.dte.destination-earth.eu'));
    assert.deepEqual(c.trustedInternalHosts, ['metdx-demo-api']);
  });
  it('reads env overrides', () => {
    const c = configFromEnv({
      PORT: '9000',
      STATIC_DIR: '/srv/www',
      ALLOWED_HOSTS: 'A.example, b.example',
      TRUSTED_INTERNAL_HOSTS: 'svc',
      UPSTREAM_TIMEOUT_MS: '1000',
    });
    assert.deepEqual(
      { port: c.port, staticDir: c.staticDir, upstreamTimeoutMs: c.upstreamTimeoutMs },
      { port: 9000, staticDir: '/srv/www', upstreamTimeoutMs: 1000 },
    );
    assert.deepEqual(c.allowedHosts, ['a.example', 'b.example']);
    assert.deepEqual(c.trustedInternalHosts, ['svc']);
  });
});
