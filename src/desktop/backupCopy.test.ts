import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCopy, brainFolderName } from './backupCopy.js';
import { brainId, type DB } from '../db.js';

test('the second backup folder is kept in backup-copy.json and read back by a new BackupCopy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bcopy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(new BackupCopy(dir).folder(), null);
  new BackupCopy(dir).set('/tmp/x');
  assert.ok(existsSync(join(dir, 'backup-copy.json')));
  assert.equal(new BackupCopy(dir).folder(), '/tmp/x');
  assert.equal(new BackupCopy(dir).lastResult(), null);
  new BackupCopy(dir).set(null);
  assert.equal(new BackupCopy(dir).folder(), null);
});

import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renameSync } from 'node:fs';
import { openSync, chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';

/** A BackupCopy whose run() defaults to the brain it was made with (the app always passes it). */
class TestCopy extends BackupCopy {
  constructor(dir: string, readonly db: DB, remove?: (path: string, opts: { force: boolean }) => void, open?: (path: string, flags: number) => number, after?: () => void) { super(dir, remove, open, after); }
  override run(file: string, keep: number, now: Date, ctx: { db: DB; dataDir?: string } = { db: this.db }): void { super.run(file, keep, now, ctx); }
}

function setup(t: import('node:test').TestContext, given?: DB) {
  const root = mkdtempSync(join(tmpdir(), 'bcopy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const second = join(root, 'second');
  mkdirSync(data);
  mkdirSync(second);
  const db = given ?? openDb(':memory:');
  // The chosen folder is shared; this brain's copies live in `own` inside it.
  const own = join(second, brainFolderName(brainId(db)));
  mkdirSync(own, { mode: 0o700 });
  const finished = join(root, 'memory-2026-10-20.db');
  writeFileSync(finished, 'brain');
  const copy = new TestCopy(data, db);
  copy.set(second);
  return { root, data, second, own, db, finished, copy };
}
const NOW = new Date('2026-10-20T08:00:00Z');

test('a link planted at a temporary or final name is never followed', (t) => {
  const { root, own, finished, copy } = setup(t);
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(own, '.memory-2026-10-20.db.partial'));
  symlinkSync(victim, join(own, 'memory-2026-10-20.db'));
  copy.run(finished, 14, NOW);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  assert.equal(copy.lastResult()?.ok, true);
  assert.ok(lstatSync(join(own, 'memory-2026-10-20.db')).isFile());
});

test('planted later-dated names are never deleted or counted, and the owner\'s copies stay', (t) => {
  const { root, own, finished, copy } = setup(t);
  const run = (day: string) => { const f = join(root, `memory-${day}.db`); writeFileSync(f, day); copy.run(f, 2, NOW); };
  run('2026-10-01');
  run('2026-10-02');
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(own, 'memory-2099-01-01.db'));
  writeFileSync(join(own, 'memory-2099-01-02.db'), 'planted');
  run('2026-10-03');
  const left = readdirSync(own).sort();
  assert.deepEqual(left, ['memory-2026-10-02.db', 'memory-2026-10-03.db', 'memory-2099-01-01.db', 'memory-2099-01-02.db']);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  void finished;
});

test('copies already in this brain\'s own folder are adopted and made owner-only once', (t) => {
  const { own, finished, copy } = setup(t);
  for (const day of ['2026-10-01', '2026-10-02']) { const f = join(own, `memory-${day}.db`); writeFileSync(f, 'old'); chmodSync(f, 0o644); }
  writeFileSync(join(own, 'notes.txt'), 'mine');
  chmodSync(join(own, 'notes.txt'), 0o644);
  copy.run(finished, 2, NOW);
  assert.deepEqual(readdirSync(own).sort(), ['memory-2026-10-02.db', 'memory-2026-10-20.db', 'notes.txt']);
  if (process.platform !== 'win32') {
    for (const n of ['memory-2026-10-02.db', 'memory-2026-10-20.db']) assert.equal(lstatSync(join(own, n)).mode & 0o077, 0, n);
    assert.equal(lstatSync(join(own, 'notes.txt')).mode & 0o777, 0o644, 'other files are left alone');
  }
});

test('flat copies an earlier version left in the shared folder, and another brain\'s folder, are never adopted, pruned or narrowed', (t) => {
  const { second, own, finished, copy } = setup(t);
  for (const n of ['memory-2026-10-01.db', 'memory-2026-10-02.db']) { writeFileSync(join(second, n), 'old flat'); chmodSync(join(second, n), 0o644); }
  const other = join(second, 'brainai-0123abcd');
  mkdirSync(other);
  for (const n of ['memory-2026-10-01.db', 'memory-2026-10-02.db', 'memory-2026-10-03.db']) writeFileSync(join(other, n), 'theirs');
  copy.run(finished, 1, NOW);
  copy.run(finished, 1, NOW);
  assert.deepEqual(readdirSync(own), ['memory-2026-10-20.db']);
  assert.deepEqual(readdirSync(second).sort(), ['brainai-0123abcd', basename(own), 'memory-2026-10-01.db', 'memory-2026-10-02.db']);
  assert.equal(readdirSync(other).length, 3);
  if (process.platform !== 'win32') assert.equal(lstatSync(join(second, 'memory-2026-10-01.db')).mode & 0o777, 0o644);
});

test('two brains sharing one folder keep separate same-dated copies and each prunes only its own', (t) => {
  const a = setup(t);
  const bDb = openDb(':memory:');
  const bCopy = new TestCopy(join(a.root, 'data-b'), bDb);
  mkdirSync(join(a.root, 'data-b'));
  bCopy.set(a.second);
  const fileA = join(a.root, 'memory-2026-10-20.db');
  const fileB = join(a.root, 'b-memory-2026-10-20.db');
  writeFileSync(fileA, 'brain A');
  writeFileSync(fileB, 'brain B');
  mkdirSync(join(a.root, 'bsrc'));
  const asB = join(a.root, 'bsrc', 'memory-2026-10-20.db');
  writeFileSync(asB, 'brain B');
  a.copy.run(fileA, 1, NOW);
  bCopy.run(asB, 1, NOW);
  const ownB = join(a.second, brainFolderName(brainId(bDb)));
  assert.notEqual(ownB, a.own);
  assert.equal(readFileSync(join(a.own, 'memory-2026-10-20.db'), 'utf8'), 'brain A');
  assert.equal(readFileSync(join(ownB, 'memory-2026-10-20.db'), 'utf8'), 'brain B');
  // A later day on A prunes A's older copy (keep 1) and leaves B's alone.
  const next = join(a.root, 'x'); mkdirSync(next);
  const fileA2 = join(next, 'memory-2026-10-21.db');
  writeFileSync(fileA2, 'brain A day 2');
  a.copy.run(fileA2, 1, new Date('2026-10-21T08:00:00Z'));
  assert.deepEqual(readdirSync(a.own), ['memory-2026-10-21.db']);
  assert.deepEqual(readdirSync(ownB), ['memory-2026-10-20.db']);
  void fileB;
});

test('a brain id that is not 32 hex digits is replaced by a fresh one, and the folder name only ever takes hex', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO brain_switches(name, value, set_at) VALUES ('brain_id', '../../..', 'x')").run();
  const id = brainId(db);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(brainId(db), id, 'the fresh id is kept');
  assert.throws(() => brainFolderName('../../..'), /brain id/);
  assert.throws(() => brainFolderName('abcd'), /brain id/);
  assert.equal(brainFolderName(id), `brainai-${id.slice(0, 8)}`);
});

