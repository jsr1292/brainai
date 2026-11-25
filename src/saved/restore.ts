/**
 * Restoring a saved copy (an archive, or a daily backup file memory-<date>.db) into an empty brain. A restore only ever fills a brain that has nothing in it, so it can never
 * overwrite memories: the CLI does it with the server stopped (`restoreInto`), the app stages the file and the server
 * swaps it in on its next start, before the database opens (`stageRestore` + `applyPendingRestore`).
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { plain } from './shown.js';
import Database from 'better-sqlite3';
import { checkArchive, listLines } from './archive.js';
import { busy, busyTick } from '../busyMarker.js';
import { restoredRowsProblem } from './rowChecks.js';
import { cleanImage, EXT } from '../images/clean.js';
import { latestSchema } from '../db.js';
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
 * True when the file is missing, or holds no live pages, memories, skills or discussions of the owner's, except the
 * welcome's name (at most ONE live owner profile fact). Opened read-only and never migrated, so looking never changes
 * the brain.
 */
export function isEmptyBrain(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const pages = count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL');
    const facts = count(db, "SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND NOT (kind = 'profile' AND created_by = 'owner')");
    const names = count(db, "SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND kind = 'profile' AND created_by = 'owner'");
    const skills = count(db, 'SELECT COUNT(*) AS n FROM skills WHERE deleted_at IS NULL');
    const discussions = count(db, 'SELECT COUNT(*) AS n FROM discussions WHERE deleted_at IS NULL');
    return pages === 0 && facts === 0 && names <= 1 && skills === 0 && discussions === 0;
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
export function checked(file: string): Promise<{ kind: 'archive' | 'database'; counts: Restored }> {
  return busy('checking a copy', () => checkedWork(file));
}

async function checkedWork(file: string): Promise<{ kind: 'archive' | 'database'; counts: Restored }> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error('This is not a saved BrainAI file or backup (a .tar.gz or a memory-….db).');
  const c = kind === 'archive' ? await checkArchive(file) : checkBackupFile(file);
  if (!c.ok) throw new Error(c.reason);
  // pictures_missing of a database is counted on the staged copy, never on the source.
  return { kind, counts: { facts: c.facts, pages: c.pages, pictures_missing: 0 } };
}

/** The sign-in addresses every brain starts with (db.ts MIGRATION_1); a restored copy goes back to exactly these. */
const DEFAULT_ALLOWLIST = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'loopback'];

/**
 * Security settings a saved copy must not bring in (security review #11), after its sign-in data is stripped: the
 * redirect allowlist goes back to the defaults, registered apps and their connections are dropped (an app registers and
 * the owner approves it again), and skills the copy has switched on are Off until the owner turns them on.
 */
function resetSecuritySettings(file: string): void {
  const db = new Database(file);
  try {
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(table);
    db.transaction(() => {
      if (has('redirect_allowlist')) {
        db.exec('DELETE FROM redirect_allowlist');
        const add = db.prepare("INSERT INTO redirect_allowlist(entry, added_at) VALUES (?, datetime('now'))");
        for (const e of DEFAULT_ALLOWLIST) add.run(e);
      }
      for (const table of ['oauth_grants', 'oauth_clients']) if (has(table)) db.exec(`DELETE FROM ${table}`);
      if (has('skills') && (db.pragma('table_info(skills)') as { name: string }[]).some((c) => c.name.toLowerCase() === 'enabled')) db.exec('UPDATE skills SET enabled = 0');
    })();
    db.exec('VACUUM');
  } finally { db.close(); }
}

/**
 * Runs every picture the staged database lists and whose file is there through the cleaning uploads get (cleanImage:
 * type from the bytes, only listed parts kept, size limits). A file that fails, is not what its row says, or is not a
 * plain file is deleted and its row marked removed by the restore (or dropped, in a database that does not record
 * removals). Files the database does not list are never served and are left alone. Returns how many pictures went.
 */
