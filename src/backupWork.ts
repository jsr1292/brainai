/**
 * The long, synchronous parts of a backup, as plain functions with few imports: the server runs them in a worker thread
 * (backupWorker.ts, via offThread.ts) so its main thread keeps answering; tests and the fallback call them directly.
 */
import { readFileSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { busyTick } from './busyMarker.js';

/**
 * Sign-in data a backup leaves out: the owner's password hash and authenticator secret, sessions and known devices,
 * the Macs' folder-report tokens (with their latest reports, which point at them), OAuth tokens, codes and pending
 * requests, and client secrets (replaced by random ones, so such a client fails and registers again instead of
 * passing as a public client). A backup is for memories; after a restore the owner sets the password and
 * authenticator again, the apps sign in again and each Mac gets a new token. scripts/strip-signin.sh runs the same
 * statements.
 */
export const STRIP_SIGN_IN_SQL = `DELETE FROM owner; DELETE FROM sessions; DELETE FROM known_devices; DELETE FROM folder_reports; DELETE FROM device_tokens; DELETE FROM oauth_tokens; DELETE FROM oauth_codes; DELETE FROM oauth_pending; DELETE FROM image_upload_links; UPDATE oauth_clients SET metadata = json_set(metadata, '$.client_secret', lower(hex(randomblob(32)))) WHERE json_extract(metadata, '$.client_secret') IS NOT NULL;`;

/** Picture files leave the backup copies this many days after Delete for good (as scripts/backup.sh's KEEP_DAYS). */
export const PICTURE_KEEP_DAYS = 30;

/** A picture deleted for good (the row), whose file the backup copies may drop. */
export interface GonePicture { id: string; type: string }

/** The partial names a backup folder's copier makes: `.memory-DAY.db.<hex>.partial` (and the older `.memory-DAY.db.partial`). */
export const MAIN_PARTIAL = /^\.memory-\d{4}-\d{2}-\d{2}\.db(\.[0-9a-f]{16})?\.partial$/;

/** Removes the half-made files of an earlier run that was stopped (a quit, an update): regular files with one name that this user owns, in the pattern, and at least `olderThanMs` old. Only call while no run of ours is in flight. */
export function sweepPartials(dir: string, pattern: RegExp, olderThanMs = 0): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!pattern.test(n)) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (st.isFile() && st.nlink === 1 && (uid === null || st.uid === uid) && (olderThanMs === 0 || Date.now() - st.mtimeMs >= olderThanMs)) rmSync(join(dir, n), { force: true });
    } catch { /* gone, or not ours */ }
  }
}

/** True when a process with this id is running. */
export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * The temporary folders of a backup that was stopped (a quit) hold an unstripped copy (sign-in data); they go, if this
 * user owns them. A folder names its maker in `pid`: gone when that process is not running, however young. One without a
 * pid file (an earlier version) goes when over an hour old, so a BrainAI of this user that is making a backup now is safe.
 * `ours`: called from inside our own backup lock, where no draft of this process is live, so our own pid counts as gone.
 */
export function sweepBackupTemp(tmp: string = tmpdir(), ours = false): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let names: string[];
  try { names = readdirSync(tmp); } catch { return; }
  for (const n of names) {
    if (!n.startsWith('brain-backup-')) continue;
    try {
      const st = lstatSync(join(tmp, n));
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      let pid: number | null = null;
      try { pid = Number(readFileSync(join(tmp, n, 'pid'), 'utf8').trim()); } catch { /* none */ }
      // A pid can be reused by an unrelated process: nothing of ours is kept past a day.
      const gone = Date.now() - st.mtimeMs > 24 * 3_600_000 || (pid !== null && Number.isInteger(pid) && pid > 0
        ? (ours && pid === process.pid) || !alive(pid)
        : Date.now() - st.mtimeMs > 3_600_000);
      if (gone) rmSync(join(tmp, n), { recursive: true, force: true });
    } catch { /* gone, or not ours */ }
  }
}

/** The picture folder and file names a row may have: the same rule as a restore's (saved/restore.ts). A row from a restored database that fails it never makes a path. */
export const safePicture = (r: { id: string; type: string }): boolean => /^[0-9a-f]{3,}$/.test(r.id) && /^[a-z0-9]{1,8}$/.test(r.type);

/** The minimum of a database the picture sync reads. */
interface Preparer { prepare(sql: string): { all(...args: unknown[]): unknown[] } }

/** The pictures deleted for good more than 30 days ago. A picture a restore could not bring back (removed_by = 'restore') is never listed: it may be the only one left. */
export function gonePictures(db: Preparer, now: Date): GonePicture[] {
  const before = new Date(now.getTime() - PICTURE_KEEP_DAYS * 86400_000).toISOString();
  return (db.prepare("SELECT id, type FROM images WHERE removed_at IS NOT NULL AND removed_at < ? AND (removed_by IS NULL OR removed_by <> 'restore')").all(before) as GonePicture[]).filter(safePicture);
}

