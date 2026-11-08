import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRerankerFiles, createLocalReranker, oneAtATime, RERANK_FILES, rerankerDir, startReranker } from './reranker.js';

test('checkRerankerFiles accepts the pinned bytes and refuses any others, naming both hashes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rerank-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(rerankerDir(dir), 'onnx'), { recursive: true });
  writeFileSync(join(rerankerDir(dir), 'onnx', 'm.onnx'), 'pinned bytes');
  const good = createHash('sha256').update('pinned bytes').digest('hex');
  assert.doesNotThrow(() => checkRerankerFiles(dir, { 'onnx/m.onnx': good }));
  const other = RERANK_FILES['tokenizer.json']!;
  assert.throws(() => checkRerankerFiles(dir, { 'onnx/m.onnx': other }), (e: Error) => e.message.includes(good) && e.message.includes(other));
});

test('checkRerankerFiles says the reranker is missing when a pinned file is not there', () => {
  assert.throws(() => checkRerankerFiles(join(tmpdir(), 'no-such-dir-rerank')), /missing/i);
});

test('the pins cover the model file and the three files the tokenizer and model read', () => {
  assert.deepEqual(Object.keys(RERANK_FILES).sort(), ['config.json', 'onnx/model_qint8_arm64.onnx', 'tokenizer.json', 'tokenizer_config.json']);
  assert.equal(rerankerDir('/m'), '/m/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1');
});

test('startReranker: off loads nothing; a load failure is logged and recall goes on without it', async (t) => {
  let loads = 0;
  const fine = { async score(_q: string, texts: string[]) { return texts.map(() => 0); } };
  const ok = async () => { loads++; return fine; };
  assert.equal(await startReranker({ rerank: false, modelDir: '/m' }, ok), undefined);
  assert.equal(loads, 0);
  assert.equal(await startReranker({ rerank: true, modelDir: '/m' }, ok), fine);
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: string) => { errors.push(String(m)); });
  assert.equal(await startReranker({ rerank: true, modelDir: '/m' }, async () => { throw new Error('no file'); }), undefined);
  assert.deepEqual(errors, ['reranker unavailable (no file): recall keeps its plain order']);
});

test('loading the reranker offline from a model folder without it says it is missing, plainly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rerank-none-'));
  try {
    await assert.rejects(createLocalReranker({ modelDir: dir, allowRemote: false }), /The reranker model is missing .*npm run model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('oneAtATime scores in batches of at most `size`, never two at once, scores in the texts\' order', async () => {
  let running = 0; let most = 0; const sizes: number[] = [];
  const inner = {
    async score(_q: string, texts: string[]) {
      running++; most = Math.max(most, running); sizes.push(texts.length);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return texts.map((t) => Number(t));
    },
  };
  const r = oneAtATime(inner, 5);
  const texts = Array.from({ length: 12 }, (_, i) => String(i));
  const [a, b, c] = await Promise.all([r.score('q', texts), r.score('q', texts.slice(0, 3)), r.score('q', [])]);
  assert.deepEqual(a, texts.map(Number));
  assert.deepEqual(b, [0, 1, 2]);
  assert.deepEqual(c, []);
  assert.equal(most, 1, 'never two batches at once');
  assert.ok(sizes.every((n) => n >= 1 && n <= 5), sizes.join(','));
});

test('oneAtATime: a failing batch fails that call only; the next call still runs', async () => {
  let calls = 0;
  const r = oneAtATime({ async score(_q: string, texts: string[]) { if (calls++ === 0) throw new Error('boom'); return texts.map(() => 1); } }, 5);
  await assert.rejects(r.score('q', ['a']), /boom/);
  assert.deepEqual(await r.score('q', ['a', 'b']), [1, 1]);
});