test('a crafted brain id cannot make a run write or delete outside the chosen folder', (t) => {
  const { root, second, finished, db } = setup(t);
  db.prepare("UPDATE brain_switches SET value = '../../../victim' WHERE name = 'brain_id'").run();
  const victim = join(root, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'memory-2026-01-01.db'), 'precious');
  const copy = new TestCopy(join(root, 'data'), db);
  copy.run(finished, 1, NOW);
  assert.equal(readFileSync(join(victim, 'memory-2026-01-01.db'), 'utf8'), 'precious');
  assert.deepEqual(readdirSync(victim), ['memory-2026-01-01.db']);
  assert.equal(readdirSync(second).filter((n) => /^brainai-[0-9a-f]{8}$/.test(n)).length, 2, 'a new brain folder beside the old empty one');
});

test('upgrade: an old flat written list with no brain never deletes the flat files, and the new copy lands in the brain\'s own folder', (t) => {
  const { data, second, own, finished, copy } = setup(t);
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) writeFileSync(join(second, `memory-${d}.db`), 'flat');
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, written: ['memory-2026-10-01.db', 'memory-2026-10-02.db', 'memory-2026-10-03.db'] })}\n`);
  copy.run(finished, 1, NOW);
  assert.equal(copy.lastResult()?.ok, true);
  assert.deepEqual(readdirSync(second).filter((n) => n.startsWith('memory-')).sort(), ['memory-2026-10-01.db', 'memory-2026-10-02.db', 'memory-2026-10-03.db']);
  assert.deepEqual(readdirSync(own), ['memory-2026-10-20.db']);
});

test('upgrade: an images folder in the chosen folder is never moved, even one that is the owner\'s own; pictures are simply copied into the brain\'s folder', (t) => {
  const s = withPictures(t, [{ id: 'bb0002' }], ['bb0002']);
  // The owner's own unrelated folder, and an old picture folder of the earlier version, both named images.
  mkdirSync(join(s.second, 'images', 'holiday'), { recursive: true });
  writeFileSync(join(s.second, 'images', 'holiday', 'beach.jpg'), 'mine');
  writeFileSync(join(s.data, 'backup-copy.json'), `${JSON.stringify({ folder: s.second, last: null, written: ['memory-2026-10-01.db'] })}\n`);
  s.copy.run(s.finished, 14, NOW, s.pictures);
  assert.equal(s.copy.lastResult()?.ok, true);
  assert.equal(readFileSync(join(s.second, 'images', 'holiday', 'beach.jpg'), 'utf8'), 'mine', 'left exactly where it was');
  assert.deepEqual(readdirSync(join(s.second, 'images')), ['holiday']);
  assert.equal(readFileSync(join(s.own, 'images', 'bb', 'bb0002.png'), 'utf8'), 'pic-bb0002', 'copied into the brain\'s own folder');
});

test('a chosen folder that goes away while the brain folder is made is the folder\'s problem, not a blocked brain folder', (t) => {
  const { second, data, db, finished } = setup(t);
  let gone = false;
  const racing = new Proxy(db, { get(target, key) {
    // brainId() runs after the folder was found and before the brain's folder is looked at.
    if (key === 'prepare' && !gone) { gone = true; rmSync(second, { recursive: true, force: true }); }
    const v = Reflect.get(target, key);
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  new BackupCopy(data).run(finished, 5, NOW, { db: racing });
  const r = new BackupCopy(data).lastResult();
  assert.ok(r && !r.ok && r.why === 'folder');
});

test('a link at the brain folder name fails with its own reason, brainFolder, not "the folder is missing"', { skip: process.platform === 'win32' }, (t) => {
  const { root, own, finished, copy } = setup(t);
  rmSync(own, { recursive: true });
  symlinkSync(root, own);
  copy.run(finished, 5, NOW);
  const r = copy.lastResult();
  assert.ok(r && !r.ok && r.why === 'brainFolder');
});

test('a brain folder swapped for another between the checks stops the run before anything is deleted', { skip: process.platform === 'win32' }, (t) => {
  const { root, own, finished, db } = setup(t);
  writeFileSync(join(own, 'memory-2026-10-01.db'), 'old');
  writeFileSync(join(own, 'memory-2026-10-02.db'), 'old');
  // The copy is made; the folder is then swapped for a new one (the same names inside) while it is being worked on.
  const swapped = join(root, 'swapped');
  mkdirSync(swapped);
  writeFileSync(join(swapped, 'memory-2026-10-01.db'), 'precious');
  const swap = () => { renameSync(own, join(root, 'moved')); renameSync(swapped, own); };
  const copy = new TestCopy(join(root, 'data'), db, (p, o) => rmSync(p, o), (path, flags) => openSync(path, flags), swap);
  copy.set(dirname(own));
  copy.run(finished, 1, NOW);
  assert.equal(readFileSync(join(own, 'memory-2026-10-01.db'), 'utf8'), 'precious');
  assert.equal(copy.lastResult()?.ok, false);
});

test('a link or a foreign file at this brain\'s folder name is never followed or written through', { skip: process.platform === 'win32' }, (t) => {
  const { root, second, own, finished, copy } = setup(t);
  rmSync(own, { recursive: true });
  const victim = join(root, 'victim');
  mkdirSync(victim);
  symlinkSync(victim, own);
  copy.run(finished, 5, NOW);
  const r = copy.lastResult();
  assert.equal(r?.ok, false);
  assert.deepEqual(readdirSync(victim), [], 'nothing was written through the link');
  assert.ok(lstatSync(own).isSymbolicLink());
  void second;
});

test('the brain\'s folder inside the chosen one is made 0700 and an open one is narrowed; the copy is 0600', { skip: process.platform === 'win32' }, (t) => {
  const { second, own, finished, copy } = setup(t);
  rmSync(own, { recursive: true });
  const before = process.umask(0o000);
  try { copy.run(finished, 5, NOW); } finally { process.umask(before); }
  assert.equal(lstatSync(own).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(own, 'memory-2026-10-20.db')).mode & 0o777, 0o600);
  chmodSync(own, 0o755);
  copy.run(finished, 5, NOW);
  assert.equal(lstatSync(own).mode & 0o777, 0o700);
  void second;
});

test('a name in the written list that has since become a link or folder is dropped, never deleted through', (t) => {
  const { root, data, second, own, db, copy } = setup(t);
  const victim = join(root, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'keep.txt'), 'precious');
  symlinkSync(victim, join(own, 'memory-2026-10-01.db'));
  mkdirSync(join(own, 'memory-2026-10-02.db'));
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, brain: brainId(db), written: ['memory-2026-10-01.db', 'memory-2026-10-02.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new');
  copy.run(f, 1, NOW);
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'precious');
  assert.ok(lstatSync(join(own, 'memory-2026-10-01.db')).isSymbolicLink());
  assert.ok(lstatSync(join(own, 'memory-2026-10-02.db')).isDirectory());
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')).written, ['memory-2026-10-20.db']);
});

test('a named pipe at a kept name does not stop a run from returning', { skip: process.platform === 'win32' }, (t) => {
  const { root, data, second, own, db } = setup(t);
  execFileSync('mkfifo', [join(own, 'memory-2026-10-01.db')]);
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, brain: brainId(db), written: ['memory-2026-10-01.db'] })}\n`);
  const script = join(root, 'run.ts');
  writeFileSync(script, `import { BackupCopy } from ${JSON.stringify(join(process.cwd(), 'src/desktop/backupCopy.ts'))};
import { openDb } from ${JSON.stringify(join(process.cwd(), 'src/db.ts'))};
const db = openDb(':memory:');
db.prepare("INSERT OR REPLACE INTO brain_switches(name, value, set_at) VALUES ('brain_id', ?, 'x')").run(${JSON.stringify(brainId(db))});
new BackupCopy(${JSON.stringify(data)}).run(${JSON.stringify(join(root, 'memory-2026-10-20.db'))}, 5, new Date('2026-10-20T08:00:00Z'), { db });`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { timeout: 8000, cwd: process.cwd() });
  assert.equal(r.error, undefined, 'run() returned in time');
  assert.equal(r.status, 0);
});

