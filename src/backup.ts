import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { writeBackupStatus, type BackupRun } from './backupStatus.js';
import type { BackupCopy } from './desktop/backupCopy.js';
import { tighten, type DB } from './db.js';

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
 *
 * `careful` is for a folder the owner chose (the second backup folder, maybe a synced one): `dir/images` and its
 * sub-folders must be real folders (never links), a source that is not a regular file is skipped, a name there that
 * is not a regular file is refused (never followed or overwritten), the new files are narrowed to the owner (0600),
 * and only regular files with one name that this user owns are ever deleted.
 */
export function syncPictures(db: DB, dataDir: string, dir: string, now: Date, careful = false): void {
  const src = join(dataDir, 'images');
  if (!existsSync(src)) return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const realDir = (path: string): boolean => {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
  };
  const refuse = (path: string): never => { throw new Error(`Pictures could not be copied: ${path} is not an ordinary folder or file.`); };
  for (const sub of readdirSync(src).filter((d) => /^[0-9a-f]{2}$/.test(d))) {
    const subDir = join(dir, 'images', sub);
    for (const file of readdirSync(join(src, sub))) {
      const target = join(subDir, file);
      if (careful) {
        try { if (!lstatSync(join(src, sub, file)).isFile()) continue; } catch { continue; }
        let seen = null;
        try { seen = lstatSync(target); } catch { /* not there yet */ }
        if (seen !== null) { if (seen.isFile()) continue; refuse(target); }
      } else if (existsSync(target)) continue;
      if (careful) {
        for (const d of [join(dir, 'images'), subDir]) {
          let there = true;
          try { lstatSync(d); } catch { there = false; }
          if (!there) mkdirSync(d, { mode: 0o700 });
          else if (!realDir(d)) refuse(d);
        }
      } else mkdirSync(subDir, { recursive: true });
      const partial = `${target}.partial`;
      try {
        if (careful) rmSync(partial, { force: true });
        copyFileSync(join(src, sub, file), partial, careful ? constants.COPYFILE_EXCL : 0);
        if (careful) chmodSync(partial, 0o600);
        renameSync(partial, target);
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
    }
  }
  const before = new Date(now.getTime() - PICTURE_KEEP_DAYS * 86400_000).toISOString();
  const gone = db.prepare("SELECT id, type FROM images WHERE removed_at IS NOT NULL AND removed_at < ?").all(before) as { id: string; type: string }[];
  for (const g of gone) {
    const path = join(dir, 'images', g.id.slice(0, 2), `${g.id}.${g.type === 'jpeg' ? 'jpg' : g.type}`);
    if (careful) {
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.nlink !== 1 || (uid !== null && st.uid !== uid) || !realDir(join(dir, 'images')) || !realDir(join(dir, 'images', g.id.slice(0, 2)))) continue;
      } catch { continue; }
    }
    rmSync(path, { force: true });
  }
}

/**
 * Writes today's consistent snapshot to `dir` as memory-YYYY-MM-DD.db (local date) (replacing one from earlier today),
 * without the sign-in data (STRIP_SIGN_IN_SQL), checks it, then keeps only the newest `keep` snapshots. The in-app twin
 * of scripts/backup.sh, for a copy that runs without cron (BACKUP_DIR, the app). The snapshot is made, stripped and
 * checked in a private temporary folder, and only the finished file goes into `dir`: `dir` may be a synced cloud
 * folder, which must never see the sign-in data, not even for a moment or after a crash. In `dir` it only
 * ever writes or deletes memory-YYYY-MM-DD.db files and its own .partial file. Returns the path.
 */
export async function backupNow(db: DB, dir: string, keep: number, now: Date, dataDir?: string): Promise<string> {
  // A folder made here is the owner's alone: names and dates of the backups are not for other users of the computer.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // An existing folder (made earlier, or chosen by the owner) is made owner-only too; never loosened, never fatal.
  tighten(dir);
  // The local date, so a backup made just after midnight carries the day it was made on.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = `memory-${day}.db`;
  const path = join(dir, name);
  const work = mkdtempSync(join(tmpdir(), 'brain-backup-'));
  try {
    const draft = join(work, name);
    await db.backup(draft);
    // Owner-only from here on: the copies made from the draft keep this mode whatever the umask.
    chmodSync(draft, 0o600);
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
      // Cleared first and created exclusively, so a link planted at this name is never followed.
      rmSync(partial, { force: true });
      copyFileSync(draft, partial, constants.COPYFILE_EXCL);
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
  if (dataDir !== undefined) syncPictures(db, dataDir, dir, now);
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

/** One backup run, logged and recorded in `statusDir` for the dashboard; failures are never thrown. Returns the run it recorded. */
export async function runBackup(db: DB, dir: string, keep: number, now: Date, statusDir: string, copy?: BackupCopy): Promise<BackupRun> {
  let run: BackupRun;
  try {
    // statusDir is the data dir (index.ts), where the pictures live.
    const path = await backupNow(db, dir, keep, now, statusDir);
    console.log(`Backup written to ${path}`);
    // The second folder gets this finished file; its failure is recorded by the copy itself and never touches this run.
    try { copy?.run(path, keep, now, { db, dataDir: statusDir }); } catch (e) { console.error('Backup copy failed:', e); }
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
  return run;
}

/** Backs up now and then every day; failures are logged and recorded, never fatal. Returns the timer (unref'd). */
export function scheduleBackups(db: DB, dir: string, keep: number, now: () => Date, statusDir: string, copy?: BackupCopy): NodeJS.Timeout {
  const run = () => { void runBackup(db, dir, keep, now(), statusDir, copy); };
  run();
  return setInterval(run, BACKUP_INTERVAL_MS).unref();
}
