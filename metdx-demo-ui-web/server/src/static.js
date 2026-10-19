import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function statFile(p) {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * Serve a file from `root`; unknown paths fall back to index.html (SPA).
 * @returns {Promise<boolean>} true if handled
 */
export async function serveStatic(req, res, pathname, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end();
    return true;
  }
  const base = path.resolve(root);
  let file = path.join(base, decoded);
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return true;
  }
  let st = await statFile(file);
  let spa = false;
  if (!st) {
    // Missing asset (has an extension) is a real 404; other paths are SPA routes.
    if (path.extname(decoded)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return true;
    }
    file = path.join(base, 'index.html');
    st = await statFile(file);
    spa = true;
    if (!st) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return true;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': st.size,
  };
  // Vite hashed assets are immutable; HTML must always revalidate.
  headers['cache-control'] =
    !spa && decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}
