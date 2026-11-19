import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { appBundlePath, computeSpace, folderBytes, formatBytes, SpaceCache } from './diskSpace.js';
import { CATALOGUE, modelDirOf } from './models/catalogue.js';

const tmp = (t: { after: (f: () => void) => void }) => {
  const d = mkdtempSync(join(tmpdir(), 'brain-space-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const file = (path: string, n: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.alloc(n)); };

test('formatBytes uses 1000-based units like Finder', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(500), 'less than 1 KB');
  assert.equal(formatBytes(12_000), '12 KB');
  assert.equal(formatBytes(340_000_000), '340 MB');
  assert.equal(formatBytes(1_200_000_000), '1.2 GB');
  assert.equal(formatBytes(1_500_000), '1.5 MB');
  assert.equal(formatBytes(999_999_999), '1 GB');
  assert.equal(formatBytes(14_900_000_000), '15 GB');
});

test('folderBytes sums real file sizes, skips symlinks and unreadable folders', async (t) => {
  const d = tmp(t);
  file(join(d, 'a'), 100);
  file(join(d, 'sub', 'b'), 250);
  file(join(d, 'outside', 'big'), 5000);
  symlinkSync(join(d, 'outside'), join(d, 'link'));
  symlinkSync(join(d, 'a'), join(d, 'linkfile'));
  file(join(d, 'locked', 'c'), 700);
  chmodSync(join(d, 'locked'), 0o000);
  assert.equal(await folderBytes(join(d, 'a')), 100);
  const skipped = await folderBytes(d, new Set([join(d, 'outside')]));
  assert.equal(skipped, 350);
  assert.equal(await folderBytes(join(d, 'missing')), 0);
  const all = await folderBytes(d);
  chmodSync(join(d, 'locked'), 0o755);
  assert.ok(all === 5350 || all === 6050, String(all)); // root can still read the locked folder
});

test('appBundlePath finds the .app on macOS, the folder on Windows, nothing elsewhere', () => {
  assert.equal(appBundlePath('/Applications/BrainAI.app/Contents/MacOS/node', 'darwin'), '/Applications/BrainAI.app');
  assert.equal(appBundlePath('/usr/local/bin/node', 'darwin'), null);
  assert.equal(appBundlePath('C:\\Program Files\\BrainAI\\node.exe', 'win32'), 'C:\\Program Files\\BrainAI');
  assert.equal(appBundlePath('/usr/bin/node', 'linux'), null);
});

function tree(d: string) {
  file(join(d, 'Applications', 'BrainAI.app', 'Contents', 'MacOS', 'node'), 1000);
  file(join(d, 'Applications', 'BrainAI.app', 'Contents', 'Resources', 'x'), 500);
  const data = join(d, 'data');
  file(join(data, 'memory.db'), 400); file(join(data, 'memory.db-wal'), 40); file(join(data, 'memory.db-shm'), 4);
  file(join(data, 'images', 'ab', 'p.jpg'), 3000);
  file(join(data, 'backups', 'one.db'), 200);
  file(join(data, 'pre-migrate', 'm.db'), 100);
  file(join(data, 'logs', 'l.txt'), 20);
  file(join(data, 'status.json'), 2);
  file(join(data, 'copy', 'big'), 99999);
  const light = CATALOGUE.find((m) => m.id === 'e5')!;
  const rerank = CATALOGUE.find((m) => m.kind === 'rerank')!;
  file(join(modelDirOf(join(data, 'models'), light), 'model.onnx'), 8000);
  file(join(modelDirOf(join(data, 'models'), rerank), 'model.onnx'), 6000);
  file(join(data, 'models', 'stray.bin'), 70);
  return { data, execPath: join(d, 'Applications', 'BrainAI.app', 'Contents', 'MacOS', 'node') };
}

test('computeSpace adds the parts up to the total (macOS bundle)', async (t) => {
  const d = tmp(t);
  const { data, execPath } = tree(d);
  const s = await computeSpace({ dataDir: data, modelDir: join(data, 'models'), backupDir: join(data, 'backups'), copyFolder: join(data, 'copy'), execPath, platform: 'darwin' });
  assert.equal(s.app, 1500);
  assert.equal(s.memories, 3444);
  assert.equal(s.backups, 300);
  assert.equal(s.models.bytes, 14070);
  assert.deepEqual(s.models.parts.map((p) => [p.label, p.bytes]), [['Light search model', 8000], ['Standard reranker', 6000], ['Other model files', 70]]);
  assert.equal(s.other, 22);
  assert.equal(s.total, 1500 + 3444 + 300 + 14070 + 22);
});

test('computeSpace on Windows counts the install folder; with no app known it leaves it out', async (t) => {
  const d = tmp(t);
  const { data } = tree(d);
  file(join(d, 'install', 'BrainAI.exe'), 900); file(join(d, 'install', 'lib', 'x.dll'), 100);
  const win = await computeSpace({ dataDir: data, modelDir: join(data, 'models'), execPath: join(d, 'install', 'node.exe'), platform: 'win32' });
  assert.equal(win.app, 1000);
  const none = await computeSpace({ dataDir: data, modelDir: join(data, 'models'), execPath: '/usr/bin/node', platform: 'linux' });
  assert.equal(none.app, null);
  assert.equal(none.total, none.memories + none.backups + none.models.bytes + none.other);
});

test('computeSpace counts a backup folder outside the data folder', async (t) => {
  const d = tmp(t);
  const { data } = tree(d);
  file(join(d, 'elsewhere', 'b.db'), 600);
  const s = await computeSpace({ dataDir: data, modelDir: join(data, 'models'), backupDir: join(d, 'elsewhere'), execPath: '/usr/bin/node', platform: 'linux' });
  assert.equal(s.backups, 700);
});

test('SpaceCache keeps an answer, and get() gives up waiting on a slow walk', async () => {
  let n = 0; let t = 0;
  const value = { total: 1, app: null, models: { bytes: 0, parts: [] }, memories: 1, backups: 0, other: 0 };
  const cache = new SpaceCache(async () => { n++; await new Promise((r) => setTimeout(r, 30)); return value; }, () => t, 1000);
  assert.equal(await cache.get(1), null);
  assert.equal(await cache.get(500), value);
  assert.equal(await cache.get(1), value);
  assert.equal(n, 1);
  t = 2000;
  assert.equal(await cache.get(1), null);
  assert.equal(n, 2);
});

test('a walk never has more than its limit of lstat/readdir calls in flight, and finds the same total', async (t) => {
  const d = tmp(t);
  let expected = 0;
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) { file(join(d, `a${a}`, `b${b}`, `f${c}`), 10 + c); expected += 10 + c; }
  let now = 0; let max = 0;
  const watch = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    now++; max = Math.max(max, now);
    try { await new Promise((r) => setImmediate(r)); return await fn(...a); } finally { now--; }
  };
  const fs = { lstat: watch(lstat) as typeof lstat, readdir: watch((p: string) => readdir(p)) };
  assert.equal(await folderBytes(d, new Set(), { fs, limit: 4 }), expected);
  assert.ok(max <= 4 && max > 1, `max in flight ${max}`);
  assert.equal(await folderBytes(d), expected);
});

test('computeSpace in the app also counts the shell logs beside the data folder, only that folder', async (t) => {
  const d = tmp(t);
  const { data } = tree(d);
  file(join(d, 'logs', 'shell.log'), 300);
  file(join(d, 'other', 'x'), 5000);
  const base = { dataDir: data, modelDir: join(data, 'models'), execPath: '/usr/bin/node', platform: 'linux' as const };
  assert.equal((await computeSpace({ ...base, copyFolder: join(data, 'copy'), backupDir: join(data, 'backups') })).other, 22);
  const local = await computeSpace({ ...base, copyFolder: join(data, 'copy'), backupDir: join(data, 'backups'), localMode: true });
  assert.equal(local.other, 322);
  assert.equal(local.total, local.memories + local.backups + local.models.bytes + local.other);
  const noLogs = tmp(t);
  file(join(noLogs, 'data', 'memory.db'), 5);
  assert.equal((await computeSpace({ ...base, dataDir: join(noLogs, 'data'), modelDir: join(noLogs, 'data', 'models'), localMode: true })).other, 0);
});
