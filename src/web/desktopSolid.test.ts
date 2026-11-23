/** Settings › Tools: the same-computer guard, a temporary port, and the notice after an update. Temp homes only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { fakeHome } from '../testing/fakeTools.js';
import { appSession, startTestApp } from '../testing/helpers.js';
import { setupText } from '../setup/texts.js';
import { BRAIN_VERSION } from '../version.js';

const KEY = 'a-made-up-app-key-for-solid-0123456789';

async function start(t: TestContext, tools: Record<string, unknown> = {}, noPassword = true) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  // The port file sits beside the data folder: a folder of its own, never the shared temp folder.
  const root = mkdtempSync(join(tmpdir(), 'brainai-solid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusDir = join(root, 'data');
  mkdirSync(statusDir);
  const app = await startTestApp({ localMode: true, noPassword, statusDir, appSecret: KEY, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, system: {}, ...tools } as never });
  t.after(() => app.close());
  writeFileSync(join(statusDir, 'welcome-done'), '');
  const cookie = await appSession({ baseUrl: app.baseUrl, deps: { appSecret: KEY } });
  return { app, f, root, statusDir, cookie };
}
const get = (baseUrl: string, path: string, cookie: string, lang?: string) => fetch(baseUrl + path, { headers: { Cookie: cookie, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(lang ? { 'Accept-Language': lang } : {}) } }).then((r) => r.text());

test('connect, disconnect and reminders do not exist through the public door, and work on this computer', async (t) => {
  const { app, f, cookie } = await start(t, {}, false);
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const door = (path: string) => new Promise<number>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'POST', setHost: false, headers: { Host: host, Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end('');
  });
  for (const what of ['connect', 'disconnect', 'reminders']) assert.equal(await door(`/settings/tools/claude-code/${what}`), 404, what);
  assert.deepEqual(f.calls(), [], 'nothing was run');
  const local = await fetch(app.baseUrl + '/settings/tools/claude-code/connect', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(local.status, 303);
});

test('on a temporary port the entry at the usual port is ours, the page says so (EN and ES), and Connect waits', async (t) => {
  const { app, f, root, cookie } = await start(t);
  const running = Number(new URL(app.baseUrl).port);
  const host = new URL(app.baseUrl).hostname;
  const usual = `http://${host}:3100/mcp`;
  f.write('.fake-claude.json', JSON.stringify({ brainai: usual }));
  f.write('.claude/CLAUDE.md', `${setupText('claude-code', usual)}\n`);
  const calm = await get(app.baseUrl, '/settings/tools', cookie);
  assert.match(calm, /Uses another BrainAI/, 'without the file the entry at another port is another BrainAI');
  assert.doesNotMatch(calm, /temporary address/);
  writeFileSync(join(root, 'brainai.json'), JSON.stringify({ port: running, home: 3100, misses: 1 }));
  // The Tools look is kept for 30 s; a different grant list or a new app ends it, so look through a fresh page after the file.
  const body = await get(app.baseUrl, '/settings/tools', cookie);
  assert.match(body, /BrainAI is on a temporary address this time; your apps reconnect when it&#39;s back\./);
  assert.doesNotMatch(body, /Uses another BrainAI/, 'the entry at the usual port is ours');
  assert.doesNotMatch(body, /name="replace"/, 'so no Replace is offered');
  assert.match(await get(app.baseUrl, '/settings/tools', cookie, 'es'), /BrainAI está en una dirección temporal esta vez; tus apps se reconectan cuando vuelva\./);
  const connect = await fetch(app.baseUrl + '/settings/tools/codex/connect', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(connect.status, 303);
  assert.deepEqual(f.calls().filter((c) => c.includes(' add ')), [], 'no entry written with the temporary address');
});

test('after an update, a connected Claude desktop is told once to quit it completely and open it again (Windows only)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brainai-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claudeConfig = join(root, 'claude_desktop_config.json');
  writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { brainai: { command: 'node', args: ['cli.js', 'claude-bridge'] } } }));
  const win = await start(t, { platform: 'win32', claudeConfig });
  writeFileSync(join(win.statusDir, 'just-updated.json'), JSON.stringify({ version: BRAIN_VERSION, notes: '- x' }));
  const home = await get(win.app.baseUrl, '/', win.cookie);
  assert.match(home, /BrainAI was updated: quit Claude completely \(from the tray\) and open it again to reconnect\./);
  assert.match(await get(win.app.baseUrl, '/', win.cookie, 'es'), /BrainAI se ha actualizado: cierra Claude del todo/);
  const done = await fetch(win.app.baseUrl + '/app/update/dismiss', { method: 'POST', redirect: 'manual', headers: { Cookie: win.cookie, Origin: win.app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(done.status, 303);
  assert.doesNotMatch(await get(win.app.baseUrl, '/', win.cookie), /quit Claude completely/, 'gone once dismissed');
  // Not on the Mac, and not when Claude is not connected.
  const mac = await start(t, { claudeConfig });
  writeFileSync(join(mac.statusDir, 'just-updated.json'), JSON.stringify({ version: BRAIN_VERSION, notes: '- x' }));
  assert.doesNotMatch(await get(mac.app.baseUrl, '/', mac.cookie), /quit Claude completely/);
  const bare = await start(t, { platform: 'win32', claudeConfig: join(root, 'none.json') });
  writeFileSync(join(bare.statusDir, 'just-updated.json'), JSON.stringify({ version: BRAIN_VERSION, notes: '- x' }));
  const bareHome = await get(bare.app.baseUrl, '/', bare.cookie);
  assert.match(bareHome, /just-updated/);
  assert.doesNotMatch(bareHome, /quit Claude completely/);
});

test('Claude desktop\'s key made at the usual address still proves itself on a temporary port', async (t) => {
  const { app, root } = await start(t);
  const running = Number(new URL(app.baseUrl).port);
  const { MemoryOAuthProvider } = await import('../auth/provider.js');
  // A key issued when the app was on its usual port 3100: its token is bound to that address.
  const atHome = new MemoryOAuthProvider(app.deps.db!, app.deps.clients, app.deps.allowlist, app.deps.now, new URL(`http://localhost:3100/mcp`));
  const key = atHome.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const challenge = 'a'.repeat(64);
  const hello = () => fetch(`${app.baseUrl.replace('127.0.0.1', 'localhost')}/app/bridge-hello?grant=${key.grantId}&challenge=${challenge}`);
  assert.equal((await hello()).status, 410, 'on the running address alone it has no live key');
  writeFileSync(join(root, 'brainai.json'), JSON.stringify({ port: running, home: 3100 }));
  const r = await hello();
  assert.equal(r.status, 200);
  assert.match(((await r.json()) as { proof: string }).proof, /^[0-9a-f]{64}$/);
  // And the key itself is accepted at /mcp (initialize), as it is for a key made at the running address.
  const init = (token: string) => fetch(`${app.baseUrl.replace('127.0.0.1', 'localhost')}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  assert.equal((await init(key.token)).status, 200, 'a key for the usual address works on the temporary one');
  const other = new MemoryOAuthProvider(app.deps.db!, app.deps.clients, app.deps.allowlist, app.deps.now, new URL('http://localhost:3999/mcp')).issueLocalGrant({ name: 'x', clientName: 'x' });
  assert.equal((await init(other.token)).status, 401, 'a key for some other address does not');
});
