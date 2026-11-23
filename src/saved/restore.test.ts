/** Restoring a saved copy: only into an empty brain, never over memories, never with anything hostile. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { restoredRowsProblem } from './rowChecks.js';
import { applyPendingRestore, isEmptyBrain, restoreInto, stageRestore, swapIn } from './restore.js';

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
      .run(`${String(i).repeat(24)}`, (page as { id: string }).id);
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
  src.prepare("UPDATE images SET removed_at = '2026-11-01T00:00:00.000Z', removed_by = 'owner' WHERE id = '222222222222222222222222'").run();
  src.close();
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(file, dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.deepEqual(applyPendingRestore(dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'restored.json'), 'utf8')).pictures_missing, 2);
  const restored = new Database(join(dir, 'memory.db'));
  t.after(() => restored.close());
  const rows = restored.prepare('SELECT id, removed_at, removed_by FROM images ORDER BY id').all() as { id: string; removed_at: string | null; removed_by: string | null }[];
  assert.equal(rows.find((r) => r.id === '000000000000000000000000')!.removed_by, 'restore');
  assert.ok(rows.find((r) => r.id === '000000000000000000000000')!.removed_at);
  assert.equal(rows.find((r) => r.id === '222222222222222222222222')!.removed_by, 'owner', 'a picture already removed keeps its own record');
  assert.equal(missingPictures(restored, dir), null);
  const missing = missingPictures(restored, dir) ?? 0;
  const health = backupHealth({ nightly: { at: new Date().toISOString(), ok: true, pictures: { missing, stray: 0 } } } as never, new Date());
  assert.doesNotMatch(JSON.stringify(health), /pictures the database lists/);
  const pages = restored.prepare('SELECT body FROM pages').all() as { body: string }[];
  assert.ok(pages.some((p) => p.body.includes('Run it with the usual command.')), 'the page text is unchanged');
});

/** A saved copy at the current schema whose rows were written by plain SQL, the way a crafted file would be. */
function craftedArchive(t: TestContext, setup: (c: ReturnType<typeof openDb>) => void): string {
  const craft = tmp(t);
  const c = openDb(join(craft, 'memory.db'));
  setup(c);
  c.pragma('journal_mode = DELETE');
  c.close();
  const archive = join(tmp(t), 'brainai-saved-2026-11-06.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', craft, 'memory.db']);
  return archive;
}

const addSkill = (c: ReturnType<typeof openDb>, name: string, path?: string) => {
  c.prepare(`INSERT INTO skills(id, name, description, body, enabled, origin, version, created_at, created_by, updated_at, updated_by)
    VALUES ('s1', ?, 'dummy', 'dummy body', 0, 'here', 1, '2026-11-06', 'owner', '2026-11-06', 'owner')`).run(name);
  if (path !== undefined) c.prepare("INSERT INTO skill_files(skill_id, path, text) VALUES ('s1', ?, 'dummy')").run(path);
};
const addFact = (c: ReturnType<typeof openDb>, project: string) => {
  c.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1', 'decision', 'dummy fact text', ?, '[]', '', x'00', '2026-11-06', 'owner', '2026-11-06', 'owner')`).run(project);
};
const BAD = '../../../escaped';
const addPage = (c: ReturnType<typeof openDb>, project: string | null, area: string | null) => {
  c.pragma('ignore_check_constraints = ON');
  c.prepare(`INSERT INTO pages(id, title, title_key, body, project, area, version, created_at, created_by, updated_at, updated_by)
    VALUES ('p1', 'dummy', 'dummy', 'dummy', ?, ?, 1, '2026-11-06', 'owner', '2026-11-06', 'owner')`).run(project, area);
};
const addImage = (c: ReturnType<typeof openDb>, id: string, type: string) => {
  c.pragma('ignore_check_constraints = ON');
  c.prepare(`INSERT INTO images(id, type, bytes, width, height, created_at, created_by) VALUES (?, ?, 1, 1, 1, '2026-11-06', 'owner')`).run(id, type);
};

