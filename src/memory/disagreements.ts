import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';

/**
 * How a pair was settled: a or b was right, both are right (dismissed for good), one of them went away, or one of
 * them was rewritten (the disagreement may be fixed; a new flag opens it again).
 */
export type SettledHow = 'a' | 'b' | 'both' | 'gone' | 'changed';

/**
 * Two live facts an assistant says can't both be true (B1). BrainAI never guesses one: only an assistant flags, only
 * the owner settles. A pair is stored once (its `pair` key is the two ids sorted), a and b in the order they were
 * flagged, and keeps its one row for good.
 */
export interface Disagreement {
  id: string; a: string; b: string; why: string; flaggedBy: string; createdAt: string;
  settledAt: string | null; settledHow: SettledHow | null; settledBy: string | null;
}
interface Row {
  id: string; a: string; b: string; why: string; flagged_by: string; created_at: string;
  settled_at: string | null; settled_how: SettledHow | null; settled_by: string | null;
}
const toDisagreement = (r: Row): Disagreement => ({
  id: r.id, a: r.a, b: r.b, why: r.why, flaggedBy: r.flagged_by, createdAt: r.created_at,
  settledAt: r.settled_at, settledHow: r.settled_how, settledBy: r.settled_by,
});

export const MAX_WHY = 300;

const pairKey = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);

export class DisagreementStore {
  constructor(private db: DB, private now: Clock) {}

  /** The pair's row, whichever order the ids come in. */
  forPair(x: string, y: string): Disagreement | undefined {
    const r = this.db.prepare('SELECT * FROM disagreements WHERE pair = ?').get(pairKey(x, y)) as Row | undefined;
    return r && toDisagreement(r);
  }

  get(id: string): Disagreement | undefined {
    const r = this.db.prepare('SELECT * FROM disagreements WHERE id = ?').get(id) as Row | undefined;
    return r && toDisagreement(r);
  }

  add(a: string, b: string, why: string, by: string): Disagreement {
    const id = randomUUID();
    this.db.prepare('INSERT INTO disagreements(id, a, b, pair, why, flagged_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, a, b, pairKey(a, b), why, by, this.now().toISOString());
    return this.get(id)!;
  }

  /** A settled pair flagged again: any way but "both are right", which the owner said for good. */
  reopen(id: string, why: string, by: string): Disagreement {
    this.db.prepare(`UPDATE disagreements SET why = ?, flagged_by = ?, created_at = ?, settled_at = NULL, settled_how = NULL, settled_by = NULL
      WHERE id = ? AND settled_at IS NOT NULL AND settled_how <> 'both'`).run(why, by, this.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Settles every open pair this fact is in (its text was rewritten). */
  settleFor(memoryId: string, how: SettledHow, by: string): void {
    this.db.prepare('UPDATE disagreements SET settled_at = ?, settled_how = ?, settled_by = ? WHERE (a = ? OR b = ?) AND settled_at IS NULL')
      .run(this.now().toISOString(), how, by, memoryId, memoryId);
  }

  /** Only a pair still open is settled. */
  settle(id: string, how: SettledHow, by: string): void {
    this.db.prepare('UPDATE disagreements SET settled_at = ?, settled_how = ?, settled_by = ? WHERE id = ? AND settled_at IS NULL')
      .run(this.now().toISOString(), how, by, id);
  }

  /** Open pairs, newest first. */
  open(): Disagreement[] {
    return (this.db.prepare('SELECT * FROM disagreements WHERE settled_at IS NULL ORDER BY created_at DESC, id').all() as Row[]).map(toDisagreement);
  }
}
