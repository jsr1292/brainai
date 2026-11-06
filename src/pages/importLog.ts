/**
 * The record of the move from Outline (round 1): which documents became pages, which were not moved and why, and
 * which the owner has checked. The importer itself was a one-off and is gone; its record and the Moved from Outline
 * screens stay while the owner checks them (they show only when there are imports).
 */
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';

export interface ImportRow {
  outlineId: string; pageId: string | null; collection: string; title: string; original: string; outlineUpdatedAt: string; importedAt: string;
  checkedAt: string | null; status: 'imported' | 'refused' | 'conflict'; reason: string | null;
}

/** The record of the move from Outline, for Settings' check view. */
export class ImportLog {
  constructor(private db: DB, private now: Clock) {}

  /** Moved documents (status imported), by collection and title. */
  list(): ImportRow[] {
    return this.all().filter((r) => r.status === 'imported');
  }

  /** Documents that were not moved, with their reason. */
  notMoved(): ImportRow[] {
    return this.all().filter((r) => r.status !== 'imported');
  }

  private all(): ImportRow[] {
    return (this.db.prepare('SELECT * FROM page_imports ORDER BY collection, title').all() as Record<string, string | null>[]).map(toRow);
  }

  get(outlineId: string): ImportRow | undefined {
    const r = this.db.prepare("SELECT * FROM page_imports WHERE outline_id = ? AND status = 'imported'").get(outlineId) as Record<string, string | null> | undefined;
    return r ? toRow(r) : undefined;
  }

  check(outlineId: string): void {
    this.db.prepare('UPDATE page_imports SET checked_at = ? WHERE outline_id = ? AND checked_at IS NULL').run(this.now().toISOString(), outlineId);
  }

  /** How many documents were moved, how many of those the owner checked, and how many were not moved: one count query. */
  summary(): { moved: number; checked: number; notMoved: number } {
    return this.db.prepare(
      `SELECT count(*) FILTER (WHERE status = 'imported') AS moved, count(*) FILTER (WHERE status = 'imported' AND checked_at IS NOT NULL) AS checked,
       count(*) FILTER (WHERE status != 'imported') AS notMoved FROM page_imports`,
    ).get() as { moved: number; checked: number; notMoved: number };
  }

  /** Per collection: documents Outline had, how many were moved, and how many of those pages are still live. */
  countsByCollection(): { collection: string; outline: number; moved: number; live: number }[] {
    return this.db.prepare(
      `SELECT i.collection, count(*) AS outline, count(*) FILTER (WHERE i.status = 'imported') AS moved, count(p.id) AS live FROM page_imports i
       LEFT JOIN pages p ON p.id = i.page_id AND p.deleted_at IS NULL GROUP BY i.collection ORDER BY i.collection`,
    ).all() as { collection: string; outline: number; moved: number; live: number }[];
  }
}

const toRow = (r: Record<string, string | null>): ImportRow => ({
  outlineId: r.outline_id!, pageId: r.page_id, collection: r.collection!, title: r.title!, original: r.original!,
  outlineUpdatedAt: r.outline_updated_at!, importedAt: r.imported_at!, checkedAt: r.checked_at,
  status: r.status as ImportRow['status'], reason: r.reason,
});
