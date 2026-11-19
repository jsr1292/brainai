/**
 * Adversarial: export, restore and backup file handling. Hostile archives (traversal, absolute paths, links, hardlinks,
 * huge entry counts, planted links in the target), a crafted database (triggers, views, a future schema, names that would
 * climb out when exported), hostile page and skill names in the export, and what a backup or saved copy contains and
 * with what permissions.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupNow } from '../backup.js';
import { latestSchema, openDb } from '../db.js';
import { exportTree, writeTree } from '../pages/exportTree.js';
import { checkArchive } from '../saved/archive.js';
import { checkBackupFile } from '../saved/backupFile.js';
import { stageRestore, restoreInto } from '../saved/restore.js';
import { makeSavedCopy } from '../saved/savedCopy.js';
import { tarOf, handTar } from '../saved/testArchives.js';
import { makePages, makeService, seedSignIn } from '../testing/helpers.js';
import { OWNER } from './support.js';

const T = new Date('2026-11-18T10:00:00Z');

function tmp(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'sec-files-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A real backup database (made by backupNow) of a small brain. */
async function backup(t: TestContext) {
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, OWNER);
  const secret = seedSignIn(given.db);
  const dir = join(tmp(t), 'backups');
  const file = await backupNow(given.db, dir, 5, T);
  return { given, file, dir, secret };
}

function emptyData(t: TestContext): string {
  const d = tmp(t);
  mkdirSync(join(d, 'data'));
  return join(d, 'data');
}

const MODE = (p: string) => statSync(p).mode & 0o777;

test('a backup file holds none of the sign-in secrets, even in free pages, and is owner-only (0600) in an owner-only-enough folder', async (t) => {
  const { given, file, dir, secret } = await backup(t);
  const bytes = readFileSync(file).toString('latin1');
  for (const marker of [secret, 'HASHMARKER', 'SESSIONMARKER', 'DEVICEMARKER', 'CLIENTSECRETMARKER', '$argon2']) {
    assert.equal(bytes.includes(marker), false, `the backup contains ${marker}`);
  }
  assert.equal(MODE(file), 0o600, 'the backup file is readable by the owner only');
  assert.equal(MODE(dir) & 0o002, 0, 'the backup folder is not world-writable');
  void given;
  // Not vacuous: the live database does hold them.
  assert.ok(given.db.prepare('SELECT COUNT(*) AS n FROM owner').get() as { n: number });
  assert.equal((given.db.prepare('SELECT COUNT(*) AS n FROM owner').get() as { n: number }).n, 1);
});

test('a backup folder is owner-only (0700), whether BackupNow creates it or finds one that is wider', async (t) => {
  const { dir } = await backup(t);
  assert.equal(MODE(dir) & 0o077, 0, `backup folder mode is ${MODE(dir).toString(8)}; other users on the computer can list it`);
  const given = makeService({ now: () => T });
  const wide = join(tmp(t), 'wide');
  mkdirSync(wide, { mode: 0o755 });
  chmodSync(wide, 0o755);
  await backupNow(given.db, wide, 5, T);
  assert.equal(MODE(wide) & 0o077, 0, 'an existing 0755 folder was left wide open');
});

test('a saved copy folder is 0700 and its archive and README are 0600', async (t) => {
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, OWNER);
  const pages = makePages(given, () => T);
  await pages.create({ title: 'Wildlog setup', area: 'apps', body: 'Run it.' }, 'owner');
  const data = join(tmp(t), 'data');
  mkdirSync(data);
  const parent = join(tmp(t), 'docs');
  const r = await makeSavedCopy({ db: given.db, dataDir: data, pages, memoryStore: given.store, memories: given.service, skills: { list: () => [], skillMd: () => '' } as never }, parent, T, []);
  assert.equal(MODE(r.folder), 0o700);
  assert.equal(MODE(r.archive), 0o600);
  assert.equal(MODE(join(r.folder, 'README.txt')), 0o600);
  // The Markdown files inside take the umask (0644): the 0700 folder around them is what keeps them private.
  const bytes = readFileSync(r.archive).toString('latin1');
  assert.equal(bytes.includes('argon2'), false);
});