test('names dated after the copy are never adopted on the first run, so they cannot cause deletion', (t) => {
  const { own, finished, copy } = setup(t);
  for (const n of ['memory-2099-01-01.db', 'memory-2099-01-02.db']) writeFileSync(join(own, n), 'planted');
  copy.run(finished, 2, NOW);
  copy.run(finished, 2, NOW);
  assert.equal(copy.lastResult()?.ok, true);
  assert.ok(existsSync(join(own, 'memory-2026-10-20.db')), 'the new copy stays');
  assert.equal(readdirSync(own).length, 3);
});

test('a hard-linked file at an old name is not adopted or narrowed', { skip: process.platform === 'win32' }, (t) => {
  const { root, own, finished, copy } = setup(t);
  const other = join(root, 'elsewhere.txt');
  writeFileSync(other, 'x');
  chmodSync(other, 0o644);
  linkSync(other, join(own, 'memory-2026-10-01.db'));
  copy.run(finished, 1, NOW);
  assert.ok(existsSync(join(own, 'memory-2026-10-01.db')), 'not adopted, so not pruned');
  assert.equal(lstatSync(other).mode & 0o777, 0o644, 'not narrowed');
});

test('a copy that cannot be deleted stays on the written list and the run is not ok', (t) => {
  const { root, data, second, own, db } = setup(t);
  const stuck = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  const copy = new TestCopy(data, db, (p, o) => (p.includes('memory-2026-10-01.db') ? stuck() : rmSync(p, o)));
  writeFileSync(join(own, 'memory-2026-10-01.db'), 'old');
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, brain: brainId(db), written: ['memory-2026-10-01.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new');
  copy.run(f, 1, NOW);
  const r = copy.lastResult();
  assert.equal(r?.ok, false);
  assert.match(r && !r.ok ? r.reason : '', /could not remove/i);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')).written, ['memory-2026-10-01.db', 'memory-2026-10-20.db']);
});

