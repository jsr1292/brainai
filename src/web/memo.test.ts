import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoByKey } from './memo.js';

test('memoByKey computes once per key and again when the key changes', () => {
  let key = 'v1';
  let runs = 0;
  const get = memoByKey(() => key, () => ++runs);
  assert.equal(get(), 1);
  assert.equal(get(), 1);
  key = 'v2';
  assert.equal(get(), 2);
  assert.equal(get(), 2);
});
