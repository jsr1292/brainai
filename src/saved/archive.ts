/**
 * The saved archive: the one file format for a saved copy of the memories (a copy of the database made as the nightly
 * backup makes it, so no password, authenticator, sessions or tokens, plus the picture files). `packArchive` makes it,
 * `checkArchive` proves a file is one before anything trusts it, so a restore never unpacks a hostile or damaged file.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { backupNow } from '../backup.js';
import { liveCounts, moveAcrossDisks, readCounts } from '../backupWork.js';
import { inWorker } from '../offThread.js';
import { busy } from '../busyMarker.js';
import { latestSchema, type DB } from '../db.js';
import { shown } from './shown.js';

/** The file names an archive has: `brainai-saved-<day>.tar.gz`, and the earlier `brainai-move-<day>.tar.gz`. */
export const ARCHIVE_NAME = /^brainai-(saved|move)-\d{4}-\d{2}-\d{2}\.tar\.gz$/;

export type ArchiveCheck = { ok: true; facts: number; pages: number; schema: number } | { ok: false; reason: string };

const run = promisify(execFile);

export { liveCounts, moveAcrossDisks };

/**
 * Packs the archive at `outFile` (mode 600, written whole or not at all) and gives the counts read from the copy, not
 * from the live brain, so they say what the file holds.
 */
export function packArchive(db: DB, dataDir: string, outFile: string, now: Date): Promise<{ facts: number; pages: number }> {
  return busy('saving a copy', () => packArchiveWork(db, dataDir, outFile, now));
}

async function packArchiveWork(db: DB, dataDir: string, outFile: string, now: Date): Promise<{ facts: number; pages: number }> {
  // Staged next to the data (same disk), in this run's own folder, so two runs at once never share a half-written file.
  const staging = mkdtempSync(join(dataDir, '.move-'));
  try {
    const copy = await backupNow(db, staging, 1, now, dataDir);
    const dbFile = join(staging, 'memory.db');
    renameSync(copy, dbFile);
    const counts = await inWorker('readCounts', [dbFile], () => readCounts(dbFile));
    const partial = join(staging, 'out.tar.gz');
    const parts = existsSync(join(staging, 'images')) ? ['memory.db', 'images'] : ['memory.db'];
    // The system tar (macOS, Linux and Windows 10+ all have one); the server unpacks it with the same command. Without
    // macOS's file attributes and ._ files, which a Linux server's tar would warn about for every file.
    const plain = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
    await run('tar', ['-czf', partial, ...plain, '-C', staging, ...parts], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    chmodSync(partial, 0o600);
    mkdirSync(join(outFile, '..'), { recursive: true, mode: 0o700 });
    await inWorker('moveAcrossDisks', [partial, outFile], () => moveAcrossDisks(partial, outFile));
    return counts;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The non-empty lines of a tar listing; Windows tar may end them with CRLF. */
export function listLines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}

/** Why an entry is not allowed, or null. `type` is the first column of `tar -tv` (`-` file, `d` folder). */
function entryProblem(type: string, name: string): string | null {
  if (type !== '-' && type !== 'd') return `it holds a link or special file (${shown(name)})`;
  if (name.startsWith('/')) return `it holds an absolute path (${shown(name)})`;
  if (name.split('/').includes('..')) return `it holds a path that climbs out of its folder (${shown(name)})`;
  // Windows tar treats `\` as a separator, and `:` reaches drive-relative paths and alternate streams.
  if (/[\\:\0]/.test(name)) return `it holds a name with a backslash or colon (${shown(name)})`;
  return null;
}

/**
 * Looks inside a file without trusting it: only plain files and folders, nothing outside `memory.db` and `images/`,
 * and a database that opens, passes SQLite's own check and is not from a newer BrainAI. Only `memory.db` is unpacked,
 * into a temporary folder that is removed again.
 */
export async function checkArchive(file: string): Promise<ArchiveCheck> {
  let kinds: string[];
  let listed: string[];
  try {
    // Two listings of the same archive: the type column of the verbose one (the columns after it differ between tar
    // makers, so they are not parsed), and the plain names. A name with a line break would make them disagree: refused.
    const opts = { maxBuffer: 256 * 1024 * 1024 };
    kinds = listLines((await run('tar', ['-tvzf', file], opts)).stdout).map((l) => l[0]);
    listed = listLines((await run('tar', ['-tzf', file], opts)).stdout);
  } catch {
    return { ok: false, reason: 'This is not a BrainAI saved copy: the file could not be read as an archive.' };
  }
  if (kinds.length !== listed.length) return { ok: false, reason: 'This is not a BrainAI saved copy: its entries could not be understood.' };
  const names: string[] = [];
  for (const [i, name] of listed.entries()) {
    const problem = entryProblem(kinds[i], name);
    if (problem) return { ok: false, reason: `This is not a safe BrainAI saved copy: ${problem}.` };
    names.push(name.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  if (!names.includes('memory.db')) return { ok: false, reason: 'This is not a BrainAI saved copy: it has no memory.db.' };
  const stray = names.find((n) => n.split('/')[0] !== 'memory.db' && n.split('/')[0] !== 'images');
  if (stray) return { ok: false, reason: `This is not a BrainAI saved copy: it holds something else (${shown(stray)}).` };

  const tmp = mkdtempSync(join(tmpdir(), 'brainai-check-'));
  try {
    try {
      await run('tar', ['-xzf', file, '-C', tmp, 'memory.db']);
    } catch {
      return { ok: false, reason: 'The saved copy could not be unpacked.' };
    }
    return checkDatabase(join(tmp, 'memory.db'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function checkDatabase(file: string): ArchiveCheck {
  let db: DB | undefined;
  try {
    db = new Database(file, { readonly: true });
    const schema = (db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version;
    if (schema === undefined) return { ok: false, reason: 'The database in the saved copy has no schema version.' };
    // Before the integrity check: a newer copy may not be readable by this version at all, and that is the honest reason.
    if (schema > latestSchema()) return { ok: false, reason: 'This copy was saved by a newer BrainAI. Update BrainAI, then try again.' };
    const verdict = db.pragma('integrity_check', { simple: true });
    if (verdict !== 'ok') return { ok: false, reason: 'The database in the saved copy failed its integrity check.' };
    return { ok: true, ...liveCounts(db), schema };
  } catch {
    return { ok: false, reason: 'The database in the saved copy could not be read (integrity check failed).' };
  } finally {
    db?.close();
  }
}
