/**
 * A second folder for the daily backups (the desktop app), kept in <data>/backup-copy.json so it survives restarts:
 * the folder, and how the last copy went. The copy is the finished backup file, never a second backup run, and a
 * failure is recorded here, never thrown. Read from the file each time, so every instance sees the same state.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type CopyResult = { ok: true; at: string } | { ok: false; at: string; folder: string; reason: string };

const NAME = /^memory-\d{4}-\d{2}-\d{2}\.db$/;

export class BackupCopy {
  constructor(private readonly dir: string) {}

  private file(): string {
    return join(this.dir, 'backup-copy.json');
  }

  private read(): { folder: string | null; last: CopyResult | null } {
    try {
      const saved = JSON.parse(readFileSync(this.file(), 'utf8')) as { folder?: unknown; last?: unknown };
      const folder = typeof saved.folder === 'string' && saved.folder !== '' ? saved.folder : null;
      const l = saved.last as Partial<CopyResult> | undefined;
      const last = folder && l && typeof l.at === 'string'
        ? l.ok === true ? { ok: true as const, at: l.at }
          : l.ok === false && typeof l.folder === 'string' && typeof l.reason === 'string' ? { ok: false as const, at: l.at, folder: l.folder, reason: l.reason } : null
        : null;
      return { folder, last };
    } catch {
      return { folder: null, last: null };
    }
  }

  private write(folder: string | null, last: CopyResult | null): void {
    if (folder === null) rmSync(this.file(), { force: true });
    else writeFileSync(this.file(), `${JSON.stringify({ folder, last })}\n`);
  }

  /** The folder the daily backups are also kept in; null when off. */
  folder(): string | null {
    return this.read().folder;
  }

  /** Chooses the folder (or null to turn it off). A new folder starts with no result. */
  set(folder: string | null): void {
    const was = this.read();
    this.write(folder, folder !== null && folder === was.folder ? was.last : null);
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
      const partial = join(folder, `.${name}.partial`);
      try {
        copyFileSync(file, partial);
        renameSync(partial, join(folder, name));
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
      for (const old of readdirSync(folder).filter((f) => NAME.test(f)).sort().reverse().slice(keep)) rmSync(join(folder, old));
      result = { ok: true, at: now.toISOString() };
    } catch (e) {
      result = { ok: false, at: now.toISOString(), folder, reason: e instanceof Error ? e.message : String(e) };
    }
    try {
      this.write(folder, result);
    } catch (e) {
      console.error('Could not record the backup copy result:', e);
    }
  }
}
