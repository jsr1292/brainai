/** B9: the size budget on recall's default answer — keeps rows in order while they fit, never fewer than `min`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packByBudget } from './budget.js';

const rows = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({ i, text: 'x'.repeat(size) }));
const len = (r: { text: string }) => r.text.length;

test('packByBudget keeps rows while the running total fits the budget', () => {
  assert.equal(packByBudget(rows(12, 1000), len, { budget: 8000, min: 5 }).length, 8);
  assert.equal(packByBudget(rows(12, 100), len, { budget: 8000, min: 5 }).length, 12);
});

test('packByBudget always keeps at least min rows, or all there are', () => {
  assert.equal(packByBudget(rows(3, 5000), len, { budget: 8000, min: 5 }).length, 3);
  assert.equal(packByBudget(rows(1, 9000), len, { budget: 8000, min: 5 }).length, 1);
  assert.equal(packByBudget(rows(10, 5000), len, { budget: 8000, min: 5 }).length, 5);
});

test('packByBudget keeps the order', () => {
  assert.deepEqual(packByBudget(rows(12, 1000), len, { budget: 8000, min: 5 }).map((r) => r.i), [0, 1, 2, 3, 4, 5, 6, 7]);
});
