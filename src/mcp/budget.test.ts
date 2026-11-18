/** B9: the size budget on recall's default answer — keeps rows in order while they fit, never fewer than `min`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBrief, packByBudget, type BriefFit } from './budget.js';

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

test('fitBrief: when the floor alone is over the limit, only the floor stays (newest 3 decisions in full, up to 5 owner notes and the first 2 pages; the rest dropped)', () => {
  // Every full decision costs 5,000 characters, every other row 10, so even the floor passes the limit.
  const render = (f: BriefFit) => 'x'.repeat(f.fullDecisions.size * 5000 + (6 - f.dropped.size - f.fullDecisions.size) * 10 + f.pages * 100 + f.notes * 100);
  const fit = fitBrief({ limit: 9000, statuses: 1, decisions: 6, founding: 2, pages: 5, notes: 5, topics: 0, render });
  assert.deepEqual([...fit.fullDecisions].sort(), [3, 4, 5]);
  assert.deepEqual([...fit.dropped].sort(), [0, 1, 2]);
  assert.equal(fit.pages, 2, 'the first 2 pages are part of the floor');
  assert.equal(fit.notes, 5, 'the owner notes are part of the floor');
});

test('fitBrief drops the oldest non-founding decisions first and the founding ones last', () => {
  // 10 decisions, founding 3; each listed excerpt costs 100, each full one 1,000; room for 3 full + 4 excerpts only.
  const render = (f: BriefFit) => 'x'.repeat(f.fullDecisions.size * 1000 + (10 - f.dropped.size - f.fullDecisions.size) * 100);
  const fit = fitBrief({ limit: 3400, statuses: 0, decisions: 10, founding: 3, pages: 0, notes: 0, topics: 0, render });
  assert.deepEqual([...fit.dropped].sort((a, b) => a - b), [3, 4, 5]);
  assert.deepEqual([...fit.fullDecisions].sort((a, b) => a - b), [7, 8, 9]);
});
