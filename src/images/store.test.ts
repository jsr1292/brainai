import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../db.js';
import { cleanImage, ImageError } from './clean.js';
import { ImageStore, syncFolder } from './store.js';
import * as fx from '../testing/imageFixtures.js';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let ms = Date.parse('2026-11-05T09:00:00Z');
  const now = () => new Date(ms);
  const db = openDb(':memory:');
  return { dir, db, store: new ImageStore(db, dir, now), advance: (n: number) => { ms += n; } };
}

test('add stores the cleaned bytes once, named by their hash, and records who and what', async (t) => {
  const { dir, store } = setup(t);
  const input = await fx.jpegWithGps();
  const img = store.add(input, { alt: 'A label', by: 'owner' });
  const cleaned = cleanImage(input).bytes;
  assert.match(img.id, /^[0-9a-f]{24}$/);
  assert.ok(createHash('sha256').update(cleaned).digest('hex').startsWith(img.id));
  const path = join(dir, 'images', img.id.slice(0, 2), `${img.id}.jpg`);
  assert.equal(store.path(img), path);
  assert.ok(readFileSync(path).equals(cleaned));
  assert.deepEqual([img.type, img.ext, img.width, img.height, img.frames, img.alt, img.createdBy, img.pageId, img.removedAt], ['jpeg', 'jpg', 64, 48, 1, 'A label', 'owner', null, null]);
  assert.equal(img.bytes, cleaned.length);
  assert.deepEqual(readdirSync(join(dir, 'images', 'tmp')), []);
});

test('the same picture added twice is one row and one file, and keeps its first uploader', async (t) => {
  const { dir, db, store } = setup(t);
  const input = await fx.pngWithText();
  const a = store.add(input, { alt: 'first', by: 'owner' });
  const b = store.add(input, { alt: 'second', by: 'Claude Code' });
  assert.equal(a.id, b.id);
  assert.equal((db.prepare('SELECT count(*) c FROM images').get() as { c: number }).c, 1);
  assert.deepEqual([b.createdBy, b.alt], ['owner', 'first']);
  assert.deepEqual(readdirSync(join(dir, 'images', a.id.slice(0, 2))), [`${a.id}.png`]);
  assert.deepEqual([...store.many([a.id, 'nope']).keys()], [a.id]);
});

test('bytes deleted for good come back when uploaded again', async (t) => {
  const { store } = setup(t);
  const input = await fx.motionPhoto();
  const a = store.add(input, { alt: 'x', by: 'owner' });
  store.markRemoved(a.id, 'owner');
  unlinkSync(store.path(a));
  assert.ok(store.get(a.id)!.removedAt);
  const b = store.add(input, { alt: 'x', by: 'owner' });
  assert.deepEqual([b.removedAt, b.removedBy], [null, null]);
  assert.ok(existsSync(store.path(b)));
});

test('a refused upload leaves no row and no file', (t) => {
  const { dir, db, store } = setup(t);
  assert.throws(() => store.add(fx.svg(), { alt: 'x', by: 'owner' }), ImageError);
  assert.equal((db.prepare('SELECT count(*) c FROM images').get() as { c: number }).c, 0);
  assert.ok(!existsSync(join(dir, 'images')) || readdirSync(join(dir, 'images')).every((d) => d === 'tmp'));
});

test('a failed write leaves no file in images/tmp and no row', async (t) => {
  const { dir, db, store } = setup(t);
  const input = await fx.pngWithText();
  const id = createHash('sha256').update(cleanImage(input).bytes).digest('hex').slice(0, 24);
  const sub = join(dir, 'images', id.slice(0, 2));
  mkdirSync(sub, { recursive: true });
  chmodSync(sub, 0o500);
  try {
    assert.throws(() => store.add(input, { alt: 'x', by: 'owner' }));
  } finally {
    chmodSync(sub, 0o700);
  }
  assert.deepEqual(readdirSync(join(dir, 'images', 'tmp')), []);
  assert.equal((db.prepare('SELECT count(*) c FROM images').get() as { c: number }).c, 0);
});

test('syncing the folder is best effort: Windows refusing to fsync a folder never fails an upload', () => {
  const calls: string[] = [];
  const refuse = (code: string) => () => { calls.push(code); throw Object.assign(new Error(code), { code }); };
  for (const code of ['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES']) {
    assert.doesNotThrow(() => syncFolder('/x', { openSync: () => 3, fsyncSync: refuse(code), closeSync: () => {} }), code);
  }
  assert.doesNotThrow(() => syncFolder('/x', { openSync: refuse('EPERM'), fsyncSync: () => {}, closeSync: () => {} }));
  assert.equal(calls.length, 6);
});

test('Delete for good that cannot remove the file leaves the picture live, so pressing it again can finish the job', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores folder permissions');
  const { store } = setup(t);
  const img = store.add(await fx.pngWithText(), { alt: 'Secret', by: 'owner' });
  const folder = dirname(store.path(img));
  chmodSync(folder, 0o500);
  t.after(() => { if (existsSync(folder)) chmodSync(folder, 0o700); });
  assert.throws(() => store.deleteForGood(img.id, 'owner'));
  assert.equal(store.get(img.id)!.removedAt, null, 'not marked removed while its file is still there');
  chmodSync(folder, 0o700);
  assert.equal(store.deleteForGood(img.id, 'owner'), 'deleted');
  assert.equal(existsSync(store.path(img)), false);
});