const refused: [string, (c: ReturnType<typeof openDb>) => void][] = [
  ['skills.name', (c) => addSkill(c, BAD)],
  ['skill_files.path', (c) => addSkill(c, 'plain', '../../escaped.txt')],
  ['memories.project', (c) => addFact(c, BAD)],
  ['pages.project', (c) => addPage(c, BAD, null)],
  ['projects.name', (c) => { c.pragma('ignore_check_constraints = ON'); c.prepare("INSERT INTO projects(name, state_changed_at, created_at, created_by, updated_at, updated_by) VALUES (?, '2026-11-06', '2026-11-06', 'owner', '2026-11-06', 'owner')").run(BAD); }],
  ['project_aliases.alias', (c) => c.prepare("INSERT INTO project_aliases(alias, project, added_at, added_by) VALUES (?, 'wildlog', '2026-11-06', 'owner')").run(BAD)],
  ['project_aliases.project', (c) => c.prepare("INSERT INTO project_aliases(alias, project, added_at, added_by) VALUES ('old', ?, '2026-11-06', 'owner')").run(BAD)],
  ['pages.area', (c) => addPage(c, null, 'bogus')],
  ['projects.area', (c) => { c.pragma('ignore_check_constraints = ON'); c.prepare("INSERT INTO projects(name, area, state_changed_at, created_at, created_by, updated_at, updated_by) VALUES ('wildlog', 'bogus', '2026-11-06', '2026-11-06', 'owner', '2026-11-06', 'owner')").run(); }],
  ['images.id', (c) => addImage(c, '../../../../escaped-id00', 'png')],
  ['images.type', (c) => addImage(c, 'abcdef0123456789abcdef01', '../../x')],
];

for (const [column, setup] of refused) {
  test(`a saved copy with a bad ${column} is refused, naming it`, async (t) => {
    const archive = craftedArchive(t, setup);
    const dir = emptyData(t);
    await assert.rejects(
      stageRestore(archive, dir),
      (e: Error) => e.message.startsWith('This saved copy holds names BrainAI would never write (' + column + ': ') && e.message.endsWith(', so it is not brought back.'),
    );
    assert.equal(existsSync(join(dir, 'restore-pending')), false);
  });
}

test('a saved copy whose column is declared in upper case is still checked', (t) => {
  const file = join(tmp(t), 'memory.db');
  const c = new Database(file);
  c.exec("CREATE TABLE skills(id TEXT, NAME TEXT); INSERT INTO skills VALUES ('s1', '../../dummy')");
  c.close();
  assert.equal(restoredRowsProblem(file), 'skills.name: "../../dummy"');
});

test('a saved copy from before skills existed is not refused for that', (t) => {
  const file = join(tmp(t), 'memory.db');
  const c = new Database(file);
  c.exec("CREATE TABLE memories(id TEXT, project TEXT); INSERT INTO memories VALUES ('m1', 'wildlog')");
  c.close();
  assert.equal(restoredRowsProblem(file), null);
});

test('a saved copy with a nested skill file such as references/palette.md is still restored', async (t) => {
  const archive = craftedArchive(t, (c) => { addSkill(c, 'palette-skill', 'references/palette.md'); addFact(c, 'wildlog'); });
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(archive, dir), { facts: 1, pages: 0, pictures_missing: 0 });
  assert.ok(existsSync(join(dir, 'restore-pending', 'memory.db')));
});

test('a crafted constraint name in a backup file gives a short restore error with no raw control character', async (t) => {
  const { file } = await backupFile(t);
  const c = new Database(file);
  c.pragma('foreign_keys = OFF');
  const name = `\u001b[2J\u0007\u009b${'z'.repeat(10_000)}`;
  c.exec('DROP TABLE oauth_clients');
  c.exec(`CREATE TABLE oauth_clients(client_id TEXT PRIMARY KEY, metadata TEXT, CONSTRAINT "${name}" CHECK(length(json_extract(metadata, '$.client_secret')) < 10))`);
  c.prepare('INSERT INTO oauth_clients VALUES (?, ?)').run('c1', '{"client_secret":"a"}');
  c.close();
  for (const restore of [restoreInto, stageRestore]) {
    const err = await restore(file, emptyData(t)).then(() => null, (e: Error) => e);
    assert.ok(err, 'the restore is refused');
    assert.match(err.message, /CHECK constraint failed/);
    assert.ok(err.message.length < 400, `${err.message.length}`);
    assert.doesNotMatch(err.message, /[\u0000-\u001f\u007f-\u009f]/);
  }
});