function cleanRestoredPictures(into: string): number {
  const db = new Database(join(into, 'memory.db'));
  try {
    const hasRemoved = (db.pragma('table_info(images)') as { name: string }[]).some((c) => c.name === 'removed_by');
    const hasFrames = (db.pragma('table_info(images)') as { name: string }[]).some((c) => c.name === 'frames');
    const at = new Date().toISOString();
    let dropped = 0;
    for (const r of restorablePictures(db)) {
      busyTick();
      if (!/^[0-9a-f]{3,}$/.test(r.id) || !/^[a-z0-9]{1,8}$/.test(r.type)) continue;
      const file = join(into, 'images', r.id.slice(0, 2), `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`);
      let st;
      try { st = lstatSync(file); } catch { continue; }
      let bad = !st.isFile();
      if (!bad) {
        try {
          const original = readFileSync(file);
          const c = cleanImage(original);
          if (c.type !== r.type || EXT[c.type] !== (r.type === 'jpeg' ? 'jpg' : r.type)) bad = true;
          else if (!c.bytes.equals(original)) {
            writeFileSync(file, c.bytes);
            // The row describes the file that is there now (the size and the header's width, height and frames).
            if (hasFrames) db.prepare('UPDATE images SET bytes = ?, width = ?, height = ?, frames = ? WHERE id = ?').run(c.bytes.length, c.width, c.height, c.frames, r.id);
            else db.prepare('UPDATE images SET bytes = ?, width = ?, height = ? WHERE id = ?').run(c.bytes.length, c.width, c.height, r.id);
          }
        } catch { bad = true; }
      }
      if (!bad) continue;
      // A folder (or a link) where the file should be goes too, with whatever is in it.
      rmSync(file, { recursive: true, force: true });
      if (hasRemoved) db.prepare("UPDATE images SET removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'restore') WHERE id = ?").run(at, r.id);
      else db.prepare('DELETE FROM images WHERE id = ?').run(r.id);
      dropped++;
    }
    return dropped;
  } finally { db.close(); }
}

/**
 * A restored brain gets a new id when it first needs one (db.ts brainId): the copy may be restored twice, or the old
 * brain may still be running, and two live brains must never share a backup folder name.
 */
function forgetBrainId(file: string): void {
  const db = new Database(file);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'brain_switches'").get()) db.exec("DELETE FROM brain_switches WHERE name = 'brain_id'");
  } finally { db.close(); }
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
  resetSecuritySettings(join(into, 'memory.db'));
  forgetBrainId(join(into, 'memory.db'));
  const problem = restoredRowsProblem(join(into, 'memory.db'));
  if (problem) throw new Error(`This saved copy holds names BrainAI would never write (${problem}), so it is not brought back.`);
  if (kind === 'archive') return cleanRestoredPictures(into);
  // A backup file holds no pictures itself. The pictures that sit beside it (an `images` folder, as the second backup
  // folder keeps them) are brought along; the live pictures still without a file are counted, then marked removed on the
  // staged copy, so the restored brain does not list pictures it cannot have and the backup check has nothing to flag.
  copyBesidePictures(dirname(file), into);
  cleanRestoredPictures(into);
  const db = new Database(join(into, 'memory.db'));
  try {
    let n = 0;
    if (picturesCanBeRemoved(db)) {
      // Pictures an earlier restore left out come back when their file is beside the copy this time.
      const rows = restorablePictures(db);
      const here = (r: PictureRow) => existsSync(join(into, 'images', r.id.slice(0, 2), `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`)) && /^[0-9a-f]{3,}$/.test(r.id) && /^[a-z0-9]{1,8}$/.test(r.type);
      const back = db.prepare('UPDATE images SET removed_at = NULL, removed_by = NULL WHERE id = ?');
      const mark = db.prepare("UPDATE images SET removed_at = ?, removed_by = 'restore' WHERE id = ?");
      const at = new Date().toISOString();
      for (const r of rows) {
        busyTick();
        if (here(r)) { if (r.removed_at !== null) back.run(r.id); } else { n++; if (r.removed_at === null) mark.run(at, r.id); }
      }
    } else n = pictureRows(db);
    writeFileSync(join(into, FROM_DATABASE), String(n));
    return n;
  } finally { db.close(); }
}