const PICTURE_PARTIAL = /^(?:[0-9a-f]{3,}\.[a-z0-9]{1,8}|\.[0-9a-f]{3,}\.[a-z0-9]{1,8}\.[0-9a-f]{16})\.partial$/;

function sweepPicturePartials(images: string): void {
  try {
    if (!lstatSync(images).isDirectory()) return;
    for (const sub of readdirSync(images, { withFileTypes: true })) {
      if (sub.isDirectory() && /^[0-9a-f]{2}$/.test(sub.name)) {
        sweepPartials(join(images, sub.name), PICTURE_PARTIAL);
      }
    }
  } catch { /* no backup pictures yet, or the folder is unavailable */ }
}

/**
 * Copies the picture files `<dataDir>/images/<2 hex>/` that `dir/images` doesn't have yet (files never change), each
 * to a .partial name and renamed, then removes from `dir/images` the ones in `gone`.
 * `<dataDir>/images` itself is never changed, and its tmp folder is the store's own.
 *
 * `careful` is for a folder the owner chose (the second backup folder, maybe a synced one): `dir/images` and its
 * sub-folders must be real folders (never links), a source that is not a regular file is skipped, a name there that
 * is not a regular file is refused (never followed or overwritten), the new files are narrowed to the owner (0600),
 * and only regular files with one name that this user owns are ever deleted.
 */
export function syncPictureFiles(dataDir: string, dir: string, gone: GonePicture[], careful = false): void {
  const src = join(dataDir, 'images');
  sweepPicturePartials(join(dir, 'images'));
  if (!existsSync(src)) return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const realDir = (path: string): boolean => {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
  };
  const refuse = (path: string): never => { throw new Error(`Pictures could not be copied: ${path} is not an ordinary folder or file.`); };
  for (const sub of readdirSync(src).filter((d) => /^[0-9a-f]{2}$/.test(d))) {
    const subDir = join(dir, 'images', sub);
    for (const file of readdirSync(join(src, sub))) {
      busyTick();
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
      const partial = join(subDir, `.${file}.${randomBytes(8).toString('hex')}.partial`);
      copyFileSync(join(src, sub, file), partial, constants.COPYFILE_EXCL);
      try {
        if (careful) chmodSync(partial, 0o600);
        renameSync(partial, target);
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
    }
  }
  for (const g of gone) {
    if (!safePicture(g)) continue;
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
 * Turns the raw snapshot `draft` into the backup `path`: owner-only, one self-contained file (no WAL), without the
 * sign-in data, compacted and checked, then copied into its folder under a name that is not a backup's and renamed, so
 * the folder never holds a half-written backup.
 */
export function finishDraft(draft: string, partial: string, path: string): void {
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
  try {
    // Cleared first and created exclusively, so a link planted at this name is never followed.
    rmSync(partial, { force: true });
    copyFileSync(draft, partial, constants.COPYFILE_EXCL);
    renameSync(partial, path);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
}

/** How many of the live pictures `rows` have no file in `<dataDir>/images`. */
export function missingPictureCount(dataDir: string, rows: { id: string; type: string }[]): number {
  return rows.filter(safePicture).filter((r) => !existsSync(join(dataDir, 'images', r.id.slice(0, 2), `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`))).length;
}

/** What a person would count: facts and pages that are not deleted. */
export function liveCounts(db: { prepare(sql: string): { get(): unknown } }): { facts: number; pages: number } {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    facts: n('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL'),
    pages: n('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'),
  };
}

/**
 * Moves a file to `to`, also when that is on another disk (the saved folder in Documents or the home folder can be),
 * where a plain rename fails with EXDEV. Then it is copied to a temporary name next to the destination, so the final
 * rename is on one disk and the destination is whole or absent, and the original is removed. `rename` is a test seam.
 */
export function moveAcrossDisks(from: string, to: string, rename: (a: string, b: string) => void = renameSync): void {
  try {
    rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // A stopped earlier copy leaves its temporary file: those older than ten minutes (not a copy still running) go.
    const stale = new RegExp(`^\\.${basename(to).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]+\\.part$`);
    try {
      for (const n of readdirSync(dirname(to)).filter((f) => stale.test(f))) {
        const st = lstatSync(join(dirname(to), n));
        if (st.isFile() && st.nlink === 1 && Date.now() - st.mtimeMs > 600_000) rmSync(join(dirname(to), n), { force: true });
      }
    } catch { /* nothing to sweep */ }
    const part = join(dirname(to), `.${basename(to)}.${randomBytes(6).toString('hex')}.part`);
    try {
      copyFileSync(from, part);
      chmodSync(part, 0o600);
      rename(part, to);
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
    unlinkSync(from);
  }
}

/** Opens a database file read-only and reads what it holds. */
export function readCounts(file: string): { facts: number; pages: number } {
  const db = new Database(file, { readonly: true });
  try {
    return liveCounts(db);
  } finally {
    db.close();
  }
}