test('a restored brain still queues rows saved with a placeholder vector for a model', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await restoreInto(archive, dir);
  const db = openDb(join(dir, 'memory.db'));
  try {
    db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
      VALUES ('placeholder','decision','Saved with no model','larder','[]','',?,'2026-11-06','owner','2026-11-06','owner')`).run(Buffer.alloc(16));
    assert.deepEqual(db.prepare("SELECT tbl, key FROM embedding_pending WHERE key = 'placeholder'").all(), [{ tbl: 'm', key: 'placeholder' }]);
  } finally { db.close(); }
});

test('A12: a backup file from schema 37 (no date or source columns) restores, opens and gets the empty columns', async (t) => {
  const file = join(tmp(t), 'memory-2026-11-06.db');
  const old = openDb(file, { upTo: 37 });
  old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1', 'decision', 'The site is plain HTML', 'garden-club-site', '[]', x'00', '2026-11-06', 'owner', '2026-11-06', 'owner')`).run();
  old.pragma('journal_mode = DELETE');
  old.close();
  const dir = emptyData(t);
  assert.deepEqual(await restoreInto(file, dir), { facts: 1, pages: 0, pictures_missing: 0 });
  const opened = openDb(join(dir, 'memory.db'));
  t.after(() => opened.close());
  assert.equal((opened.prepare('SELECT version FROM schema_version').get() as { version: number }).version, latestSchema());
  assert.deepEqual(opened.prepare("SELECT valid_until, source, source_note FROM memories WHERE id = 'm1'").get(), { valid_until: null, source: null, source_note: null });
});

test('A12: a saved copy carries the date and the source of a fact through a restore', async (t) => {
  const source = tmp(t);
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog licence renews yearly', meta: { validUntil: '2027-01-31', source: 'owner_said', sourceNote: 'phone call' } } as never, me);
  const archive = join(tmp(t), 'brainai-saved-2026-11-06.tar.gz');
  await packArchive(given.db, source, archive, T);
  const dir = emptyData(t);
  await restoreInto(archive, dir);
  const opened = openDb(join(dir, 'memory.db'));
  t.after(() => opened.close());
  assert.deepEqual(opened.prepare('SELECT valid_until, source, source_note FROM memories').get(), { valid_until: '2027-01-31', source: 'owner_said', source_note: 'phone call' });
});

