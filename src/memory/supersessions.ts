import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { toMemory, type MemoryRow } from './store.js';
import type { Kind, Memory } from './types.js';

/**
 * Superseded facts (round 2 section 16). A decision replaces a decision and a status replaces a status; profile facts
 * and roadmaps are never replaced. Written out on its own (never through isStatus), because the two kinds are exactly:
 * a decision is kind 'decision' not tagged status; a status is kind 'summary', or kind 'decision' tagged status.
 */
export type Replaceable = 'decision' | 'status';

export function replaceableKind(m: Pick<Memory, 'kind' | 'tags'>): Replaceable | null {
  if (m.kind === 'summary') return 'status';
  if (m.kind === 'decision') return m.tags.includes('status') ? 'status' : 'decision';
  return null;
}

/** At most this many facts are replaced by one save. */
export const MAX_SUPERSEDES = 5;
/** Walks along a chain of replacements stop after this many steps (a loop made by hand never hangs a reader). */
export const MAX_CHAIN = 50;

export interface Supersession {
  id: number; oldId: string; newId: string; createdAt: string; createdBy: string; undoneAt: string | null; undoneBy: string | null;
}
interface Row {
  id: number; old_id: string; new_id: string; created_at: string; created_by: string; undone_at: string | null; undone_by: string | null;
}
const toSupersession = (r: Row): Supersession => ({
  id: r.id, oldId: r.old_id, newId: r.new_id, createdAt: r.created_at, createdBy: r.created_by, undoneAt: r.undone_at, undoneBy: r.undone_by,
});

/**
 * The supersessions table: the one source of truth for which fact replaced which. A fact is replaced while it has a
 * row with undone_at NULL. Nothing here touches memories (no updated_at, no history, no embedding).
 */
export class SupersessionStore {
  constructor(private db: DB, private now: Clock) {}

