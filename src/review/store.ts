import type { DB } from '../db.js';
import { toHistory, toMemory, type HistoryRow, type MemoryRow } from '../memory/store.js';
import type { HistoryEntry, Memory } from '../memory/types.js';
import type { TidySummary } from '../memory/tidy.js';
import { KNOWN_FORMATS, REVIEW_FORMAT, type ReviewBody, type StoredReview } from './types.js';

interface ReviewRow { monday: string; format: number; body: string; built_at: string; built_by: string; opened_at: string | null; dismissed_at: string | null }

/**
 * "Last touched" at a moment, one row per project: creations counted under the project the memory started in (its
 * earliest history row's project, else its current one), and history rows filed under the project. Deletions count.
 */
const TOUCHED = (agg: 'max' | 'min', where: (col: string) => string) => `
SELECT project, ${agg}(at) AS at FROM (
  SELECT COALESCE((SELECT h.project FROM memory_history h WHERE h.memory_id = m.id ORDER BY h.id LIMIT 1), m.project) AS project,
         m.created_at AS at FROM memories m WHERE ${where('m.created_at')} AND m.kind != 'profile'
  UNION ALL
  SELECT project, changed_at FROM memory_history WHERE ${where('changed_at')} AND project IS NOT NULL
) WHERE project IS NOT NULL GROUP BY project`;

/** Stored weekly reviews, and the facts a week is built from. Every range is [start, end), as ISO strings. */
export class ReviewStore {
  constructor(private db: DB) {}

  /** Runs fn in one SQLite transaction: a build that throws stores nothing. */
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  get(monday: string): StoredReview | undefined {
    const r = this.db.prepare('SELECT * FROM weekly_reviews WHERE monday = ?').get(monday) as ReviewRow | undefined;
    if (!r) return undefined;
    if (!KNOWN_FORMATS.includes(r.format)) throw new Error(`weekly review ${monday} has format ${r.format}, which this version can't read`);
    return {
      monday: r.monday, format: r.format, body: JSON.parse(r.body) as ReviewBody, builtAt: r.built_at, builtBy: r.built_by,
      openedAt: r.opened_at, dismissedAt: r.dismissed_at,
    };
  }

  /** Once per Monday: a week already stored keeps its first body. */
  insert(r: { monday: string; body: ReviewBody; builtAt: string; builtBy: string }): void {
    this.db.prepare('INSERT OR IGNORE INTO weekly_reviews(monday, format, body, built_at, built_by) VALUES (?, ?, ?, ?, ?)')
      .run(r.monday, REVIEW_FORMAT, JSON.stringify(r.body), r.builtAt, r.builtBy);
  }

  /** Fill a pending summary once, preserving the latest body and all review metadata. */
  setTidy(monday: string, tidy: TidySummary): boolean {
    return this.atomic(() => {
      const r = this.get(monday);
      if (!r || r.body.tidy !== null) return false;
      this.db.prepare('UPDATE weekly_reviews SET body = ? WHERE monday = ?')
        .run(JSON.stringify({ ...r.body, tidy }), monday);
      return true;
    });
  }

  /** Newest first. */
  mondays(): string[] {
    return (this.db.prepare('SELECT monday FROM weekly_reviews ORDER BY monday DESC').all() as { monday: string }[]).map((r) => r.monday);
  }

  private mark(col: 'opened_at' | 'dismissed_at', monday: string, at: string): boolean {
    this.db.prepare(`UPDATE weekly_reviews SET ${col} = ? WHERE monday = ? AND ${col} IS NULL`).run(at, monday);
    return this.db.prepare('SELECT 1 FROM weekly_reviews WHERE monday = ?').get(monday) !== undefined;
  }

  /** Read it: the first time is kept. False when the week isn't stored. */
  markOpened(monday: string, at: string): boolean {
    return this.mark('opened_at', monday, at);
  }

  /** Not now: the first time is kept. False when the week isn't stored. */
  markDismissed(monday: string, at: string): boolean {
    return this.mark('dismissed_at', monday, at);
  }

  /** Every roadmap that could have been live during the week, with its history oldest first. */
  roadmapsBetween(start: string, end: string): { memory: Memory; history: HistoryEntry[] }[] {
    const rows = this.db.prepare(`SELECT * FROM memories WHERE kind = 'roadmap' AND created_at < ? AND (deleted_at IS NULL OR deleted_at >= ?)
      ORDER BY created_at, rowid`).all(end, start) as MemoryRow[];
    const history = this.db.prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id');
    return rows.map((r) => ({ memory: toMemory(r), history: (history.all(r.id) as HistoryRow[]).map(toHistory) }));
  }

  /** Each project's latest touch at or before `at`. */
  lastTouched(at: string): Map<string, string> {
    const rows = this.db.prepare(TOUCHED('max', (c) => `${c} <= :at`)).all({ at }) as { project: string; at: string }[];
    return new Map(rows.map((r) => [r.project, r.at]));
  }

  /** Each project's first touch inside [start, end). */
  firstTouched(start: string, end: string): Map<string, string> {
    const rows = this.db.prepare(TOUCHED('min', (c) => `${c} >= :start AND ${c} < :end`)).all({ start, end }) as { project: string; at: string }[];
    return new Map(rows.map((r) => [r.project, r.at]));
  }

  /** Distinct pages saved in the week, with the project each version was saved under. */
  pagesSaved(start: string, end: string): { pageId: string; project: string | null }[] {
    return (this.db.prepare(`SELECT DISTINCT page_id, project FROM page_versions WHERE saved_at >= ? AND saved_at < ? ORDER BY page_id`)
      .all(start, end) as { page_id: string; project: string | null }[]).map((r) => ({ pageId: r.page_id, project: r.project }));
  }

  /** Observations that got evidence in the week: how much, and when the latest came. */
  evidenceAdded(start: string, end: string): { observationId: string; kind: 'strength' | 'improve'; count: number; latest: string }[] {
    return (this.db.prepare(`SELECT e.observation_id AS observationId, o.kind AS kind, count(*) AS count, max(e.added_at) AS latest
      FROM observation_evidence e JOIN observations o ON o.id = e.observation_id
      WHERE e.added_at >= ? AND e.added_at < ? GROUP BY e.observation_id ORDER BY e.observation_id`).all(start, end)) as
      { observationId: string; kind: 'strength' | 'improve'; count: number; latest: string }[];
  }

  /** When the first memory was saved, or null in an empty brain. */
  earliestMemory(): string | null {
    return (this.db.prepare('SELECT min(created_at) AS at FROM memories').get() as { at: string | null }).at;
  }

  /** Who replied in the discussion this decision closed, in the order they first posted; undefined when none did. */
  discussionVoices(memoryId: string): string[] | undefined {
    const d = this.db.prepare('SELECT id FROM discussions WHERE decision_memory_id = ? LIMIT 1').get(memoryId) as { id: string } | undefined;
    if (!d) return undefined;
    const rows = this.db.prepare(`SELECT author, min(id) AS first FROM discussion_posts WHERE discussion_id = ? AND kind = 'reply'
      GROUP BY author ORDER BY first`).all(d.id) as { author: string }[];
    return rows.map((r) => r.author);
  }
}
