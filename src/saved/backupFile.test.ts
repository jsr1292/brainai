/** Telling a daily backup file from a saved archive, and proving it is a BrainAI backup before anything trusts it. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupNow } from '../backup.js';
import { latestSchema } from '../db.js';
import { makeService } from '../testing/helpers.js';
import { packArchive } from './archive.js';
import { checkBackupFile, kindOfFile } from './backupFile.js';

const T = new Date('2026-11-06T10:00:00Z');

function tmp(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'backupfile-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function backup(t: TestContext): Promise<string> {
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'garden-club-site', content: 'The site is plain HTML' }, { type: 'owner' });
  await given.service.remember({ kind: 'summary', project: 'garden-club-site', content: 'Photos page is done' }, { type: 'owner' });
  return backupNow(given.db, tmp(t), 1, T);
}

test('kindOfFile reads the first bytes: an archive, a database, or neither', async (t) => {
  const file = await backup(t);
  const dir = tmp(t);
  const archive = join(dir, 'brainai-saved-2026-11-06.tar.gz');
  const given = makeService({ now: () => T });
  await packArchive(given.db, dir, archive, T);
  assert.equal(kindOfFile(archive), 'archive');
  assert.equal(kindOfFile(file), 'database');
  const text = join(dir, 'notes.txt');
  writeFileSync(text, 'just some notes');
  assert.equal(kindOfFile(text), null);
  assert.equal(kindOfFile(join(dir, 'missing')), null);
  // The name does not count: a database called .tar.gz is still a database.
  const renamed = join(dir, 'x.tar.gz');
  writeFileSync(renamed, readFileSync(file));
  assert.equal(kindOfFile(renamed), 'database');
});

test('checkBackupFile accepts a backup and counts what it holds', async (t) => {
  const file = await backup(t);
  const c = checkBackupFile(file);
  assert.deepEqual(c, { ok: true, facts: 2, pages: 0, schema: latestSchema() });
});

test('checkBackupFile refuses a SQLite file that is not a BrainAI backup', (t) => {
  const file = join(tmp(t), 'other.db');
  const db = new Database(file);
  db.exec('CREATE TABLE recipes(id TEXT); INSERT INTO recipes VALUES (\'soup\')');
  db.close();
  const c = checkBackupFile(file);
  assert.equal(c.ok, false);
  assert.match((c as { reason: string }).reason, /not a BrainAI backup/);
});

test('checkBackupFile refuses a truncated copy', async (t) => {
  const file = await backup(t);
  const cut = join(tmp(t), 'cut.db');
  writeFileSync(cut, readFileSync(file));
  truncateSync(cut, 6000);
  const c = checkBackupFile(cut);
  assert.equal(c.ok, false);
});

test('checkBackupFile refuses a schema from a newer BrainAI', async (t) => {
  const file = await backup(t);
  const db = new Database(file);
  db.prepare('UPDATE schema_version SET version = ?').run(latestSchema() + 1);
  db.close();
  const c = checkBackupFile(file);
  assert.equal(c.ok, false);
  assert.match((c as { reason: string }).reason, /from a newer BrainAI/);
});

test('checkBackupFile refuses a text file', (t) => {
  const f = join(tmp(t), 'notes.txt');
  writeFileSync(f, 'just some notes');
  assert.equal(checkBackupFile(f).ok, false);
});
