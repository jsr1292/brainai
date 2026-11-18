/**
 * Restoring a saved copy (an archive, or a daily backup file memory-<date>.db) into an empty brain. A restore only ever fills a brain that has nothing in it, so it can never
 * overwrite memories: the CLI does it with the server stopped (`restoreInto`), the app stages the file and the server
 * swaps it in on its next start, before the database opens (`stageRestore` + `applyPendingRestore`).
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plain } from './shown.js';
import Database from 'better-sqlite3';
import { checkArchive, listLines } from './archive.js';
import { restoredRowsProblem } from './rowChecks.js';
import { checkBackupFile, kindOfFile, pictureRows, picturesCanBeRemoved, stripSignIn } from './backupFile.js';

const run = promisify(execFile);

/** What a restore brought in; `pictures_missing` is the pictures a backup file lists but cannot carry (0 for an archive). */
export type Restored = { facts: number; pages: number; pictures_missing: number };

/** Left in the staged folder when the source was a database; holds how many live pictures the file listed (now marked removed), for the start-up swap to report. */
const FROM_DATABASE = 'from-database';

const NOT_EMPTY = 'This brain already has memories: BrainAI only brings a saved copy into an empty one.';

/**
 * How many rows a query counts. Only a missing table counts as none (an older database); any other failure, a missing
 * column included, is thrown, so a brain that cannot be read is never taken for an empty one.
 */
function count(db: Database.Database, sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } catch (e) {
    if (/no such table/.test((e as Error).message)) return 0;
    throw e;
  }
}

/**
 * True when the file is missing, or holds no live pages and no live memories except the welcome (the owner's profile
 * fact). Opened read-only and never migrated, so looking never changes the brain.
 */