export type PictureRow = { id: string; type: string; removed_at: string | null };

/** The pictures a copy could bring: the live ones, and those an earlier restore left out (removed_by = 'restore'). */
export function restorablePictures(db: Database.Database): PictureRow[] {
  const cols = (db.prepare("PRAGMA table_info('images')").all() as { name: string }[]).map((c) => c.name);
  if (cols.length === 0) return [];
  if (!cols.includes('removed_at') || !cols.includes('removed_by')) return (db.prepare('SELECT id, type FROM images').all() as { id: string; type: string }[]).map((r) => ({ ...r, removed_at: null }));
  return db.prepare("SELECT id, type, removed_at FROM images WHERE removed_at IS NULL OR removed_by = 'restore'").all() as PictureRow[];
}

/**
 * Where a picture's file sits beside a saved copy (`<folder>/images/<2 hex>/<id>.<ext>`): real folders and a regular file
 * only, never a link. null when it is not there or the row's id or type is not what BrainAI writes. The one rule the
 * preview counts by and the copy follows.
 */
export function besidePicture(folder: string, r: { id: string; type: string }): string | null {
  // A copy inside a second-folder brain folder (brainai-…) may have its pictures in the folder above (kept there by an earlier version).
  const own = besideIn(folder, r);
  return own ?? (/^brainai-[0-9a-f]{8}$/.test(basename(folder)) ? besideIn(dirname(folder), r) : null);
}

function besideIn(folder: string, r: { id: string; type: string }): string | null {
  if (!/^[0-9a-f]{3,}$/.test(r.id) || !/^[a-z0-9]{1,8}$/.test(r.type)) return null;
  const real = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
  const sub = join(folder, 'images', r.id.slice(0, 2));
  const file = join(sub, `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`);
  try {
    if (!real(join(folder, 'images')) || !real(sub) || !lstatSync(file).isFile()) return null;
  } catch { return null; }
  return file;
}

/**
 * Copies the pictures the staged database lists as live or left out by an earlier restore (`<from>/images/<2 hex>/<id>.<ext>`) into `<into>/images`: real folders
 * and regular files only, never a link, a half-written .partial or a stray file the database does not know. A file that cannot
 * be copied is skipped, so it counts as a missing picture.
 */