test('a copy already readable by its owner only is not opened again, and one with group or other bits is narrowed', (t) => {
  const { root, data, second, own, db } = setup(t);
  const opened: string[] = [];
  const copy = new TestCopy(data, db, rmSync, (path, flags) => { opened.push(path); return openSync(path, flags); });
  const done = join(own, 'memory-2026-10-01.db');
  const open = join(own, 'memory-2026-10-02.db');
  writeFileSync(done, 'a'); chmodSync(done, 0o600);
  writeFileSync(open, 'b'); chmodSync(open, 0o644);
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, brain: brainId(db), written: ['memory-2026-10-01.db', 'memory-2026-10-02.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new'); chmodSync(f, 0o600);
  copy.run(f, 5, NOW);
  assert.equal(copy.lastResult()?.ok, true);
  assert.deepEqual(opened, [open], 'only the copy with wider permissions was opened');
  assert.equal(lstatSync(open).mode & 0o777, 0o600);
  assert.equal(lstatSync(done).mode & 0o777, 0o600);
});

import { copyState, COPY_MAX_DAYS } from './backupCopy.js';
import { openDb } from '../db.js';
import { backupHealth } from '../backupStatus.js';

/** A data folder with a database whose images table lists `rows`, and a picture file for each id in `files`. */
function withPictures(t: import('node:test').TestContext, rows: { id: string; removedAt?: string }[], files: string[]) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'bcopy-db-')), 'memory.db'));
  t.after(() => { db.close(); rmSync(dirname(db.name), { recursive: true, force: true }); });
  const s = setup(t, db);
  for (const r of rows) {
    db.prepare(`INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at, removed_by) VALUES (?, 'png', 1, 1, 1, '2026-01-01', 'owner', ?, ?)`)
      .run(r.id, r.removedAt ?? null, r.removedAt ? 'owner' : null);
  }
  for (const id of files) {
    mkdirSync(join(s.data, 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(s.data, 'images', id.slice(0, 2), `${id}.png`), `pic-${id}`);
  }
  return { ...s, db, pictures: { db, dataDir: s.data } };
}

