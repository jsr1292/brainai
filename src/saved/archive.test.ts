/** The saved archive: how it is packed and how it is checked before anything trusts it. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openDb, latestSchema } from '../db.js';
import { makeService, makePages, seedSignIn } from '../testing/helpers.js';
import { makeMoveFile, moveFile } from '../desktop/move.js';
import { handTar, tarOf } from './testArchives.js';
import { checkArchive, listLines, packArchive, liveCounts, moveAcrossDisks, ARCHIVE_NAME } from './archive.js';

const T = new Date('2026-11-06T10:00:00Z');
const me = { type: 'owner' } as const;

function tmp(t: TestContext, prefix = 'saved-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function packed(t: TestContext) {
  const dataDir = tmp(t);
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, me);
  await given.service.remember({ kind: 'summary', project: 'larder', content: 'Larder shelf list is done' }, me);
  const pages = makePages(given, () => T);
  await pages.create({ title: 'Wildlog setup', area: 'apps', body: 'Run it with the usual command.' }, 'owner');
  seedSignIn(given.db);
  mkdirSync(join(dataDir, 'images', 'ab'), { recursive: true });
  writeFileSync(join(dataDir, 'images', 'ab', 'abcdef.jpg'), 'not really a picture');
  const out = join(tmp(t), 'saved.tar.gz');
  const counts = await packArchive(given.db, dataDir, out, T);
  return { ...given, dataDir, out, counts };
}

test('packArchive writes memory.db and images and no sign-in data', async (t) => {
  const { out, counts } = await packed(t);
  assert.deepEqual(counts, { facts: 2, pages: 1 });
  const names = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n').filter(Boolean).map((n) => n.replace(/\/$/, ''));
  assert.deepEqual(names.filter((n) => !/^images(\/|$)/.test(n)), ['memory.db']);
  assert.ok(names.includes('images/ab/abcdef.jpg'));
  const x = tmp(t);
  execFileSync('tar', ['-xzf', out, '-C', x]);
  const copy = openDb(join(x, 'memory.db'));
  t.after(() => copy.close());
  const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'oauth\\_%' ESCAPE '\\' OR name IN ('owner','sessions','device_tokens','known_devices','folder_reports','image_upload_links'))").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes('owner') && tables.some((n) => n.startsWith('oauth_')));
  for (const name of tables) {
    if (name === 'oauth_clients') continue; // kept (its secrets are replaced), as the nightly backup does
    assert.equal((copy.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n, 0, name);
  }
});

test('liveCounts counts only live facts and pages', async (t) => {
  const { db } = await packed(t);
  db.prepare("UPDATE memories SET deleted_at = 'x' WHERE project = 'larder'").run();
  db.prepare("UPDATE pages SET deleted_at = 'x'").run();
  assert.deepEqual(liveCounts(db), { facts: 1, pages: 0 });
});

test('checkArchive accepts a good archive', async (t) => {
  const { out } = await packed(t);
  assert.deepEqual(await checkArchive(out), { ok: true, facts: 2, pages: 1, schema: latestSchema() });
});

async function refused(file: string, cause: RegExp) {
  const r = await checkArchive(file);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, cause);
}

/** A folder holding a good memory.db copy, to build bad archives around. */
async function goodFolder(t: TestContext): Promise<string> {
  const { out } = await packed(t);
  const x = tmp(t);
  execFileSync('tar', ['-xzf', out, '-C', x]);
  return x;
}

test('checkArchive refuses an entry that climbs out (../evil)', async (t) => {
  await refused(handTar(join(tmp(t), 'a.tar.gz'), '../evil'), /climbs out/);
});

test('checkArchive refuses an absolute path', async (t) => {
  await refused(handTar(join(tmp(t), 'a.tar.gz'), '/etc/x'), /absolute/);
});

