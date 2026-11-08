/** Move it to a server (D5): Settings › Move to a server. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from '../desktop/tools.js';
import { fakeHome } from '../testing/fakeTools.js';
import { toolEnv } from './desktopRoutes.js';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { moveFile } from '../desktop/move.js';
import { revealCommand } from './moveRoutes.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'https://brainai-mac.tail1234.ts.net';

async function desktop(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-move-web-'));
  const app = await startTestApp({ localMode: true, statusDir, ...opts });
  t.after(() => app.close());
  const shown: string[] = [];
  app.deps.reveal = (p) => { shown.push(p); };
  return { app, statusDir, shown, f: await loggedIn(app) };
}

/** A request through the public door, naming whatever Host it likes. */
function viaDoor(port: number, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: new URL(PUBLIC).host, Origin: PUBLIC, ...FORM } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('Move to a server makes the moving file, shows it in Finder and deletes it, on a desktop install only', async (t) => {
  const { app, statusDir, shown, f } = await desktop(t);
  assert.match(await (await f('/settings')).text(), /href="\/settings\/move"/);
  const page = await (await f('/settings/move')).text();
  assert.match(page, /action="\/settings\/move\/file"/);
  const made = await f('/settings/move/file', { method: 'POST', headers: FORM, body: '' });
  assert.equal(made.status, 303);
  const file = moveFile(statusDir);
  assert.ok(file && existsSync(file));
  const after = await (await f('/settings/move')).text();
  assert.match(after, /brainai-move-\d{4}-\d{2}-\d{2}\.tar\.gz/);
  assert.match(after, /holds every memory/);
  await f('/settings/move/show', { method: 'POST', headers: FORM, body: '' });
  assert.deepEqual(shown, [file]);
  await f('/settings/move/file/delete', { method: 'POST', headers: FORM, body: '' });
  assert.equal(moveFile(statusDir), null);
  // Other sites cannot make one.
  const foreign = await fetch(app.baseUrl + '/settings/move/file', { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: 'https://attacker.example' }, body: '' });
  assert.equal(foreign.status, 403);
});

test('the Move page does not exist on a server install', async (t) => {
  const app = await startTestApp({});
  t.after(() => app.close());
  const f = await loggedIn(app);
  assert.equal((await f('/settings/move')).status, 404);
  assert.equal((await f('/settings/move/file', { method: 'POST', headers: FORM, body: '' })).status, 404);
});

test('nothing about the move can be done through the public address', async (t) => {
  const { app, statusDir } = await desktop(t);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  assert.equal(await viaDoor(port, 'GET', '/settings/move'), 404);
  assert.equal(await viaDoor(port, 'POST', '/settings/move/file'), 404);
  assert.equal(await viaDoor(port, 'POST', '/settings/move/show'), 404);
  assert.equal(moveFile(statusDir), null);
});

test('the Reach page points to moving for those who need it always on', async (t) => {
  const { app, f } = await desktop(t);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  assert.match(await (await f('/settings/reach')).text(), /<a href="\/settings\/move">Move it to a server<\/a>/);
});

const listTools = (baseUrl: string, token: string) => fetch(baseUrl + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
const SERVER = 'https://brain.example.net';

test('after the move every assistant is told where the brain lives, and the dashboard says so', async (t) => {
  const { app, statusDir, f } = await desktop(t);
  const { accessToken } = await connectClient(app.baseUrl, f);
  assert.equal((await listTools(app.baseUrl, accessToken)).status, 200);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL('https://brainai-mac.tail1234.ts.net'), port);
  const done = await f('/settings/move/done', { method: 'POST', headers: FORM, body: new URLSearchParams({ address: `${SERVER}/settings` }).toString() });
  assert.equal(done.status, 303);
  const refused = await listTools(app.baseUrl, accessToken);
  assert.equal(refused.status, 410);
  assert.match((await refused.json() as { error: { message: string } }).error.message, new RegExp(SERVER.replace(/[.]/g, '\\.')));
  for (const path of ['/', '/settings', '/settings/move']) assert.match(await (await f(path)).text(), /This brain now lives at <a href="https:\/\/brain\.example\.net">https:\/\/brain\.example\.net<\/a>/, path);
  assert.equal(app.deps.reach!.saved(), null, 'Reach is turned off by the move');
  assert.equal(app.deps.door!.port(), null);
  assert.ok(existsSync(join(statusDir, 'moved.json')));
});

test('only an https address counts as a move', async (t) => {
  const { statusDir, f } = await desktop(t);
  for (const address of ['http://brain.example.net', 'javascript:alert(1)', '', 'brain.example.net', 'https://']) {
    await f('/settings/move/done', { method: 'POST', headers: FORM, body: new URLSearchParams({ address }).toString() });
    assert.ok(!existsSync(join(statusDir, 'moved.json')), address);
  }
});

test('Not moved after all brings it back', async (t) => {
  const { app, f } = await desktop(t);
  const { accessToken } = await connectClient(app.baseUrl, f);
  await f('/settings/move/done', { method: 'POST', headers: FORM, body: new URLSearchParams({ address: SERVER }).toString() });
  assert.equal((await listTools(app.baseUrl, accessToken)).status, 410);
  await f('/settings/move/undo', { method: 'POST', headers: FORM, body: '' });
  assert.equal((await listTools(app.baseUrl, accessToken)).status, 200);
  assert.doesNotMatch(await (await f('/')).text(), /This brain now lives at/);
});

test('Remove from this computer disconnects the tools connected to this BrainAI and says goodbye; the data stays', async (t) => {
  const home = fakeHome();
  t.after(() => home.cleanup());
  const { app, statusDir, f } = await desktop(t, { tools: { home: home.home, path: `${home.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: home.apps } });
  const env = toolEnv(app.deps)!;
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.equal((await connect('codex', env, {})).ok, true);
  const elsewhere = JSON.stringify({ mcp: { brainai: { type: 'remote', url: 'https://memory.example.com/mcp', enabled: true } } }, null, 2);
  home.write('.config/opencode/opencode.json', elsewhere);
  // Not moved: there is nothing to remove.
  assert.equal((await f('/settings/move/remove', { method: 'POST', headers: FORM, body: '' })).status, 404);
  assert.equal((await f('/app/goodbye')).status, 404);
  await f('/settings/move/done', { method: 'POST', headers: FORM, body: new URLSearchParams({ address: SERVER }).toString() });
  assert.match(await (await f('/settings/move')).text(), /action="\/settings\/move\/remove"/);
  const removed = await f('/settings/move/remove', { method: 'POST', headers: FORM, body: '' });
  assert.equal(removed.status, 303);
  assert.equal(removed.headers.get('location'), '/app/goodbye');
  assert.deepEqual(home.servers('claude'), {}, 'Claude Code no longer points at this Mac');
  assert.deepEqual(home.servers('codex'), {});
  assert.equal(home.read('.config/opencode/opencode.json'), elsewhere, 'a tool on another BrainAI is left alone');
  assert.equal((await f('/app/goodbye')).status, 200);
  assert.ok(existsSync(join(statusDir, 'moved.json')));
});

test('Show in Finder on the Mac, Show in Explorer on Windows', () => {
  assert.deepEqual(revealCommand('/Users/ana/x.tar.gz', 'darwin'), ['open', ['-R', '/Users/ana/x.tar.gz']]);
  assert.deepEqual(revealCommand('C:\\Users\\Ana\\x.tar.gz', 'win32'), ['explorer.exe', ['/select,C:\\Users\\Ana\\x.tar.gz']]);
});