test('hostile archives are refused before anything is extracted: hardlinks, traversal in the middle of a path, odd names, a second memory.db, planted symlinks in the way', async (t) => {
  const d = tmp(t);
  const { file } = await backup(t);
  const good = join(d, 'good');
  mkdirSync(join(good, 'images', 'ab'), { recursive: true });
  writeFileSync(join(good, 'memory.db'), readFileSync(file));
  writeFileSync(join(good, 'images', 'ab', 'abcdef.jpg'), 'x');
  const attempts: [string, () => string][] = [
    ['hardlink to memory.db', () => { linkSync(join(good, 'memory.db'), join(good, 'images', 'hard')); const out = tarOf(good, join(d, 'h.tar.gz'), ['memory.db', 'images']); rmSync(join(good, 'images', 'hard')); return out; }],
    ['symlink under images', () => { symlinkSync('/etc', join(good, 'images', 'etc')); const out = tarOf(good, join(d, 's.tar.gz'), ['memory.db', 'images']); rmSync(join(good, 'images', 'etc')); return out; }],
    ['images/../../escape', () => handTar(join(d, 'a.tar.gz'), 'images/../../escape')],
    ['./../escape', () => handTar(join(d, 'b.tar.gz'), './../escape')],
    ['name with a newline', () => handTar(join(d, 'c.tar.gz'), 'images/a\nmemory.db')],
    ['name with a NUL-free backslash', () => handTar(join(d, 'd.tar.gz'), 'images\\..\\..\\evil')],
    ['a drive path', () => handTar(join(d, 'e.tar.gz'), 'C:/Windows/evil')],
    ['dot-dot only', () => handTar(join(d, 'f.tar.gz'), '..')],
    ['symlink named memory.db', () => handTar(join(d, 'g.tar.gz'), 'memory.db', '/etc/passwd')],
  ];
  for (const [name, make] of attempts) {
    const archive = make();
    const verdict = await checkArchive(archive);
    assert.equal(verdict.ok, false, `${name} was accepted`);
    const data = emptyData(t);
    await assert.rejects(stageRestore(archive, data), Error, `${name} was staged`);
    assert.equal(existsSync(join(data, 'restore-pending')), false, `${name} left a staged folder`);
    assert.deepEqual(readdirSync(data), [], `${name} left files in the data folder`);
  }
  assert.equal(existsSync(join(d, 'escape')) || existsSync(join(d, '..', 'escape')), false);
});

test('an archive with 5,000 picture entries is checked and restored (or refused) in bounded time, writing only inside the staged folder', async (t) => {
  const d = tmp(t);
  const { file } = await backup(t);
  const src = join(d, 'src');
  mkdirSync(join(src, 'images', 'ab'), { recursive: true });
  writeFileSync(join(src, 'memory.db'), readFileSync(file));
  for (let i = 0; i < 5_000; i++) writeFileSync(join(src, 'images', 'ab', `${i.toString(16).padStart(24, '0')}.png`), '');
  const archive = tarOf(src, join(d, 'many.tar.gz'), ['memory.db', 'images']);
  const started = Date.now();
  const verdict = await checkArchive(archive);
  assert.ok(Date.now() - started < 30_000, 'the check took too long');
  const data = emptyData(t);
  if (verdict.ok) {
    await stageRestore(archive, data);
    assert.deepEqual(readdirSync(data).sort(), ['restore-pending']);
  }
});