test('checkArchive refuses a symlink entry', async (t) => {
  const x = await goodFolder(t);
  symlinkSync('/etc/passwd', join(x, 'link'));
  await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['memory.db', 'link']), /link/i);
  await refused(handTar(join(tmp(t), 'b.tar.gz'), 'memory.db', '/etc/passwd'), /link/i);
});

test('checkArchive refuses a file that is not gzip', async (t) => {
  const f = join(tmp(t), 'a.tar.gz');
  writeFileSync(f, 'plain text, not an archive');
  await refused(f, /archive|gzip|read/i);
});

test('checkArchive refuses an archive without memory.db', async (t) => {
  const x = tmp(t);
  writeFileSync(join(x, 'other.txt'), 'x');
  await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['other.txt']), /memory\.db/);
});

test('checkArchive refuses an extra top-level entry', async (t) => {
  const x = await goodFolder(t);
  writeFileSync(join(x, 'notes.txt'), 'x');
  await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['memory.db', 'notes.txt']), /notes\.txt/);
});

test('a saved file whose names use backslashes or colons is refused', async (t) => {
  // Both names sit under images/, so the stray-entry rule alone would let them through. On Windows tar, `\` separates
  // folders (so the first one climbs out of images/) and `:` reaches drive-relative paths and alternate streams.
  for (const [folder, name] of [['', 'ab\\..\\..\\evil.txt'], ['ab', 'x:y.jpg']] as const) {
    const x = await goodFolder(t);
    mkdirSync(join(x, 'images', folder), { recursive: true });
    writeFileSync(join(x, 'images', folder, name), 'x');
    await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['memory.db', 'images']), /backslash or colon/);
  }
});

test('listings with CRLF line ends are read like LF ones', async (t) => {
  assert.deepEqual(listLines('a\r\nb/c\r\n\r\nd\n'), ['a', 'b/c', 'd']);
  // A tar that ends its listing lines with CRLF, as Windows tar output may.
  const { out } = await packed(t);
  const bin = tmp(t, 'fake-tar-');
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\ncase "$1" in -tvzf|-tzf) /usr/bin/tar "$@" | sed \'s/$/\'"$(printf \'\\r\')"\'/\' ;; *) exec /usr/bin/tar "$@" ;; esac\n');
  chmodSync(join(bin, 'tar'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    assert.deepEqual(await checkArchive(out), { ok: true, facts: 2, pages: 1, schema: latestSchema() });
  } finally {
    process.env.PATH = before;
  }
});

test('checkArchive refuses a database from a newer BrainAI', async (t) => {
  const x = await goodFolder(t);
  const db = openDb(join(x, 'memory.db'));
  db.prepare('UPDATE schema_version SET version = ?').run(latestSchema() + 1);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['memory.db']), /newer BrainAI/);
});

test('checkArchive refuses a database that fails its integrity check', async (t) => {
  const x = await goodFolder(t);
  const file = join(x, 'memory.db');
  const size = readFileSync(file).length;
  const fd = openSync(file, 'r+');
  // Garbage over the later pages, leaving the header (and so the schema version) readable.
  writeSync(fd, Buffer.alloc(Math.min(8192, size - 4096), 0xab), 0, Math.min(8192, size - 4096), 4096);
  closeSync(fd);
  await refused(tarOf(x, join(tmp(t), 'a.tar.gz'), ['memory.db']), /integrity|database|read/i);
});

test('the moving file is now brainai-saved and the old name is still found', async (t) => {
  const dataDir = tmp(t);
  const { db } = makeService({ now: () => T });
  const file = await makeMoveFile(db, dataDir, T);
  assert.match(file, /brainai-saved-2026-11-06\.tar\.gz$/);
  assert.match('brainai-move-2026-11-06.tar.gz', ARCHIVE_NAME);
  const other = tmp(t);
  mkdirSync(join(other, 'move'));
  copyFileSync(file, join(other, 'move', 'brainai-move-2026-10-01.tar.gz'));
  assert.equal(moveFile(other), join(other, 'move', 'brainai-move-2026-10-01.tar.gz'));
});

