import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { backupNow, runBackup, syncPictures } from './backup.js';
import { readBackupStatus } from './backupStatus.js';
import { openDb } from './db.js';
import { seedSignIn } from './testing/helpers.js';

test('backupNow writes a dated, readable snapshot and keeps only the newest ones', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  db.prepare("INSERT INTO redirect_allowlist(entry, added_at) VALUES ('https://x.example/cb', 'x')").run();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) writeFileSync(join(dir, `memory-${day}.db`), '');
  writeFileSync(join(dir, 'notes.txt'), 'not a backup');

  const path = await backupNow(db, dir, 2, new Date('2026-10-20T08:00:00Z'));
  assert.equal(path, join(dir, 'memory-2026-10-20.db'));
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('memory-2026-10-20')), ['memory-2026-10-20.db']);
  const copy = new Database(path, { readonly: true });
  assert.equal((copy.prepare("SELECT entry FROM redirect_allowlist WHERE entry LIKE 'https://x%'").get() as { entry: string }).entry, 'https://x.example/cb');
  copy.close();
  // The live database's own files (and its -wal/-shm companions) are never touched.
  assert.deepEqual(readdirSync(dir).filter((f) => !f.startsWith('live.sqlite')).sort(), ['memory-2026-10-03.db', 'memory-2026-10-20.db', 'notes.txt']);
});

