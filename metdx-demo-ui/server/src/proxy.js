import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPrivateAddress } from './ip.js';

export const PROXY_PATH = '/api/proxy';

const DEFAULT_ALLOWED_HOSTS = [
  'wmo-resource-catalogue.labs.wis2dev.io',
  'dev.api.weather.gc.ca',
  'wis2-gdc.weather.gc.ca',
  'polytope-edr.lumi.apps.dte.destination-earth.eu',
];
const DEFAULT_TRUSTED_INTERNAL_HOSTS = ['metdx-demo-api'];

/** Error carrying the HTTP status to answer with. */
export class ProxyError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Build the server configuration from an env-like object.
 * Entries in the host lists are `host` (any port) or `host:port`.
 * @param {Record<string, string | undefined>} env
 */
export function configFromEnv(env = process.env) {
  const trusted = parseList(env.TRUSTED_INTERNAL_HOSTS, DEFAULT_TRUSTED_INTERNAL_HOSTS);
  const allowed = parseList(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS);
  const timeout = Number(env.UPSTREAM_TIMEOUT_MS);
  return {
    port: Number(env.PORT) || 8551,
    staticDir: env.STATIC_DIR || undefined,
    allowedHosts: allowed,
    trustedInternalHosts: trusted,
    upstreamTimeoutMs: timeout > 0 ? timeout : 150000,
  };
}

function hostMatches(list, hostname, host) {
  return list.includes(hostname) || list.includes(host);
}

/** Default resolver: all addresses of a hostname. */
export async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validate a proxy target. Returns the parsed URL and the vetted address to
 * connect to (so a second DNS answer cannot swap in a private address).
 * @param {string} raw
 * @param {ReturnType<typeof configFromEnv> & {lookup?: typeof defaultLookup}} config
 */
export async function validateTarget(raw, config) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError(400, 'invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError(400, 'unsupported protocol');
  }
  if (url.username || url.password) throw new ProxyError(400, 'credentials in url not allowed');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const host = url.host.toLowerCase();
  const trusted = hostMatches(config.trustedInternalHosts, hostname, host);
  if (!trusted && !hostMatches(config.allowedHosts, hostname, host)) {
    throw new ProxyError(403, `host not allowed: ${hostname}`);
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await (config.lookup ?? defaultLookup)(hostname);
    } catch {
      throw new ProxyError(502, `cannot resolve host: ${hostname}`);
    }
  }
  if (!addresses.length) throw new ProxyError(502, `cannot resolve host: ${hostname}`);
  if (!trusted && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ProxyError(403, `host resolves to a private address: ${hostname}`);
  }
  return { url, address: addresses[0] };
}

/** Build the proxy URL for an absolute target URL. */
export function toProxyUrl(target) {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
];

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

/**
 * Handle `GET /api/proxy?url=`.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} reqUrl
 * @param {ReturnType<typeof configFromEnv> & {lookup?: typeof defaultLookup}} config
 */
export async function handleProxy(req, res, reqUrl, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const raw = reqUrl.searchParams.get('url');
  if (!raw) return sendJson(res, 400, { error: 'missing url parameter' });

  let target;
  try {
    target = await validateTarget(raw, config);
  } catch (err) {
    if (err instanceof ProxyError) return sendJson(res, err.status, { error: err.message });
    throw err;
  }

  const { url, address } = target;
  const client = url.protocol === 'https:' ? https : http;
  const headers = { 'accept-encoding': 'identity', 'user-agent': 'metdx-demo-ui-proxy' };
  if (req.headers.accept) headers.accept = req.headers.accept;

  const upstream = client.request(url, {
    method: req.method,
    headers,
    // Pin the connection to the address that passed validation.
    lookup: (_host, opts, cb) =>
      opts && opts.all
        ? cb(null, [{ address: address.address, family: address.family }])
        : cb(null, address.address, address.family),
  });

  let finished = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    upstream.destroy(new ProxyError(504, 'upstream timeout'));
  }, config.upstreamTimeoutMs);
  const done = () => {
    finished = true;
    clearTimeout(timer);
  };

  upstream.on('error', (err) => {
    if (finished) return;
    done();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof ProxyError) return sendJson(res, err.status, { error: err.message });
    // Say how long we waited: "socket hang up" after ~50 s means the upstream gateway gave up.
    const waited = Math.round((Date.now() - startedAt) / 1000);
    sendJson(res, 502, { error: `upstream error: ${err.message}${waited >= 2 ? ` (after ${waited} s)` : ''}`, elapsedMs: Date.now() - startedAt });
  });

  upstream.on('response', async (up) => {
    const status = up.statusCode ?? 502;
    const location = up.headers.location;

    if (status >= 300 && status < 400 && location) {
      up.resume();
      try {
        const next = new URL(location, url).toString();
        await validateTarget(next, config);
        done();
        return sendJson(res, 200, { status, location: toProxyUrl(next) });
      } catch (err) {
        done();
        if (err instanceof ProxyError) {
          return sendJson(res, err.status, { error: `redirect rejected: ${err.message}` });
        }
        return sendJson(res, 502, { error: 'invalid redirect location' });
      }
    }

    const out = {};
    for (const name of PASS_HEADERS) {
      if (up.headers[name] !== undefined) out[name] = up.headers[name];
    }
    res.writeHead(status, out);
    up.on('end', done);
    up.on('error', () => {
      done();
      res.destroy();
    });
    up.pipe(res);
  });

  res.on('close', () => {
    if (!finished) {
      done();
      upstream.destroy();
    }
  });
  upstream.end();
}