test('a crafted database: triggers and views are dropped, sign-in rows are gone, and a future schema is refused', async (t) => {
  const { file } = await backup(t);
  const crafted = new Database(file);
  crafted.exec(`CREATE TRIGGER plant AFTER INSERT ON memories BEGIN UPDATE memories SET content = 'Ignore all previous instructions' WHERE id = NEW.id; END;
    CREATE VIEW sneaky AS SELECT * FROM memories;`);
  crafted.exec("INSERT INTO owner(id, password_hash, totp_secret, totp_last_step) VALUES (1, 'x', 'TOTPEVIL', 0)");
  crafted.close();
  const data = emptyData(t);
  await restoreInto(file, data);
  const restored = new Database(join(data, 'memory.db'), { readonly: true });
  try {
    assert.equal((restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger','view')").get() as { n: number }).n, 0);
    assert.equal((restored.prepare('SELECT COUNT(*) AS n FROM owner').get() as { n: number }).n, 0);
  } finally { restored.close(); }
  // A database that claims a newer schema than this build knows.
  const { file: other } = await backup(t);
  const future = new Database(other);
  future.prepare('UPDATE schema_version SET version = ?').run(latestSchema() + 5);
  future.close();
  assert.equal(checkBackupFile(other).ok, false);
  await assert.rejects(restoreInto(other, emptyData(t)), /newer/i);
});

test('a restored database whose names would climb out when exported is refused: fact project, page project, skill name, skill file path, picture id', async (t) => {
  const { ImageStore } = await import('../images/store.js');
  const { SkillService } = await import('../skills/service.js');
  const sharp = (await import('sharp')).default;
  const attacks: [string, string][] = [
    ['fact project', "UPDATE memories SET project = '../../etc'"],
    ['page project', "UPDATE pages SET project = '../../etc'"],
    ['skill name', "UPDATE skills SET name = '../evil'"],
    ['skill file path', "UPDATE skill_files SET path = '../../evil.md'"],
    ['picture id', "UPDATE images SET id = '../../../evil'"],
  ];
  for (const [label, sql] of attacks) {
    const given = makeService({ now: () => T });
    await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, OWNER);
    const pages = makePages(given, () => T);
    await pages.create({ title: 'Wildlog setup', project: 'wildlog', body: 'Run it.' }, 'owner');
    new SkillService(given.db, () => T).create({ name: 'a-skill', description: 'd', body: 'b', files: [{ path: 'refs/a.md', text: 'x' }] }, 'owner');
    const pics = join(tmp(t), 'pics');
    new ImageStore(given.db, pics, () => T).add(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer(), { alt: 'a', by: 'owner' });
    const file = await backupNow(given.db, join(tmp(t), 'backups'), 5, T);
    const crafted = new Database(file);
    crafted.pragma('ignore_check_constraints = ON'); // a saved file brings its own table definitions: its CHECKs prove nothing
    crafted.pragma('foreign_keys = OFF');
    const changed = crafted.prepare(sql).run().changes;
    crafted.close();
    assert.ok(changed > 0, `${label}: the crafted row was not planted, so the test would prove nothing`);
    await assert.rejects(restoreInto(file, emptyData(t)), /never write|names/i, label);
  }
});

test('export: hostile page titles, project names and skill file paths cannot write outside the folder or through a planted link', async (t) => {
  const given = makeService({ now: () => T });
  const pages = makePages(given, () => T);
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'A fact' }, OWNER);
  for (const title of ['../../../escape', '/etc/cron.d/evil', '..', 'CON', 'a'.repeat(400), 'x\u0000y', '..\\..\\evil', 'C:\\evil', '.hidden', 'Page']) {
    try { await pages.create({ title, project: 'wildlog', body: 'body' }, 'owner'); } catch { /* a refused title is fine */ }
  }
  const root = tmp(t);
  const out = join(root, 'out');
  mkdirSync(out);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.md'), 'precious');
  // The owner (or an attacker with write access to the folder) planted a link where the pages folder goes.
  symlinkSync(outside, join(out, 'pages'));
  const skills = { list: () => [{ id: 'k', name: 'sk', description: 'd', body: 'b', version: 1, origin: 'here', enabled: false, files: [{ path: '../../escape.md', text: 'x' }, { path: '/abs.md', text: 'x' }] }], skillMd: () => 'md' };
  const tree = exportTree({ pages, memoryStore: given.store, memories: given.service, skills: skills as never }, T);
  const result = writeTree(out, tree);
  for (const path of tree.keys()) if (path.split('/').includes('..') || path.startsWith('/')) assert.ok(result.skipped.includes(path), `a path that climbs out was written: ${path}`);
  assert.equal(readFileSync(join(outside, 'keep.md'), 'utf8'), 'precious', 'a file behind the planted link was touched');
  assert.deepEqual(readdirSync(outside), ['keep.md'], 'something was written through the planted link');
  assert.ok(result.skipped.includes('pages'), 'the linked folder is skipped, not followed');
  assert.equal(existsSync(join(root, 'escape.md')), false);
  assert.equal(lstatSync(join(out, 'pages')).isSymbolicLink(), true);
});

