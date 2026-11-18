import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';

const MARKER = 'auto-sign-in-ended';

/**
 * Local mode used to sign any browser in by itself while no password was set. Those sessions must not outlive that
 * change: the first time this version starts, every session is deleted and a marker file is written. After that
 * it does nothing, so the app window's own sessions last. True when it deleted them.
 */
export function forgetAutoSessions(db: DB, dataDir: string): boolean {
  const marker = join(dataDir, MARKER);
  if (existsSync(marker)) return false;
  db.prepare('DELETE FROM sessions').run();
  writeFileSync(marker, 'Sessions made by the old automatic sign-in were deleted at the first start of this version.\n');
  return true;
}
