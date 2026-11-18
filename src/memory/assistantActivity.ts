/**
 * C2: what each assistant saved or changed, newest first (the Activity view). Assistant activity only: anything the
 * owner did (a save, an edit, an undo) is left out; a held save the owner approved is shown under the assistant that made it. Read-only; the undo rules
 * live here too, so the view and the undo route agree on what "changed since" means.
 */
import type { DB } from '../db.js';
import { OWNER_LABEL } from './types.js';

export const ACTIVITY_PAGE_SIZE = 50;

export type ActivityKind = 'saved' | 'updated' | 'deleted' | 'replaced' | 'page';

export interface AssistantActivity {
  kind: ActivityKind;
  at: string;
  by: string;
  /** The fact (or, for 'replaced', the old fact); null for a page. */
  memoryId: string | null;
  /** The fact's text: as saved, as it was before an update, as it was when deleted, or the replaced fact's. */
  content: string;
  /** updated: the text after this change (the next version's, or the fact's current text). */
  after: string | null;
  /** The history row an update or delete can be undone to. */
  historyId: number | null;
  /** replaced: the replacement row, and the fact that replaced it. */
  supersessionId: number | null;
  newId: string | null;
  /** page: which page, which version this save made, whether it created the page, and the title then. */
  pageId: string | null;
  pageVersion: number | null;
  pageTitle: string | null;
  /** Whether Undo still applies (nothing touched the fact after this; a replacement not yet brought back). */
  undoable: boolean;
}

interface Raw {
  at: string; by: string; kind: ActivityKind; fid: string | null; content: string; hid: number | null; sid: number | null; nid: string | null;
  pid: string | null; pv: number | null; ptitle: string | null;
}

const UNION = `
  SELECT m.created_at AS at, m.created_by AS by, 'saved' AS kind, m.id AS fid, m.content AS content, NULL AS hid, NULL AS sid, NULL AS nid, NULL AS pid, NULL AS pv, NULL AS ptitle, 0 AS ord, m.rowid AS seq
    FROM memories m WHERE m.created_by <> '${OWNER_LABEL}'
  UNION ALL
  SELECT h.changed_at, h.changed_by, CASE h.action WHEN 'update' THEN 'updated' ELSE 'deleted' END, h.memory_id, h.content, h.id, NULL, NULL, NULL, NULL, NULL, 1, h.id
    FROM memory_history h WHERE h.action IN ('update', 'delete') AND h.changed_by <> '${OWNER_LABEL}'
  UNION ALL
  SELECT s.created_at, s.created_by, 'replaced', s.old_id, m.content, NULL, s.id, s.new_id, NULL, NULL, NULL, 2, s.id
    FROM supersessions s JOIN memories m ON m.id = s.old_id WHERE s.created_by <> '${OWNER_LABEL}'
  UNION ALL
  SELECT v.saved_at, v.saved_by, 'page', NULL, '', NULL, NULL, NULL, v.page_id, v.version, v.title, 3, v.version
    FROM page_versions v WHERE v.saved_by <> '${OWNER_LABEL}'`;

/** Every assistant that has saved or changed something, by name. */
export function activityAssistants(db: DB): string[] {
  return (db.prepare(`SELECT DISTINCT by FROM (${UNION}) ORDER BY by COLLATE NOCASE`).all() as { by: string }[]).map((r) => r.by);
}

/** Whether a later change touched the fact: any history row after `historyId`, or (a new fact) any history at all. */
const touchedAfter = (db: DB, memoryId: string, historyId: number): boolean =>
  db.prepare('SELECT 1 FROM memory_history WHERE memory_id = ? AND id > ? LIMIT 1').get(memoryId, historyId) !== undefined;

/**
 * Undo of a new fact: still there, never changed since, and not standing in for older facts it replaced (undo that
 * replacement first, or the older facts would be left replaced by a deleted fact).
 */
