/**
 * A second folder for the daily backups (the desktop app), kept in <data>/backup-copy.json so it survives restarts:
 * the folder, and how the last copy went. The copy is the finished backup file, never a second backup run, and a
 * failure is recorded here, never thrown. Read from the file each time, so every instance sees the same state.
 */
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

export type CopyResult = { ok: true; at: string } | { ok: false; at: string; folder: string; reason: string };

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

  private read(): { folder: string | null; last: CopyResult | null; written: string[] | null } {
    try {
      const saved = JSON.parse(readFileSync(this.file(), 'utf8')) as { folder?: unknown; last?: unknown; written?: unknown };
      const folder = typeof saved.folder === 'string' && saved.folder !== '' ? saved.folder : null;
      const l = saved.last as Partial<CopyResult> | undefined;
      const last = folder && l && typeof l.at === 'string'
        ? l.ok === true ? { ok: true as const, at: l.at }
          : l.ok === false && typeof l.folder === 'string' && typeof l.reason === 'string' ? { ok: false as const, at: l.at, folder: l.folder, reason: l.reason } : null
        : null;
      const written = Array.isArray(saved.written) ? saved.written.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : null;
      return { folder, last, written };
    } catch {
      return { folder: null, last: null, written: null };
    }
  }

  private write(folder: string | null, last: CopyResult | null, written: string[] | null = null): void {
    if (folder === null) rmSync(this.file(), { force: true });
    else writeFileSync(this.file(), `${JSON.stringify(written === null ? { folder, last } : { folder, last, written })}\n`);
  }

  /** The folder the daily backups are also kept in; null when off. */
  folder(): string | null {
    return this.read().folder;
  }

  /** Chooses the folder (or null to turn it off). A new folder starts with no result. */
  set(folder: string | null): void {
    const was = this.read();
    const same = folder !== null && folder === was.folder;
    this.write(folder, same ? was.last : null, same ? was.written : null);
  }

  /** How the last copy went; null before the first one or when off. */
  lastResult(): CopyResult | null {
    return this.read().last;
  }

  /** Copies the finished backup `file` into the folder and keeps the newest `keep` memory-*.db files there. Never throws. */
  run(file: string, keep: number, now: Date): void {
    const folder = this.folder();
    if (folder === null) return;
    let result: CopyResult;
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('The folder is not there.');
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
        throw e;
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
      this.write(folder, saved.last, written);
      if (stuck.length > 0) throw new Error(`Could not remove the old ${stuck.length === 1 ? 'copy' : 'copies'} ${stuck.join(', ')} from the folder. It will try again next time.`);
      result = { ok: true, at: now.toISOString() };
    } catch (e) {
      result = { ok: false, at: now.toISOString(), folder, reason: e instanceof Error ? e.message : String(e) };
    }
    try {
      this.write(folder, result, this.read().written);
    } catch (e) {
      console.error('Could not record the backup copy result:', e);
    }
  }
}