export function isEmptyBrain(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const pages = count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL');
    const facts = count(db, "SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND NOT (kind = 'profile' AND created_by = 'owner')");
    return pages === 0 && facts === 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Unpacks only `memory.db` and the `images/` folder (the archive was checked, but nothing else is ever asked for). */
async function extract(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true, mode: 0o700 });
  // Named exactly as the archive lists them (`./memory.db` stays `./memory.db`), so tar always finds them.
  const listed = listLines(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const top = (n: string) => n.replace(/^\.\//, '').split('/')[0];
  const wanted = [listed.find((n) => n.replace(/^\.\//, '') === 'memory.db')!, ...listed.filter((n) => top(n) === 'images')];
  await run('tar', ['-xzf', archive, '-C', into, '--no-same-owner', ...wanted]);
}

/** Checks either kind of file and says what it holds; `pictures_missing` counts the pictures only a database can lack. */
async function checked(file: string): Promise<{ kind: 'archive' | 'database'; counts: Restored }> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error('This is not a saved BrainAI file or backup (a .tar.gz or a memory-….db).');
  const c = kind === 'archive' ? await checkArchive(file) : checkBackupFile(file);
  if (!c.ok) throw new Error(c.reason);
  // pictures_missing of a database is counted on the staged copy, never on the source.
  return { kind, counts: { facts: c.facts, pages: c.pages, pictures_missing: 0 } };
}

/** Puts the database (and an archive's pictures) into `into`, with the sign-in data taken out. The source is never changed. */
async function unpack(file: string, kind: 'archive' | 'database', into: string): Promise<number> {
  if (kind === 'archive') {
    await extract(file, into);
  } else {
    mkdirSync(into, { recursive: true, mode: 0o700 });
    copyFileSync(file, join(into, 'memory.db'));
  }
  stripSignIn(join(into, 'memory.db'));
  const problem = restoredRowsProblem(join(into, 'memory.db'));
  if (problem) throw new Error(`This saved copy holds names BrainAI would never write (${problem}), so it is not brought back.`);
  if (kind === 'archive') return 0;
  // A backup file holds no pictures: count the live ones (not deleted for good), then mark them removed on the staged
  // copy, so the restored brain does not list pictures it cannot have and the backup check has nothing to flag.
  const db = new Database(join(into, 'memory.db'));
  try {
    const n = pictureRows(db);
    if (n > 0 && picturesCanBeRemoved(db)) db.prepare("UPDATE images SET removed_at = ?, removed_by = 'restore' WHERE removed_at IS NULL").run(new Date().toISOString());
    writeFileSync(join(into, FROM_DATABASE), String(n));
    return n;
  } finally { db.close(); }
}

/** The picture count a database restore left in its staged folder; 0 for an archive (no note) or an unreadable one. */
function missingFromNote(staged: string): number {
  try {
    const n = Number(readFileSync(join(staged, FROM_DATABASE), 'utf8'));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Moves the unpacked database and pictures from `from` into the data folder, dropping the old database's side files. */
function swapIn(from: string, dataDir: string): void {
  // Pictures first and the database last: if the pictures fail, the database has not changed.
  if (existsSync(join(from, 'images'))) cpSync(join(from, 'images'), join(dataDir, 'images'), { recursive: true });
  for (const f of ['memory.db-wal', 'memory.db-shm']) rmSync(join(dataDir, f), { force: true });
  renameSync(join(from, 'memory.db'), join(dataDir, 'memory.db'));
}

/** An error from a crafted file may carry its text (SQLite quotes a constraint name): bounded and safe to print or show. */
async function safely<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw new Error(plain(e instanceof Error ? e.message : e));
  }
}

/** Restores into the data folder now. For the CLI, which runs with the server stopped. */
async function restoreIntoRaw(file: string, dataDir: string): Promise<Restored> {
  const { kind, counts } = await checked(file);
  if (!isEmptyBrain(join(dataDir, 'memory.db'))) throw new Error(NOT_EMPTY);
  mkdirSync(dataDir, { recursive: true });
  const stage = join(dataDir, `.restore-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    counts.pictures_missing = await unpack(file, kind, stage);
    swapIn(stage, dataDir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return counts;
}

export const restoreInto = (file: string, dataDir: string): Promise<Restored> => safely(() => restoreIntoRaw(file, dataDir));

/** Checks the file and unpacks it into `<data>/restore-pending/`, for the server to swap in at its next start. */
async function stageRestoreRaw(file: string, dataDir: string): Promise<Restored> {
  const { kind, counts } = await checked(file);
  if (!isEmptyBrain(join(dataDir, 'memory.db'))) throw new Error(NOT_EMPTY);
  const pending = join(dataDir, 'restore-pending');
  rmSync(pending, { recursive: true, force: true });
  try {
    counts.pictures_missing = await unpack(file, kind, pending);
  } catch (e) {
    rmSync(pending, { recursive: true, force: true });
    throw e;
  }
  return counts;
}

export const stageRestore = (file: string, dataDir: string): Promise<Restored> => safely(() => stageRestoreRaw(file, dataDir));

/**
 * At startup, before the database opens: swaps a staged restore in when the brain is still empty, and leaves a note in
 * `restored.json` either way. It never throws: whatever goes wrong, the current brain stays as it is and the server starts.
 */
export function applyPendingRestore(dataDir: string): Restored | null {
  const pending = join(dataDir, 'restore-pending');
  if (!existsSync(join(pending, 'memory.db'))) {
    rmSync(pending, { recursive: true, force: true });
    return null;
  }
  const note = (o: object) => { try { writeFileSync(join(dataDir, 'restored.json'), JSON.stringify(o)); } catch { /* nothing more to do */ } };
  try {
    if (!isEmptyBrain(join(dataDir, 'memory.db'))) {
      note({ refused: 'This brain already has memories, so the saved copy was not brought in.' });
      return null;
    }
    const db = new Database(join(pending, 'memory.db'), { readonly: true });
    let counts: Restored;
    try {
      counts = {
        facts: count(db, 'SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL'),
        pages: count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'),
        pictures_missing: missingFromNote(pending),
      };
    } finally {
      db.close();
    }
    swapIn(pending, dataDir);
    note({ at: new Date().toISOString(), ...counts });
    return counts;
  } catch (e) {
    console.error('restore: the saved copy could not be brought in:', e);
    note({ refused: 'The saved copy could not be brought in, so the brain was left as it is.' });
    return null;
  } finally {
    rmSync(pending, { recursive: true, force: true });
  }
}
