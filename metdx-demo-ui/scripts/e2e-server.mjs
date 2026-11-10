// Web server of the Playwright run (playwright.config.ts): builds the app only when the existing build is stale, then serves
// it with `vite preview` IN THIS PROCESS (so when Playwright stops the server nothing is left listening on the port).
// Usage: node scripts/e2e-server.mjs <port> [outDir]   (VITE_* variables of the environment go to the build, e.g. VITE_ENABLE_LEAFLET=1)
//
// A build is fresh when the stamp <outDir>/.e2e-build.json (written here after a successful build) holds the same
// fingerprint as now (scripts/e2e-fingerprint.mjs: path/size/mtime of src/ without tests, public/, test/fixtures/,
// index.html, vite/ts/package config and .env* files, plus the VITE_* environment and the sources of these scripts)
// and is not older than <outDir>/index.html (so a later `npm run build:pages` or `vite build` into the same directory
// counts as stale). Force a rebuild with E2E_REBUILD=1.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build, preview } from 'vite';
import { computeFingerprint, isBuildFresh } from './e2e-fingerprint.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 4173);
const outDir = process.argv[3] ?? 'dist';
const stampPath = join(root, outDir, '.e2e-build.json');

/** The scripts' own version: a change of how the build is made invalidates old stamps. */
const scriptVersion = createHash('sha256')
  .update(readFileSync(new URL('./e2e-server.mjs', import.meta.url)))
  .update(readFileSync(new URL('./e2e-fingerprint.mjs', import.meta.url)))
  .digest('hex');

// Fingerprint BEFORE building: edits made while the build runs make the next run rebuild instead of being missed.
const fingerprint = computeFingerprint({ root, version: scriptVersion });

if (isBuildFresh({ stampPath, indexPath: join(root, outDir, 'index.html'), fingerprint, force: process.env.E2E_REBUILD === '1' })) {
  console.log(`e2e-server: ${outDir}/ is up to date, not rebuilding (E2E_REBUILD=1 forces it)`);
} else {
  console.log(`e2e-server: building into ${outDir}/ ...`);
  await build({ root, logLevel: 'warn', build: { outDir } });
  writeFileSync(stampPath, JSON.stringify({ fingerprint, builtAt: new Date().toISOString() }));
}

const server = await preview({ root, build: { outDir }, preview: { port, strictPort: true } });
server.printUrls();
const stop = () => server.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