test('a backup file with an images folder beside it (the second backup folder) brings those pictures back', async (t) => {
  const { file } = await backupFile(t, 3);
  const beside = join(file, '..', 'images', '00');
  mkdirSync(beside, { recursive: true });
  writeFileSync(join(beside, `${'0'.repeat(24)}.png`), 'pic');
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(file, dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.deepEqual(applyPendingRestore(dir), { facts: 2, pages: 1, pictures_missing: 2 });
  assert.equal(readFileSync(join(dir, 'images', '00', `${'0'.repeat(24)}.png`), 'utf8'), 'pic');
  const restored = new Database(join(dir, 'memory.db'));
  t.after(() => restored.close());
  assert.equal(restored.prepare("SELECT removed_at FROM images WHERE id = ?").get('0'.repeat(24)) !== undefined, true);
  assert.equal((restored.prepare("SELECT removed_at FROM images WHERE id = ?").get('0'.repeat(24)) as { removed_at: string | null }).removed_at, null, 'the picture that came back stays live');
  assert.equal(missingPictures(restored, dir), 0);
});

test('an unreadable picture beside a backup file does not fail the restore and a stray file is not copied', async (t) => {
  const { file } = await backupFile(t, 3);
  const beside = join(file, '..', 'images');
  for (const d of ['00', '11', '22', '33']) mkdirSync(join(beside, d), { recursive: true });
  writeFileSync(join(beside, '00', `${'0'.repeat(24)}.png`), 'pic');
  writeFileSync(join(beside, '11', `${'1'.repeat(24)}.png`), 'locked');
  chmodSync(join(beside, '11', `${'1'.repeat(24)}.png`), 0o000);
  t.after(() => { try { chmodSync(join(beside, '11', `${'1'.repeat(24)}.png`), 0o600); } catch { /* already removed */ } });
  writeFileSync(join(beside, '33', `${'3'.repeat(24)}.png`), 'stray');
  const dir = emptyData(t);
  const counts = await stageRestore(file, dir);
  assert.equal(counts.pictures_missing, process.getuid?.() === 0 ? 1 : 2, 'the locked and the absent picture are counted missing');
  applyPendingRestore(dir);
  assert.equal(existsSync(join(dir, 'images', '00', `${'0'.repeat(24)}.png`)), true);
  assert.equal(existsSync(join(dir, 'images', '33')), false, 'a file the database does not list is not copied');
});

const insertProfile = (dir: string, id: string) => {
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES (?,'profile','The owner is Alex',NULL,'[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run(id);
  db.close();
};

test('isEmptyBrain allows one owner profile fact, but not two', (t) => {
  const dir = emptyData(t);
  insertProfile(dir, 'p1');
  assert.equal(isEmptyBrain(join(dir, 'memory.db')), true);
  insertProfile(dir, 'p2');
  assert.equal(isEmptyBrain(join(dir, 'memory.db')), false);
});

test('isEmptyBrain counts a live skill or discussion as content, a deleted one not', (t) => {
  const dir = emptyData(t);
  const file = join(dir, 'memory.db');
  const db = openDb(file);
  db.prepare(`INSERT INTO skills(id, name, description, body, enabled, origin, version, created_at, created_by, updated_at, updated_by, deleted_at)
    VALUES ('s1','how','d','b',0,'owner',1,'2026-11-06','owner','2026-11-06','owner','2026-11-07')`).run();
  db.close();
  assert.equal(isEmptyBrain(file), true, 'a deleted skill does not count');
  const db2 = openDb(file);
  db2.prepare("UPDATE skills SET deleted_at = NULL").run();
  db2.close();
  assert.equal(isEmptyBrain(file), false, 'a live skill counts');
  const db3 = openDb(file);
  db3.prepare("DELETE FROM skills").run();
  db3.prepare(`INSERT INTO discussions(id, title, question, opened_by, opened_model, opened_at) VALUES ('d1','t','q','owner','m','2026-11-06')`).run();
  db3.close();
  assert.equal(isEmptyBrain(file), false, 'a live discussion counts');
});

test('a restore keeps the brain it replaces as memory-before-restore-<stamp>.db, and the backup code ignores that name', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  insertProfile(dir, 'p1');
  writeFileSync(join(dir, 'memory.db-wal'), 'wal');
  writeFileSync(join(dir, 'memory.db-shm'), 'shm');
  await stageRestore(archive, dir);
  applyPendingRestore(dir);
  const kept = readdirSync(dir).filter((n) => /^memory-before-restore-\d{8}-\d{6}\.db/.test(n)).sort();
  // The side files moved with it (opening the kept file to strip its sign-in data then folded them in).
  assert.equal(kept.filter((n) => n.endsWith('.db')).length, 1, kept.join(', '));
  assert.match(kept[0]!, /^memory-before-restore-\d{8}-\d{6}\.db$/);
  assert.ok(!existsSync(join(dir, 'memory.db-shm')));
  assert.equal(counts(join(dir, kept[0]!)).facts, 1, 'the old brain is intact');
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 2, pages: 1 });
  assert.ok(!existsSync(join(dir, 'memory.db-wal')));
  // Neither backup regex takes it for a dated backup.
  assert.doesNotMatch(kept[0]!, /^memory-\d{4}-\d{2}-\d{2}\.db$/);
});

test('the CLI restore keeps the replaced brain too', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await restoreInto(archive, dir);
  assert.equal(readdirSync(dir).filter((n) => /^memory-before-restore-\d{8}-\d{6}\.db$/.test(n)).length, 1);
});

test('staging is atomic: a leftover tmp folder is never swapped in and is cleaned up', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  await stageRestore(archive, dir);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('restore-pending')), ['restore-pending'], 'no tmp folder after a good staging');
  // What a crash between unpacking and the final rename leaves: a complete-looking database in a tmp folder.
  const stray = join(dir, 'restore-pending.tmp-abcdef0123456789');
  renameSync(join(dir, 'restore-pending'), stray);
  assert.equal(applyPendingRestore(dir), null);
  assert.ok(!existsSync(stray), 'the stray folder is removed at startup');
  assert.deepEqual(counts(join(dir, 'memory.db')), { facts: 0, pages: 0 }, 'nothing was swapped in');
});

test('a failed unpack (after unpacking started) leaves no restore-pending and no tmp folder', async (t) => {
  const dir = emptyData(t);
  const archive = craftedArchive(t, (c) => addSkill(c, BAD));
  await assert.rejects(stageRestore(archive, dir), /names BrainAI would never write/);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('restore-pending')), []);
});

test('startup also removes a stray restore-upload-<hex>.tmp file', (t) => {
  const dir = emptyData(t);
  writeFileSync(join(dir, 'restore-upload-0123abcd.tmp'), 'half an upload');
  writeFileSync(join(dir, 'restore-upload-keep.txt'), 'not ours');
  applyPendingRestore(dir);
  assert.ok(!existsSync(join(dir, 'restore-upload-0123abcd.tmp')));
  assert.ok(existsSync(join(dir, 'restore-upload-keep.txt')));
});

