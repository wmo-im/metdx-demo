// Build fingerprint for scripts/e2e-server.mjs: a hash of everything a `vite build` of the app depends on, so an existing
// build in dist/ is reused only when none of it changed (content edits, added/deleted/renamed files, env, this script).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Bump when the way the fingerprint is made changes (the sources of the scripts are hashed as well, see e2e-server.mjs). */
export const FINGERPRINT_VERSION = 1;

// Directories walked recursively. Test files under src/ are never imported by the app, so they are skipped; everything
// under test/fixtures is bundled by src/lib/mockFetch.ts (import.meta.glob) and is therefore an input.
const DIRS = ['src', 'public', 'test/fixtures'];
// Single files in the root; plus every `.env*` file (Vite loads .env, .env.local, .env.production, ...).
const FILES = ['index.html', 'vite.config.ts', 'package.json', 'package-lock.json'];
const isRootInput = (name) => FILES.includes(name) || /^tsconfig.*\.json$/.test(name) || name.startsWith('.env');
const isTestFile = (rel) => /^src\/.*\.test\.[jt]sx?$/.test(rel);

/** Sorted `[relative path, size, mtimeMs]` entries of the build inputs below `root` (missing paths are just absent). */
export function listInputs(root) {
  const entries = [];
  const add = (path, st) => entries.push([relative(root, path).split(sep).join('/'), st.size, st.mtimeMs]);
  const visit = (path) => {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!isTestFile(relative(root, path).split(sep).join('/'))) {
      add(path, st);
    }
  };
  for (const dir of DIRS) visit(join(root, dir));
  for (const name of readdirSync(root)) {
    if (!isRootInput(name)) continue;
    const st = statSync(join(root, name), { throwIfNoEntry: false });
    if (st?.isFile()) add(join(root, name), st);
  }
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The VITE_* variables of `env`, sorted by name. */
export function viteEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => k.startsWith('VITE_') && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** sha256 over the inputs, the effective VITE_* environment and `version` (e.g. a hash of the scripts' own sources). */
export function computeFingerprint({ root, env = process.env, version = '' }) {
  return createHash('sha256')
    .update(JSON.stringify({ v: FINGERPRINT_VERSION, version, env: viteEnv(env), inputs: listInputs(root) }))
    .digest('hex');
}

/** Whether the stamp holds `fingerprint` and is not older than the built index.html (a later build into the same dir is stale). */
export function isBuildFresh({ stampPath, indexPath, fingerprint, force = false }) {
  if (force || !existsSync(stampPath)) return false;
  const index = statSync(indexPath, { throwIfNoEntry: false });
  if (!index) return false;
  let stamped;
  try {
    stamped = JSON.parse(readFileSync(stampPath, 'utf8')).fingerprint;
  } catch {
    return false;
  }
  return stamped === fingerprint && statSync(stampPath).mtimeMs >= index.mtimeMs;
}
