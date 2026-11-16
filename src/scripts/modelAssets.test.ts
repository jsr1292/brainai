import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE } from '../models/catalogue.js';
import { DEFAULT_SOURCES, githubAssetName } from '../models/download.js';
import { modelAssets } from './modelAssets.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = modelAssets({ repoRoot, sizeOf: () => 7 });
const EXTRA = ['GEMMA-TERMS.md', 'GEMMA-PROHIBITED-USE-POLICY.md'];

test('every model file is named as the downloader names it on GitHub, with the downloader\'s Hugging Face url', () => {
  for (const m of CATALOGUE) for (const file of Object.keys(m.files)) {
    const a = assets.find((x) => x.url === DEFAULT_SOURCES[0](m, file));
    assert.ok(a, `${m.id}/${file}`);
    assert.equal(a.name, basename(DEFAULT_SOURCES[1](m, file)));
    assert.equal(a.name, githubAssetName(m, file));
    assert.equal(a.sha256, m.files[file]);
  }
});

test('one entry per catalogue file plus the notice files', () => {
  const files = CATALOGUE.reduce((n, m) => n + Object.keys(m.files).length, 0);
  const notices = CATALOGUE.filter((m) => m.notice).length * (1 + EXTRA.length);
  assert.equal(assets.length, files + notices);
  const local = assets.filter((a) => a.url.startsWith('file:'));
  assert.equal(local.length, notices);
  for (const a of local) assert.equal(a.sha256, createHash('sha256').update(readFileSync(join(repoRoot, a.url.slice(5)))).digest('hex'));
  assert.equal(new Set(assets.map((a) => a.name)).size, assets.length);
});

test('every sha256 is 64 hex and every given size a positive number', () => {
  for (const a of assets) { assert.match(a.sha256, /^[0-9a-f]{64}$/); assert.ok(a.bytes === undefined || a.bytes > 0); }
});

test('the reserved bge-m3-rerank never appears', () => {
  assert.ok(!assets.some((a) => /bge-m3/i.test(a.name) || /bge-m3/i.test(a.url)));
});

test('bytes come from the local file when it exists and are omitted when it does not', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = CATALOGUE[0];
  const file = Object.keys(m.files)[0];
  mkdirSync(dirname(join(dir, m.repo, file)), { recursive: true });
  writeFileSync(join(dir, m.repo, file), 'twelve bytes');
  const list = modelAssets({ repoRoot, modelsDir: dir });
  assert.equal(list.find((a) => a.name === githubAssetName(m, file))?.bytes, 12);
  const others = list.filter((a) => !a.url.startsWith('file:') && a.name !== githubAssetName(m, file));
  assert.ok(others.length > 0 && others.every((a) => !('bytes' in a)));
  const none = modelAssets({ repoRoot, modelsDir: join(dir, 'absent') });
  assert.ok(none.length > 0 && none.filter((a) => !a.url.startsWith('file:')).every((a) => a.bytes === undefined));
});
