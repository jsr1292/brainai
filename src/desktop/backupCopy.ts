/**
 * A second folder for the daily backups (the desktop app), kept in <data>/backup-copy.json so it survives restarts:
 * the folder, and how the last copy went. The copy is the finished backup file, never a second backup run, and a
 * failure is recorded here, never thrown. Read from the file each time, so every instance sees the same state.
 */
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { syncPictures } from '../backup.js';
import type { DB } from '../db.js';

/** Why a copy failed, as a code the screens word in the owner's language (the raw message, with paths, stays in `reason` and the log). */
export type CopyWhy = 'folder' | 'pictures' | 'write' | 'stuck' | 'other';
export const COPY_WHY: readonly CopyWhy[] = ['folder', 'pictures', 'write', 'stuck', 'other'];
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

export class BackupCopy {
  constructor(
    private readonly dir: string,
    private readonly remove: (path: string, opts: { force: boolean }) => void = rmSync,
    private readonly open: Opener = openSync,
  ) {}

  private file(): string {
    return join(this.dir, 'backup-copy.json');
  }

  private read(): { folder: string | null; last: CopyResult | null; written: string[] | null; firstOk: string | null } {
    try {
      const saved = JSON.parse(readFileSync(this.file(), 'utf8')) as { folder?: unknown; last?: unknown; written?: unknown; firstOk?: unknown };
      const folder = typeof saved.folder === 'string' && saved.folder !== '' ? saved.folder : null;
      const l = saved.last as Partial<CopyResult> | undefined;
      const last = folder && l && typeof l.at === 'string'
        ? l.ok === true ? { ok: true as const, at: l.at }
          : l.ok === false && typeof l.folder === 'string' && typeof l.reason === 'string' ? { ok: false as const, at: l.at, folder: l.folder, reason: l.reason, why: COPY_WHY.includes(l.why as CopyWhy) ? l.why as CopyWhy : 'other' as const } : null
        : null;
      const written = Array.isArray(saved.written) ? saved.written.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : null;
      // The first success is kept apart from `last`, which a later failure overwrites; older files only knew `last`.
      const firstOk = folder && typeof saved.firstOk === 'string' ? saved.firstOk : last?.ok ? last.at : null;
      return { folder, last, written, firstOk };
    } catch {
      return { folder: null, last: null, written: null, firstOk: null };
    }
  }

  private write(folder: string | null, last: CopyResult | null, written: string[] | null = null, firstOk: string | null = null): void {
    if (folder === null) rmSync(this.file(), { force: true });
    else writeFileSync(this.file(), `${JSON.stringify({ folder, last, ...(written === null ? {} : { written }), ...(firstOk === null ? {} : { firstOk }) })}\n`);
  }

  /** The folder the daily backups are also kept in; null when off. */
  folder(): string | null {
    return this.read().folder;
  }

  /** Chooses the folder (or null to turn it off). A new folder starts with no result. */
  set(folder: string | null): void {
    const was = this.read();
    const same = folder !== null && folder === was.folder;
    this.write(folder, same ? was.last : null, same ? was.written : null, same ? was.firstOk : null);
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
   * Copies the finished backup `file` into the folder and keeps the newest `keep` memory-*.db files there; with
   * `pictures`, also the picture files into `<folder>/images/` (as the main backup does, and removes the ones deleted
   * for good over 30 days ago). A picture failure is a failed result, after the database copy is whole. Never throws.
   */
  run(file: string, keep: number, now: Date, pictures?: { db: DB; dataDir: string }): void {
    const folder = this.folder();
    if (folder === null) return;
    let result: CopyResult;
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new CopyFailure('The folder is not there.', 'folder');
      const name = basename(file);
      const saved = this.read();
      // The first run with no list adopts the memory-*.db files an earlier version left (this user's own, where owners exist).
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      let written = saved.written ?? readdirSync(folder).filter((f) => {
        // Never a later date than this copy: the copier writes none, so such a name was put there by someone else.
        if (!NAME.test(f) || f > name) return false;
        try {
          const st = lstatSync(join(folder, f));
          return st.isFile() && st.nlink === 1 && (uid === null || st.uid === uid);
        } catch { return false; }
      });
      const partial = join(folder, `.${name}.${randomBytes(8).toString('hex')}.partial`);
      try {
        copyFileSync(file, partial, constants.COPYFILE_EXCL);
        renameSync(partial, join(folder, name));
      } catch (e) {
        rmSync(partial, { force: true });
        throw new CopyFailure(`Could not write the copy: ${e instanceof Error ? e.message : String(e)}`, 'write');
      }
      if (!written.includes(name)) written.push(name);
      written = written.sort();
      const dropped = new Set<string>();
      const stuck: string[] = [];
      for (const old of written.slice().reverse().slice(keep)) {
        const path = join(folder, old);
        try {
          if (lstatSync(path).isFile()) this.remove(path, { force: false });
          dropped.add(old);
        } catch (e) {
          // Gone, or not a regular file any more: nothing to delete. Any other failure keeps the name to try again.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') dropped.add(old);
          else stuck.push(old);
        }
      }
      written = written.filter((n) => !dropped.has(n));
      for (const n of written) ownerOnly(join(folder, n), this.open);
      this.write(folder, saved.last, written, saved.firstOk);
      if (pictures) {
        try { syncPictures(pictures.db, pictures.dataDir, folder, now, true); } catch (e) {
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
    try {
      const now0 = this.read();
      this.write(folder, result, now0.written, result.ok ? (now0.firstOk ?? result.at) : now0.firstOk);
    } catch (e) {
      console.error('Could not record the backup copy result:', e);
    }
  }
}
