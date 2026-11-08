import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_THREADS, modelSessionOptions } from './onnxOptions.js';
import { embedderOptions } from './embedder.js';
import { rerankerSessionOptions } from './reranker.js';

const noSpin = { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } };

test('each model uses at most MODEL_THREADS threads, never more than the machine has and never none', () => {
  assert.equal(MODEL_THREADS, 6);
  assert.equal(modelSessionOptions(22).intraOpNumThreads, 6);
  assert.equal(modelSessionOptions(4).intraOpNumThreads, 4);
  assert.equal(modelSessionOptions(1).intraOpNumThreads, 1);
  assert.equal(modelSessionOptions(0).intraOpNumThreads, 1);
  assert.ok(modelSessionOptions().intraOpNumThreads >= 1 && modelSessionOptions().intraOpNumThreads <= MODEL_THREADS);
});

test("the models' threads never spin while waiting: two spinning pools taking turns made a recall 3 times slower", () => {
  const o = modelSessionOptions(22);
  assert.deepEqual(o.extra, noSpin);
  assert.equal(o.interOpNumThreads, 1);
});

test('the embedder and the reranker both get these options; the reranker keeps memory going back after each run', () => {
  assert.deepEqual(embedderOptions(22), { dtype: 'q8', session_options: modelSessionOptions(22) });
  assert.deepEqual(rerankerSessionOptions(22), { ...modelSessionOptions(22), enableCpuMemArena: false });
});
