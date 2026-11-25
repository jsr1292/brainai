/**
 * A second folder for the daily backups (the desktop app), kept in <data>/backup-copy.json so it survives restarts:
 * the folder, and how the last copy went. The copy is the finished backup file, never a second backup run, and a
 * failure is recorded here, never thrown. Read from the file each time, so every instance sees the same state.
 */
import { chmodSync, type Stats, closeSync, constants, mkdirSync, copyFileSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { gonePictures, MAIN_PARTIAL, sweepPartials, syncPictureFiles, type GonePicture } from '../backupWork.js';
import { inWorker, WorkerTimeout } from '../offThread.js';
import { BRAIN_ID, brainId, type DB } from '../db.js';

/** Why a copy failed, as a code the screens word in the owner's language (the raw message, with paths, stays in `reason` and the log). */
export type CopyWhy = 'folder' | 'brainFolder' | 'pictures' | 'write' | 'stuck' | 'timeout' | 'busy' | 'other';
export const COPY_WHY: readonly CopyWhy[] = ['folder', 'brainFolder', 'pictures', 'write', 'stuck', 'timeout', 'busy', 'other'];
/** An error with the code of the known failure. */
class CopyFailure extends Error {
  constructor(message: string, readonly why: CopyWhy) { super(message); }
}
export type CopyResult = { ok: true; at: string } | { ok: false; at: string; folder: string; reason: string; why: CopyWhy };

/** A second copy counts as current for this many days (the first-steps tick and brain health). */
export const COPY_MAX_DAYS = 8;

/** Where the second folder stands: off, chosen but never copied, copied recently, failed, or copied but too long ago. */
export type CopyState = { kind: 'off' } | { kind: 'first' } | { kind: 'ok'; at: string } | { kind: 'failed'; reason: string; why: CopyWhy; at: string } | { kind: 'old'; at: string };
export function copyState(folder: string | null, last: CopyResult | null, now: Date): CopyState {
  if (folder === null) return { kind: 'off' };
  if (last === null) return { kind: 'first' };
  if (!last.ok) return { kind: 'failed', reason: last.reason, why: last.why, at: last.at };
  return now.getTime() - Date.parse(last.at) > COPY_MAX_DAYS * 86_400_000 ? { kind: 'old', at: last.at } : { kind: 'ok', at: last.at };
}

const NAME = /^memory-\d{4}-\d{2}-\d{2}\.db$/;

/** The folder inside the chosen one that holds this brain's copies: two brains may share a folder, each keeps to its own. */
export const BRAIN_FOLDER = /^brainai-[0-9a-f]{8}$/;
export const brainFolderName = (id: string): string => {
  if (!BRAIN_ID.test(id)) throw new Error('A brain id is 32 hex digits.');
  return `brainai-${id.slice(0, 8)}`;
};

type Opener = (path: string, flags: number) => number;

/**
 * Narrows a regular file with one name to 0600 through a descriptor that never follows a link; anything else is skipped.
 * A copy that already has no group or other bits is not opened at all: opening a file that iCloud Drive evicted
 * (Optimize Mac Storage) makes macOS download it, and the open blocks the server meanwhile.
 */
function ownerOnly(path: string, open: Opener): void {
  try {
    const seen = lstatSync(path);
    if (!seen.isFile() || seen.nlink !== 1 || (seen.mode & 0o077) === 0) return;
    const fd = open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd);
      if (st.isFile() && st.nlink === 1) fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch { /* a link, or gone: left alone */ }
}

/**
 * This brain's folder inside the chosen one, made owner-only when new. A name that is not a real folder (a planted
 * link, a file) or not ours is never followed or used; an existing folder is narrowed to 0700, never loosened.
 */
function ownFolder(folder: string, id: string, uid: number | null): { dir: string; still: () => void } {
  const dir = join(folder, brainFolderName(id));
  const way = (): CopyFailure => new CopyFailure(`${dir} is not an ordinary folder of yours, so nothing was copied.`, 'brainFolder');
  let seen: Stats | null = null;
  // A name that appeared meanwhile is in the way; a chosen folder that is gone is the folder's problem; any other failure is a write problem.
  const fail = (e: unknown): CopyFailure => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return way();
    if (code === 'ENOENT' || code === 'ENOTDIR') return new CopyFailure('The folder is not there.', 'folder');
    return new CopyFailure(`Could not use ${dir}: ${e instanceof Error ? e.message : String(e)}`, 'write');
  };
  try { seen = lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fail(e); }
  if (seen === null) {
    try { mkdirSync(dir, { mode: 0o700 }); seen = lstatSync(dir); } catch (e) { throw fail(e); }
  } else {
    if (!seen.isDirectory() || (uid !== null && seen.uid !== uid)) throw way();
    if ((seen.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  const { dev, ino } = seen;
  // Checked again before anything is deleted or written into it: the folder must still be the one first seen.
  const still = () => {
    let now: Stats;
    try { now = lstatSync(dir); } catch { throw way(); }
    if (!now.isDirectory() || now.dev !== dev || now.ino !== ino) throw way();
  };
  return { dir, still };
}

export class BackupCopy {
  constructor(
    private readonly dir: string,
    private readonly remove: (path: string, opts: { force: boolean }) => void = rmSync,
    private readonly open: Opener = openSync,
    /** Test seam: runs right after the brain's own folder is made or checked. */
    private readonly afterOwnFolder?: () => void,
  ) {}

  /** A copy that has not ended after this long is stopped and recorded as stuck (a share that stopped answering). Test seams: the limit and the worker file. */
  limitMs = 6 * 3_600_000;
  private lingering: Promise<void> | null = null;

  /** A worker that was stopped at the time limit is still running its last call: no new copy is started meanwhile. */
  isLingering(): boolean { return this.lingering !== null; }
  workerUrl: URL | undefined;

  private file(): string {
    return join(this.dir, 'backup-copy.json');
  }

  private read(): { folder: string | null; last: CopyResult | null; written: string[] | null; firstOk: string | null; brain: string | null } {
    try {
      const saved = JSON.parse(readFileSync(this.file(), 'utf8')) as { folder?: unknown; last?: unknown; written?: unknown; firstOk?: unknown; brain?: unknown };
      const folder = typeof saved.folder === 'string' && saved.folder !== '' ? saved.folder : null;
      const l = saved.last as Partial<CopyResult> | undefined;
      const last = folder && l && typeof l.at === 'string'
        ? l.ok === true ? { ok: true as const, at: l.at }
          : l.ok === false && typeof l.folder === 'string' && typeof l.reason === 'string' ? { ok: false as const, at: l.at, folder: l.folder, reason: l.reason, why: COPY_WHY.includes(l.why as CopyWhy) ? l.why as CopyWhy : 'other' as const } : null
        : null;
      const written = Array.isArray(saved.written) ? saved.written.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : null;
      // The first success is kept apart from `last`, which a later failure overwrites; older files only knew `last`.
      const firstOk = folder && typeof saved.firstOk === 'string' ? saved.firstOk : last?.ok ? last.at : null;
      const brain = typeof saved.brain === 'string' && /^[0-9a-f]{32}$/.test(saved.brain) ? saved.brain : null;
      return { folder, last, written, firstOk, brain };
    } catch {
      return { folder: null, last: null, written: null, firstOk: null, brain: null };
    }
  }

  private write(folder: string | null, last: CopyResult | null, written: string[] | null = null, firstOk: string | null = null, brain: string | null = null): void {
    if (folder === null) rmSync(this.file(), { force: true });
    else {
      // Through a temporary file and a rename: another thread (the server's main thread) may read this file at any moment.
      const tmp = `${this.file()}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify({ folder, last, ...(written === null ? {} : { written }), ...(firstOk === null ? {} : { firstOk }), ...(brain === null ? {} : { brain }) })}\n`);
        renameSync(tmp, this.file());
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    }
  }

  /** The folder the daily backups are also kept in; null when off. */
  folder(): string | null {
    return this.read().folder;
  }

  /** Chooses the folder (or null to turn it off). A new folder starts with no result. */
  set(folder: string | null): void {
    const was = this.read();
    const same = folder !== null && folder === was.folder;
    this.write(folder, same ? was.last : null, same ? was.written : null, same ? was.firstOk : null, same ? was.brain : null);
  }

  /** How the last copy went; null before the first one or when off. */
  lastResult(): CopyResult | null {
    return this.read().last;
  }

  /** Whether a copy to the chosen folder has ever succeeded (a later failure does not undo it; a new folder starts again). */
  everCopied(): boolean {
    return this.read().firstOk !== null;
  }

  /**
   * `run`, in a worker thread: the copy of a big backup and of thousands of pictures to a slow or synced folder keeps
   * the server's main thread free. Same files, same recorded result. The files are copied in the worker; backup-copy.json
   * and the brain's id are read and written here, on the main thread. A copier built with its own remove/open (tests)
   * works on this thread.
   */
  async runOffThread(file: string, keep: number, now: Date, ctx: { db: DB; dataDir?: string }): Promise<void> {
    if (this.remove !== rmSync || this.open !== openSync) return this.run(file, keep, now, ctx);
    const plan = this.plan(file, now, ctx);
    if (plan === null) return;
    const { folder, id, job, list, added } = plan;
    let out: { written: string[] | null; brain: string | null; added?: string | null; made?: boolean; result: CopyResult };
    try {
      out = { ...(await inWorker('copyRun', [file, keep, now.toISOString(), id, job, folder, list], () => this.work(file, keep, now, id, job, folder, list), this.workerUrl, this.limitMs)) } as typeof out;
      out.added = out.made ? null : added;
    } catch (e) {
      // A worker that died or never returned: the result is recorded here, so an old "ok" is not left standing. The
      // copy's name stays listed (it may have been renamed into place); the next run drops it if no file is there.
      const stuck = e instanceof WorkerTimeout;
      // The thread may still be inside a call that never returns: this copier counts as busy until it has really ended.
      if (e instanceof WorkerTimeout) { const gone = e.exited.finally(() => { if (this.lingering === gone) this.lingering = null; }); this.lingering = gone; }
      const reason = e instanceof Error ? e.message : String(e);
      console.error('Backup copy to the second folder failed:', reason);
      out = { written: null, brain: null, result: { ok: false, at: now.toISOString(), folder, reason, why: stuck ? 'timeout' : 'other' } };
    }
    this.record(folder, out);
  }

  /** The second folder could not be copied to because the last copy to it is still running (a folder that does not answer). */
  skipBusy(now: Date): void {
    const folder = this.folder();
    if (folder === null) return;
    this.record(folder, { written: null, brain: null, result: { ok: false, at: now.toISOString(), folder, reason: 'The previous copy to this folder is still running.', why: 'busy' } });
  }

  /**
   * What a copy needs from backup-copy.json and the live brain, read here on the main thread. The copy's own name goes
   * into the list before the file is made: a process that dies after the copy was renamed into place but before the
   * result was recorded still finds it in the list, so it is pruned later like the others. A name whose file never came
   * (the run failed) is taken out again by `record`, and by the next copy if a crash left it.
   */
  private plan(file: string, now: Date, ctx: { db: DB; dataDir?: string }): { folder: string; id: string; job: { gone: GonePicture[]; dataDir: string } | undefined; list: string[] | null; added: string | null } | null {
    const folder = this.folder();
    if (folder === null) return null;
    let id: string;
    try { id = brainId(ctx.db); } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('Backup copy to the second folder failed:', reason);
      this.record(folder, { written: null, brain: null, result: { ok: false, at: now.toISOString(), folder, reason, why: 'other' } });
      return null;
    }
    const read = this.read();
    // A list kept for another brain (a restored copy with a new id, an older version's flat list) is not this brain's.
    const mine = read.brain === id ? read.written : null;
    const name = basename(file);
    let list = mine;
    let added: string | null = null;
    if (mine !== null && NAME.test(name) && !mine.includes(name)) {
      list = [...mine, name].sort();
      added = name;
      try { this.write(folder, read.last, list, read.firstOk, id); } catch { /* the result is recorded after the copy anyway */ }
    }
    let job: { gone: GonePicture[]; dataDir: string } | undefined;
    try {
      job = ctx.dataDir !== undefined ? { gone: gonePictures(ctx.db, now), dataDir: ctx.dataDir } : undefined;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('Backup copy to the second folder failed:', reason);
      this.record(folder, { written: null, brain: null, added, result: { ok: false, at: now.toISOString(), folder, reason, why: 'other' } });
      return null;
    }
    return { folder, id, job, list, added };
  }

  /** What the copy leaves in backup-copy.json, unless the owner has turned the folder off or chosen another meanwhile. */
  private record(folder: string, out: { written: string[] | null; brain: string | null; added?: string | null; made?: boolean; result: CopyResult }): void {
    try {
      const now0 = this.read();
      if (now0.folder !== folder) return;
      // A run that failed before the copy was made leaves no file: the name it listed first is taken out again.
      const written = out.written ?? (out.added && now0.written ? now0.written.filter((n) => n !== out.added) : now0.written);
      this.write(folder, out.result, written, out.result.ok ? (now0.firstOk ?? out.result.at) : now0.firstOk, out.brain ?? now0.brain);
    } catch (e) {
      console.error('Could not record the backup copy result:', e);
    }
  }

  /**
   * Copies the finished backup `file` into this brain's own folder inside the chosen one (`brainai-<8 hex of the
   * brain's id>/`, owner only, never a link) and keeps the newest `keep` memory-*.db files there; with `dataDir`, also
   * the picture files into its `images/` (as the main backup does, and removes the ones deleted for good over 30 days
   * ago). Only this brain's folder is ever read for adoption or pruned: another brain sharing the chosen folder, and
   * the flat memory-*.db files an earlier version left there (whose brain is unknown), are never touched. A picture
   * failure is a failed result, after the database copy is whole. Never throws.
   */
  run(file: string, keep: number, now: Date, ctx: { db: DB; dataDir?: string }): void {
    const plan = this.plan(file, now, ctx);
    if (plan === null) return;
    this.record(plan.folder, (() => { const w = this.work(file, keep, now, plan.id, plan.job, plan.folder, plan.list); return { ...w, added: w.made ? null : plan.added }; })());
  }

  /** The file work of a copy (no backup-copy.json, no live brain): safe to run in a worker. Never throws; says what it wrote and how it went. */
  work(file: string, keep: number, now: Date, id: string, pictures: { gone: GonePicture[]; dataDir: string } | undefined, folder: string, savedWritten: string[] | null): { written: string[] | null; brain: string | null; made: boolean; result: CopyResult } {
    let made = false;
    let result: CopyResult;
    let written: string[] | null = null;
    let brain: string | null = null;
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new CopyFailure('The folder is not there.', 'folder');
      const name = basename(file);
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      const { dir, still } = ownFolder(folder, id, uid);
      this.afterOwnFolder?.();
      still();
      // Half-made copies of an earlier run that was stopped (a quit, an update) go first, from this brain's own folder only.
      sweepPartials(dir, MAIN_PARTIAL);
      // The first run with no list adopts the memory-*.db files already in this brain's own folder (this user's own, where owners exist).
      let list = savedWritten ?? readdirSync(dir).filter((f) => {
        // Never a later date than this copy: the copier writes none, so such a name was put there by someone else.
        if (!NAME.test(f) || f > name) return false;
        try {
          const st = lstatSync(join(dir, f));
          return st.isFile() && st.nlink === 1 && (uid === null || st.uid === uid);
        } catch { return false; }
      });
      const partial = join(dir, `.${name}.${randomBytes(8).toString('hex')}.partial`);
      still();
      try {
        copyFileSync(file, partial, constants.COPYFILE_EXCL);
        renameSync(partial, join(dir, name));
        made = true;
      } catch (e) {
        rmSync(partial, { force: true });
        throw new CopyFailure(`Could not write the copy: ${e instanceof Error ? e.message : String(e)}`, 'write');
      }
      if (!list.includes(name)) list.push(name);
      list = list.sort();
      still();
      // Names whose file is gone (a run that failed or was stopped after it listed its name) must not count toward `keep`:
      // they would push real copies out. Today's name stays; a name whose check fails for another reason stays too.
      list = list.filter((n) => {
        if (n === name) return true;
        try { lstatSync(join(dir, n)); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
      });
      const dropped = new Set<string>();
      const stuck: string[] = [];
      for (const old of list.slice().reverse().slice(keep)) {
        const path = join(dir, old);
        try {
          if (lstatSync(path).isFile()) this.remove(path, { force: false });
          dropped.add(old);
        } catch (e) {
          // Gone, or not a regular file any more: nothing to delete. Any other failure keeps the name to try again.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') dropped.add(old);
          else stuck.push(old);
        }
      }
      list = list.filter((n) => !dropped.has(n));
      still();
      for (const n of list) ownerOnly(join(dir, n), this.open);
      written = list;
      brain = id;
      if (pictures) {
        still();
        try { syncPictureFiles(pictures.dataDir, dir, pictures.gone, true); } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          throw new CopyFailure(m.startsWith('Pictures could not be copied') ? m : `Pictures could not be copied: ${m}`, 'pictures');
        }
      }
      if (stuck.length > 0) throw new CopyFailure(`Could not remove the old ${stuck.length === 1 ? 'copy' : 'copies'} ${stuck.join(', ')} from the folder. It will try again next time.`, 'stuck');
      result = { ok: true, at: now.toISOString() };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('Backup copy to the second folder failed:', reason);
      result = { ok: false, at: now.toISOString(), folder, reason, why: e instanceof CopyFailure ? e.why : 'other' };
    }
    return { written, brain, made, result };
  }
}