function copyBesidePictures(from: string, into: string): void {
  let rows: PictureRow[] = [];
  const db = new Database(join(into, 'memory.db'), { readonly: true });
  try { rows = restorablePictures(db); } catch { rows = []; } finally { db.close(); }
  for (const r of rows) {
    busyTick();
    const src = besidePicture(from, r);
    if (!src) continue;
    try {
      const sub = r.id.slice(0, 2);
      mkdirSync(join(into, 'images', sub), { recursive: true, mode: 0o700 });
      copyFileSync(src, join(into, 'images', sub, `${r.id}.${r.type === 'jpeg' ? 'jpg' : r.type}`));
    } catch { /* unreadable: counted as a missing picture */ }
  }
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

/** `YYYYMMDD-HHMMSS` in local time, for the name the replaced brain is kept under. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Moves the unpacked database and pictures from `from` into the data folder. The brain being replaced is never lost:
 * it is renamed (with its -wal and -shm, the server being stopped) to `memory-before-restore-<stamp>.db`, a name no
 * backup code treats as one of its dated backups.
 */
export function swapIn(from: string, dataDir: string, rename: typeof renameSync = renameSync): void {
  // Pictures first and the database last: if the pictures fail, the database has not changed.
  if (existsSync(join(from, 'images'))) cpSync(join(from, 'images'), join(dataDir, 'images'), { recursive: true });
  const current = join(dataDir, 'memory.db');
  const moved: [string, string][] = [];
  let kept: string | null = null;
  try {
    if (existsSync(current)) {
      const base = `memory-before-restore-${stamp(new Date())}`;
      let name = `${base}.db`;
      for (let i = 2; existsSync(join(dataDir, name)); i++) name = `${base}-${i}.db`;
      for (const side of ['', '-wal', '-shm']) {
        if (existsSync(current + side)) { rename(current + side, join(dataDir, name + side)); moved.push([join(dataDir, name + side), current + side]); }
      }
      kept = join(dataDir, name);
    } else {
      for (const f of ['memory.db-wal', 'memory.db-shm']) rmSync(join(dataDir, f), { force: true });
    }
    rename(join(from, 'memory.db'), current);
  } catch (e) {
    // Anything moved aside goes back under its own name: the brain being replaced is never left half-moved.
    for (const [aside, original] of moved.reverse()) { try { rename(aside, original); } catch { /* nothing more to do */ } }
    throw e;
  }
  // The kept brain is never a way to sign in later: its sign-in data goes, as it does from any copy (only after the swap, so a rollback keeps it whole).
  if (kept) { try { stripSignIn(kept); } catch { /* the kept file is still the owner's: leave it as it is */ } }
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

export const restoreInto = (file: string, dataDir: string): Promise<Restored> => busy('unpacking a copy', () => safely(() => restoreIntoRaw(file, dataDir)));

/** Left by a staging or an upload that never finished: `restore-pending.tmp-<hex>` folders and `restore-upload-<hex>.tmp` files. Only startup removes them (a live staging may own one). */
const STRAY = /^(restore-pending\.tmp-[0-9a-f]+|restore-upload-[0-9a-f]+\.tmp)$/;
function removeStray(dataDir: string): void {
  try {
    for (const n of readdirSync(dataDir)) if (STRAY.test(n)) rmSync(join(dataDir, n), { recursive: true, force: true });
  } catch { /* no data folder yet */ }
}

/**
 * Checks the file and unpacks it into `<data>/restore-pending/`, for the server to swap in at its next start. It is
 * unpacked into a temporary folder and renamed only when everything succeeded, so a half-unpacked copy is never "ready".
 */
async function stageRestoreRaw(file: string, dataDir: string): Promise<Restored> {
  const { kind, counts } = await checked(file);
  if (!isEmptyBrain(join(dataDir, 'memory.db'))) throw new Error(NOT_EMPTY);
  const pending = join(dataDir, 'restore-pending');
  const tmp = join(dataDir, `restore-pending.tmp-${randomBytes(8).toString('hex')}`);
  rmSync(pending, { recursive: true, force: true });
  try {
    counts.pictures_missing = await unpack(file, kind, tmp);
    renameSync(tmp, pending);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return counts;
}

export const stageRestore = (file: string, dataDir: string): Promise<Restored> => busy('unpacking a copy', () => safely(() => stageRestoreRaw(file, dataDir)));

/**
 * At startup, before the database opens: swaps a staged restore in when the brain is still empty, and leaves a note in
 * `restored.json` either way. It never throws: whatever goes wrong, the current brain stays as it is and the server starts.
 */
export function applyPendingRestore(dataDir: string): Restored | null {
  const pending = join(dataDir, 'restore-pending');
  removeStray(dataDir);
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
      // The copy was staged by a newer BrainAI and this older one started (an update undone): refused before anything is swapped.
      const schema = (db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version ?? 0;
      if (schema > latestSchema()) {
        note({ refused: 'This saved copy is from a newer BrainAI than this one, so it was not brought in. Update BrainAI, then restore it again.' });
        return null;
      }
      counts = {
        facts: count(db, 'SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL'),
        pages: count(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'),
        pictures_missing: missingFromNote(pending),
      };
    } finally {
      db.close();
    }
    // A copy staged by a build from before restores dropped the id.
    forgetBrainId(join(pending, 'memory.db'));
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
