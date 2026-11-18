import type { DB } from '../db.js';

/**
 * Activity: why an Undo is not offered on a row, in the owner's words (read only; the rule itself is in assistantActivity.ts).
 * Null when nothing in the data explains it.
 */
export function activityWhyNot(db: DB, kind: 'saved' | 'updated' | 'deleted' | 'replaced', memoryId: string | null, ref: number | string): string | null {
  if (kind === 'replaced') return 'Already undone';
  if (memoryId === null) return null;
  const m = db.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(memoryId) as { deleted_at: string | null } | undefined;
  if (m === undefined) return null;
  if (kind === 'saved') {
    if (m.deleted_at !== null) return 'Deleted since';
    if (db.prepare('SELECT 1 FROM supersessions WHERE new_id = ? AND undone_at IS NULL LIMIT 1').get(memoryId) !== undefined) return 'Stands in for replaced facts';
    return 'Changed since';
  }
  const next = db.prepare('SELECT action FROM memory_history WHERE memory_id = ? AND id > ? ORDER BY id LIMIT 1').get(memoryId, Number(ref)) as { action: string } | undefined;
  if (kind === 'deleted' && m.deleted_at === null) return 'Already undone';
  if (next?.action === 'restore') return 'Already undone';
  return 'Changed since';
}
