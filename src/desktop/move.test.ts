/** Move it to a server (D5): the moving file. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db.js';
import { ImageStore } from '../images/store.js';
import * as fx from '../testing/imageFixtures.js';
import { makeService, seedSignIn } from '../testing/helpers.js';
import { deleteMoveFile, makeMoveFile, moveFile } from './move.js';

const T = new Date('2026-11-06T10:00:00Z');
const me = { type: 'owner' } as const; // the owner's own saves go straight in (an assistant's profile facts wait for approval)

async function brain(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'brainai-move-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { db, service } = makeService({ now: () => T });
  for (const c of ['Prefers short answers', 'Lives near the sea', 'Uses a Mac']) await service.remember({ kind: 'profile', content: c }, me);
  const images = new ImageStore(db, dataDir, () => T);
  const img = images.add(await fx.jpegWithGps(), { alt: 'A label', by: 'owner' });
  seedSignIn(db);
  return { dataDir, db, service, img, images };
}

/** Unpacks a moving file into a fresh folder, as the server's runbook does. */
function unpack(t: TestContext, file: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-server-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('tar', ['-xzf', file, '-C', dir]);
  return dir;
}
const count = (db: ReturnType<typeof openDb>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('a moving file unpacks into a data folder the server opens, with every memory and picture and no sign-in data', async (t) => {
  const { dataDir, db, img, images } = await brain(t);
  const file = await makeMoveFile(db, dataDir, T);
  assert.equal(file, join(dataDir, 'move', 'brainai-move-2026-11-06.tar.gz'));
  assert.equal(statSync(file).mode & 0o777, 0o600, 'only the owner can read it');
  assert.equal(moveFile(dataDir), file);
  const server = unpack(t, file);
  const moved = openDb(join(server, 'memory.db'));
  t.after(() => moved.close());
  assert.equal((moved.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND kind = 'profile'").get() as { n: number }).n, 3);
  assert.ok(existsSync(join(server, images.path(img).slice(dataDir.length + 1))), 'the picture file came along');
  for (const table of ['owner', 'sessions', 'oauth_tokens', 'oauth_codes', 'known_devices']) assert.equal(count(moved, table), 0, table);
  // Made again: still one file.
  await makeMoveFile(db, dataDir, new Date('2026-11-07T10:00:00Z'));
  assert.deepEqual(readdirSync(join(dataDir, 'move')), ['brainai-move-2026-11-07.tar.gz']);
});

test('a moving file is the copy of the moment it was made', async (t) => {
  const { dataDir, db, service } = await brain(t);
  const file = await makeMoveFile(db, dataDir, T);
  await service.remember({ kind: 'profile', content: 'Saved after the moving file' }, me);
  const moved = openDb(join(unpack(t, file), 'memory.db'));
  t.after(() => moved.close());
  assert.equal((moved.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = 'Saved after the moving file'").get() as { n: number }).n, 0);
});

test('a moving file with a picture whose file is missing is still made', async (t) => {
  const { dataDir, db, img, images } = await brain(t);
  rmSync(images.path(img));
  const file = await makeMoveFile(db, dataDir, T);
  const moved = openDb(join(unpack(t, file), 'memory.db'));
  t.after(() => moved.close());
  assert.equal(count(moved, 'images'), 1, 'the row is kept; the runbook check lists it as missing');
});

test('deleting the moving file removes it and the folder holds nothing else', async (t) => {
  const { dataDir, db } = await brain(t);
  await makeMoveFile(db, dataDir, T);
  deleteMoveFile(dataDir);
  assert.equal(moveFile(dataDir), null);
  assert.deepEqual(readdirSync(join(dataDir, 'move')), []);
});

test("the runbook's move steps give a server the moved brain", async (t) => {
  const { dataDir, db } = await brain(t);
  const file = await makeMoveFile(db, dataDir, T);
  const runbook = readFileSync(new URL('../../docs/RUNBOOK.md', import.meta.url), 'utf8');
  const section = /^## \d+\. Moving from the app\n([\s\S]*?)(?=^## )/m.exec(runbook)?.[1];
  assert.ok(section, 'the runbook has the section');
  // The documented unpack command, run as written with this file and a fresh data folder.
  const line = /^\s*tar -xzf (\S+) -C (\S+)\s*$/m.exec(section!);
  assert.ok(line, 'it says how to unpack the file');
  assert.equal(line![1], 'brainai-move-*.tar.gz');
  assert.equal(line![2], 'data');
  const server = mkdtempSync(join(tmpdir(), 'brainai-server-'));
  t.after(() => rmSync(server, { recursive: true, force: true }));
  mkdirSync(join(server, 'data'));
  copyFileSync(file, join(server, basename(file)));
  execFileSync('sh', ['-c', line![0].trim()], { cwd: server });
  const moved = openDb(join(server, 'data', 'memory.db'));
  t.after(() => moved.close());
  assert.equal((moved.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND kind = 'profile'").get() as { n: number }).n, 3);
  assert.ok(existsSync(join(server, 'data', 'images')));
  // It also says to set the sign-in (the file has none) and to reconnect the apps from the server.
  assert.match(section!, /set-password/);
  assert.match(section!, /setup-totp/);
  assert.match(section!, /chown/);
});

test("a moving file carries no macOS file attributes, so a Linux server's tar unpacks it without warnings", async (t) => {
  const { dataDir, db } = await brain(t);
  const file = await makeMoveFile(db, dataDir, T);
  const stream = gunzipSync(readFileSync(file)).toString('latin1');
  assert.ok(!stream.includes('LIBARCHIVE.xattr'), 'no extended attributes');
  assert.ok(!/(^|\/)\._/m.test(stream), 'no AppleDouble ._ files');
});

test('two moving files made at once (a double click) both finish, and the one kept is whole', async (t) => {
  const { dataDir, db } = await brain(t);
  // Enough pictures that packing takes a while, so the two runs overlap.
  mkdirSync(join(dataDir, 'images', 'ff'), { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(dataDir, 'images', 'ff', `big${i}.jpg`), randomBytes(10 * 1024 * 1024));
  const results = await Promise.allSettled([makeMoveFile(db, dataDir, T), makeMoveFile(db, dataDir, T)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map((r) => (r as PromiseRejectedResult).reason?.message)));
  const file = moveFile(dataDir)!;
  gunzipSync(readFileSync(file)); // throws on a broken archive
  const moved = openDb(join(unpack(t, file), 'memory.db'));
  t.after(() => moved.close());
  assert.equal((moved.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND kind = 'profile'").get() as { n: number }).n, 3);
  assert.deepEqual(readdirSync(join(dataDir, 'move')), [basename(file)], 'one file, no partials');
});