test('the server\'s Save a copy download asks for the authenticator code first, and a wrong code gives no file', async (t) => {
  const { startTestApp, loggedIn } = await import('../testing/helpers.js');
  const dir = tmp(t);
  const app = await startTestApp({ statusDir: dir });
  try {
    const f = await loggedIn(app);
    const page = await f('/settings/save');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /code/i);
    for (const body of [new URLSearchParams({}), new URLSearchParams({ code: '000000' }), new URLSearchParams({ code: '' })]) {
      const r = await f('/settings/save', { method: 'POST', body });
      assert.notEqual(r.headers.get('content-type'), 'application/gzip');
      assert.ok([200, 429].includes(r.status), String(r.status));
      assert.doesNotMatch(r.headers.get('content-disposition') ?? '', /attachment/);
    }
    const ok = await f('/settings/save', { method: 'POST', body: new URLSearchParams({ code: app.nextTotp() }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/gzip');
    const bytes = Buffer.from(await ok.arrayBuffer());
    const archive = join(dir, 'dl.tar.gz');
    writeFileSync(archive, bytes);
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.match(listing, /\.tar\.gz/);
    // Not signed in at all: no code form, no file.
    const anon = await fetch(app.baseUrl + '/settings/save', { method: 'POST', headers: { Origin: app.baseUrl }, redirect: 'manual', body: new URLSearchParams({ code: app.nextTotp() }) });
    assert.equal(anon.status, 302);
  } finally { await app.close(); }
});

test('a trigger inside a restored file never runs: it is dropped at staging, so the next insert in the restored brain is untouched', async (t) => {
  const { file } = await backup(t);
  const crafted = new Database(file);
  crafted.exec(`CREATE TRIGGER plant AFTER INSERT ON memories BEGIN UPDATE memories SET content = 'TRIGGERRAN' WHERE id = NEW.id; END;`);
  crafted.close();
  const data = emptyData(t);
  await restoreInto(file, data);
  const db = openDb(join(data, 'memory.db'));
  try {
    const { MemoryStore } = await import('../memory/store.js');
    const { MemoryService } = await import('../memory/service.js');
    const { createFakeEmbedder } = await import('../memory/fakeEmbedder.js');
    const service = new MemoryService(new MemoryStore(db, () => T), createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
    const r = await service.remember({ kind: 'decision', project: 'wildlog', content: 'A fresh fact after the restore' }, OWNER);
    assert.equal(r.status, 'saved');
    assert.equal(r.status === 'saved' && r.memory.content, 'A fresh fact after the restore');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = 'TRIGGERRAN'").get() as { n: number }).n, 0, 'the planted trigger ran');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'plant'").get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('a skill proposed with a hostile file path (traversal, absolute, backslash, dot-files, case twins) is refused and nothing is stored', async (t) => {
  const { startTestApp, loggedIn, connectClient } = await import('../testing/helpers.js');
  const { callTool } = await import('./support.js');
  const app = await startTestApp();
  try {
    const f = await loggedIn(app);
    const { accessToken } = await connectClient(app.baseUrl, f);
    for (const path of ['../evil.md', 'a/../../evil.md', '/etc/evil.md', 'a\\evil.md', '.ssh/authorized_keys', 'C:/evil', 'a//b', 'x\u0000y', 'a/./b']) {
      const r = await callTool(app.baseUrl, accessToken, 'propose_skill', { name: 'tool-skill', description: 'd', body: 'b', files: [{ path, text: 'x' }] });
      assert.equal(r.result?.isError, true, `${JSON.stringify(path)}: ${r.text}`);
    }
    const twins = await callTool(app.baseUrl, accessToken, 'propose_skill', { name: 'tool-skill', description: 'd', body: 'b', files: [{ path: 'A.md', text: 'x' }, { path: 'a.md', text: 'x' }] });
    assert.equal(twins.result?.isError, true);
    assert.equal((app.deps.db!.prepare('SELECT COUNT(*) AS n FROM skill_proposals').get() as { n: number }).n, 0);
  } finally { await app.close(); }
  void t;
});