test('pictures are copied into images/<2 hex>/ and only the missing ones the next time', (t) => {
  const s = withPictures(t, [{ id: 'aa0001' }, { id: 'bb0002' }], ['aa0001']);
  s.copy.run(s.finished, 14, NOW, s.pictures);
  assert.equal(s.copy.lastResult()?.ok, true);
  assert.equal(readFileSync(join(s.own, 'images', 'aa', 'aa0001.png'), 'utf8'), 'pic-aa0001');
  assert.equal(readdirSync(join(s.own, 'images', 'aa')).length, 1, 'no .partial left');
  // Changing the copy shows an existing file is not copied again; a new one is.
  writeFileSync(join(s.own, 'images', 'aa', 'aa0001.png'), 'kept');
  mkdirSync(join(s.data, 'images', 'bb'), { recursive: true });
  writeFileSync(join(s.data, 'images', 'bb', 'bb0002.png'), 'pic-bb0002');
  s.copy.run(s.finished, 14, NOW, s.pictures);
  assert.equal(readFileSync(join(s.own, 'images', 'aa', 'aa0001.png'), 'utf8'), 'kept');
  assert.equal(readFileSync(join(s.own, 'images', 'bb', 'bb0002.png'), 'utf8'), 'pic-bb0002');
  assert.equal(lstatSync(join(s.own, 'images', 'bb', 'bb0002.png')).mode & 0o077, 0, 'owner only');
});