test('moveAcrossDisks falls back to copy-then-rename next to the destination when the rename crosses disks', (t) => {
  const from = tmp(t);
  const to = tmp(t);
  writeFileSync(join(from, 'a.tar.gz'), 'archive bytes');
  const calls: string[] = [];
  const exdev = (a: string, b: string) => { calls.push(b); if (calls.length === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); renameSync(a, b); };
  moveAcrossDisks(join(from, 'a.tar.gz'), join(to, 'out.tar.gz'), exdev);
  assert.equal(readFileSync(join(to, 'out.tar.gz'), 'utf8'), 'archive bytes');
  assert.equal(existsSync(join(from, 'a.tar.gz')), false);
  // The second rename went from a temp name in the destination's own folder.
  assert.deepEqual(readdirSync(to), ['out.tar.gz']);
  assert.throws(() => moveAcrossDisks(join(from, 'none'), join(to, 'x'), () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); }), /nope/);
});

test('a stray entry with a very long name is refused with a short reason', async (t) => {
  const x = await goodFolder(t);
  // Three components under the 255 limit make a path of over 750 characters, which only a PAX header can carry.
  const deep = join(x, ...['a', 'b', 'c'].map((c) => c.repeat(250)));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'f.txt'), 'x');
  const out = join(tmp(t), 'a.tar.gz');
  execFileSync('tar', ['--format', 'pax', '-czf', out, '-C', x, 'memory.db', 'a'.repeat(250)]);
  const r = await checkArchive(out);
  assert.equal(r.ok, false);
  const reason = (r as { reason: string }).reason;
  assert.match(reason, /holds something else/);
  assert.ok(reason.length < 200, `${reason.length}`);
});

test('archive failures can be rendered in the recovery route language after checking', async (t) => {
  const { runWithLocale } = await import('../i18n/core.js');
  const { removeTempDir } = await import('../testing/tempDir.js');
  const { errorText } = await import('../web/errorText.js');
  const { stageRestore } = await import('./restore.js');
  const { findCopy } = await import('./findCopy.js');
  const dir = mkdtempSync(join(tmpdir(), 'archive-locale-'));
  t.after(() => removeTempDir(dir));
  const file = join(dir, 'brainai-saved-2026-11-06.tar.gz');
  writeFileSync(file, gzipSync('invalid archive'));
  await assert.rejects(stageRestore(file, dir), (error: Error) => {
    assert.match(error.message, /could not be read as an archive/);
    assert.match(runWithLocale('es', () => errorText(error)), /no se pudo leer como un archivo comprimido/);
    return true;
  });
  await assert.rejects(findCopy(dir), (error: Error) => {
    assert.match(runWithLocale('es', () => errorText(error.cause ?? error)), /no se pudo leer como un archivo comprimido/);
    return true;
  });
});

test('restore errors for a backup file, an unknown file and odd names can be rendered in the recovery route language, and stay English in .message', async (t) => {
  const { runWithLocale } = await import('../i18n/core.js');
  const { errorText } = await import('../web/errorText.js');
  const { stageRestore } = await import('./restore.js');
  const { default: Database } = await import('better-sqlite3');
  const dir = tmp(t);
  const es = (e: Error) => runWithLocale('es', () => errorText(e));
  const other = join(dir, 'memory-2026-11-06.db');
  const db = new Database(other);
  db.exec("CREATE TABLE recipes(id TEXT)");
  db.close();
  await assert.rejects(stageRestore(other, dir), (e: Error) => {
    assert.match(e.message, /This is not a BrainAI backup: it does not hold BrainAI's tables\./);
    assert.match(es(e), /no es una copia de seguridad de BrainAI/);
    return true;
  });
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'just notes');
  await assert.rejects(stageRestore(notes, dir), (e: Error) => {
    assert.match(e.message, /This is not a saved BrainAI file or backup/);
    assert.match(es(e), /no es un archivo guardado ni una copia de seguridad de BrainAI/);
    return true;
  });
});
