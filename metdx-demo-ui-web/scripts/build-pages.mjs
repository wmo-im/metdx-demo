// GitHub Pages build: static hosting under a sub-path, no proxy, hash routing.
// Usage (via `npm run build:pages`): PAGES_BASE overrides the default base path.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.PAGES_BASE ?? '/metdx-demo/metdx-demo-ui-web/';

const res = spawnSync('npx', ['vite', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_BASE: base, VITE_ROUTER: 'hash' },
});
if (res.status !== 0) process.exit(res.status ?? 1);

// Pages is static: call the upstream servers directly from the browser.
const configPath = new URL('../dist/config.json', import.meta.url);
const config = { ...JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8')), proxy: false };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`build:pages: base ${base}, hash routing, proxy disabled in dist/config.json`);
