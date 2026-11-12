/*
 * B9: recall's default answer to an assistant is up to 12 facts, but never more text than an assistant can use well:
 * the facts stop when their text would pass the budget (from Hindsight's token-budget packing), never below `min`.
 */

/** The rows in order while their running size stays within `budget`; always the first `min` (or all there are). */
export function packByBudget<T>(rows: T[], size: (row: T) => number, opts: { budget: number; min: number }): T[] {
  let total = 0;
  let n = 0;
  for (const row of rows) {
    total += size(row);
    if (total > opts.budget && n >= opts.min) break;
    n += 1;
  }
  return rows.slice(0, n);
}
