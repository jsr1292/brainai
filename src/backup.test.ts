import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupNow, runBackup } from './backup.js';
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
  const dir = join(root, 'OneDrive', 'Work memory backups');
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