test('pictures deleted for good over 30 days ago leave the copy; newer ones stay', (t) => {
  const old = new Date(NOW.getTime() - 31 * 86400_000).toISOString();
  const recent = new Date(NOW.getTime() - 5 * 86400_000).toISOString();
  const s = withPictures(t, [{ id: 'aa0001', removedAt: old }, { id: 'cc0003', removedAt: recent }], []);
  for (const id of ['aa0001', 'cc0003']) {
    mkdirSync(join(s.own, 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(s.own, 'images', id.slice(0, 2), `${id}.png`), 'x');
  }
  mkdirSync(join(s.data, 'images'));
  s.copy.run(s.finished, 14, NOW, s.pictures);
  assert.equal(existsSync(join(s.own, 'images', 'aa', 'aa0001.png')), false);
  assert.equal(existsSync(join(s.own, 'images', 'cc', 'cc0003.png')), true);
});

test('a picture failure is a failed result with a reason, and the database copy is whole', (t) => {
  const s = withPictures(t, [{ id: 'aa0001' }], ['aa0001']);
  const outside = join(s.root, 'elsewhere');
  mkdirSync(outside);
  symlinkSync(outside, join(s.own, 'images'));
  s.copy.run(s.finished, 14, NOW, s.pictures);
  const r = s.copy.lastResult();
  assert.equal(r?.ok, false);
  assert.match(r && !r.ok ? r.reason : '', /Pictures could not be copied/);
  assert.equal(r && !r.ok ? r.why : '', 'pictures');
  assert.equal(readFileSync(join(s.own, 'memory-2026-10-20.db'), 'utf8'), 'brain');
  assert.deepEqual(readdirSync(outside), [], 'a linked images folder is never written through');
  assert.deepEqual(readdirSync(s.own).filter((f) => f.endsWith('.partial')), []);
});

test('copyState and the first-steps / health rules around it', () => {
  const day = 86400_000;
  const ok = (ago: number) => ({ ok: true as const, at: new Date(NOW.getTime() - ago).toISOString() });
  assert.equal(copyState(null, null, NOW).kind, 'off');
  assert.equal(copyState('/x', null, NOW).kind, 'first');
  assert.equal(copyState('/x', ok(day), NOW).kind, 'ok');
  assert.equal(copyState('/x', ok((COPY_MAX_DAYS + 1) * day), NOW).kind, 'old');
  assert.deepEqual(copyState('/x', { ok: false, at: NOW.toISOString(), folder: '/x', reason: 'Disk full', why: 'write' }, NOW), { kind: 'failed', reason: 'Disk full', why: 'write', at: NOW.toISOString() });
  const nightly = { at: NOW.toISOString(), ok: true };
  assert.equal(backupHealth({ nightly }, NOW, { offsite: false, copy: copyState('/x', ok(day), NOW) }).ok, true);
  assert.equal(backupHealth({ nightly }, NOW, { offsite: false, copy: copyState('/x', null, NOW) }).ok, true);
  const bad = backupHealth({ nightly }, NOW, { offsite: false, copy: copyState('/x', { ok: false, at: NOW.toISOString(), folder: '/x', reason: 'Disk full', why: 'write' }, NOW) });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0]!, /second folder failed: The copy could not be written\.$/);
  assert.deepEqual(bad.say[0], { key: 'backup.p.copyFailed', params: { reason: 'write' } }, 'the screen gets the code, not the message');
  const old = backupHealth({ nightly }, NOW, { offsite: false, copy: copyState('/x', ok(9 * day), NOW) });
  assert.match(old.problems[0]!, /more than 8 days/);
});

test('a failure records its code, and the first success is kept through later failures', (t) => {
  const s = withPictures(t, [], []);
  assert.equal(s.copy.everCopied(), false);
  s.copy.run(s.finished, 14, NOW);
  assert.equal(s.copy.everCopied(), true);
  rmSync(s.second, { recursive: true });
  s.copy.run(s.finished, 14, NOW);
  const r = s.copy.lastResult();
  assert.ok(r && !r.ok && r.why === 'folder');
  assert.equal(s.copy.everCopied(), true, 'a later failure does not undo it');
  s.copy.set(s.second);
  assert.equal(s.copy.everCopied(), true, 'the same folder keeps it');
  s.copy.set(join(s.root, 'other'));
  assert.equal(s.copy.everCopied(), false, 'a new folder starts again');
});

