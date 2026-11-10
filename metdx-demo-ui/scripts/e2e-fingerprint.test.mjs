// node --test scripts/e2e-fingerprint.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { computeFingerprint, isBuildFresh } from './e2e-fingerprint.mjs';

let root;
const put = (rel, text = 'x') => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const fp = (env = {}, version = 'v1') => computeFingerprint({ root, env, version });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'e2e-fp-'));
  for (const f of ['src/main.tsx', 'src/lib/a.ts', 'public/favicon.svg', 'test/fixtures/edr/a.json', 'index.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json']) {
    put(f);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('computeFingerprint', () => {
  it('is stable without changes', () => {
    assert.equal(fp(), fp());
  });

  it('changes with a fixture, a source, a public file, a config file', () => {
    for (const f of ['test/fixtures/edr/a.json', 'src/lib/a.ts', 'public/favicon.svg', 'vite.config.ts', 'tsconfig.app.json', 'package-lock.json']) {
      const before = fp();
      put(f, 'changed, longer content');
      assert.notEqual(fp(), before, f);
    }
  });

  it('changes when only the mtime changes', () => {
    const before = fp();
    utimesSync(join(root, 'test/fixtures/edr/a.json'), new Date(), new Date(Date.now() + 5000));
    assert.notEqual(fp(), before);
  });

  it('changes with a new, a deleted and a renamed file', () => {
    let before = fp();
    put('test/fixtures/maps/new.png');
    assert.notEqual(fp(), before, 'new fixture');
    before = fp();
    rmSync(join(root, 'src/lib/a.ts'));
    assert.notEqual(fp(), before, 'deleted source');
    before = fp();
    renameSync(join(root, 'test/fixtures/edr/a.json'), join(root, 'test/fixtures/edr/b.json'));
    assert.notEqual(fp(), before, 'renamed fixture');
  });

  it('changes with any .env* file', () => {
    let before = fp();
    put('.env', 'VITE_X=1');
    assert.notEqual(fp(), before, 'new .env');
    before = fp();
    put('.env', 'VITE_X=2');
    assert.notEqual(fp(), before, 'edited .env');
    before = fp();
    put('.env.production.local', 'VITE_Y=1');
    assert.notEqual(fp(), before, '.env.production.local');
  });

  it('changes with the VITE_* environment only', () => {
    const base = fp();
    assert.notEqual(fp({ VITE_ENABLE_LEAFLET: '1' }), base);
    assert.notEqual(fp({ VITE_ENABLE_LEAFLET: '1' }), fp({ VITE_ENABLE_LEAFLET: '0' }));
    assert.equal(fp({ PATH: '/bin', HOME: '/x' }), base, 'non-VITE variables are ignored');
    assert.equal(fp({ VITE_A: '1', VITE_B: '2' }), fp({ VITE_B: '2', VITE_A: '1' }), 'order does not matter');
  });

  it('changes with the script version', () => {
    assert.notEqual(fp({}, 'v1'), fp({}, 'v2'));
  });

  it('ignores test files under src/ and unrelated files', () => {
    const before = fp();
    put('src/lib/a.test.ts');
    put('src/pages/x.test.tsx');
    put('README.md');
    put('test/e2e/app.spec.ts');
    put('dist/index.html');
    assert.equal(fp(), before);
  });
});

describe('isBuildFresh', () => {
  const setup = (fingerprint, { stampOlder = false } = {}) => {
    const indexPath = put('dist/index.html');
    const stampPath = put('dist/.e2e-build.json', JSON.stringify({ fingerprint }));
    if (stampOlder) utimesSync(stampPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    return { stampPath, indexPath, fingerprint };
  };

  it('is fresh with a matching stamp that is not older than index.html', () => {
    assert.equal(isBuildFresh(setup('abc')), true);
  });
  it('is stale when the fingerprint differs', () => {
    assert.equal(isBuildFresh({ ...setup('abc'), fingerprint: 'def' }), false);
  });
  it('is stale when the stamp or index.html is missing, or the stamp is corrupt', () => {
    const args = setup('abc');
    writeFileSync(args.stampPath, '{nope');
    assert.equal(isBuildFresh(args), false, 'corrupt');
    rmSync(args.stampPath);
    assert.equal(isBuildFresh(args), false, 'no stamp');
    put('dist/.e2e-build.json', JSON.stringify({ fingerprint: 'abc' }));
    rmSync(args.indexPath);
    assert.equal(isBuildFresh(args), false, 'no index');
  });
  it('is stale when index.html is newer than the stamp', () => {
    assert.equal(isBuildFresh(setup('abc', { stampOlder: true })), false);
  });
  it('is stale when forced', () => {
    assert.equal(isBuildFresh({ ...setup('abc'), force: true }), false);
  });
});
