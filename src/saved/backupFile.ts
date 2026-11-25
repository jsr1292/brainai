/**
 * The daily backup file (`memory-YYYY-MM-DD.db`, what backupNow writes) as something to bring back: telling it from a
 * saved archive by its first bytes, proving it is a BrainAI database before anything trusts it, and taking the
 * sign-in data out of any imported database, whichever file it came from.
 */
import { closeSync, copyFileSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STRIP_SIGN_IN_SQL } from '../backup.js';
import { latestSchema, type DB } from '../db.js';
import { archiveFailure, liveCounts, type ArchiveCheck } from './archive.js';

/** Which kind of file this is, read from its first bytes (never its name), or null when it is neither. */
export function kindOfFile(path: string): 'archive' | 'database' | null {
  const head = Buffer.alloc(16);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    readSync(fd, head, 0, 16, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return 'archive';
  if (head.equals(Buffer.from('SQLite format 3\0', 'latin1'))) return 'database';
  return null;
}

function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name);
}

/** How many live pictures a database lists (rows in `images` not deleted for good); an older database without the table lists none. */
export function pictureRows(db: DB): number {
  if (!tableExists(db, 'images')) return 0;
  // A schema from before pictures could be removed has no such column: every row is live then.
  const where = picturesCanBeRemoved(db) ? ' WHERE removed_at IS NULL' : '';
  return (db.prepare(`SELECT COUNT(*) AS n FROM images${where}`).get() as { n: number }).n;
}

/** True when the database's `images` table records removals (`removed_at`, `removed_by`). */
export function picturesCanBeRemoved(db: DB): boolean {
  const cols = (db.prepare("PRAGMA table_info('images')").all() as { name: string }[]).map((c) => c.name);
  return cols.includes('removed_at') && cols.includes('removed_by');
}

/**
 * Looks inside a backup file without trusting it: a database that opens, has BrainAI's schema-version table and
 * `memories`, is not from a newer BrainAI and passes SQLite's own check. Works on a copy, so the file (and its folder)
 * is never touched, not even by SQLite's side files.
 */
export function checkBackupFile(path: string): ArchiveCheck {
  if (kindOfFile(path) !== 'database') return archiveFailure('data.archive.backupNotDatabase');
  const tmp = mkdtempSync(join(tmpdir(), 'brainai-check-'));
  let db: DB | undefined;
  try {
    const copy = join(tmp, 'memory.db');
    copyFileSync(path, copy);
    db = new Database(copy, { readonly: true });
    if (!tableExists(db, 'schema_version') || !tableExists(db, 'memories')) return archiveFailure('data.archive.backupTables');
    const schema = (db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version;
    if (schema === undefined) return archiveFailure('data.archive.backupNoSchema');
    // Before the integrity check: a newer file may not be readable by this version at all, and that is the honest reason.
    if (schema > latestSchema()) return archiveFailure('data.archive.backupNewer');
    const verdict = db.pragma('integrity_check', { simple: true });
    if (verdict !== 'ok') return archiveFailure('data.archive.backupIntegrity');
    // A database from before pages existed holds none (the start-up migration adds the table).
    const live = tableExists(db, 'pages') ? liveCounts(db) : { facts: (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL').get() as { n: number }).n, pages: 0 };
    return { ok: true, ...live, schema };
  } catch {
    return archiveFailure('data.archive.backupUnreadable');
  } finally {
    db?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The tables STRIP_SIGN_IN_SQL empties, read from its own DELETE statements. */
const STRIPPED_TABLES = [...STRIP_SIGN_IN_SQL.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]!);

/**
 * Takes the sign-in data (STRIP_SIGN_IN_SQL) out of the database at `file` and leaves it as one plain file. Every
 * import does this, whatever the source, so a raw copy of a live database never brings the old password or tokens.
 * The file is untrusted: its triggers and views are dropped first (a trigger could keep a row or make a delete fail),
 * a table or column an older database does not have yet is skipped, and afterwards every table is checked to be empty
 * (and every client secret replaced), or this throws.
 */
export function stripSignIn(file: string): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    for (const row of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").all() as { type: string; name: string }[]) {
      db.exec(`DROP ${row.type.toUpperCase()} "${row.name.replace(/"/g, '""')}"`);
    }
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(table);
    const hasSecrets = has('oauth_clients') && (db.pragma('table_info(oauth_clients)') as { name: string }[]).some((c) => c.name.toLowerCase() === 'metadata');
    const secrets = (): string[] => hasSecrets
      ? (db.prepare("SELECT json_extract(metadata, '$.client_secret') AS s FROM oauth_clients WHERE json_extract(metadata, '$.client_secret') IS NOT NULL").all() as { s: string }[]).map((r) => r.s)
      : [];
    const before = new Set(secrets());
    for (const statement of STRIP_SIGN_IN_SQL.split(';').map((x) => x.trim()).filter(Boolean)) {
      const table = /^(?:DELETE FROM|UPDATE) (\w+)/.exec(statement)![1]!;
      if (!has(table)) continue;
      if (table === 'oauth_clients' && !hasSecrets) continue;
      db.exec(statement);
    }
    for (const table of STRIPPED_TABLES) {
      if (has(table) && (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n !== 0) throw new Error(`The sign-in data in ${table} could not be removed.`);
    }
    if (secrets().some((x) => before.has(x))) throw new Error('A client secret could not be replaced.');
    // Rewrites the file, so the deleted rows are not left behind in free pages.
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}
