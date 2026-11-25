import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeBackupStatus, type BackupRun } from './backupStatus.js';
import type { BackupCopy } from './desktop/backupCopy.js';
import { tighten, type DB } from './db.js';
import { busy } from './busyMarker.js';
import { finishDraft, gonePictures, STRIP_SIGN_IN_SQL, PICTURE_KEEP_DAYS, syncPictureFiles, missingPictureCount, sweepPartials, sweepBackupTemp, MAIN_PARTIAL } from './backupWork.js';
import { inWorker } from './offThread.js';

export { STRIP_SIGN_IN_SQL, PICTURE_KEEP_DAYS };

const NAME = /^memory-\d{4}-\d{2}-\d{2}\.db$/;

export const BACKUP_INTERVAL_MS = 24 * 60 * 60_000;
/** Copies the pictures a backup folder doesn't have yet and drops the ones deleted for good long ago; see syncPictureFiles. */
export function syncPictures(db: DB, dataDir: string, dir: string, now: Date, careful = false): void {
  syncPictureFiles(dataDir, dir, gonePictures(db, now), careful);
}

/**
 * Writes today's consistent snapshot to `dir` as memory-YYYY-MM-DD.db (local date) (replacing one from earlier today),
 * without the sign-in data (STRIP_SIGN_IN_SQL), checks it, then keeps only the newest `keep` snapshots. The in-app twin
 * of scripts/backup.sh, for a copy that runs without cron (BACKUP_DIR, the app). The snapshot is made, stripped and
 * checked in a private temporary folder, and only the finished file goes into `dir`: `dir` may be a synced cloud
 * folder, which must never see the sign-in data, not even for a moment or after a crash. In `dir` it only
 * ever writes or deletes memory-YYYY-MM-DD.db files and its own .partial file. Returns the path.
 */
export function backupNow(db: DB, dir: string, keep: number, now: Date, dataDir?: string): Promise<string> {
  return busy('backing up', () => locked(() => backupNowWork(db, dir, keep, now, dataDir)));
}

/**
 * Backup work runs one at a time (startup run, Back up now, the nightly run, a saved copy): the heavy parts are off
 * the main thread, so two runs would otherwise interleave on the same files. A run that waits starts when the one
 * before ends, however it ends.
 */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Resolves once the backup work in flight has ended, or after `maxMs`: the server waits for it before it exits, so a stop never leaves a half-made copy behind. */
export function backupsIdle(maxMs: number): Promise<void> {
  return Promise.race([chain.then(() => {}), new Promise<void>((r) => setTimeout(r, maxMs).unref())]);
}