test('turning the second folder off while a copy runs is not undone by the copy finishing', (t) => {
  const { own, data, root, db, copy } = setup(t);
  writeFileSync(join(own, 'memory-2026-10-19.db'), 'old');
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new');
  // The owner switches the folder off at the moment the copy removes the oldest file.
  const racing = new TestCopy(data, db, (path, opts) => { copy.set(null); rmSync(path, opts); });
  racing.run(f, 1, NOW);
  assert.equal(copy.folder(), null, 'still off');
  assert.equal(existsSync(join(data, 'backup-copy.json')), false);
});

test('a copy sweeps half-made files from this brain\'s own folder only; links, hard-linked files, strangers\' names, flat files and other brains\' folders are left', (t) => {
  const { second, own, root, finished, copy } = setup(t);
  const other = join(second, 'brainai-ffffffff');
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(own, '.memory-2026-10-19.db.0123456789abcdef.partial'), 'half');
  writeFileSync(join(own, '.memory-2026-10-19.db.partial'), 'half');
  writeFileSync(join(own, '.memory-notes.partial'), 'mine');
  writeFileSync(join(other, '.memory-2026-10-19.db.0123456789abcdef.partial'), "another brain's");
  writeFileSync(join(second, '.memory-2026-10-19.db.0123456789abcdef.partial'), 'flat, an earlier version');
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(own, '.memory-2026-10-18.db.0123456789abcdef.partial'));
  linkSync(victim, join(own, '.memory-2026-10-17.db.0123456789abcdef.partial'));
  copy.run(finished, 14, NOW);
  assert.deepEqual(readdirSync(own).filter((n) => n.endsWith('.partial')).sort(), ['.memory-2026-10-17.db.0123456789abcdef.partial', '.memory-2026-10-18.db.0123456789abcdef.partial', '.memory-notes.partial']);
  assert.equal(readdirSync(other).length, 1);
  assert.ok(existsSync(join(second, '.memory-2026-10-19.db.0123456789abcdef.partial')));
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
});

test('a copy that was renamed into place but never recorded (the process died) is pruned by a later run', (t) => {
  const { own, data, root, db, copy } = setup(t);
  const day = (d: string) => { const f = join(root, `memory-2026-10-${d}.db`); writeFileSync(f, d); return f; };
  copy.run(day('19'), 2, new Date('2026-10-19T08:00:00Z'));
  // The next run listed its own name first (plan), made the copy and died before recording the result.
  writeFileSync(join(own, 'memory-2026-10-20.db'), 'orphan');
  const saved = JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')) as { written: string[] };
  writeFileSync(join(data, 'backup-copy.json'), JSON.stringify({ ...saved, written: [...saved.written, 'memory-2026-10-20.db'] }));
  copy.run(day('21'), 2, new Date('2026-10-21T08:00:00Z'));
  copy.run(day('22'), 2, new Date('2026-10-22T08:00:00Z'));
  assert.deepEqual(readdirSync(own).filter((n) => NAME_RE.test(n)).sort(), ['memory-2026-10-21.db', 'memory-2026-10-22.db']);
  assert.ok(db);
});
const NAME_RE = /^memory-\d{4}-\d{2}-\d{2}\.db$/;

test('a copy puts its own name in the list before it makes the file; a run that fails before the file is made takes it out again', (t) => {
  const { data, root, copy } = setup(t);
  const f = (d: string) => { const p = join(root, `memory-2026-10-${d}.db`); writeFileSync(p, d); return p; };
  copy.run(f('19'), 5, new Date('2026-10-19T08:00:00Z'));
  // The source is gone when the copy is made: the run fails, and no ghost name stays behind.
  copy.run(join(root, 'memory-2026-10-21.db'), 5, new Date('2026-10-21T08:00:00Z'));
  assert.equal(copy.lastResult()?.ok, false);
  const saved = JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')) as { written: string[] };
  assert.deepEqual(saved.written, ['memory-2026-10-19.db']);
});

