import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { writeBackupStatus, type BackupRun } from './backupStatus.js';
import type { DB } from './db.js';

const NAME = /^memory-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Sign-in data a backup leaves out: the owner's password hash and authenticator secret, sessions and known devices,
 * the Macs' folder-report tokens (with their latest reports, which point at them), OAuth tokens, codes and pending
 * requests, and client secrets (replaced by random ones, so such a client fails and registers again instead of
 * passing as a public client). A backup is for memories; after a restore the owner sets the password and
 * authenticator again, the apps sign in again and each Mac gets a new token. scripts/strip-signin.sh runs the same
 * statements.
 */
export const STRIP_SIGN_IN_SQL = `DELETE FROM owner; DELETE FROM sessions; DELETE FROM known_devices; DELETE FROM folder_reports; DELETE FROM device_tokens; DELETE FROM oauth_tokens; DELETE FROM oauth_codes; DELETE FROM oauth_pending; DELETE FROM image_upload_links; UPDATE oauth_clients SET metadata = json_set(metadata, '$.client_secret', lower(hex(randomblob(32)))) WHERE json_extract(metadata, '$.client_secret') IS NOT NULL;`;
export const BACKUP_INTERVAL_MS = 24 * 60 * 60_000;
/** Picture files leave the backup copies this many days after Delete for good (as scripts/backup.sh's KEEP_DAYS). */
export const PICTURE_KEEP_DAYS = 30;

/**
 * Copies the picture files `<dataDir>/images/<2 hex>/` that `dir/images` doesn't have yet (files never change), each
 * to a .partial name and renamed, then removes from `dir/images` the ones deleted for good more than 30 days ago.
 * `<dataDir>/images` itself is never changed, and its tmp folder is the store's own.
 */
function copyPictures(db: DB, dataDir: string, dir: string, now: Date): void {
  const src = join(dataDir, 'images');
  if (!existsSync(src)) return;
  for (const sub of readdirSync(src).filter((d) => /^[0-9a-f]{2}$/.test(d))) {
    for (const file of readdirSync(join(src, sub))) {
      const target = join(dir, 'images', sub, file);
      if (existsSync(target)) continue;
      mkdirSync(join(dir, 'images', sub), { recursive: true });
      const partial = `${target}.partial`;
      try {
        copyFileSync(join(src, sub, file), partial);
        renameSync(partial, target);
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
    }
  }
  const before = new Date(now.getTime() - PICTURE_KEEP_DAYS * 86400_000).toISOString();
  const gone = db.prepare("SELECT id, type FROM images WHERE removed_at IS NOT NULL AND removed_at < ?").all(before) as { id: string; type: string }[];
  for (const g of gone) rmSync(join(dir, 'images', g.id.slice(0, 2), `${g.id}.${g.type === 'jpeg' ? 'jpg' : g.type}`), { force: true });
}

/**
 * Writes today's consistent snapshot to `dir` as memory-YYYY-MM-DD.db (local date) (replacing one from earlier today),
 * without the sign-in data (STRIP_SIGN_IN_SQL), checks it, then keeps only the newest `keep` snapshots. The in-app twin
 * of scripts/backup.sh, for a copy that runs without cron (work mode on Windows). The snapshot is made, stripped and
 * checked in a private temporary folder, and only the finished file goes into `dir`: at work `dir` is a synced
 * OneDrive folder, which must never see the sign-in data, not even for a moment or after a crash. In `dir` it only
 * ever writes or deletes memory-YYYY-MM-DD.db files and its own .partial file. Returns the path.
 */
export async function backupNow(db: DB, dir: string, keep: number, now: Date, dataDir?: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  // The local date, so a backup made just after midnight carries the day it was made on.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = `memory-${day}.db`;
  const path = join(dir, name);
  const work = mkdtempSync(join(tmpdir(), 'brain-backup-'));
  try {
    const draft = join(work, name);
    await db.backup(draft);
    // The copy inherits WAL mode; switching it to a rollback journal keeps each backup a single self-contained file.
    const copy = new Database(draft);
    try {
      copy.pragma('journal_mode = DELETE');
      copy.exec(STRIP_SIGN_IN_SQL);
      // Rewrites the file, so the deleted rows are not left behind in free pages.
      copy.exec('VACUUM');
      const result = copy.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`Backup ${path} failed its integrity check: ${String(result)}`);
    } finally {
      copy.close();
    }
    // Copied under a name that is not a backup's, then renamed, so `dir` never holds a half-written backup.
    const partial = join(dir, `.${name}.partial`);
    try {
      copyFileSync(draft, partial);
      renameSync(partial, path);
    } catch (e) {
      rmSync(partial, { force: true });
      throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const snapshots = readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse();
  for (const old of snapshots.slice(keep)) rmSync(join(dir, old));
  if (dataDir !== undefined) copyPictures(db, dataDir, dir, now);
  return path;
}

/**
 * How many live pictures (rows not deleted for good) have no file in `<dataDir>/images`, as scripts/backup.sh checks
 * at home (audit F11); null when there are none to check.
 */
export function missingPictures(db: DB, dataDir: string): number | null {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'").get() !== undefined;
  if (!hasTable) return null;
  const rows = db.prepare('SELECT id, type FROM images WHERE removed_at IS NULL').all() as { id: string; type: string }[];
  if (rows.length === 0) return null;
  return rows.filter((r) => !existsSync(join(dataDir, 'images', r.id.slice(0, 2), `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`))).length;
}

/** One backup run, logged and recorded in `statusDir` for the dashboard; failures are never thrown. */
export async function runBackup(db: DB, dir: string, keep: number, now: Date, statusDir: string): Promise<void> {
  let run: BackupRun;
  try {
    // statusDir is the data dir (index.ts), where the pictures live.
    const path = await backupNow(db, dir, keep, now, statusDir);
    console.log(`Backup written to ${path}`);
    run = { at: now.toISOString(), ok: true, copies: [{ where: dir, result: 'copied' }] };
    const missing = missingPictures(db, statusDir);
    if (missing !== null) run.pictures = { missing, stray: 0 };
  } catch (e) {
    console.error('Backup failed:', e);
    run = { at: now.toISOString(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // A status file that cannot be written is logged, never thrown: it must not take the server down.
  try {
    writeBackupStatus(statusDir, 'nightly', run);
  } catch (e) {
    console.error('Could not record the backup status:', e);
  }
}

/** Backs up now and then every day; failures are logged and recorded, never fatal. Returns the timer (unref'd). */
export function scheduleBackups(db: DB, dir: string, keep: number, now: () => Date, statusDir: string): NodeJS.Timeout {
  const run = () => { void runBackup(db, dir, keep, now(), statusDir); };
  run();
  return setInterval(run, BACKUP_INTERVAL_MS).unref();
}
