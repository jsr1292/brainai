import { test } from 'node:test';
import { existsSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { CATALOGUE, modelDirOf } from './catalogue.js';
import { E5_FILES, GEMMA_FILES, GEMMA_MODEL } from '../memory/embedder.js';
import { RERANK_FILES, RERANK_MODEL } from '../memory/reranker.js';
import { suggest, type Hardware } from './hardware.js';

const GB = 1024 ** 3;
const hw = (o: Partial<Hardware>): Hardware => ({ arch: 'x64', platform: 'win32', memoryBytes: 16 * GB, freeDiskBytes: 50 * GB, ...o });
const get = (id: string) => CATALOGUE.find((m) => m.id === id)!;

test('catalogue pins equal the ones the loaders use', () => {
  assert.deepEqual(get('gemma').files, GEMMA_FILES);
  assert.equal(get('gemma').repo, GEMMA_MODEL);
  assert.deepEqual(get('mminilm').files, RERANK_FILES);
  assert.equal(get('mminilm').repo, RERANK_MODEL);
  assert.equal(get('e5').repo, 'Xenova/multilingual-e5-small');
  assert.deepEqual(Object.keys(get('e5').files).sort(), ['config.json', 'onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json']);
  assert.deepEqual(get('e5').files, E5_FILES);
});

test('catalogue holds exactly e5, gemma, mminilm, each with bytes, licence and a sentence', () => {
  assert.deepEqual(CATALOGUE.map((m) => m.id), ['e5', 'gemma', 'mminilm']);
  for (const m of CATALOGUE) {
    assert.ok(m.bytes > 0);
    assert.ok(m.licence.length > 0);
    assert.ok(m.measured.length > 0);
    for (const h of Object.values(m.files)) assert.match(h, /^[0-9a-f]{64}$/);
  }
  assert.equal(get('gemma').notice, 'licenses/GEMMA-NOTICE.txt');
});

test('modelDirOf is <dir>/<repo>', () => {
  assert.equal(modelDirOf('/x/models', get('e5')), '/x/models/Xenova/multilingual-e5-small');
});

test('suggest', () => {
  assert.deepEqual(suggest(hw({ arch: 'arm64', platform: 'darwin', memoryBytes: 8 * GB })), { search: 'gemma', rerank: 'mminilm' });
  assert.deepEqual(suggest(hw({ memoryBytes: 16 * GB, freeDiskBytes: 5 * GB })), { search: 'gemma', rerank: 'mminilm' });
  assert.deepEqual(suggest(hw({ memoryBytes: 6 * GB })), { search: 'e5', rerank: 'mminilm' });
  assert.deepEqual(suggest(hw({ memoryBytes: 3 * GB })), { search: 'e5', rerank: null });
  assert.deepEqual(suggest(hw({ memoryBytes: 16 * GB, freeDiskBytes: 500 * 1024 ** 2 })), { search: 'e5', rerank: 'mminilm' });
});

test('suggest at the edges', () => {
  const S = (o: Partial<Hardware>) => suggest(hw(o));
  const gm = { search: 'gemma', rerank: 'mminilm' }, em = { search: 'e5', rerank: 'mminilm' }, en = { search: 'e5', rerank: null };
  assert.deepEqual(S({ memoryBytes: 8 * GB, freeDiskBytes: 5 * GB }), gm);
  assert.deepEqual(S({ memoryBytes: 8 * GB - 1, freeDiskBytes: 5 * GB }), em);
  assert.deepEqual(S({ memoryBytes: 4 * GB }), em);
  assert.deepEqual(S({ memoryBytes: 4 * GB - 1 }), en);
  assert.deepEqual(S({ arch: 'arm64', memoryBytes: 16 * GB, freeDiskBytes: GB }), gm);
  assert.deepEqual(S({ arch: 'arm64', memoryBytes: 16 * GB, freeDiskBytes: GB - 1 }), em);
  assert.deepEqual(S({ arch: 'arm64', memoryBytes: 3 * GB }), en);
  assert.deepEqual(S({ memoryBytes: 4 * GB, freeDiskBytes: 500 * 1024 ** 2 }), em);
});

test('suggest: only an Apple-silicon Mac counts as Apple silicon; a Windows Arm PC goes by its memory', () => {
  const win = { arch: 'arm64', platform: 'win32' } as const;
  assert.deepEqual(suggest(hw({ ...win, memoryBytes: 6 * GB, freeDiskBytes: 2 * GB })), { search: 'e5', rerank: 'mminilm' });
  assert.deepEqual(suggest(hw({ ...win, memoryBytes: 8 * GB, freeDiskBytes: 2 * GB })), { search: 'gemma', rerank: 'mminilm' });
  assert.deepEqual(suggest(hw({ arch: 'arm64', platform: 'darwin', memoryBytes: 6 * GB, freeDiskBytes: 2 * GB })), { search: 'gemma', rerank: 'mminilm' });
});

test('each entry bytes equals the sum of its pinned files under ./models', (t) => {
  for (const m of CATALOGUE) {
    const paths = Object.keys(m.files).map((f) => modelDirOf('models', m) + '/' + f);
    if (!paths.every((p) => existsSync(p))) { t.diagnostic(`skipped ${m.id}`); continue; }
    assert.equal(m.bytes, paths.reduce((n, p) => n + statSync(p).size, 0), m.id);
  }
});
