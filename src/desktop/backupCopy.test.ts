import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCopy } from './backupCopy.js';

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

import { openSync, chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';

function setup(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bcopy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const second = join(root, 'second');
  mkdirSync(data);
  mkdirSync(second);
  const finished = join(root, 'memory-2026-10-20.db');
  writeFileSync(finished, 'brain');
  const copy = new BackupCopy(data);
  copy.set(second);
  return { root, data, second, finished, copy };
}
const NOW = new Date('2026-10-20T08:00:00Z');

test('a link planted at a temporary or final name is never followed', (t) => {
  const { root, second, finished, copy } = setup(t);
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(second, '.memory-2026-10-20.db.partial'));
  symlinkSync(victim, join(second, 'memory-2026-10-20.db'));
  copy.run(finished, 14, NOW);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  assert.equal(copy.lastResult()?.ok, true);
  assert.ok(lstatSync(join(second, 'memory-2026-10-20.db')).isFile());
});

test('planted later-dated names are never deleted or counted, and the owner\'s copies stay', (t) => {
  const { root, second, finished, copy } = setup(t);
  const run = (day: string) => { const f = join(root, `memory-${day}.db`); writeFileSync(f, day); copy.run(f, 2, NOW); };
  run('2026-10-01');
  run('2026-10-02');
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(second, 'memory-2099-01-01.db'));
  writeFileSync(join(second, 'memory-2099-01-02.db'), 'planted');
  run('2026-10-03');
  const left = readdirSync(second).sort();
  assert.deepEqual(left, ['memory-2026-10-02.db', 'memory-2026-10-03.db', 'memory-2099-01-01.db', 'memory-2099-01-02.db']);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  void finished;
});

test('copies left by the earlier version are adopted and made owner-only once', (t) => {
  const { second, finished, copy } = setup(t);
  for (const day of ['2026-10-01', '2026-10-02']) { const f = join(second, `memory-${day}.db`); writeFileSync(f, 'old'); chmodSync(f, 0o644); }
  writeFileSync(join(second, 'notes.txt'), 'mine');
  chmodSync(join(second, 'notes.txt'), 0o644);
  copy.run(finished, 2, NOW);
  assert.deepEqual(readdirSync(second).sort(), ['memory-2026-10-02.db', 'memory-2026-10-20.db', 'notes.txt']);
  if (process.platform !== 'win32') {
    for (const n of ['memory-2026-10-02.db', 'memory-2026-10-20.db']) assert.equal(lstatSync(join(second, n)).mode & 0o077, 0, n);
    assert.equal(lstatSync(join(second, 'notes.txt')).mode & 0o777, 0o644, 'other files are left alone');
  }
});

test('a name in the written list that has since become a link or folder is dropped, never deleted through', (t) => {
  const { root, data, second, copy } = setup(t);
  const victim = join(root, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'keep.txt'), 'precious');
  symlinkSync(victim, join(second, 'memory-2026-10-01.db'));
  mkdirSync(join(second, 'memory-2026-10-02.db'));
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, written: ['memory-2026-10-01.db', 'memory-2026-10-02.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new');
  copy.run(f, 1, NOW);
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'precious');
  assert.ok(lstatSync(join(second, 'memory-2026-10-01.db')).isSymbolicLink());
  assert.ok(lstatSync(join(second, 'memory-2026-10-02.db')).isDirectory());
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')).written, ['memory-2026-10-20.db']);
});

test('a named pipe at a kept name does not stop a run from returning', { skip: process.platform === 'win32' }, (t) => {
  const { root, data, second } = setup(t);
  execFileSync('mkfifo', [join(second, 'memory-2026-10-01.db')]);
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, written: ['memory-2026-10-01.db'] })}\n`);
  const script = join(root, 'run.ts');
  writeFileSync(script, `import { BackupCopy } from ${JSON.stringify(join(process.cwd(), 'src/desktop/backupCopy.ts'))};
new BackupCopy(${JSON.stringify(data)}).run(${JSON.stringify(join(root, 'memory-2026-10-20.db'))}, 5, new Date('2026-10-20T08:00:00Z'));`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { timeout: 8000, cwd: process.cwd() });
  assert.equal(r.error, undefined, 'run() returned in time');
  assert.equal(r.status, 0);
});

test('names dated after the copy are never adopted on the first run, so they cannot cause deletion', (t) => {
  const { second, finished, copy } = setup(t);
  for (const n of ['memory-2099-01-01.db', 'memory-2099-01-02.db']) writeFileSync(join(second, n), 'planted');
  copy.run(finished, 2, NOW);
  copy.run(finished, 2, NOW);
  assert.equal(copy.lastResult()?.ok, true);
  assert.ok(existsSync(join(second, 'memory-2026-10-20.db')), 'the new copy stays');
  assert.equal(readdirSync(second).length, 3);
});

test('a hard-linked file at an old name is not adopted or narrowed', { skip: process.platform === 'win32' }, (t) => {
  const { root, second, finished, copy } = setup(t);
  const other = join(root, 'elsewhere.txt');
  writeFileSync(other, 'x');
  chmodSync(other, 0o644);
  linkSync(other, join(second, 'memory-2026-10-01.db'));
  copy.run(finished, 1, NOW);
  assert.ok(existsSync(join(second, 'memory-2026-10-01.db')), 'not adopted, so not pruned');
  assert.equal(lstatSync(other).mode & 0o777, 0o644, 'not narrowed');
});

test('a copy that cannot be deleted stays on the written list and the run is not ok', (t) => {
  const { root, data, second } = setup(t);
  const stuck = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  const copy = new BackupCopy(data, (p, o) => (p.includes('memory-2026-10-01.db') ? stuck() : rmSync(p, o)));
  writeFileSync(join(second, 'memory-2026-10-01.db'), 'old');
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, written: ['memory-2026-10-01.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new');
  copy.run(f, 1, NOW);
  const r = copy.lastResult();
  assert.equal(r?.ok, false);
  assert.match(r && !r.ok ? r.reason : '', /could not remove/i);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'backup-copy.json'), 'utf8')).written, ['memory-2026-10-01.db', 'memory-2026-10-20.db']);
});

test('a copy already readable by its owner only is not opened again, and one with group or other bits is narrowed', (t) => {
  const { root, data, second } = setup(t);
  const opened: string[] = [];
  const copy = new BackupCopy(data, rmSync, (path, flags) => { opened.push(path); return openSync(path, flags); });
  const done = join(second, 'memory-2026-10-01.db');
  const open = join(second, 'memory-2026-10-02.db');
  writeFileSync(done, 'a'); chmodSync(done, 0o600);
  writeFileSync(open, 'b'); chmodSync(open, 0o644);
  writeFileSync(join(data, 'backup-copy.json'), `${JSON.stringify({ folder: second, last: null, written: ['memory-2026-10-01.db', 'memory-2026-10-02.db'] })}\n`);
  const f = join(root, 'memory-2026-10-20.db');
  writeFileSync(f, 'new'); chmodSync(f, 0o600);
  copy.run(f, 5, NOW);
  assert.equal(copy.lastResult()?.ok, true);
  assert.deepEqual(opened, [open], 'only the copy with wider permissions was opened');
  assert.equal(lstatSync(open).mode & 0o777, 0o600);
  assert.equal(lstatSync(done).mode & 0o777, 0o600);
});