test('a backup leaves out the owner\'s password, authenticator secret, sessions, tokens and client secrets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  seedSignIn(db);
  const path = await backupNow(db, dir, 2, new Date('2026-10-20T08:00:00Z'));
  const copy = new Database(path, { readonly: true });
  for (const table of ['owner', 'sessions', 'known_devices', 'oauth_tokens', 'oauth_codes', 'oauth_pending']) {
    assert.equal((copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  // The secret is replaced, not removed: a client with no secret would be accepted as a public client.
  const meta = JSON.parse((copy.prepare("SELECT metadata FROM oauth_clients WHERE client_id = 'c1'").get() as { metadata: string }).metadata);
  assert.match(meta.client_secret, /^[0-9a-f]{64}$/);
  assert.deepEqual(meta.redirect_uris, ['https://claude.ai/cb']);
  copy.close();
  const bytes = readFileSync(path).toString('latin1');
  for (const marker of ['TOTPSECRETMARKER', 'HASHMARKER', 'SESSIONMARKER', 'DEVICEMARKER', 'CLIENTSECRETMARKER']) assert.ok(!bytes.includes(marker), marker);
  // The live database keeps them.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM owner').get() as { n: number }).n, 1);
});

test('a backup leaves out the Mac\'s device tokens', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  db.prepare("INSERT INTO device_tokens(id, name, token_hash, created_at) VALUES ('d1', 'Mac', 'MACTOKENHASHMARKER', 'x')").run();
  db.prepare("INSERT INTO folder_reports(device_id, received_at, folders) VALUES ('d1', 'x', '[]')").run();
  const path = await backupNow(db, dir, 2, new Date('2026-10-20T08:00:00Z'));
  const copy = new Database(path, { readonly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM device_tokens').get() as { n: number }).n, 0);
  copy.close();
  assert.ok(!readFileSync(path).toString('latin1').includes('MACTOKENHASHMARKER'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_tokens').get() as { n: number }).n, 1);
});

test('the unstripped snapshot is never written into the backup folder (a synced OneDrive folder at work)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb(join(root, 'live.sqlite'));
  t.after(() => db.close());
  seedSignIn(db);
  const dir = join(root, 'OneDrive', 'BrainAI backups');
  // What the backup folder holds at the moment the full snapshot has been written, before any stripping.
  const written: string[] = [];
  let seenInDir: string[] = [];
  const watched = new Proxy(db, {
    get(target, key) {
      if (key === 'backup') {
        return async (path: string) => {
          written.push(path);
          const r = await target.backup(path);
          seenInDir = readdirSync(dir).filter((f) => readFileSync(join(dir, f)).toString('latin1').includes('TOTPSECRETMARKER'));
          return r;
        };
      }
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const path = await backupNow(watched, dir, 2, new Date('2026-10-20T08:00:00Z'));
  assert.equal(written.length, 1);
  assert.ok(!written[0]!.startsWith(dir), `snapshot written at ${written[0]}`);
  assert.deepEqual(seenInDir, []);
  // The finished, stripped file is the only thing left, and the work copy is cleaned up.
  assert.deepEqual(readdirSync(dir), ['memory-2026-10-20.db']);
  assert.ok(!readFileSync(path).toString('latin1').includes('TOTPSECRETMARKER'));
  assert.ok(!existsSync(written[0]!), 'the work copy is removed');
});

test('an in-app backup run records its outcome for the dashboard, success or failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const target = join(dir, 'copies');
  await runBackup(db, target, 2, new Date('2026-10-20T08:00:00Z'), dir);
  assert.deepEqual(readBackupStatus(dir).nightly, { at: '2026-10-20T08:00:00.000Z', ok: true, copies: [{ where: target, result: 'copied' }] });
  writeFileSync(join(dir, 'a-file'), 'x');
  await runBackup(db, join(dir, 'a-file', 'sub'), 2, new Date('2026-10-21T08:00:00Z'), dir);
  const failed = readBackupStatus(dir).nightly!;
  assert.equal(failed.ok, false);
  assert.ok(failed.error);
});

test('a status file that cannot be written never takes the server down', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  await runBackup(db, join(dir, 'copies'), 2, new Date('2026-10-20T08:00:00Z'), join(dir, 'missing', 'dir'));
  assert.ok(readdirSync(join(dir, 'copies')).some((f) => f.startsWith('memory-')));
});

test('backupNow copies new pictures next to the backup, prunes them 30 days after Delete for good, and leaves out upload links', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-pics-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const dir = join(root, 'backups');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'memory.db'));
  const now = new Date('2026-11-20T08:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 86400_000).toISOString();
  const row = db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at) VALUES (?, 'png', 3, 1, 1, '2026-11-01', 'owner', ?)");
  const put = (base: string, id: string) => { mkdirSync(join(base, 'images', id.slice(0, 2)), { recursive: true }); writeFileSync(join(base, 'images', id.slice(0, 2), `${id}.png`), id); };
  const [live, recent, old] = ['a'.repeat(24), 'd'.repeat(24), 'e'.repeat(24)];
  row.run(live, null); put(dataDir, live);
  row.run(recent, days(10)); put(dataDir, recent);
  row.run(old, days(31)); put(dataDir, old); put(dir, old);
  mkdirSync(join(dataDir, 'images', 'tmp'), { recursive: true });
  writeFileSync(join(dataDir, 'images', 'tmp', 'half'), 'x');
  db.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by) VALUES ('p', 'P', 'p', NULL, 'start', 'b', 1, 'now', 'o', 'now', 'o')`).run();
  db.prepare("INSERT INTO image_upload_links(token_hash, grant_id, page_id, alt, created_by, created_at, expires_at) VALUES ('h', 'g', 'p', 'a', 'x', 'now', 'later')").run();
  const path = await backupNow(db, dir, 2, now, dataDir);
  const at = (base: string, id: string) => join(base, 'images', id.slice(0, 2), `${id}.png`);
  assert.ok(existsSync(at(dir, live)) && existsSync(at(dir, recent)));
  assert.ok(!existsSync(at(dir, old)), 'deleted 31 days ago: pruned from the copy');
  assert.ok(existsSync(at(dataDir, old)), 'never from data');
  assert.ok(!existsSync(join(dir, 'images', 'tmp')));
  const copy = new Database(path);
  assert.equal((copy.prepare('SELECT count(*) c FROM image_upload_links').get() as { c: number }).c, 0);
  copy.close();
  db.close();
});

test('the in-app backup counts live pictures whose file is missing (audit F11)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const id = 'ab' + '0'.repeat(22);
  db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by) VALUES (?, 'png', 3, 1, 1, '2026-11-01', 'owner')").run(id);
  await runBackup(db, join(dir, 'copies'), 2, new Date('2026-11-05T08:00:00Z'), dir);
  assert.deepEqual(readBackupStatus(dir).nightly!.pictures, { missing: 1, stray: 0 });
  mkdirSync(join(dir, 'images', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'images', 'ab', `${id}.png`), 'png');
  await runBackup(db, join(dir, 'copies'), 2, new Date('2026-11-06T08:00:00Z'), dir);
  assert.deepEqual(readBackupStatus(dir).nightly!.pictures, { missing: 0, stray: 0 });
});

test('a scheduled backup is also copied to the second folder, pruned there to the newest ones, touching only memory-*.db', async (t) => {
  const { scheduleBackups } = await import('./backup.js');
  const { BackupCopy, brainFolderName } = await import('./desktop/backupCopy.js');
  const { brainId } = await import('./db.js');
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const main = join(dir, 'main');
  const second = join(dir, 'second');
  mkdirSync(second);
  const own = join(second, brainFolderName(brainId(db)));
  mkdirSync(own);
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) writeFileSync(join(own, `memory-${day}.db`), '');
  writeFileSync(join(own, 'notes.txt'), 'mine');
  // Flat copies in the shared folder (an earlier version's) are not this brain's to prune.
  writeFileSync(join(second, 'memory-2026-09-01.db'), '');
  const copy = new BackupCopy(dir);
  copy.set(second);
  const timer = scheduleBackups(db, main, 2, () => new Date('2026-10-20T08:00:00Z'), dir, copy);
  clearInterval(timer);
  for (let i = 0; i < 100 && copy.lastResult() === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(copy.lastResult()?.ok, true);
  assert.ok(existsSync(join(main, 'memory-2026-10-20.db')));
  assert.deepEqual(readdirSync(own).sort(), ['memory-2026-10-03.db', 'memory-2026-10-20.db', 'notes.txt']);
  assert.deepEqual(readdirSync(second).sort(), [basename(own), 'memory-2026-09-01.db']);
  assert.ok(readFileSync(join(own, 'memory-2026-10-20.db')).length > 0);
});

test('a missing second folder is recorded as a failed copy and never stops the normal backup', async (t) => {
  const { runBackup } = await import('./backup.js');
  const { BackupCopy, brainFolderName } = await import('./desktop/backupCopy.js');
  const { brainId } = await import('./db.js');
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const gone = join(dir, 'unplugged-drive');
  const copy = new BackupCopy(dir);
  copy.set(gone);
  await runBackup(db, join(dir, 'main'), 2, new Date('2026-10-20T08:00:00Z'), dir, copy);
  assert.ok(existsSync(join(dir, 'main', 'memory-2026-10-20.db')));
  const r = copy.lastResult();
  assert.equal(r?.ok, false);
  assert.equal(r && !r.ok ? r.folder : '', gone);
  assert.equal(existsSync(gone), false);
  assert.equal(readBackupStatus(dir).nightly?.ok, true);
});

test('runBackup resolves to the run it recorded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const ok = await runBackup(db, join(dir, 'copies'), 2, new Date('2026-10-20T08:00:00Z'), dir);
  assert.equal(ok.ok, true);
  writeFileSync(join(dir, 'a-file'), 'x');
  const bad = await runBackup(db, join(dir, 'a-file', 'sub'), 2, new Date('2026-10-21T08:00:00Z'), dir);
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test('every backup file and second-folder copy is readable by the owner only', async (t) => {
  const { BackupCopy, brainFolderName } = await import('./desktop/backupCopy.js');
  const { brainId } = await import('./db.js');
  const before = process.umask(0o022);
  t.after(() => { process.umask(before); });
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const second = join(dir, 'second');
  mkdirSync(second);
  const copy = new BackupCopy(dir);
  copy.set(second);
  const path = await backupNow(db, join(dir, 'main'), 2, new Date('2026-10-20T08:00:00Z'));
  copy.run(path, 2, new Date('2026-10-20T08:00:00Z'), { db });
  assert.equal(copy.lastResult()?.ok, true);
  const own = join(second, brainFolderName(brainId(db)));
  for (const f of [path, own, join(own, 'memory-2026-10-20.db')]) assert.equal(lstatSync(f).mode & 0o077, 0, f);
});

test('a link planted at the backup\'s temporary name is never followed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'live.sqlite'));
  t.after(() => db.close());
  const main = join(dir, 'main');
  mkdirSync(main);
  const target = join(dir, 'victim.txt');
  writeFileSync(target, 'precious');
  symlinkSync(target, join(main, '.memory-2026-10-20.db.partial'));
  const path = await backupNow(db, main, 2, new Date('2026-10-20T08:00:00Z'));
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  assert.ok(lstatSync(path).isFile());
});

test("a careful picture sync never deletes a picture a restore left out (removed_by = 'restore'), however old", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-pics-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const dir = join(root, 'copy');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'memory.db'));
  t.after(() => db.close());
  const now = new Date('2026-11-20T08:00:00Z');
  const old = new Date(now.getTime() - 90 * 86400_000).toISOString();
  const row = db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at, removed_by) VALUES (?, 'png', 3, 1, 1, '2026-08-01', 'owner', ?, ?)");
  const restored = 'a'.repeat(24);
  const owner = 'b'.repeat(24);
  row.run(restored, old, 'restore');
  row.run(owner, old, 'owner');
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  for (const id of [restored, owner]) {
    mkdirSync(join(dir, 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, 'images', id.slice(0, 2), `${id}.png`), id);
  }
  syncPictures(db, dataDir, dir, now, true);
  assert.ok(existsSync(join(dir, 'images', 'aa', `${restored}.png`)), 'kept: a restore could not bring it back');
  assert.ok(!existsSync(join(dir, 'images', 'bb', `${owner}.png`)), 'an owner deletion is still pruned');
});

test('the server stays answering while a big brain is backed up (no stall of the event loop over 1 second)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-loop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const db = openDb(join(data, 'memory.db'));
  t.after(() => db.close());
  const ins = db.prepare("INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by) VALUES (?, 'decision', ?, 'big', '[]', ?, '2026-11-01', 'owner', '2026-11-01', 'owner')");
  const text = randomBytes(1500).toString('base64');
  const embedding = randomBytes(3072);
  db.transaction(() => { for (let i = 0; i < 60_000; i++) ins.run(`m${i}`, `${i} ${text}`, embedding); })();
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 10); last = n; }, 10);
  const path = await backupNow(db, join(root, 'main'), 2, new Date('2026-11-20T08:00:00Z'), data);
  // A stall at the very end is only seen by the first timer that fires after it.
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(timer);
  assert.ok(lstatSync(path).isFile());
  assert.ok(worst < 1000, `the event loop was stuck for ${worst} ms`);
});

test('two backups started 30 ms apart both succeed, and the file they leave passes its integrity check', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-two-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const db = openDb(join(data, 'memory.db'));
  t.after(() => db.close());
  const ins = db.prepare("INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by) VALUES (?, 'decision', ?, 'big', '[]', ?, '2026-11-01', 'owner', '2026-11-01', 'owner')");
  const text = randomBytes(1500).toString('base64');
  const embedding = randomBytes(3072);
  db.transaction(() => { for (let i = 0; i < 15_000; i++) ins.run(`m${i}`, `${i} ${text}`, embedding); })();
  const dir = join(root, 'main');
  const now = new Date('2026-11-20T08:00:00Z');
  const a = runBackup(db, dir, 7, now, data);
  await new Promise((r) => setTimeout(r, 30));
  const b = runBackup(db, dir, 7, now, data);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(rb.ok, true, JSON.stringify(rb));
  const file = join(dir, 'memory-2026-11-20.db');
  const check = new Database(file, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('partial')), []);
});

test('a backup that was stopped leaves nothing behind at the next start: its temporary folders and its half-made files are swept', async (t) => {
  const { sweepBackupTemp, sweepPartials, MAIN_PARTIAL } = await import('./backupWork.js');
  const tmp = mkdtempSync(join(tmpdir(), 'brain-sweep-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'brain-backup-abc123'));
  writeFileSync(join(tmp, 'brain-backup-abc123', 'memory-2026-11-20.db'), 'unstripped sign-in data');
  mkdirSync(join(tmp, 'other-folder'));
  sweepBackupTemp(tmp);
  assert.deepEqual(readdirSync(tmp).sort(), ['brain-backup-abc123', 'other-folder'], 'a fresh one may be another running BrainAI\'s');
  const old = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(join(tmp, 'brain-backup-abc123'), old, old);
  sweepBackupTemp(tmp);
  assert.deepEqual(readdirSync(tmp), ['other-folder']);
  writeFileSync(join(tmp, '.memory-2026-11-20.db.0123456789abcdef.partial'), 'half');
  writeFileSync(join(tmp, 'memory-2026-11-20.db'), 'whole');
  sweepPartials(tmp, MAIN_PARTIAL);
  assert.deepEqual(readdirSync(tmp).sort(), ['memory-2026-11-20.db', 'other-folder']);
});

test('a worker that fails after starting is not run again on the main thread, and its error keeps its message, code and stack', async () => {
  const { inWorker } = await import('./offThread.js');
  let reran = false;
  // A folder that is not there makes the task fail inside the worker, after it started.
  await assert.rejects(
    inWorker('moveAcrossDisks', ['/nonexistent-brainai/a', '/nonexistent-brainai/b'], () => { reran = true; }),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT' && /ENOENT/.test(e.message) && /backupWork/.test(String(e.stack)),
  );
  assert.equal(reran, false);
});

async function bigBrain(t: import('node:test').TestContext, rows: number) {
  const root = mkdtempSync(join(tmpdir(), 'brain-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const db = openDb(join(data, 'memory.db'));
  t.after(() => db.close());
  const ins = db.prepare("INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by) VALUES (?, 'decision', ?, 'big', '[]', ?, '2026-11-01', 'owner', '2026-11-01', 'owner')");
  const text = randomBytes(1500).toString('base64');
  const embedding = randomBytes(3072);
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(`m${i}`, `${i} ${text}`, embedding); })();
  return { root, data, db };
}

test('a worker that dies after it started is not run again on the main thread', async (t) => {
  const { inWorker } = await import('./offThread.js');
  const dir = mkdtempSync(join(tmpdir(), 'brain-dying-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const how of ['process.exit(1)', "throw new Error('boom after start')"]) {
    const file = join(dir, 'dying.mjs');
    writeFileSync(file, `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ started: true });\nsetTimeout(() => { ${how}; }, 20);\n`);
    let reran = false;
    await assert.rejects(inWorker('finishDraft', [], () => { reran = true; }, pathToFileURL(file)));
    assert.equal(reran, false, how);
  }
  // A worker that never started (a missing file) does fall back.
  let reran = false;
  await inWorker('finishDraft', [], () => { reran = true; }, pathToFileURL(join(dir, 'missing.mjs')));
  assert.equal(reran, true);
});

test('Back up now arriving while a saved copy is being made waits its turn, and both finish whole', async (t) => {
  const { packArchive, checkArchive } = await import('./saved/archive.js');
  const { root, data, db } = await bigBrain(t, 8_000);
  const now = new Date('2026-11-20T08:00:00Z');
  const out = join(root, 'saved.tar.gz');
  const pack = packArchive(db, data, out, now);
  await new Promise((r) => setTimeout(r, 20));
  const run = await runBackup(db, join(root, 'main'), 7, now, data);
  await pack;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(await checkArchive(out), { ok: true, facts: 8_000, pages: 0, schema: (await checkArchive(out) as { schema: number }).schema });
  const check = new Database(join(root, 'main', 'memory-2026-11-20.db'), { readonly: true });
  t.after(() => check.close());
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
});

test('a second-folder copy that never ends does not hold the backup lock, and the next run says the copy is still running', async (t) => {
  const { root, data, db } = await bigBrain(t, 200);
  const skipped: string[] = [];
  const hung = { folder: () => '/hung/share', runOffThread: () => new Promise<void>(() => {}), run: () => {}, skipBusy: (n: Date) => { skipped.push(n.toISOString()); } };
  const first = runBackup(db, join(root, 'main'), 7, new Date('2026-11-20T08:00:00Z'), data, hung as never);
  first.catch(() => {});
  // The first run waits for its copy; the lock is free, so the next run goes through.
  const second = await Promise.race([
    runBackup(db, join(root, 'main'), 7, new Date('2026-11-20T09:00:00Z'), data, hung as never),
    new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
  ]);
  assert.ok(second && second.ok, 'the next backup was not held up');
  assert.deepEqual(skipped, ['2026-11-20T09:00:00.000Z']);
});

test('a queued backup reads the clock when it starts, not when it was queued', async (t) => {
  const { root, data, db } = await bigBrain(t, 200);
  const dir = join(root, 'main');
  let sawFirstFile = false;
  const a = runBackup(db, dir, 7, new Date('2026-11-20T08:00:00Z'), data);
  const b = runBackup(db, dir, 7, () => { sawFirstFile = existsSync(join(dir, 'memory-2026-11-20.db')); return new Date('2026-11-21T08:00:00Z'); }, data);
  await Promise.all([a, b]);
  assert.equal(sawFirstFile, true, 'the clock was read after the first run had finished its backup');
  assert.ok(existsSync(join(dir, 'memory-2026-11-21.db')));
});

test('a picture row from a restored database that names a path outside the backup folder never deletes anything there', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-pics-evil-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const dir = join(root, 'Documents', 'backup');
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  mkdirSync(join(dir, 'images', 'aa'), { recursive: true });
  const outside = join(root, 'Documents', 'x.png');
  writeFileSync(outside, 'the owner\'s own file');
  const db = openDb(join(dataDir, 'memory.db'));
  t.after(() => db.close());
  const old = new Date(Date.now() - 90 * 86400_000).toISOString();
  // images/<id.slice(0,2)>/<id>.png from the backup folder: '../../x' climbs out to Documents/x.png.
  db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at, removed_by) VALUES (?, 'png', 3, 1, 1, '2026-08-01', 'owner', ?, NULL)").run('../../x', old);
  for (const careful of [false, true]) {
    syncPictures(db, dataDir, dir, new Date(), careful);
    assert.equal(readFileSync(outside, 'utf8'), "the owner's own file", `careful=${careful}`);
  }
});

test('the busy flag of a second folder clears after a copy that rejects, so the next run copies again', async (t) => {
  const { root, data, db } = await bigBrain(t, 100);
  let calls = 0;
  const skipped: string[] = [];
  const copy = { folder: () => '/share', runOffThread: () => { calls++; return calls === 1 ? Promise.reject(new Error('the copy failed')) : Promise.resolve(); }, run: () => {}, skipBusy: (n: Date) => { skipped.push(n.toISOString()); } };
  const a = await runBackup(db, join(root, 'main'), 7, new Date('2026-11-20T08:00:00Z'), data, copy as never);
  const b = await runBackup(db, join(root, 'main'), 7, new Date('2026-11-21T08:00:00Z'), data, copy as never);
  assert.equal(a.ok && b.ok, true);
  assert.equal(calls, 2, 'the second run copied');
  assert.deepEqual(skipped, []);
});

test('a backup\'s temp folder of a process that is gone is swept at once, one of a running process is not, and our own goes inside our lock', async (t) => {
  const { sweepBackupTemp } = await import('./backupWork.js');
  const tmp = mkdtempSync(join(tmpdir(), 'brain-sweep-pid-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const made = (name: string, pid: number) => { mkdirSync(join(tmp, name)); writeFileSync(join(tmp, name, 'pid'), String(pid)); };
  made('brain-backup-dead', 2_147_483_000);
  made('brain-backup-other', process.ppid);
  made('brain-backup-mine', process.pid);
  sweepBackupTemp(tmp);
  assert.deepEqual(readdirSync(tmp).sort(), ['brain-backup-mine', 'brain-backup-other']);
  sweepBackupTemp(tmp, true);
  assert.deepEqual(readdirSync(tmp).sort(), ['brain-backup-other']);
});

test('picture backup sweeps orphaned partials even when their source is gone', async (t) => {
  const { removeTempDir } = await import('./testing/tempDir.js');
  const { syncPictureFiles } = await import('./backupWork.js');
  const root = mkdtempSync(join(tmpdir(), 'picture-partials-'));
  t.after(() => removeTempDir(root));
  const copies = join(root, 'backup', 'images', 'ab');
  mkdirSync(copies, { recursive: true });
  writeFileSync(join(copies, 'abcdef.jpg.partial'), 'old partial');
  writeFileSync(join(copies, '.abcdef.jpg.0123456789abcdef.partial'), 'new partial');
  writeFileSync(join(copies, 'notes.partial'), 'unrelated');
  syncPictureFiles(join(root, 'source'), join(root, 'backup'), []);
  assert.deepEqual(readdirSync(copies), ['notes.partial']);
});