async function backupNowWork(db: DB, dir: string, keep: number, now: Date, dataDir?: string): Promise<string> {
  // A folder made here is the owner's alone: names and dates of the backups are not for other users of the computer.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // An existing folder (made earlier, or chosen by the owner) is made owner-only too; never loosened, never fatal.
  tighten(dir);
  // The local date, so a backup made just after midnight carries the day it was made on.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = `memory-${day}.db`;
  const path = join(dir, name);
  sweepPartials(dir, MAIN_PARTIAL);
  // Inside the lock no draft of this process is live: what a quit left behind goes now, not at the next start.
  sweepBackupTemp(tmpdir(), true);
  const work = mkdtempSync(join(tmpdir(), 'brain-backup-'));
  try {
    writeFileSync(join(work, 'pid'), String(process.pid));
    const draft = join(work, name);
    await db.backup(draft);
    // Everything heavy after the snapshot (strip, VACUUM, integrity check, the copy) runs in a worker thread.
    // A name of its own for the copy in `dir`, so nothing else ever shares or removes it.
    const partial = join(dir, `.${name}.${randomBytes(8).toString('hex')}.partial`);
    await inWorker('finishDraft', [draft, partial, path], () => finishDraft(draft, partial, path));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const snapshots = readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse();
  for (const old of snapshots.slice(keep)) rmSync(join(dir, old));
  if (dataDir !== undefined) {
    const gone = gonePictures(db, now);
    await inWorker('syncPictures', [dataDir, dir, gone, false], () => syncPictureFiles(dataDir, dir, gone, false));
  }
  return path;
}

/**
 * How many live pictures (rows not deleted for good) have no file in `<dataDir>/images`, as scripts/backup.sh checks
 * at home (audit F11); null when there are none to check.
 */
export function missingPictures(db: DB, dataDir: string): number | null {
  const rows = liveRows(db);
  return rows === null ? null : missingPictureCount(dataDir, rows);
}

function liveRows(db: DB): { id: string; type: string }[] | null {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'").get() !== undefined;
  if (!hasTable) return null;
  const rows = db.prepare('SELECT id, type FROM images WHERE removed_at IS NULL').all() as { id: string; type: string }[];
  if (rows.length === 0) return null;
  return rows;
}

/** The same count, made in a worker thread: with many pictures the per-file checks add up. */
async function missingPicturesOffThread(db: DB, dataDir: string): Promise<number | null> {
  const rows = liveRows(db);
  return rows === null ? null : inWorker('missingPictures', [dataDir, rows], () => missingPictureCount(dataDir, rows));
}

/** The second folders a copy is running to right now: a folder that does not answer (a network share) must not stack copies up or hold the backup lock. */
const copying = new Set<string>();

/**
 * One backup run, logged and recorded in `statusDir` for the dashboard; failures are never thrown. Returns the run it recorded.
 * The backup itself holds the lock; the copy to the second folder runs after it is released, one at a time per folder.
 * `now` may be a function: it is read when the run starts, not when it was queued, so the file carries the day it was made on.
 */
export function runBackup(db: DB, dir: string, keep: number, nowIn: Date | (() => Date), statusDir: string, copy?: BackupCopy): Promise<BackupRun> {
  return busy('backing up', async () => {
    let now = typeof nowIn === 'function' ? new Date() : nowIn;
    let path: string | null = null;
    let run: BackupRun | null = null;
    await locked(async () => {
      now = typeof nowIn === 'function' ? nowIn() : nowIn;
      try {
        // statusDir is the data dir (index.ts), where the pictures live.
        path = await backupNowWork(db, dir, keep, now, statusDir);
        console.log(`Backup written to ${path}`);
      } catch (e) {
        console.error('Backup failed:', e);
        run = { at: now.toISOString(), ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    if (path !== null) {
      try {
        // The second folder gets this finished file; its failure is recorded by the copy itself and never touches this run.
        const folder = copy?.folder() ?? null;
        if (copy && folder !== null && (copying.has(folder) || copy.isLingering?.())) copy.skipBusy(now);
        else {
          if (folder !== null) copying.add(folder);
          try { await (copy?.runOffThread ? copy.runOffThread(path, keep, now, { db, dataDir: statusDir }) : copy?.run(path, keep, now, { db, dataDir: statusDir })); } finally { if (folder !== null) copying.delete(folder); }
        }
      } catch (e) { console.error('Backup copy failed:', e); }
      try {
        run = { at: now.toISOString(), ok: true, copies: [{ where: dir, result: 'copied' }] };
        const missing = await missingPicturesOffThread(db, statusDir);
        if (missing !== null) run.pictures = { missing, stray: 0 };
      } catch (e) {
        console.error('Backup failed:', e);
        run = { at: now.toISOString(), ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    // A status file that cannot be written is logged, never thrown: it must not take the server down.
    try {
      writeBackupStatus(statusDir, 'nightly', run!);
    } catch (e) {
      console.error('Could not record the backup status:', e);
    }
    return run!;
  });
}

/** Backs up now and then every day; failures are logged and recorded, never fatal. Returns the timer (unref'd). */
export function scheduleBackups(db: DB, dir: string, keep: number, now: () => Date, statusDir: string, copy?: BackupCopy): NodeJS.Timeout {
  const run = () => { void runBackup(db, dir, keep, now, statusDir, copy); };
  run();
  return setInterval(run, BACKUP_INTERVAL_MS).unref();
}
