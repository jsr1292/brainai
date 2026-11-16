/** Restoring a saved copy: only into an empty brain, never over memories, never with anything hostile. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db.js';
import { makeService, makePages } from '../testing/helpers.js';
import { packArchive } from './archive.js';
import { backupNow, missingPictures } from '../backup.js';
import { backupHealth } from '../backupStatus.js';
import { latestSchema } from '../db.js';
import { handTar, tarOf } from './testArchives.js';
import { applyPendingRestore, isEmptyBrain, restoreInto, stageRestore } from './restore.js';

const T = new Date('2026-11-06T10:00:00Z');
const me = { type: 'owner' } as const;

function tmp(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'restore-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A saved copy with two facts, one page and one picture; also returns it under the old brainai-move name. */
async function saved(t: TestContext) {
  const source = tmp(t);
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, me);
  await given.service.remember({ kind: 'summary', project: 'larder', content: 'Larder shelf list is done' }, me);
  await makePages(given, () => T).create({ title: 'Wildlog setup', area: 'apps', body: 'Run it with the usual command.' }, 'owner');
  mkdirSync(join(source, 'images', 'ab'), { recursive: true });
  writeFileSync(join(source, 'images', 'ab', 'abcdef.jpg'), 'not really a picture');
  const archive = join(tmp(t), 'brainai-saved-2026-11-06.tar.gz');
  await packArchive(given.db, source, archive, T);
  return archive;
}

/** A data folder whose brain is empty (just the database, migrated). */
function emptyData(t: TestContext): string {
  const dir = tmp(t);
  openDb(join(dir, 'memory.db')).close();
  return dir;
}

async function withDecision(t: TestContext): Promise<string> {
  const dir = tmp(t);
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1','decision','Larder uses shelves','larder','[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run();
  db.close();
  return dir;
}

function counts(dbFile: string) {
  const db = openDb(dbFile);
  try {
    return {
      facts: (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL').get() as { n: number }).n,
      pages: (db.prepare('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

test('restoreInto brings back facts, pages and pictures', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(archive, dir), { facts: 2, pages: 1, pictures_missing: 0 });
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 2, pages: 1 });
  assert.equal(readFileSync(join(dir, 'images', 'ab', 'abcdef.jpg'), 'utf8'), 'not really a picture');
});

test('restoreInto refuses a brain with a decision in it', async (t) => {
  const archive = await saved(t);
  const dir = await withDecision(t);
  await assert.rejects(restoreInto(archive, dir), /already has memories/);
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 1, pages: 0 });
  assert.equal(existsSync(join(dir, 'images')), false);
});

test("the welcome's name does not count", (t) => {
  const dir = emptyData(t);
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('p1','profile','The owner is Alex',NULL,'[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run();
  db.close();
  assert.equal(isEmptyBrain(join(dir, 'memory.db')), true);
  assert.equal(isEmptyBrain(join(dir, 'missing.db')), true);
});

test('isEmptyBrain reads an old database without migrating it, a missing table counting as none', (t) => {
  const file = join(tmp(t), 'memory.db');
  const old = new Database(file);
  old.exec('CREATE TABLE memories(id TEXT, kind TEXT, created_by TEXT, deleted_at TEXT)');
  old.close();
  assert.equal(isEmptyBrain(file), true);
  const after = new Database(file, { readonly: true });
  t.after(() => after.close());
  assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'memories' }]);
});

test('stageRestore then applyPendingRestore swaps it in and records restored.json', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(archive, dir), { facts: 2, pages: 1, pictures_missing: 0 });
  assert.ok(existsSync(join(dir, 'restore-pending', 'memory.db')));
  assert.deepEqual(applyPendingRestore(dir), { facts: 2, pages: 1, pictures_missing: 0 });
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 2, pages: 1 });
  assert.ok(existsSync(join(dir, 'images', 'ab', 'abcdef.jpg')));
  const note = JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8'));
  assert.equal(note.facts, 2);
  assert.equal(note.pages, 1);
  assert.ok(typeof note.at === 'string');
  assert.equal(applyPendingRestore(dir), null);
});

test('applyPendingRestore leaves a non-empty brain alone', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await stageRestore(archive, dir);
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1','decision','Larder uses shelves','larder','[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run();
  db.close();
  assert.equal(applyPendingRestore(dir), null);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 1, pages: 0 });
  assert.match(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).refused, /already has memories/);
});

