/**
 * The security review of 2026-11-23, findings 1, 2 (server side), 3, 4 and 5: the public door never serves the app's
 * endpoints however the path is written, sessions stay where they were made, web pages cannot use up the sign-in limits
 * on this computer, and a stranger cannot lock the owner out of the public address. Fake door and fake tunnel only.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession, connectClient, loggedIn, startTestApp, TEST_PASSWORD } from '../testing/helpers.js';
import { createApp } from '../web/app.js';
import { listRoutes } from './routes.js';

const KEY = 'a-made-up-app-key-for-door-0123456789ab';
const HOST = 'brainai-mac.tail1234.ts.net';
const CHALLENGE = 'a'.repeat(64);

interface Res { status: number; body: string; setCookie: string[]; headers: Record<string, string | string[] | undefined> }

async function start(t: TestContext, opts: { noPassword?: boolean; via?: 'tailscale' | 'cloudflare' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brainai-doorsec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusDir = join(root, 'data');
  mkdirSync(statusDir);
  writeFileSync(join(statusDir, 'welcome-done'), '');
  const app = await startTestApp({ localMode: true, statusDir, appSecret: KEY, noPassword: opts.noPassword });
  t.after(() => app.close());
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${HOST}`), port);
  const door = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<Res>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: HOST, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `https://${HOST}` } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, setCookie: res.headers['set-cookie'] ?? [], headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const login = (headers: Record<string, string> = {}, password = TEST_PASSWORD, code?: string) =>
    door('POST', '/login', headers, new URLSearchParams({ password, code: code ?? app.nextTotp() }).toString());
  return { app, door, login, port, statusDir };
}
const cookieOf = (r: Res) => r.setCookie.map((c) => c.split(';')[0]).join('; ');

// Finding 1.

const ODD = (path: string) => [
  path, path.toUpperCase(), path.replace(/^\/app/, '/App'), path.replace(/^\/app/, '/aPp'), path.replace(/^\/app/, '/APp'),
  path.replace(/^\/app/, '/%61pp'), path.replace(/^\/app/, '/%41pp'), path.replace(/^\/app/, '/%2561pp'), path.replace(/^\/app/, '//app'),
  path.replace(/^\/app/, '/./app'), path.replace(/^\/app/, '/x/../app'), path.replace(/^\/app/, '/\\app'),
];

test('through the door every /app route is refused in every spelling of its path (case, %-encoding, extra slashes), with the app key and without', async (t) => {
  const { door } = await start(t);
  // The routes are listed from a second app, so building one cannot disturb the one under test.
  const walked = await startTestApp({ localMode: true, appSecret: KEY });
  t.after(() => walked.close());
  const routes = listRoutes(createApp(walked.deps)).filter((r) => r.path === '/app' || r.path.startsWith('/app/'));
  assert.ok(routes.length >= 8, 'the walk finds the app routes');
  const seen = new Set<string>();
  for (const r of routes) {
    for (const path of ODD(r.path)) {
      for (const method of [r.method, 'GET', 'POST']) {
        const key = `${method} ${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const headers of [{} as Record<string, string>, { 'X-App-Key': KEY, Origin: `https://${HOST}` }]) {
          const res = await door(method, `${path}?challenge=${CHALLENGE}&grant=x&ticket=x`, headers);
          assert.equal(res.status, 404, `${key} ${JSON.stringify(headers)} -> ${res.status}`);
          assert.doesNotMatch(res.body, /proof|ticket"/, key);
          assert.deepEqual(res.setCookie, [], key);
        }
      }
    }
  }
  assert.ok(seen.size > 100);
});

test('the /app routes refuse a request that comes through the door even if the door block in front of them is bypassed', async (t) => {
  const { app } = await start(t);
  // Walk createApp's router the way a request would, with the door flag set but the early block taken out: the routes' own check answers.
  const { authRoutes } = await import('../web/authRoutes.js');
  const { PublicDoor, isAppPath } = await import('../desktop/publicDoor.js');
  const { default: express } = await import('express');
  const bare = express();
  bare.use(authRoutes(app.deps));
  const door = new PublicDoor(bare);
  const port = await door.open();
  t.after(() => door.close());
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: HOST, ...headers } });
  assert.equal((await call(`/app/hello?challenge=${CHALLENGE}`)).status, 404);
  assert.equal((await call('/app/ticket', 'POST', { 'X-App-Key': KEY })).status, 404);
  assert.equal((await call('/app/open?ticket=x')).status, 404);
  assert.equal((await call(`/app/bridge-hello?challenge=${CHALLENGE}`)).status, 404);
  for (const p of ['/app', '/APP/hello', '/%61pp/hello', '//app/hello', '/a/../app/x', '/%zz', '/app/..', '/app/%2e%2e', '/app/x/../..', '/App/%2E%2E/%2e%2e', '/./app/..']) assert.ok(isAppPath(p), p);
  for (const p of ['/', '/apple', '/settings/app', '/appendix/x', '/login']) assert.ok(!isAppPath(p), p);
});

test('a path that starts at /app and climbs out of it with .. is still refused at the door', async (t) => {
  const { door } = await start(t);
  for (const path of ['/app/..', '/app/%2e%2e', '/app/x/../..', '/APP/%2E%2E/', '/app/../app/hello']) {
    const r = await door('GET', path);
    assert.equal(r.status, 404, path);
  }
});

test('a ticket is never accepted through the door, and the one asked for here is still good afterwards', async (t) => {
  const { app, door } = await start(t);
  const res = await fetch(app.baseUrl + '/app/ticket', { method: 'POST', headers: { 'X-App-Key': KEY } });
  const { ticket } = await res.json() as { ticket: string };
  for (const path of ODD('/app/open')) {
    const r = await door('GET', `${path}?ticket=${ticket}`);
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.setCookie, [], path);
  }
  const open = await fetch(`${app.baseUrl}/app/open?ticket=${ticket}`, { redirect: 'manual' });
  assert.equal(open.status, 303, 'not used up by the door');
});

// Finding 4.

test('a session made on this computer is refused at the door; one made at the door works there; both keep working where they were made', async (t) => {
  const { app, door, login } = await start(t);
  const win = await appSession({ baseUrl: app.baseUrl, deps: { appSecret: KEY } });
  const localLogin = await loggedIn(app);
  const local = await (await localLogin('/', { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } })).status;
  assert.equal(local, 200);
  const nav = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' };
  // The window's cookie, sent to the door.
  const w = await door('GET', '/settings', { Cookie: win, ...nav });
  assert.equal(w.status, 302, 'the window session means nothing at the door');
  assert.match(String(w.headers.location), /^\/login/);
  // A password login made at localhost: the cookie, sent to the door.
  const res = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  const localCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c!.startsWith('mem_session=')).join('; ');
  assert.equal((await door('GET', '/settings', { Cookie: localCookie, ...nav })).status, 302, 'a local login stays local');
  assert.equal((await fetch(app.baseUrl + '/settings', { headers: { Cookie: localCookie, ...nav } })).status, 200, 'and works here');
  assert.equal((await fetch(app.baseUrl + '/settings', { headers: { Cookie: win, ...nav } })).status, 200, 'the window works here');
  // A login made at the door.
  const at = await login();
  assert.equal(at.status, 302);
  assert.equal((await door('GET', '/settings', { Cookie: cookieOf(at), ...nav })).status, 200, 'a door login works at the door');
});

test('a local browser login lasts a week, the window and a door login a month; the window cookie is Secure only through the door', async (t) => {
  const { app, login } = await start(t);
  const days = (c: string) => Math.round(Number(/Max-Age=(\d+)/i.exec(c)![1]) / 86_400);
  const session = (cs: string[]) => cs.find((c) => c.startsWith('mem_session='))!;
  const res = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  assert.equal(days(session(res.headers.getSetCookie())), 7);
  assert.match(session(res.headers.getSetCookie()), /^mem_session=local\./);
  const open = await (async () => {
    const tk = await (await fetch(app.baseUrl + '/app/ticket', { method: 'POST', headers: { 'X-App-Key': KEY } })).json() as { ticket: string };
    return fetch(`${app.baseUrl}/app/open?ticket=${tk.ticket}`, { redirect: 'manual' });
  })();
  assert.equal(days(session(open.headers.getSetCookie())), 30);
  assert.match(session(open.headers.getSetCookie()), /^mem_session=app\./);
  assert.doesNotMatch(session(open.headers.getSetCookie()), /Secure/i, 'http://localhost: no Secure');
  const at = await login();
  assert.equal(days(session(at.setCookie)), 30);
  assert.match(session(at.setCookie), /^mem_session=door\./);
  assert.match(session(at.setCookie), /Secure/i);
});

test('a session from before this was recorded (no origin in its token) counts as local', async (t) => {
  const { app, door } = await start(t);
  const { randomToken } = await import('../auth/hash.js');
  const { sha256 } = await import('../auth/hash.js');
  const old = randomToken();
  const now = app.deps.now();
  app.deps.db!.prepare('INSERT INTO sessions(token_hash, id, user_agent, created_at, last_seen_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(sha256(old), 'old-1', null, now.toISOString(), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  const nav = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' };
  assert.equal((await fetch(app.baseUrl + '/settings', { headers: { Cookie: `mem_session=${old}`, ...nav } })).status, 200);
  assert.equal((await door('GET', '/settings', { Cookie: `mem_session=${old}`, ...nav })).status, 302);
  // Faking the start of a door token does not make a local one a door one: only the hash of the whole token is known.
  assert.equal((await door('GET', '/settings', { Cookie: `mem_session=door.${old}`, ...nav })).status, 302);
});

// Finding 3.

test('on this computer a web page (a request with a foreign Origin) cannot register clients, use up the limits or starve a real tool', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const tool = await connectClient(app.baseUrl, f, 'Claude Code');
  const evil = { Origin: 'https://evil.example' };
  const reg = (headers: Record<string, string>) => fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'x', token_endpoint_auth_method: 'none' }) });
  for (let i = 0; i < 30; i++) assert.equal((await reg(evil)).status, 403, `registration ${i}`);
  const refresh = (headers: Record<string, string> = {}, id = tool.clientId, token = tool.refreshToken) => fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: id }) });
  for (let i = 0; i < 120; i++) assert.equal((await refresh(evil, 'made-up')).status, 403, `token ${i}`);
  for (const path of ['/authorize?client_id=x', '/revoke', '/REGISTER']) {
    assert.equal((await fetch(app.baseUrl + path, { method: path.startsWith('/authorize') ? 'GET' : 'POST', headers: evil })).status, 403, path);
  }
  assert.equal((await fetch(app.baseUrl + '/register', { method: 'OPTIONS', headers: { ...evil, 'Access-Control-Request-Method': 'POST' } })).status, 403, 'the preflight too');
  assert.equal((await fetch(app.baseUrl + '/register', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'Origin: null');
  // The tools: no Origin (or this computer's own), and the limits were never touched.
  assert.equal((await reg({})).status, 201, 'a real tool can still register');
  assert.equal((await reg({ Origin: 'http://localhost:5173' })).status, 201, 'a page on localhost is this computer');
  const r = await refresh();
  assert.equal(r.status, 200, 'and refresh');
  const next = (await r.json()) as { refresh_token: string };
  assert.equal((await refresh({}, tool.clientId, next.refresh_token)).status, 200);
});

test('on this computer the /token limit is kept for each client_id, so one program cannot starve another tool', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const tool = await connectClient(app.baseUrl, f, 'Claude Code');
  const token = (id: string, refresh: string) => fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id }) });
  let limited = 0;
  // Even a flood that names the real tool's own client_id, with refresh tokens that are not its own.
  for (let i = 0; i < 105; i++) if ((await token(tool.clientId, 'nope')).status === 429) limited++;
  assert.ok(limited >= 4, 'the noisy flood is limited');
  const r = await token(tool.clientId, tool.refreshToken);
  assert.equal(r.status, 200, 'the real tool, with its own refresh token, is not');
});

// Finding 5.

test('five failed logins from one stranger at the door lock out that stranger, not another one and not the owner\'s known device', async (t) => {
  const { app, door, login } = await start(t);
  const nav = { 'Sec-Fetch-Mode': 'navigate' };
  void nav;
  // The owner logs in at the door once, from the phone: it is now a known device.
  const first = await login({ 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(first.status, 302);
  const device = first.setCookie.map((c) => c.split(';')[0]).filter((c) => c!.startsWith('mem_device=')).join('; ');
  assert.ok(device);
  // A stranger fails five times (the address the forwarder saw), then is blocked.
  for (let i = 0; i < 5; i++) assert.equal((await login({ 'X-Forwarded-For': '203.0.113.9' }, 'wrong')).status, 401);
  assert.equal((await login({ 'X-Forwarded-For': '203.0.113.9' })).status, 429, 'the stranger is locked out');
  // Spelling more addresses in front does not give the stranger a new key: only the forwarder's own (last) entry counts.
  assert.equal((await login({ 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' })).status, 429);
  // Another stranger is not.
  assert.equal((await login({ 'X-Forwarded-For': '203.0.113.50' })).status, 302);
  // Strangers with no address at all share one key (the door's); five failures lock that key...
  for (let i = 0; i < 5; i++) assert.equal((await login({}, 'wrong')).status, 401);
  assert.equal((await login({})).status, 429);
  // ...but not the owner's phone, which has its own key.
  const owner = await login({ Cookie: device });
  assert.equal(owner.status, 302, 'the known device logs in');
  // The owner's device failing five times locks only that device.
  for (let i = 0; i < 5; i++) assert.equal((await login({ Cookie: device }, 'wrong')).status, 401);
  assert.equal((await login({ Cookie: device })).status, 429);
  assert.equal((await login({ 'X-Forwarded-For': '203.0.113.60' })).status, 302);
  void door; void app;
});

test('cf-connecting-ip is read at the door only when the tunnel is Cloudflare\'s; a Tailscale funnel caller cannot choose its own key with it', async (t) => {
  const { app, login } = await start(t);
  // Tailscale (the test brain's default): a made-up cf-connecting-ip is ignored, so these five all count against one key.
  for (let i = 0; i < 5; i++) assert.equal((await login({ 'cf-connecting-ip': `203.0.113.${i + 1}` }, 'wrong')).status, 401);
  assert.equal((await login({ 'cf-connecting-ip': '203.0.113.99' })).status, 429);
  // Cloudflare: Cloudflare sets it itself, so it names the caller.
  const reach = app.deps.reach!;
  Object.defineProperty(reach, 'via', { value: () => 'cloudflare' });
  assert.equal((await login({ 'cf-connecting-ip': '203.0.113.99' })).status, 302);
});


test('a cross-site request that is not a page navigation is refused on this computer even with no Origin header', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const reg = (h: Record<string, string>) => fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'x', token_endpoint_auth_method: 'none' }) });
  assert.equal((await reg({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' })).status, 403);
  assert.equal((await reg({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' })).status, 403);
  assert.equal((await reg({ 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' })).status, 201);
  // fetch() sets Sec-Fetch-Mode itself, so the navigation is sent with node:http.
  const u = new URL(app.baseUrl);
  const body = await new Promise<string>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: u.port, path: '/authorize?client_id=none', setHost: false, headers: { Host: `localhost:${u.port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', reject);
    r.end();
  });
  assert.doesNotMatch(body, /Web pages cannot use the sign-in endpoints/, 'a navigation is not this guard\'s business');
});

// Finding 5/C: the shared bucket is split by origin.

test('failures from the internet never use up the logins on this computer: the shared bucket is split by origin, the door\'s with a cap of its own', async () => {
  const { LoginLimiter, DOOR_GLOBAL_CAP, LOCAL_GLOBAL_CAP } = await import('../auth/loginLimiter.js');
  const l = new LoginLimiter();
  const l2 = new LoginLimiter();
  for (let i = 0; i < DOOR_GLOBAL_CAP; i++) await l.fail(`stranger-${i}`, { door: true });
  assert.equal((await l.check('stranger-new', { door: true })).allowed, false, 'the door is full');
  assert.equal((await l.check('stranger-new', { door: true, knownDevice: true })).allowed, true, 'the owner\'s known device skips it');
  assert.equal((await l.check('127.0.0.1')).allowed, true, 'this computer is not affected');
  assert.ok(DOOR_GLOBAL_CAP > LOCAL_GLOBAL_CAP);
  for (let i = 0; i < LOCAL_GLOBAL_CAP; i++) await l2.fail(`local-${i}`);
  assert.equal((await l2.check('local-new')).allowed, false);
  assert.equal((await l2.check('local-new', { door: true })).allowed, true, 'and the door is not hurt by this computer\'s failures');
});

test('through the real door: the door\'s shared bucket full does not stop a login on this computer', async (t) => {
  const { app, login } = await start(t);
  const { DOOR_GLOBAL_CAP } = await import('../auth/loginLimiter.js');
  for (let i = 0; i < DOOR_GLOBAL_CAP; i++) await app.deps.limiter.fail(`198.51.100.${i % 250}`, { door: true });
  assert.equal((await login({ 'X-Forwarded-For': '203.0.113.200' })).status, 429, 'a stranger-looking login at the door is held');
  const res = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  assert.equal(res.status, 302, 'the owner at this computer still gets in');
});

// Finding 2 (A): on a temporary port only the bridge's own key is accepted for the usual address.

test('on a temporary port a usual-address token of a tool is refused (access and refresh), the Claude bridge\'s own key is not', async (t) => {
  const { app, statusDir } = await start(t);
  const running = Number(new URL(app.baseUrl).port);
  const f = await loggedIn(app);
  const tool = await connectClient(app.baseUrl, f, 'Claude Code');
  const { MemoryOAuthProvider } = await import('../auth/provider.js');
  const atHome = new MemoryOAuthProvider(app.deps.db!, app.deps.clients, app.deps.allowlist, app.deps.now, new URL('http://localhost:3100/mcp'));
  const key = atHome.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const init = (token: string) => fetch(`${app.baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  const refresh = (token: string) => fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: tool.clientId }) });
  // The app is on a temporary port (the usual one is 3100). The tool's tokens were made for this address: fine here.
  writeFileSync(join(statusDir, '..', 'brainai.json'), JSON.stringify({ port: running, home: 3100 }));
  assert.equal((await init(tool.accessToken)).status, 200);
  // Pretend they were made for the usual address (3100) and the app is on a temporary port.
  app.deps.db!.prepare("UPDATE oauth_tokens SET resource = 'http://localhost:3100/mcp' WHERE grant_id IN (SELECT id FROM oauth_grants WHERE client_id = ?)").run(tool.clientId);
  assert.equal((await init(key.token)).status, 200, 'the bridge\'s key works');
  assert.equal((await init(tool.accessToken)).status, 401, 'a tool\'s token only gets here through a relay');
  const r = await refresh(tool.refreshToken);
  assert.equal(r.status, 400, 'and it cannot be refreshed here either');
  assert.match(JSON.stringify(await r.json()), /resource does not match/);
});
