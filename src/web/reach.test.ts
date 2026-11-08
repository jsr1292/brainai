/** Reach from phone and web (D4): the password and the authenticator from the dashboard, two addresses, Tailscale. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { totpAt } from '../auth/totp.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { fakeTailscale } from '../testing/fakeTailscale.js';
import { fakeCloudflared, type FakeCloudflaredState } from '../testing/fakeCloudflared.js';
import { prepareTunnel, startSignIn } from '../desktop/cloudflared.js';
import { spawn } from 'node:child_process';

async function start(t: TestContext, opts: { localMode?: boolean } = { localMode: true }) {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  const app = await startTestApp({ localMode: opts.localMode, noPassword: true, statusDir });
  t.after(() => app.close());
  return app;
}

/** A page load as a browser sends it; returns the body and the cookie it ends up with. */
export function openPage(baseUrl: string, path: string, cookie = '', host?: string): Promise<{ status: number; body: string; cookie: string; location?: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method: 'GET', setHost: false, headers: { Host: host ?? `localhost:${u.port}`, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const set = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!);
        resolve({ status: res.statusCode ?? 0, body, cookie: set.length ? set.join('; ') : cookie, location: res.headers.location });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
export const post = (baseUrl: string, path: string, cookie: string, body: Record<string, string> = {}) =>
  fetch(baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const cookieAfter = (res: Response, before: string) => {
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  return set.length ? set.join('; ') : before;
};

test('the password and the authenticator are set from the dashboard, in order, and only a right code saves the authenticator', async (t) => {
  const app = await start(t);
  assert.match((await openPage(app.baseUrl, '/settings')).body, /<a[^>]*href="\/settings\/reach"[^>]*>[\s\S]*Reach from phone and web/, 'Settings links to it');
  const first = await openPage(app.baseUrl, '/settings/reach');
  assert.equal(first.status, 200);
  assert.match(first.body, /action="\/settings\/reach\/password"/);
  let cookie = first.cookie;
  for (const [pw, again] of [['short', 'short'], ['long enough password', 'a different one!!']]) {
    const r = await post(app.baseUrl, '/settings/reach/password', cookie, { password: pw, again });
    assert.equal(r.status, 303);
    assert.equal(app.deps.owner.hasPassword(), false, pw);
  }
  const set = await post(app.baseUrl, '/settings/reach/password', cookie, { password: 'a long enough password', again: 'a long enough password' });
  assert.equal(set.status, 303);
  assert.equal(app.deps.owner.hasPassword(), true);
  cookie = cookieAfter(set, cookie);
  // This browser stays signed in (every other one is signed out).
  const step2 = await openPage(app.baseUrl, '/settings/reach', cookie);
  assert.equal(step2.status, 200);
  assert.match(step2.body, /action="\/settings\/reach\/authenticator\/start"/);
  await post(app.baseUrl, '/settings/reach/authenticator/start', cookie, { current: 'a long enough password' });
  const qr = await openPage(app.baseUrl, '/settings/reach', cookie);
  assert.match(qr.body, /<svg[\s\S]*<\/svg>/, 'a QR code to scan');
  const secret = /data-secret="([A-Z2-7]+)"/.exec(qr.body)![1]!;
  const step = Math.floor(app.deps.now().getTime() / 30_000);
  const wrong = String((Number(totpAt(secret, step)) + 1) % 1_000_000).padStart(6, '0');
  await post(app.baseUrl, '/settings/reach/authenticator/confirm', cookie, { code: wrong });
  assert.equal(app.deps.owner.isConfigured(), false, 'a wrong code saves nothing');
  await post(app.baseUrl, '/settings/reach/authenticator/confirm', cookie, { code: totpAt(secret, step) });
  assert.equal(app.deps.owner.isConfigured(), true);
  // From now on a new browser has to log in: nothing signs in by itself.
  const fresh = await openPage(app.baseUrl, '/');
  assert.equal(fresh.status, 302);
  assert.match(fresh.location!, /^\/login/);
});

test('an authenticator code is only accepted within 10 minutes of showing the QR code', async (t) => {
  const app = await start(t);
  let cookie = (await openPage(app.baseUrl, '/settings/reach')).cookie;
  cookie = cookieAfter(await post(app.baseUrl, '/settings/reach/password', cookie, { password: 'a long enough password', again: 'a long enough password' }), cookie);
  await post(app.baseUrl, '/settings/reach/authenticator/start', cookie, { current: 'a long enough password' });
  const secret = /data-secret="([A-Z2-7]+)"/.exec((await openPage(app.baseUrl, '/settings/reach', cookie)).body)![1]!;
  app.advance(11 * 60_000);
  await post(app.baseUrl, '/settings/reach/authenticator/confirm', cookie, { code: totpAt(secret, Math.floor(app.deps.now().getTime() / 30_000)) });
  assert.equal(app.deps.owner.isConfigured(), false);
});

test('the Reach page and its forms exist only on a desktop install, and other sites cannot post to them', async (t) => {
  const app = await start(t);
  const cookie = (await openPage(app.baseUrl, '/settings/reach')).cookie;
  const foreign = await fetch(app.baseUrl + '/settings/reach/password', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=a+long+enough+password&again=a+long+enough+password' });
  assert.equal(foreign.status, 403);
  assert.equal(app.deps.owner.hasPassword(), false);
  const server = await start(t, { localMode: false });
  const unknown = await fetch(server.baseUrl + '/no-such-page', { redirect: 'manual' });
  const reach = await fetch(server.baseUrl + '/settings/reach', { redirect: 'manual' });
  assert.ok([302, unknown.status].includes(reach.status));
});

const PUBLIC = 'https://brainai-mac.tail1234.ts.net';
const PUBLIC_HOST = 'brainai-mac.tail1234.ts.net';
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Any request with a Host of our choosing (as the tunnel would send it), to the listener at `baseUrl`. */
function call(baseUrl: string, method: string, path: string, host: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method, setHost: false, headers: { Host: host, ...headers, ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const cookiesOf = (h: Record<string, string | string[] | undefined>) => ((h['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
type App = Awaited<ReturnType<typeof startTestApp>>;

/** Reach on as Turn on leaves it: the public door open and the address saved. Returns the door's base URL. */
async function reachOn(app: App): Promise<string> {
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  return `http://127.0.0.1:${port}`;
}

/** A full app sign-in at one address: register, authorize, log in, consent, token. */
async function connectAt(base: string, app: App, origin: string, host: string, opts: { resource?: boolean } = {}): Promise<string> {
  const json = { 'Content-Type': 'application/json' };
  const reg = await call(base, 'POST', '/register', host, json, JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'Claude', token_endpoint_auth_method: 'none' }));
  assert.equal(reg.status, 201, reg.body);
  const clientId = JSON.parse(reg.body).client_id as string;
  const verifier = 'v'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource: Record<string, string> = opts.resource === false ? {} : { resource: `${origin}/mcp` };
  const auth = await call(base, 'GET', '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', ...resource }), host);
  assert.equal(auth.status, 302, auth.body);
  const consent = auth.headers.location as string;
  const form = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin };
  const login = await call(base, 'POST', '/login', host, form, new URLSearchParams({ password: 'correct horse battery', code: app.nextTotp(), next: consent }).toString());
  assert.equal(login.status, 302, login.body);
  const cookie = cookiesOf(login.headers);
  const approve = await call(base, 'POST', consent, host, { ...form, Cookie: cookie }, new URLSearchParams({ decision: 'approve', access: 'full' }).toString());
  assert.equal(approve.status, 302, approve.body);
  const back = new URL(approve.headers.location as string);
  assert.equal(back.searchParams.get('iss'), `${origin}/`, 'the issuer of the address used');
  const tok = await call(base, 'POST', '/token', host, { 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: clientId, redirect_uri: 'http://localhost:9999/cb', ...resource }).toString());
  assert.equal(tok.status, 200, tok.body);
  return JSON.parse(tok.body).access_token as string;
}
const listTools = (base: string, host: string, token: string) =>
  call(base, 'POST', '/mcp', host, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
const configuredApp = async (t: TestContext, extra: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp({ localMode: true, statusDir: mkdtempSync(join(tmpdir(), 'brainai-reach-')), ...extra }); // password and authenticator set
  t.after(() => app.close());
  return app;
};

test('with Reach on, one brain answers at both addresses, and each sign-in works only where it was made', async (t) => {
  const app = await configuredApp(t);
  const local = new URL(app.baseUrl);
  assert.equal(app.deps.door!.port(), null, 'Reach off: no public door');
  const door = await reachOn(app);
  assert.equal((await call(app.baseUrl, 'GET', '/login', PUBLIC_HOST)).status, 421, 'the localhost listener never answers the public address');
  const prmPublic = JSON.parse((await call(door, 'GET', '/.well-known/oauth-protected-resource/mcp', PUBLIC_HOST)).body);
  const prmLocal = JSON.parse((await call(app.baseUrl, 'GET', '/.well-known/oauth-protected-resource/mcp', local.host)).body);
  assert.equal(prmPublic.resource, `${PUBLIC}/mcp`);
  assert.equal(prmLocal.resource, `${local.origin}/mcp`);
  const webToken = await connectAt(door, app, PUBLIC, PUBLIC_HOST);
  const localToken = await connectAt(app.baseUrl, app, local.origin, local.host);
  assert.equal((await listTools(door, PUBLIC_HOST, webToken)).status, 200);
  assert.equal((await listTools(app.baseUrl, local.host, localToken)).status, 200);
  assert.equal((await listTools(app.baseUrl, local.host, webToken)).status, 401, 'a web sign-in does not work at localhost');
  assert.equal((await listTools(door, PUBLIC_HOST, localToken)).status, 401, 'a local sign-in does not work through the public address');
  // Turned off: the door closes, local sign-ins keep working.
  app.deps.reach!.set(null);
  assert.equal(app.deps.door!.port(), null);
  await assert.rejects(call(door, 'GET', '/login', PUBLIC_HOST), 'nothing answers at the old door');
  assert.equal((await listTools(app.baseUrl, local.host, localToken)).status, 200);
});

test('through the public door, a request that names localhost is still the internet: no session, no app endpoints, no local tokens', async (t) => {
  const app = await configuredApp(t);
  const local = new URL(app.baseUrl);
  const localToken = await connectAt(app.baseUrl, app, local.origin, local.host);
  const door = await reachOn(app);
  const home = await call(door, 'GET', '/', local.host, { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' });
  assert.equal(home.status, 302);
  assert.match(home.headers.location as string, /^\/login/);
  assert.equal(cookiesOf(home.headers), '', 'no session handed out');
  assert.equal((await call(door, 'GET', `/app/hello?challenge=${'a'.repeat(64)}`, local.host)).status, 404, 'the app window\'s endpoints are not on the door');
  assert.equal((await call(door, 'POST', '/app/ticket', local.host, { 'X-App-Key': 'x' })).status, 404);
  assert.equal((await listTools(door, local.host, localToken)).status, 401, 'a local token is not accepted through the door');
  const prm = JSON.parse((await call(door, 'GET', '/.well-known/oauth-protected-resource/mcp', local.host)).body);
  assert.equal(prm.resource, `${PUBLIC}/mcp`, 'the door always speaks as the public address');
  // A form posted through the door must come from the public address's own pages.
  const login = await call(door, 'POST', '/login', local.host, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: local.origin }, new URLSearchParams({ password: 'correct horse battery', code: app.nextTotp() }).toString());
  assert.equal(login.status, 403);
});

test('a public door left open without Reach in use answers nothing, and a BrainAI with no sign-in never opens one', async (t) => {
  const app = await configuredApp(t);
  const port = await app.deps.door!.open();
  const r = await call(`http://127.0.0.1:${port}`, 'GET', '/', PUBLIC_HOST);
  assert.equal(r.status, 421);
  app.deps.door!.close();
  // A saved address and door port from an earlier install, but this BrainAI has no password: the door stays shut.
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  writeFileSync(join(statusDir, 'reach.json'), JSON.stringify({ url: PUBLIC, port: 0 }));
  const fresh = await startTestApp({ localMode: true, noPassword: true, statusDir });
  t.after(() => fresh.close());
  await fresh.deps.reach!.ready;
  assert.equal(fresh.deps.door!.port(), null);
  assert.equal(fresh.deps.reach!.url(), null);
});

test('signing in at the public address gives a Secure cookie (it is https there)', async (t) => {
  const app = await configuredApp(t);
  const door = await reachOn(app);
  const login = await call(door, 'POST', '/login', PUBLIC_HOST, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PUBLIC }, new URLSearchParams({ password: 'correct horse battery', code: app.nextTotp() }).toString());
  assert.equal(login.status, 302);
  const session = ((login.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('mem_session='))!;
  assert.match(session, /; Secure/i);
});

test('an app that names no resource at the public address gets a public sign-in', async (t) => {
  const app = await configuredApp(t);
  const door = await reachOn(app);
  const token = await connectAt(door, app, PUBLIC, PUBLIC_HOST, { resource: false });
  assert.equal((await listTools(door, PUBLIC_HOST, token)).status, 200);
});

test('strangers using up the public address\'s sign-in limits do not block the apps on this Mac', async (t) => {
  const app = await configuredApp(t);
  const door = await reachOn(app);
  const reg = (base: string, host: string) => call(base, 'POST', '/register', host, { 'Content-Type': 'application/json' }, JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'x', token_endpoint_auth_method: 'none' }));
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await reg(door, PUBLIC_HOST)).status;
  assert.equal(last, 429, 'the door has a limit');
  assert.equal((await reg(app.baseUrl, new URL(app.baseUrl).host)).status, 201, 'local apps keep their own');
});

test('once a password exists the dashboard cannot replace it, and adding the authenticator needs that password', async (t) => {
  const app = await start(t);
  let cookie = (await openPage(app.baseUrl, '/settings/reach')).cookie;
  cookie = cookieAfter(await post(app.baseUrl, '/settings/reach/password', cookie, { password: 'a long enough password', again: 'a long enough password' }), cookie);
  await post(app.baseUrl, '/settings/reach/password', cookie, { password: 'the stolen session one', again: 'the stolen session one' });
  assert.equal(await app.deps.owner.verifyPassword('a long enough password'), true, 'the first password stands');
  await post(app.baseUrl, '/settings/reach/authenticator/start', cookie);
  assert.doesNotMatch((await openPage(app.baseUrl, '/settings/reach', cookie)).body, /data-secret=/, 'no QR code without the password');
  await post(app.baseUrl, '/settings/reach/authenticator/start', cookie, { current: 'not the password' });
  assert.doesNotMatch((await openPage(app.baseUrl, '/settings/reach', cookie)).body, /data-secret=/);
  await post(app.baseUrl, '/settings/reach/authenticator/start', cookie, { current: 'a long enough password' });
  assert.match((await openPage(app.baseUrl, '/settings/reach', cookie)).body, /data-secret=/);
  // With both set, the authenticator cannot be swapped from the dashboard.
  const done = await configuredApp(t);
  const f = await loggedIn(done);
  await f('/settings/reach/authenticator/start', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'current=correct+horse+battery' });
  assert.doesNotMatch(await (await f('/settings/reach')).text(), /data-secret=/);
});

