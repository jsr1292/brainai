import type { DB } from '../db.js';

/**
 * Activity: why an Undo is not offered on a row, in the owner's words (read only; the rule itself is in assistantActivity.ts).
 * Null when nothing in the data explains it.
 */
export type ActivityWhy = 'undone' | 'deleted' | 'standsIn' | 'changed';
const ENGLISH: Record<ActivityWhy, string> = { undone: 'Already undone', deleted: 'Deleted since', standsIn: 'Stands in for replaced facts', changed: 'Changed since' };

/** The English words of the reason (what the row carries for assistants and tests). */
export const activityWhyNot = (db: DB, kind: 'saved' | 'updated' | 'deleted' | 'replaced', memoryId: string | null, ref: number | string): string | null => {
  const c = activityWhyCode(db, kind, memoryId, ref);
  return c === null ? null : ENGLISH[c];
};

/** The same reason as a code, for a screen to word in the owner's language. */
export function activityWhyCode(db: DB, kind: 'saved' | 'updated' | 'deleted' | 'replaced', memoryId: string | null, ref: number | string): ActivityWhy | null {
  if (kind === 'replaced') return 'undone';
  if (memoryId === null) return null;
  const m = db.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(memoryId) as { deleted_at: string | null } | undefined;
  if (m === undefined) return null;
  if (kind === 'saved') {
    if (m.deleted_at !== null) return 'deleted';
    if (db.prepare('SELECT 1 FROM supersessions WHERE new_id = ? AND undone_at IS NULL LIMIT 1').get(memoryId) !== undefined) return 'standsIn';
    return 'changed';
  }
  const next = db.prepare('SELECT action FROM memory_history WHERE memory_id = ? AND id > ? ORDER BY id LIMIT 1').get(memoryId, Number(ref)) as { action: string } | undefined;
  if (kind === 'deleted' && m.deleted_at === null) return 'undone';
  if (next?.action === 'restore') return 'undone';
  return 'changed';
}
