import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEmbedderFiles, cosine, createLocalEmbedder, GEMMA_FILES, GEMMA_MODEL, gemmaDir } from './embedder.js';
import { GEMMA_PROFILE } from './embeddingProfile.js';

test('cosine refuses vectors of different lengths instead of returning NaN', () => {
  assert.throws(() => cosine(new Float32Array(384), new Float32Array(768)), /384 and 768/);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])), 1);
});

test('checkEmbedderFiles accepts the pinned bytes and refuses any others, naming both hashes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'embed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(gemmaDir(dir), 'onnx'), { recursive: true });
  writeFileSync(join(gemmaDir(dir), 'onnx', 'm.onnx'), 'pinned bytes');
  const good = createHash('sha256').update('pinned bytes').digest('hex');
  assert.doesNotThrow(() => checkEmbedderFiles(dir, { 'onnx/m.onnx': good }));
  const other = GEMMA_FILES['tokenizer.json']!;
  assert.throws(() => checkEmbedderFiles(dir, { 'onnx/m.onnx': other }), (e: Error) => /does not match the pinned version/.test(e.message) && e.message.includes(good) && e.message.includes(other));
});

test('checkEmbedderFiles says the search model is missing when a pinned file is not there', () => {
  assert.throws(() => checkEmbedderFiles(join(tmpdir(), 'no-such-dir-embed')), /The search model is missing .*run  npm run model  first/);
});

test('the Gemma pins cover the 4-bit model, its data and the files the tokenizer and model read', () => {
  assert.equal(GEMMA_MODEL, 'onnx-community/embeddinggemma-300m-ONNX');
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data']) assert.ok(GEMMA_FILES[f], f);
  assert.ok(!Object.keys(GEMMA_FILES).some((f) => f.includes('quantized')), 'the 8-bit files are not used');
  assert.equal(gemmaDir('/m'), '/m/onnx-community/embeddinggemma-300m-ONNX');
});

test('createLocalEmbedder refuses a model it does not know, and Gemma offline without its files', async () => {
  await assert.rejects(createLocalEmbedder({ modelDir: '/m', allowRemote: false, model: { ...GEMMA_PROFILE, id: 'bert' as never } }), /unknown embedding model bert/);
  await assert.rejects(createLocalEmbedder({ modelDir: join(tmpdir(), 'no-such-dir-embed'), allowRemote: false, model: GEMMA_PROFILE }), /The search model is missing/);
});
