import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { startTestApp } from '../testing/helpers.js';

async function app(t: TestContext) {
  const a = await startTestApp();
  t.after(() => a.close());
  return a;
}

test('the vendored Mermaid and DOMPurify are served as modules, cached for a year by their versioned folder', async (t) => {
  const a = await app(t);
  for (const path of ['/static/vendor/mermaid-12.3.0/mermaid.esm.min.mjs', '/static/vendor/dompurify-3.4.17/purify.es.mjs']) {
    const r = await fetch(a.baseUrl + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/, path);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
  }
  const plain = await fetch(a.baseUrl + '/static/app.js');
  assert.doesNotMatch(plain.headers.get('cache-control') ?? '', /immutable/);
});

test('the vendored folders hold the chunks and licences, and no source maps', () => {
  const root = new URL('./static/vendor/', import.meta.url);
  const chunks = readdirSync(new URL('mermaid-12.3.0/chunks/mermaid.esm.min/', root));
  assert.ok(chunks.length > 50 && chunks.every((f) => f.endsWith('.mjs')), `${chunks.length} chunks`);
  assert.ok(readdirSync(new URL('mermaid-12.3.0/', root)).includes('LICENSE'));
  assert.ok(readdirSync(new URL('dompurify-3.4.17/', root)).includes('LICENSE'));
  const all = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(new URL(`${e.name}/`, dir)) : [e.name]));
  assert.deepEqual(all(root).filter((f) => f.endsWith('.map')), []);
});