export function savedUndoable(db: DB, memoryId: string): boolean {
  const m = db.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(memoryId) as { deleted_at: string | null } | undefined;
  const replacing = db.prepare('SELECT 1 FROM supersessions WHERE new_id = ? AND undone_at IS NULL LIMIT 1').get(memoryId) !== undefined;
  return m !== undefined && m.deleted_at === null && !touchedAfter(db, memoryId, 0) && !replacing;
}

/** Undo of an update ("Undo to this": the version before it comes back): the fact is live and this was its latest change. */
export function updateUndoable(db: DB, memoryId: string, historyId: number): boolean {
  const h = db.prepare('SELECT memory_id, action FROM memory_history WHERE id = ?').get(historyId) as { memory_id: string; action: string } | undefined;
  const m = db.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(memoryId) as { deleted_at: string | null } | undefined;
  return h !== undefined && h.memory_id === memoryId && h.action === 'update' && m !== undefined && m.deleted_at === null && !touchedAfter(db, memoryId, historyId);
}

/** Undo of a delete (restore): the fact is still deleted and nothing came after the deletion. */
export function deleteUndoable(db: DB, memoryId: string, historyId: number): boolean {
  const h = db.prepare('SELECT memory_id, action FROM memory_history WHERE id = ?').get(historyId) as { memory_id: string; action: string } | undefined;
  const m = db.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(memoryId) as { deleted_at: string | null } | undefined;
  return h !== undefined && h.memory_id === memoryId && h.action === 'delete' && m !== undefined && m.deleted_at !== null && !touchedAfter(db, memoryId, historyId);
}

/** Undo of a replacement: not brought back yet. */
export function replacementUndoable(db: DB, rowId: number): boolean {
  const r = db.prepare('SELECT undone_at FROM supersessions WHERE id = ?').get(rowId) as { undone_at: string | null } | undefined;
  return r !== undefined && r.undone_at === null;
}

/**
 * One page of the feed (newest first, `page` from 1), optionally only one assistant's. `more` says an older page exists.
 */
export function assistantActivity(db: DB, opts: { by?: string; page?: number } = {}): { rows: AssistantActivity[]; more: boolean } {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const raws = db.prepare(`SELECT at, by, kind, fid, content, hid, sid, nid, pid, pv, ptitle FROM (${UNION})
    ${opts.by === undefined ? '' : 'WHERE by = ?'} ORDER BY at DESC, ord DESC, seq DESC LIMIT ? OFFSET ?`)
    .all(...(opts.by === undefined ? [] : [opts.by]), ACTIVITY_PAGE_SIZE + 1, (page - 1) * ACTIVITY_PAGE_SIZE) as Raw[];
  const rows = raws.slice(0, ACTIVITY_PAGE_SIZE).map((r): AssistantActivity => {
    const base = { kind: r.kind, at: r.at, by: r.by, memoryId: r.fid, content: r.content, after: null, historyId: r.hid, supersessionId: r.sid, newId: r.nid, pageId: r.pid, pageVersion: r.pv, pageTitle: r.ptitle, undoable: false };
    if (r.kind === 'saved') return { ...base, undoable: savedUndoable(db, r.fid!) };
    if (r.kind === 'updated') {
      const next = db.prepare('SELECT content FROM memory_history WHERE memory_id = ? AND id > ? ORDER BY id LIMIT 1').get(r.fid, r.hid) as { content: string } | undefined;
      const now = next ?? db.prepare('SELECT content FROM memories WHERE id = ?').get(r.fid) as { content: string } | undefined;
      return { ...base, after: now?.content ?? null, undoable: updateUndoable(db, r.fid!, r.hid!) };
    }
    if (r.kind === 'deleted') return { ...base, undoable: deleteUndoable(db, r.fid!, r.hid!) };
    if (r.kind === 'replaced') return { ...base, undoable: replacementUndoable(db, r.sid!) };
    return base;
  });
  return { rows, more: raws.length > ACTIVITY_PAGE_SIZE };
}