test('applyPendingRestore never throws: a broken staged database is dropped and noted', (t) => {
  const dir = emptyData(t);
  mkdirSync(join(dir, 'restore-pending'));
  writeFileSync(join(dir, 'restore-pending', 'memory.db'), 'garbage, not a database');
  const before = counts(join(dir, 'memory.db'));
  const origError = console.error;
  console.error = () => {};
  t.after(() => { console.error = origError; });
  assert.equal(applyPendingRestore(dir), null);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  assert.deepEqual(counts(join(dir, 'memory.db')), before);
  assert.ok(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).refused);
});

test('a refused archive stages nothing', async (t) => {
  const dir = emptyData(t);
  const bad = handTar(join(tmp(t), 'bad.tar.gz'), '../evil');
  await assert.rejects(stageRestore(bad, dir), /climbs out/);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  await assert.rejects(restoreInto(bad, dir), /climbs out/);
});

test('an old brainai-move file restores', async (t) => {
  const archive = await saved(t);
  const old = join(tmp(t), 'brainai-move-2026-11-06.tar.gz');
  renameSync(archive, old);
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(old, dir), { facts: 2, pages: 1, pictures_missing: 0 });
});

test('isEmptyBrain is false when it cannot tell: a memories table with rows but no created_by column', (t) => {
  const file = join(tmp(t), 'memory.db');
  const odd = new Database(file);
  odd.exec("CREATE TABLE memories(id TEXT, kind TEXT, deleted_at TEXT); INSERT INTO memories VALUES ('m1','decision',NULL)");
  odd.close();
  assert.equal(isEmptyBrain(file), false);
});

test('a failed pictures copy leaves the database as it was and says so', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await stageRestore(archive, dir);
  writeFileSync(join(dir, 'images'), 'a file where the pictures folder should go');
  const before = readFileSync(join(dir, 'memory.db'));
  const origError = console.error;
  console.error = () => {};
  t.after(() => { console.error = origError; });
  assert.equal(applyPendingRestore(dir), null);
  assert.ok(readFileSync(join(dir, 'memory.db')).equals(before));
  assert.ok(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).refused);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
});

test('an archive that lists ./memory.db extracts', async (t) => {
  const archive = await saved(t);
  const x = tmp(t);
  execFileSync('tar', ['-xzf', archive, '-C', x]);
  const dotted = tarOf(x, join(tmp(t), 'brainai-saved-2026-11-06.tar.gz'), ['./memory.db', './images']);
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(dotted, dir), { facts: 2, pages: 1, pictures_missing: 0 });
  assert.ok(existsSync(join(dir, 'images', 'ab', 'abcdef.jpg')));
});

/** A daily backup file of a brain with two facts, one page and `pictures` picture rows, plus the live database it came from. */
async function backupFile(t: TestContext, pictures = 0) {
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'garden-club-site', content: 'The site is plain HTML' }, me);
  await given.service.remember({ kind: 'summary', project: 'garden-club-site', content: 'Photos page is done' }, me);
  const page = await makePages(given, () => T).create({ title: 'Garden club setup', area: 'apps', body: 'Run it with the usual command.' }, 'owner');
  for (let i = 0; i < pictures; i++) {
    given.db.prepare(`INSERT INTO images(id, type, bytes, width, height, created_at, created_by, page_id) VALUES (?, 'png', 1, 1, 1, '2026-11-06', 'owner', ?)`)
      .run(`img${i}`, (page as { id: string }).id);
  }
  const file = await backupNow(given.db, tmp(t), 1, T);
  return { file, db: given.db };
}

