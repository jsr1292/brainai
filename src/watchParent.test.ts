import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchParent } from './watchParent.js';

test('the desktop app keeps a pipe open to the server; when the app is gone the pipe closes and the server stops', async () => {
  const stdin = new PassThrough();
  let gone = 0;
  assert.equal(watchParent({ APP_PARENT: 'stdin' }, stdin, () => { gone++; }), true);
  stdin.write('anything the app sends is ignored\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(gone, 0);
  stdin.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(gone, 1);
});

test('without APP_PARENT=stdin nothing is watched (the home server, the work laptop, npm run dev)', () => {
  const stdin = new PassThrough();
  let gone = 0;
  assert.equal(watchParent({}, stdin, () => { gone++; }), false);
  stdin.end();
  assert.equal(gone, 0);
});

test('started by the app, the server stops as soon as the app is gone, even while it is still starting', { skip: !existsSync('models/Xenova') }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCAL_MODE: 'true', PUBLIC_URL: 'http://localhost:3197', PORT: '3197', DATA_DIR: dir, MODEL_DIR: 'models', OVERLAY_DIR: join(dir, 'o'), APP_PARENT: 'stdin' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  t.after(() => { child.kill('SIGKILL'); });
  // Gone at once, long before the search model has loaded.
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(-1), 15_000);
    child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.notEqual(code, -1, 'the server was still running 15 s after the app was gone');
  assert.doesNotMatch(out, /listening/, 'it stopped before loading the model and opening its port');
});
