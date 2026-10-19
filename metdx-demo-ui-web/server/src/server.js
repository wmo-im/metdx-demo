import http from 'node:http';
import { configFromEnv, handleProxy, PROXY_PATH } from './proxy.js';
import { serveStatic } from './static.js';

/**
 * Create the HTTP server (not yet listening).
 * @param {Partial<ReturnType<typeof configFromEnv>> & {lookup?: Function}} [overrides]
 */
export function createServer(overrides = {}) {
  const config = { ...configFromEnv(), ...overrides };
  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://localhost');
      if (reqUrl.pathname === PROXY_PATH) return await handleProxy(req, res, reqUrl, config);
      if (reqUrl.pathname === '/api' || reqUrl.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      if (reqUrl.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (config.staticDir && (await serveStatic(req, res, reqUrl.pathname, config.staticDir))) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal error"}');
    }
  });
}