test('pictures an earlier restore left out come back when their file is beside the copy this time', async (t) => {
  const { file } = await backupFile(t, 2);
  const src = new Database(file);
  src.prepare("UPDATE images SET removed_at = '2026-11-01T00:00:00.000Z', removed_by = 'restore' WHERE id = '000000000000000000000000'").run();
  src.prepare("UPDATE images SET removed_at = '2026-11-01T00:00:00.000Z', removed_by = 'owner' WHERE id = '111111111111111111111111'").run();
  src.close();
  const beside = join(file, '..');
  for (const id of ['000000000000000000000000', '111111111111111111111111']) {
    mkdirSync(join(beside, 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(beside, 'images', id.slice(0, 2), `${id}.png`), 'png');
  }
  const dir = emptyData(t);
  assert.deepEqual(await stageRestore(file, dir), { facts: 2, pages: 1, pictures_missing: 0 });
  applyPendingRestore(dir);
  const db = new Database(join(dir, 'memory.db'));
  t.after(() => db.close());
  const rows = db.prepare('SELECT id, removed_at, removed_by FROM images ORDER BY id').all() as { id: string; removed_at: string | null; removed_by: string | null }[];
  assert.equal(rows[0]!.removed_at, null, 'the one a restore left out is live again');
  assert.equal(rows[1]!.removed_by, 'owner', 'a picture the owner deleted stays deleted');
  assert.ok(existsSync(join(dir, 'images', '00', '000000000000000000000000.png')));
  assert.ok(!existsSync(join(dir, 'images', '11')), 'and its file is not brought back');
});

test('after a good swap the kept copy of the old brain has no sign-in data', async (t) => {
  const archive = await saved(t);
  const dir = emptyData(t);
  const old = new Database(join(dir, 'memory.db'));
  old.pragma('foreign_keys = OFF');
  old.prepare("INSERT INTO owner(id, password_hash, totp_secret, totp_last_step) VALUES (1, 'hash', 'secret', 0)").run();
  old.close();
  await stageRestore(archive, dir);
  applyPendingRestore(dir);
  const kept = readdirSync(dir).find((n) => /^memory-before-restore-\d{8}-\d{6}\.db$/.test(n))!;
  assert.equal(signInRows(join(dir, kept)).owner, 0);
});

/** A data folder with a brain that has a sign-in row, plus -wal and -shm files, and a `from` folder with a database. */
function swapSetup(t: TestContext, withDb: boolean) {
  const dir = emptyData(t);
  const old = new Database(join(dir, 'memory.db'));
  old.pragma('foreign_keys = OFF');
  old.prepare("INSERT INTO owner(id, password_hash, totp_secret, totp_last_step) VALUES (1, 'hash', 'secret', 0)").run();
  old.close();
  writeFileSync(join(dir, 'memory.db-wal'), 'wal');
  writeFileSync(join(dir, 'memory.db-shm'), 'shm');
  const from = tmp(t);
  if (withDb) copyFileSync(join(dir, 'memory.db'), join(from, 'memory.db'));
  return { dir, from };
}
const noKept = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('memory-before-restore'));

test('swapIn: when the final rename fails, memory.db and its side files are back under their names', (t) => {
  const { dir, from } = swapSetup(t, false);
  assert.throws(() => swapIn(from, dir));
  assert.deepEqual(noKept(dir), []);
  assert.ok(existsSync(join(dir, 'memory.db-wal')) && existsSync(join(dir, 'memory.db-shm')));
  assert.equal(signInRows(join(dir, 'memory.db')).owner, 1);
});

test('swapIn: a failure part-way through moving the old brain aside rolls back everything already moved', (t) => {
  const { dir, from } = swapSetup(t, true);
  const failing = ((a: string, b: string) => {
    if (String(b).includes('memory-before-restore') && String(b).endsWith('-wal')) throw new Error('disk trouble');
    return renameSync(a, b);
  }) as typeof renameSync;
  assert.throws(() => swapIn(from, dir, failing), /disk trouble/);
  assert.deepEqual(noKept(dir), []);
  assert.ok(existsSync(join(dir, 'memory.db-wal')) && existsSync(join(dir, 'memory.db-shm')));
  assert.equal(signInRows(join(dir, 'memory.db')).owner, 1);
  assert.ok(existsSync(join(from, 'memory.db')), 'the staged copy was not used');
});