const SIGN_IN_TABLES = ['owner', 'sessions', 'oauth_tokens'];
function signInRows(dbFile: string): Record<string, number> {
  const db = new Database(dbFile, { readonly: true });
  try {
    return Object.fromEntries(SIGN_IN_TABLES.map((n) => [n, (db.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}
/** Puts an owner row, a session and an OAuth token into a database file. */
function addSignIn(dbFile: string) {
  const db = new Database(dbFile);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO owner(id, password_hash, totp_secret, totp_last_step) VALUES (1, 'hash', 'secret', 0)").run();
  db.prepare("INSERT INTO sessions(token_hash, id, created_at, last_seen_at, expires_at) VALUES ('h1', 's1', '2026-11-06', '2026-11-06', '2026-11-07')").run();
  db.prepare("INSERT INTO oauth_grants(id, client_id, created_at) VALUES ('g1', 'c1', '2026-11-06')").run();
  db.prepare("INSERT INTO oauth_tokens(token_hash, grant_id, type, expires_at) VALUES ('t1', 'g1', 'access', '2026-11-07')").run();
  db.close();
}

test('a backup file restores through stageRestore and applyPendingRestore, noting the missing pictures', async (t) => {
  const { file } = await backupFile(t, 3);
  const before = readFileSync(file);
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(file, dir), { facts: 2, pages: 1, pictures_missing: 3 });
  assert.deepEqual(applyPendingRestore(dir), { facts: 2, pages: 1, pictures_missing: 3 });
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 2, pages: 1 });
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).pictures_missing, 3);
  assert.ok(readFileSync(file).equals(before), 'the source file is untouched');
});

test('an archive restores with no pictures missing', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await stageRestore(archive, dir);
  applyPendingRestore(dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).pictures_missing, 0);
});

test('restoreInto takes a backup file too', async (t) => {
  const { file } = await backupFile(t);
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(file, dir), { facts: 2, pages: 1, pictures_missing: 0 });
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 2, pages: 1 });
});

test('a raw database copy restores without the owner, sessions or tokens, and its source keeps them', async (t) => {
  const { file } = await backupFile(t);
  addSignIn(file);
  assert.deepEqual(signInRows(file), { owner: 1, sessions: 1, oauth_tokens: 1 });
  const dir = emptyData(t);
  await stageRestore(file, dir);
  applyPendingRestore(dir);
  assert.deepEqual(signInRows(join(dir, 'memory.db')), { owner: 0, sessions: 0, oauth_tokens: 0 });
  assert.deepEqual(signInRows(file), { owner: 1, sessions: 1, oauth_tokens: 1 });
});

test('an archive whose database still has sign-in data restores without it', async (t) => {
  const { file } = await backupFile(t);
  addSignIn(file);
  const x = tmp(t);
  copyFileSync(file, join(x, 'memory.db'));
  const archive = tarOf(x, join(tmp(t), 'brainai-saved-2026-11-06.tar.gz'), ['memory.db']);
  const dir = emptyData(t);
  await restoreInto(archive, dir);
  assert.deepEqual(signInRows(join(dir, 'memory.db')), { owner: 0, sessions: 0, oauth_tokens: 0 });
});