  add(oldId: string, newId: string, by: string): Supersession {
    const r = this.db.prepare('INSERT INTO supersessions(old_id, new_id, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(oldId, newId, this.now().toISOString(), by);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Sets undone_at and undone_by, only on a row still live. */
  undo(id: number, by: string): void {
    this.db.prepare('UPDATE supersessions SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL')
      .run(this.now().toISOString(), by, id);
  }

  get(id: number): Supersession | undefined {
    const r = this.db.prepare('SELECT * FROM supersessions WHERE id = ?').get(id) as Row | undefined;
    return r && toSupersession(r);
  }

  /** This fact's live replacement, if any. */
  liveFor(oldId: string): Supersession | undefined {
    const r = this.db.prepare('SELECT * FROM supersessions WHERE old_id = ? AND undone_at IS NULL').get(oldId) as Row | undefined;
    return r && toSupersession(r);
  }

  /** The live replacement of each of these facts that has one, by old id (one query). */
  liveForMany(oldIds: readonly string[]): Map<string, Supersession> {
    if (oldIds.length === 0) return new Map();
    const rows = this.db.prepare('SELECT * FROM supersessions WHERE old_id IN (SELECT value FROM json_each(?)) AND undone_at IS NULL').all(JSON.stringify(oldIds)) as Row[];
    return new Map(rows.map((r) => [r.old_id, toSupersession(r)]));
  }

  /** The facts this one replaced directly, live rows, oldest first. */
  liveBy(newId: string): Supersession[] {
    return (this.db.prepare('SELECT * FROM supersessions WHERE new_id = ? AND undone_at IS NULL ORDER BY id').all(newId) as Row[]).map(toSupersession);
  }

  /** Every row with this old fact, undone ones included (its History), oldest first. */
  allFor(oldId: string): Supersession[] {
    return (this.db.prepare('SELECT * FROM supersessions WHERE old_id = ? ORDER BY id').all(oldId) as Row[]).map(toSupersession);
  }

  /** Follows live rows forward, through deleted facts too; steps 0 when the fact is current. */
  chainEnd(id: string): { endId: string; steps: number } {
    let endId = id;
    let steps = 0;
    while (steps < MAX_CHAIN) {
      const next = this.liveFor(endId);
      if (!next) break;
      endId = next.newId;
      steps++;
    }
    return { endId, steps };
  }

  /** Every id linked into chainEnd(id), oldest created_at first; [id] alone when the fact stands alone. */
  chain(id: string): string[] {
    const end = this.chainEnd(id).endId;
    const seen = new Set<string>([end]);
    const queue = [end];
    while (queue.length > 0 && seen.size < MAX_CHAIN) {
      const cur = queue.shift()!;
      for (const r of this.liveBy(cur)) {
        if (seen.has(r.oldId) || seen.size >= MAX_CHAIN) continue;
        seen.add(r.oldId);
        queue.push(r.oldId);
      }
    }
    if (seen.size === 1) return [id];
    const ids = [...seen];
    const rows = this.db.prepare(`SELECT id FROM memories WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
      .all(...ids) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Rows created or undone in [start, end), by id. */
  between(start: Date, end: Date): Supersession[] {
    const s = start.toISOString();
    const e = end.toISOString();
    return (this.db.prepare(`SELECT * FROM supersessions
      WHERE (created_at >= ? AND created_at < ?) OR (undone_at IS NOT NULL AND undone_at >= ? AND undone_at < ?) ORDER BY id`)
      .all(s, e, s, e) as Row[]).map(toSupersession);
  }

  /** Live rows whose old fact is not deleted and is filed under `project` or one of its aliases, newest first. */
  liveForProject(project: string): Supersession[] {
    return (this.db.prepare(`SELECT s.* FROM supersessions s JOIN memories m ON m.id = s.old_id
      LEFT JOIN project_aliases a ON a.alias = m.project
      WHERE s.undone_at IS NULL AND m.deleted_at IS NULL AND COALESCE(a.project, m.project) = ?
      ORDER BY s.created_at DESC, s.id DESC`).all(project) as Row[]).map(toSupersession);
  }

  /** Live rows whose newer fact is deleted while the old one is not: nothing in search says it any more. */
  gone(): Supersession[] {
    return (this.db.prepare(`SELECT s.* FROM supersessions s JOIN memories o ON o.id = s.old_id JOIN memories n ON n.id = s.new_id
      WHERE s.undone_at IS NULL AND o.deleted_at IS NULL AND n.deleted_at IS NOT NULL ORDER BY s.id`).all() as Row[]).map(toSupersession);
  }

  /** How many facts each of `newIds` replaced directly (live rows); ids with none are left out. */
  liveCounts(newIds: readonly string[]): Map<string, number> {
    if (newIds.length === 0) return new Map();
    const rows = this.db.prepare(`SELECT new_id, COUNT(*) AS n FROM supersessions WHERE undone_at IS NULL
      AND new_id IN (${newIds.map(() => '?').join(', ')}) GROUP BY new_id`).all(...newIds) as { new_id: string; n: number }[];
    return new Map(rows.map((r) => [r.new_id, r.n]));
  }

  /** The live rows behind All facts › Replaced: old fact not deleted, `project` matched through aliases. */
  private replacedWhere(f: { kind?: Kind; project?: string }): { sql: string; params: string[] } {
    let sql = 's.undone_at IS NULL AND m.deleted_at IS NULL';
    const params: string[] = [];
    if (f.kind) { sql += ' AND m.kind = ?'; params.push(f.kind); }
    if (f.project) { sql += ' AND COALESCE(a.project, m.project) = ?'; params.push(f.project); }
    return { sql, params };
  }

  /** Replaced facts, newest replacement first, each with the fact that replaced it and whether that one was replaced too. */
  replacedList(f: { kind?: Kind; project?: string; limit: number; offset: number }): { row: Supersession; old: Memory; next: Memory; nextReplaced: boolean }[] {
    const w = this.replacedWhere(f);
    const rows = this.db.prepare(`SELECT s.id AS sid FROM supersessions s JOIN memories m ON m.id = s.old_id
      LEFT JOIN project_aliases a ON a.alias = m.project WHERE ${w.sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, f.limit, f.offset) as { sid: number }[];
    const memory = (id: string) => toMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
    return rows.map(({ sid }) => {
      const row = this.get(sid)!;
      return { row, old: memory(row.oldId), next: memory(row.newId), nextReplaced: this.liveFor(row.newId) !== undefined };
    });
  }

  replacedCount(f: { kind?: Kind; project?: string }): number {
    const w = this.replacedWhere(f);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM supersessions s JOIN memories m ON m.id = s.old_id
      LEFT JOIN project_aliases a ON a.alias = m.project WHERE ${w.sql}`).get(...w.params) as { n: number }).n;
  }

  /** The newest row and how many were undone, for cache keys (a replacement writes no history and no updated_at). */
  version(): string {
    return JSON.stringify(this.db.prepare(`SELECT (SELECT MAX(id) FROM supersessions) AS ss,
      (SELECT COUNT(*) FROM supersessions WHERE undone_at IS NOT NULL) AS su`).get());
  }
}