test('a saved Reach comes back at start on its own door; if that port is taken it is shared again from a new one, and a failure turns it off', async (t) => {
  const ts = fakeTailscale({ backend: 'Running', dns: 'brainai-mac.tail1234.ts.net.' });
  t.after(() => ts.cleanup());
  const tools = { home: ts.home, path: `${ts.bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const free = await new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
  const dir1 = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  writeFileSync(join(dir1, 'reach.json'), JSON.stringify({ url: PUBLIC, port: free }));
  const same = await configuredApp(t, { statusDir: dir1, tools });
  await same.deps.reach!.ready;
  assert.equal(same.deps.door!.port(), free);
  assert.equal(same.deps.reach!.url()?.origin, PUBLIC);
  assert.ok(!ts.calls().some((c) => c.startsWith('funnel')), 'same port: Tailscale already points there');
  same.deps.door!.close();
  // The saved port is held by another program: a new door, and Funnel re-pointed at it.
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(free, '127.0.0.1', () => resolve()));
  t.after(() => squatter.close());
  const dir2 = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  writeFileSync(join(dir2, 'reach.json'), JSON.stringify({ url: PUBLIC, port: free }));
  const moved = await configuredApp(t, { statusDir: dir2, tools });
  await moved.deps.reach!.ready;
  const now = moved.deps.door!.port();
  assert.ok(now !== null && now !== free);
  assert.ok(ts.calls().includes(`funnel --bg --https=443 --yes http://127.0.0.1:${now}`));
  assert.equal(JSON.parse(readFileSync(join(dir2, 'reach.json'), 'utf8')).port, now);
  // Tailscale signed out meanwhile: Reach is turned off and the page says why.
  const out = fakeTailscale({ backend: 'NeedsLogin' });
  t.after(() => out.cleanup());
  const dir3 = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  writeFileSync(join(dir3, 'reach.json'), JSON.stringify({ url: PUBLIC, port: free }));
  const off = await configuredApp(t, { statusDir: dir3, tools: { home: out.home, path: `${out.bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  await off.deps.reach!.ready;
  assert.equal(off.deps.door!.port(), null);
  assert.equal(off.deps.reach!.saved(), null);
  const f = await loggedIn(off);
  assert.match(await (await f('/settings/reach')).text(), /Reach was turned off[\s\S]*sign in/i);
});

test('turning Reach on shares BrainAI at the public address and the web apps get it; turning it off takes it back', async (t) => {
  const ts = fakeTailscale({ backend: 'Running', dns: 'brainai-mac.tail1234.ts.net.' });
  t.after(() => ts.cleanup());
  const app = await startTestApp({ localMode: true, statusDir: mkdtempSync(join(tmpdir(), 'brainai-reach-')), tools: { home: ts.home, path: `${ts.bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const page1 = await (await f('/settings/reach')).text();
  assert.match(page1, /action="\/settings\/reach\/on"/);
  const on = await f('/settings/reach/on', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(on.status, 303);
  assert.equal(app.deps.reach!.url()?.origin, PUBLIC);
  const doorPort = app.deps.door!.port();
  assert.ok(doorPort !== null && doorPort !== Number(new URL(app.baseUrl).port), 'Funnel gets its own door, not the localhost listener');
  assert.ok(ts.calls().includes(`funnel --bg --https=443 --yes http://127.0.0.1:${doorPort}`));
  const page2 = await (await f('/settings/reach')).text();
  assert.match(page2, new RegExp(esc(PUBLIC)));
  assert.match(page2, /only while this Mac is on and awake/);
  assert.match(page2, /action="\/settings\/reach\/off"/);
  assert.match(await (await f('/settings/setup/claude')).text(), new RegExp(esc(`data-copy="${PUBLIC}/mcp"`)), 'web apps get the public address');
  assert.match(await (await f('/settings/setup/claude-code')).text(), new RegExp(esc(`data-copy="${app.baseUrl}/mcp"`)), 'coding tools on this Mac keep localhost');
  const off = await f('/settings/reach/off', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(off.status, 303);
  assert.equal(app.deps.reach!.saved(), null);
  assert.equal(app.deps.door!.port(), null, 'the door is shut');
  assert.ok(ts.calls().includes('funnel --https=443 off'));
});

test('Reach cannot be turned on before the password and the authenticator, and Tailscale problems leave it off', async (t) => {
  const ts = fakeTailscale({ backend: 'Running' });
  t.after(() => ts.cleanup());
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir: mkdtempSync(join(tmpdir(), 'brainai-reach-')), tools: { home: ts.home, path: `${ts.bin}:/usr/bin:/bin` } });
  t.after(() => app.close());
  const cookie = (await openPage(app.baseUrl, '/settings/reach')).cookie;
  assert.equal((await post(app.baseUrl, '/settings/reach/on', cookie)).status, 303);
  assert.equal(app.deps.reach!.saved(), null);
  assert.ok(!ts.calls().some((c) => c.startsWith('funnel')), 'Tailscale was never asked');
  const blocked = fakeTailscale({ backend: 'Running', needsApproval: true });
  t.after(() => blocked.cleanup());
  const app2 = await startTestApp({ localMode: true, statusDir: mkdtempSync(join(tmpdir(), 'brainai-reach-')), tools: { home: blocked.home, path: `${blocked.bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  t.after(() => app2.close());
  const f2 = await loggedIn(app2);
  await f2('/settings/reach/on', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(app2.deps.reach!.saved(), null);
  assert.equal(app2.deps.door!.port(), null, 'a refused Turn on leaves no door open');
  assert.match(await (await f2('/settings/reach')).text(), /login\.tailscale\.com\/f\/funnel/);
});

// Reach through Cloudflare, for people with their own domain (D5).
const CF_HOST = 'brain.example.net';
const CF_URL = `https://${CF_HOST}`;
async function cloudflareApp(t: TestContext, state: FakeCloudflaredState = {}, extra: Parameters<typeof startTestApp>[0] = {}) {
  const cf = fakeCloudflared(state);
  t.after(() => cf.cleanup());
  const app = await configuredApp(t, { tools: { home: cf.home, path: `${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, extraEnv: cf.extraEnv }, ...extra });
  const checked: string[] = [];
  app.deps.reachCheck = async (url) => { checked.push(url.href); return true; };
  const f = await loggedIn(app);
  const form = (path: string, body: Record<string, string> = {}) => f(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  return { cf, app, f, form, checked };
}
const running = (cf: ReturnType<typeof fakeCloudflared>) => cf.state().running as { url: string; pid: number } | null | undefined;
async function eventually(check: () => boolean | Promise<boolean>, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 50) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail('timed out waiting');
}
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Reach through Cloudflare: sign in, choose a name, and BrainAI answers there through its door', async (t) => {
  const { cf, app, f, form, checked } = await cloudflareApp(t);
  const first = await (await f('/settings/reach')).text();
  assert.match(first, /action="\/settings\/reach\/cloudflare\/signin"/, 'signing in comes first');
  assert.match(first, /Without a domain: Tailscale/, 'Tailscale stays the other choice');
  assert.equal((await form('/settings/reach/cloudflare/signin')).status, 303);
  await eventually(async () => /action="\/settings\/reach\/cloudflare\/on"/.test(await (await f('/settings/reach')).text()));
  assert.equal((await form('/settings/reach/cloudflare/on', { hostname: ` ${CF_HOST.toUpperCase()} ` })).status, 303);
  assert.equal(app.deps.reach!.url()?.href, `${CF_URL}/`);
  assert.equal(app.deps.reach!.via(), 'cloudflare');
  const door = app.deps.door!.port();
  assert.ok(door !== null);
  await eventually(() => running(cf)?.url === `http://127.0.0.1:${door}`);
  assert.deepEqual(checked, [`${CF_URL}/`], 'BrainAI checked it answers there before saying On');
  const saved = readFileSync(join(app.deps.statusDir!, 'reach.json'), 'utf8');
  assert.equal(JSON.parse(saved).via, 'cloudflare');
  assert.match(JSON.parse(saved).tunnel, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(saved, /SECRET/i, 'no credentials in reach.json');
  const page = await (await f('/settings/reach')).text();
  assert.match(page, new RegExp(esc(CF_URL)));
  assert.match(await (await f('/settings/setup/claude')).text(), new RegExp(esc(`data-copy="${CF_URL}/mcp"`)));
});

test('turning Cloudflare Reach off stops the tunnel and shuts the door; on again reuses the tunnel', async (t) => {
  const { cf, app, f, form } = await cloudflareApp(t);
  await form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await f('/settings/reach')).text()));
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  await eventually(() => !!running(cf));
  const pid = running(cf)!.pid;
  await form('/settings/reach/off');
  assert.equal(app.deps.reach!.saved(), null);
  assert.equal(app.deps.door!.port(), null);
  await eventually(() => !isAlive(pid));
  assert.ok(!cf.calls().some((c) => c.includes('funnel')));
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(app.deps.reach!.url()?.origin, CF_URL);
  assert.equal(cf.state().created, 1, 'one tunnel, made once');
  await form('/settings/reach/off');
});

test('a Cloudflare name in use, or a tunnel that never answers, leaves Reach off with no tunnel running', async (t) => {
  const taken = await cloudflareApp(t, { recordExists: true });
  await taken.form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await taken.f('/settings/reach')).text()));
  await taken.form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(taken.app.deps.reach!.saved(), null);
  assert.equal(taken.app.deps.door!.port(), null);
  assert.match(await (await taken.f('/settings/reach')).text(), /Cloudflare already has a record for brain\.example\.net/);
  assert.ok(!taken.cf.calls().some((c) => c.includes(' run ')), 'no tunnel started');
  const silent = await cloudflareApp(t);
  silent.app.deps.reachCheck = async () => false;
  await silent.form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await silent.f('/settings/reach')).text()));
  await silent.form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(silent.app.deps.reach!.saved(), null);
  assert.equal(silent.app.deps.door!.port(), null);
  await eventually(() => !running(silent.cf));
  assert.match(await (await silent.f('/settings/reach')).text(), /Cloudflare did not reach BrainAI/);
});

test('a saved Cloudflare Reach comes back at start, after stopping a tunnel an earlier BrainAI left running', async (t) => {
  const cf = fakeCloudflared({});
  t.after(() => cf.cleanup());
  const env = { home: cf.home, path: `${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, extraEnv: cf.extraEnv };
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  assert.equal((await startSignIn(env).done).ok, true);
  const p = await prepareTunnel(env, statusDir, CF_HOST) as { tunnelId: string; credentials: string };
  const orphan = spawn(join(cf.bin, 'cloudflared'), ['tunnel', '--no-autoupdate', 'run', '--credentials-file', p.credentials, '--url', 'http://127.0.0.1:4999', p.tunnelId], { env: { PATH: env.path, HOME: env.home }, stdio: 'ignore' });
  t.after(() => { try { orphan.kill('SIGKILL'); } catch { /* gone */ } });
  writeFileSync(join(statusDir, 'cloudflared', 'cloudflared.pid'), String(orphan.pid));
  writeFileSync(join(statusDir, 'reach.json'), JSON.stringify({ url: CF_URL, port: 4999, via: 'cloudflare', tunnel: p.tunnelId }));
  await eventually(() => running(cf)?.pid === orphan.pid);
  const app = await configuredApp(t, { statusDir, tools: env });
  await app.deps.reach!.ready;
  await eventually(() => !isAlive(orphan.pid!));
  const door = app.deps.door!.port();
  assert.ok(door !== null);
  await eventually(() => running(cf)?.url === `http://127.0.0.1:${door}` && running(cf)!.pid !== orphan.pid);
  assert.equal(app.deps.reach!.url()?.origin, CF_URL);
  assert.equal(app.deps.reach!.via(), 'cloudflare');
  app.deps.reach!.set(null);
});

test('no password or authenticator, no Cloudflare; and an app built without tools never looks for cloudflared', async (t) => {
  const cf = fakeCloudflared({});
  t.after(() => cf.cleanup());
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir: mkdtempSync(join(tmpdir(), 'brainai-reach-')), tools: { home: cf.home, path: `${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, extraEnv: cf.extraEnv } });
  t.after(() => app.close());
  const cookie = (await openPage(app.baseUrl, '/settings/reach')).cookie;
  await post(app.baseUrl, '/settings/reach/cloudflare/signin', cookie);
  await post(app.baseUrl, '/settings/reach/cloudflare/on', cookie, { hostname: CF_HOST });
  assert.deepEqual(cf.calls(), [], 'cloudflared was never asked');
  assert.equal(app.deps.reach!.saved(), null);
  // cloudflared is installed on the owner's Mac: an app with no tools environment must not find it.
  const bare = await configuredApp(t);
  const page = await (await (await loggedIn(bare))('/settings/reach')).text();
  assert.match(page, /Install cloudflared/);
});

test('Cloudflare Turn on checks BrainAI through its real door, as Cloudflare reaches it, and only then says On', async (t) => {
  const { app, f, form } = await cloudflareApp(t);
  // What Cloudflare does: a request to the door naming the public host.
  app.deps.reachCheck = async (url) => {
    const port = app.deps.door!.port();
    if (port === null) return false;
    const r = await call(`http://127.0.0.1:${port}`, 'GET', '/.well-known/oauth-protected-resource/mcp', url.host);
    return r.status === 200 && JSON.parse(r.body).resource === new URL('/mcp', url).href;
  };
  await form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await f('/settings/reach')).text()));
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(app.deps.reach!.url()?.origin, CF_URL, await (await f('/settings/reach')).text().then((p) => /notice[^>]*>([^<]*)/.exec(p)?.[1] ?? ''));
  await form('/settings/reach/off');
});

test('a tunnel left by a crash during Turn on (nothing saved yet) is stopped at the next start', async (t) => {
  const cf = fakeCloudflared({});
  t.after(() => cf.cleanup());
  const env = { home: cf.home, path: `${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, extraEnv: cf.extraEnv };
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-reach-'));
  await startSignIn(env).done;
  const p = await prepareTunnel(env, statusDir, CF_HOST) as { tunnelId: string; credentials: string };
  const orphan = spawn(join(cf.bin, 'cloudflared'), ['tunnel', '--no-autoupdate', 'run', '--credentials-file', p.credentials, '--url', 'http://127.0.0.1:4999', p.tunnelId], { env: { PATH: env.path, HOME: env.home }, stdio: 'ignore' });
  t.after(() => { try { orphan.kill('SIGKILL'); } catch { /* gone */ } });
  writeFileSync(join(statusDir, 'cloudflared', 'cloudflared.pid'), String(orphan.pid));
  await eventually(() => running(cf)?.pid === orphan.pid);
  const app = await configuredApp(t, { statusDir, tools: env });
  await app.deps.reach!.ready;
  await eventually(() => !isAlive(orphan.pid!));
});

test("BrainAI's cloudflared keeps a home of its own: the owner's ~/.cloudflared is never read or changed", async (t) => {
  const { cf, app, f, form } = await cloudflareApp(t);
  mkdirSync(join(cf.home, '.cloudflared'), { recursive: true });
  writeFileSync(join(cf.home, '.cloudflared', 'cert.pem'), 'THE OWNER CERT');
  writeFileSync(join(cf.home, '.cloudflared', 'config.yml'), 'ingress:\n  - service: http://localhost:8080\n');
  assert.match(await (await f('/settings/reach')).text(), /cloudflare\/signin/, "the owner's own sign-in is not BrainAI's");
  await form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await f('/settings/reach')).text()));
  assert.ok(existsSync(join(app.deps.statusDir!, 'cloudflared', 'home', '.cloudflared', 'cert.pem')));
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(app.deps.reach!.url()?.origin, CF_URL);
  assert.equal(readFileSync(join(cf.home, '.cloudflared', 'cert.pem'), 'utf8'), 'THE OWNER CERT');
  await form('/settings/reach/off');
});

test('signed in to the wrong Cloudflare domain: the page offers another one, and that one works', async (t) => {
  const { cf, app, f, form } = await cloudflareApp(t, { otherZone: 'example.org' });
  await form('/settings/reach/cloudflare/signin');
  await eventually(async () => /cloudflare\/on/.test(await (await f('/settings/reach')).text()));
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(app.deps.reach!.saved(), null);
  const page = await (await f('/settings/reach')).text();
  assert.match(page, /not a domain on the Cloudflare account/);
  assert.match(page, /action="\/settings\/reach\/cloudflare\/another"/);
  cf.setState({ otherZone: '' });
  await form('/settings/reach/cloudflare/another');
  await eventually(async () => /cloudflare\/on/.test(await (await f('/settings/reach')).text()));
  assert.equal(cf.calls().filter((c) => c.endsWith('tunnel login')).length, 2, 'signed in again');
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.equal(app.deps.reach!.url()?.origin, CF_URL);
  assert.equal(cf.state().created, 2, 'a tunnel on the new account');
  await form('/settings/reach/off');
});

test('on Windows the Reach page says it is Mac-only for now, and never looks for tailscale or cloudflared', async (t) => {
  const ts = fakeTailscale({ backend: 'Running' });
  const cf = fakeCloudflared({});
  t.after(() => { ts.cleanup(); cf.cleanup(); });
  const app = await configuredApp(t, { tools: { platform: 'win32', home: cf.home, path: `${ts.bin}:${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, extraEnv: cf.extraEnv } });
  const f = await loggedIn(app);
  const form = (path: string, body: Record<string, string> = {}) => f(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  assert.match(await (await f('/settings/reach')).text(), /not on Windows yet/);
  await form('/settings/reach/on');
  await form('/settings/reach/cloudflare/signin');
  await form('/settings/reach/cloudflare/on', { hostname: CF_HOST });
  assert.deepEqual(ts.calls(), []);
  assert.deepEqual(cf.calls(), []);
  assert.equal(app.deps.reach!.saved(), null);
});