test('the second folder away for days and back: the real copies are kept, ghost names never push them out', (t) => {
  const { second, own, data, root, db, copy } = setup(t);
  const f = (d: number) => { const p = join(root, `memory-2026-10-${String(d).padStart(2, '0')}.db`); writeFileSync(p, String(d)); return p; };
  const at = (d: number) => new Date(`2026-10-${String(d).padStart(2, '0')}T08:00:00Z`);
  for (let d = 1; d <= 3; d++) copy.run(f(d), 3, at(d));
  renameSync(second, `${second}-away`);
  for (let d = 4; d <= 9; d++) { copy.run(f(d), 3, at(d)); assert.equal(copy.lastResult()?.ok, false); }
  renameSync(`${second}-away`, second);
  copy.run(f(10), 3, at(10));
  assert.deepEqual(readdirSync(own).filter((n) => NAME_RE.test(n)).sort(), ['memory-2026-10-02.db', 'memory-2026-10-03.db', 'memory-2026-10-10.db'], 'three real copies');
  // A crash that left ghost names in the list (written by hand here) is cleaned by the next copy too.
  const saved = JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')) as { written: string[] };
  writeFileSync(join(data, 'backup-copy.json'), JSON.stringify({ ...saved, written: [...saved.written, 'memory-2026-10-11.db', 'memory-2026-10-12.db'] }));
  copy.run(f(13), 3, at(13));
  assert.deepEqual(readdirSync(own).filter((n) => NAME_RE.test(n)).sort(), ['memory-2026-10-03.db', 'memory-2026-10-10.db', 'memory-2026-10-13.db']);
  assert.ok(db);
});

test('a worker that crashes, and one that never returns, are recorded as failures; a stuck one is stopped at the time limit', async (t) => {
  const { data, root, db, finished } = setup(t);
  const dir = mkdtempSync(join(tmpdir(), 'bcopy-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const second = join(root, 'second');
  const make = (body: string) => { const file = join(dir, `w${Math.random()}.mjs`); writeFileSync(file, `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ started: true });\n${body}\n`); return pathToFileURL(file); };
  const copy = new BackupCopy(data);
  copy.set(second);
  // An earlier success, which a crash must not leave standing.
  await copy.runOffThread(finished, 5, NOW, { db });
  assert.equal(copy.lastResult()?.ok, true);
  copy.workerUrl = make('setTimeout(() => process.exit(1), 20);');
  await copy.runOffThread(finished, 5, new Date('2026-10-21T08:00:00Z'), { db });
  assert.equal(copy.lastResult()?.ok, false);
  assert.equal((copy.lastResult() as { why: string }).why, 'other');
  copy.workerUrl = make('setInterval(() => {}, 1000);');
  copy.limitMs = 250;
  const began = Date.now();
  await copy.runOffThread(finished, 5, new Date('2026-10-22T08:00:00Z'), { db });
  assert.ok(Date.now() - began < 5000, 'stopped at the limit');
  assert.equal((copy.lastResult() as { why: string }).why, 'timeout');
  for (let i = 0; i < 100 && copy.isLingering(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(copy.isLingering(), false, 'the stopped thread has ended');
});

test('a run that fails after its file was renamed into place keeps that name listed', { skip: process.platform === 'win32' }, (t) => {
  const { root, own, data, db, finished } = setup(t);
  const first = new TestCopy(data, db);
  first.set(dirname(own));
  first.run(finished, 5, new Date('2026-10-19T08:00:00Z'));
  writeFileSync(join(own, 'memory-2026-10-18.db'), 'older');
  const day20 = join(root, 'memory-2026-10-21.db');
  writeFileSync(day20, 'new');
  // The folder is swapped when the oldest copy is pruned: the next check fails, after the new copy was made.
  const swap = () => { renameSync(own, join(root, 'moved')); mkdirSync(own); };
  const copy = new TestCopy(data, db, (p, o) => { swap(); rmSync(p, o); });
  copy.run(day20, 1, new Date('2026-10-21T08:00:00Z'));
  assert.equal(copy.lastResult()?.ok, false);
  const saved = JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')) as { written: string[] };
  assert.ok(saved.written.includes('memory-2026-10-21.db'), JSON.stringify(saved.written));
});