test('a backup file from an older schema restores and opens', async (t) => {
  // A database as it was before the pictures tables (migration 25), holding two facts.
  const file = join(tmp(t), 'memory-2026-11-06.db');
  const old = openDb(file, { upTo: 24 });
  for (const id of ['m1', 'm2']) {
    old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'decision', 'The site is plain HTML', 'garden-club-site', '[]', x'00', '2026-11-06', 'owner', '2026-11-06', 'owner')`).run(id);
  }
  old.pragma('journal_mode = DELETE');
  old.close();
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(file, dir), { facts: 2, pages: 0, pictures_missing: 0 });
  const opened = openDb(join(dir, 'memory.db'));
  t.after(() => opened.close());
  assert.equal((opened.prepare('SELECT version FROM schema_version').get() as { version: number }).version, latestSchema());
  assert.equal((opened.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 2);
});

test('a backup file is refused by a brain that has memories', async (t) => {
  const { file } = await backupFile(t);
  const dir = await withDecision(t);
  await assert.rejects(restoreInto(file, dir), /already has memories/);
  await assert.rejects(stageRestore(file, dir), /already has memories/);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 1, pages: 0 });
});

test('a text file is refused and stages nothing', async (t) => {
  const f = join(tmp(t), 'notes.txt');
  writeFileSync(f, 'just some notes');
  const dir = emptyData(t);
  await assert.rejects(stageRestore(f, dir), /not a saved BrainAI file or backup/);
  assert.equal(existsSync(join(dir, 'restore-pending')), false);
});

function triggersIn(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger', 'view')").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test('a crafted database cannot keep its sign-in data with triggers', async (t) => {
  const { file } = await backupFile(t);
  addSignIn(file);
  const crafted = new Database(file);
  crafted.exec(`CREATE TRIGGER keep_owner BEFORE DELETE ON owner BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER break_sessions BEFORE DELETE ON sessions BEGIN DELETE FROM nosuch; END;`);
  crafted.close();
  const dir = emptyData(t);
  await restoreInto(file, dir);
  assert.deepEqual(signInRows(join(dir, 'memory.db')), { owner: 0, sessions: 0, oauth_tokens: 0 });
  assert.equal(triggersIn(join(dir, 'memory.db')), 0);
});

test('a WAL-mode source is not touched, no side files appear beside it', async (t) => {
  const { file } = await backupFile(t, 2);
  const wal = new Database(file);
  wal.pragma('journal_mode = WAL');
  wal.close();
  const before = readFileSync(file);
  const dir = emptyData(t);
  const copy = join(dir, 'restore-upload.tar.gz');
  copyFileSync(file, copy);
  assert.deepEqual(await stageRestore(copy, dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.equal(existsSync(copy + '-shm') || existsSync(copy + '-wal'), false);
  assert.ok(readFileSync(copy).equals(before));
  assert.deepEqual(await restoreInto(file, emptyData(t)), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.equal(existsSync(file + '-shm') || existsSync(file + '-wal'), false);
  assert.ok(readFileSync(file).equals(before));
});

test('the oldest schema a database can have restores and opens', async (t) => {
  const file = join(tmp(t), 'memory-2026-11-06.db');
  const old = openDb(file, { upTo: 1 });
  old.pragma('journal_mode = DELETE');
  old.close();
  const dir = emptyData(t);
  await restoreInto(file, dir);
  const opened = openDb(join(dir, 'memory.db'));
  t.after(() => opened.close());
  assert.equal((opened.prepare('SELECT version FROM schema_version').get() as { version: number }).version, latestSchema());
});

test('a sign-in table or column spelled in another case is still stripped', async (t) => {
  const { file } = await backupFile(t);
  const crafted = new Database(file);
  crafted.exec(`DROP TABLE owner;
    CREATE TABLE OWNER(id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT, totp_secret TEXT, totp_last_step INTEGER);
    INSERT INTO OWNER VALUES (1, 'hash', 'secret', 0);
    ALTER TABLE oauth_clients RENAME COLUMN metadata TO "Metadata";
    INSERT INTO oauth_clients(client_id, "Metadata", created_at) VALUES ('c1', '{"client_secret":"old-secret"}', '2026-11-06');`);
  crafted.close();
  const dir = emptyData(t);
  await restoreInto(file, dir);
  assert.equal(signInRows(join(dir, 'memory.db')).owner, 0);
  const db = new Database(join(dir, 'memory.db'), { readonly: true });
  t.after(() => db.close());
  const secret = (db.prepare("SELECT json_extract(metadata, '$.client_secret') AS s FROM oauth_clients WHERE client_id = 'c1'").get() as { s: string }).s;
  assert.notEqual(secret, 'old-secret');
});

test('a backup-file import marks its pictures removed, so the restored brain is not flagged for pictures it cannot have', async (t) => {
  const { file } = await backupFile(t, 3);
  // Three rows in the file: two live, one already deleted for good.
  const src = new Database(file);
  src.prepare("UPDATE images SET removed_at = '2026-11-01T00:00:00.000Z', removed_by = 'owner' WHERE id = 'img2'").run();
  src.close();
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(file, dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.deepEqual(applyPendingRestore(dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).pictures_missing, 2);
  const restored = new Database(join(dir, 'memory.db'));
  t.after(() => restored.close());
  const rows = restored.prepare('SELECT id, removed_at, removed_by FROM images ORDER BY id').all() as { id: string; removed_at: string | null; removed_by: string | null }[];
  assert.equal(rows.find((r) => r.id === 'img0')!.removed_by, 'restore');
  assert.ok(rows.find((r) => r.id === 'img0')!.removed_at);
  assert.equal(rows.find((r) => r.id === 'img2')!.removed_by, 'owner', 'a picture already removed keeps its own record');
  assert.equal(missingPictures(restored, dir), null);
  const missing = missingPictures(restored, dir) ?? 0;
  const health = backupHealth({ nightly: { at: new Date().toISOString(), ok: true, pictures: { missing, stray: 0 } } } as never, new Date());
  assert.doesNotMatch(JSON.stringify(health), /pictures the database lists/);
  const pages = restored.prepare('SELECT body FROM pages').all() as { body: string }[];
  assert.ok(pages.some((p) => p.body.includes('Run it with the usual command.')), 'the page text is unchanged');
});
