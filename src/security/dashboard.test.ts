/**
 * Adversarial: the dashboard's boundary. Every route the app registers is read from its Express router, so a route added
 * later is checked automatically: unreachable without a session, refused without a same-origin Origin, and in the
 * desktop app (LOCAL_MODE) refused for a foreign Host, a foreign site and a missing or wrong app key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startTestApp } from '../testing/helpers.js';
import { createApp } from '../web/app.js';
import { concretePath, listRoutes } from './routes.js';
import { changedTables, fingerprint, seedWorld, sessionCookie } from './support.js';

const EXEMPT_FROM_ORIGIN = new Set(['/mcp', '/authorize', '/token', '/register', '/revoke', '/app/hello', '/app/bridge-hello', '/app/ticket', '/app/removed/ready', '/app/backup-now', '/api/folder-report', '/api/image-upload', '/api/skills/report', '/api/skills/upload']);
const exempt = (path: string) => [...EXEMPT_FROM_ORIGIN].some((p) => path === p || path.startsWith(p + '/'));

async function boot(opts: { localMode?: boolean; noPassword?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sec-dash-'));
  const app = await startTestApp({ ...opts, statusDir: dir, backupDir: join(dir, 'backups') });
  const routes = listRoutes(createApp(app.deps));
  return { app, routes, dir, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const send = (base: string, method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(base + concretePath(path), { method, redirect: 'manual', headers, body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : '' });

/** Real ids for the params a route family looks up, so a guard that ran after the lookup would show. */
function realPath(path: string, ids: { page: string; fact: string; grant: string; discussion: string; skill: string }): string {
  const family: [RegExp, string][] = [[/^\/pages\//, ids.page], [/^\/memories\//, ids.fact], [/^\/clients\//, ids.grant], [/^\/discussions\//, ids.discussion], [/^\/skills\//, ids.skill]];
  const id = family.find(([re]) => re.test(path))?.[1];
  return concretePath(id ? path.replace(/:id|:grantId/, id) : path);
}

/** What each route that is not behind the owner's session may answer without one, and why. Everything else must redirect to /login. */
const OPEN_ANSWERS = new Map<string, number[]>([
  ['POST /login', [401, 503]], ['GET /login', [200]], ['GET /.well-known/oauth-authorization-server', [200]], ['GET /consent/:id/wait', [200]],
  ['GET /sw.js', [200]], ['GET /favicon.ico', [302]], ['GET /app/removed', [200]],
  ['POST /mcp', [401]], ['GET /mcp', [405]], ['DELETE /mcp', [405]],
  ['POST /api/folder-report', [401]], ['POST /api/skills/report', [401]], ['POST /api/skills/upload', [401]], ['PUT /api/image-upload/:token', [410]],
  // The desktop app's own endpoints answer like an unknown page without the key (or do not exist on a server).
  ['POST /app/ticket', [404]], ['GET /app/hello', [404]], ['GET /app/bridge-hello', [404]], ['GET /app/open', [404]], ['GET /app/removed/ready', [404]], ['GET /app/goodbye', [404]], ['POST /app/backup-now', [404]],
]);

for (const mode of [{ name: 'server', opts: {} as { localMode?: boolean; noPassword?: boolean } }, { name: 'desktop (LOCAL_MODE)', opts: { localMode: true } }, { name: 'desktop with no password yet', opts: { localMode: true, noPassword: true } }]) {
  test(`${mode.name}: every registered route redirects to /login without a session, except the listed open ones, which answer exactly what is listed`, async () => {
    const { app, routes, close } = await boot(mode.opts);
    try {
      const w = await seedWorld(app);
      const ids = { page: w.page, fact: w.fact, grant: 'no-grant', discussion: w.discussion, skill: 'no-skill' };
      assert.ok(routes.length > 150, `expected the whole route table, got ${routes.length}`);
      const wrong: string[] = [];
      const listedSeen = new Set<string>();
      for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        const res = await send(app.baseUrl, r.method, realPath(r.path, ids).replace(/^\//, '/'), { Origin: app.baseUrl });
        const where = res.headers.get('location') ?? '';
        // With no owner account yet, an unknown consent id is a plain "expired" page (a known one waits for the window).
        const allowed = key === 'GET /consent/:id' && 'noPassword' in mode.opts ? [404] : OPEN_ANSWERS.get(key);
        if (allowed) { listedSeen.add(key); if (!allowed.includes(res.status)) wrong.push(`${key} -> ${res.status} (listed: ${allowed.join('/')})`); continue; }
        if (!(res.status === 302 && /^\/login(\?|$)/.test(where))) wrong.push(`${key} -> ${res.status} ${where}`);
      }
      assert.deepEqual(wrong, [], 'guard these with requireOwner, or list them in OPEN_ANSWERS with a reason');
      assert.ok(listedSeen.size >= 12, `only ${listedSeen.size} of the listed open routes exist`);
    } finally { await close(); }
  });
}

test('server: every route that changes something is refused without an Origin, with a foreign Origin and with Origin: null, even with a valid session, and changes nothing', async () => {
  const { app, routes, close } = await boot();
  try {
    await seedWorld(app);
    const cookie = await sessionCookie(app);
    const before = fingerprint(app.deps.db!);
    const writes = routes.filter((r) => r.method !== 'GET' && !exempt(r.path) && r.path !== '/login');
    assert.ok(writes.length > 80, `expected the whole write table, got ${writes.length}`);
    for (const r of writes) {
      for (const origin of [undefined, 'https://evil.example', 'null', app.baseUrl + '.evil.example', app.baseUrl.replace('http', 'https')]) {
        const res = await send(app.baseUrl, r.method, r.path, { Cookie: cookie, ...(origin === undefined ? {} : { Origin: origin }) });
        assert.equal(res.status, 403, `${r.method} ${r.path} with Origin ${origin}: ${res.status}`);
      }
    }
    assert.deepEqual(changedTables(before, fingerprint(app.deps.db!)), []);
    assert.equal(app.deps.service.savesPausedSince(), null);
    // Not vacuous: the same session with the right Origin is let through (this one is a real write, the pause switch).
    const ok = await send(app.baseUrl, 'POST', '/settings/pause', { Cookie: cookie, Origin: app.baseUrl });
    assert.equal(ok.status, 303);
    assert.ok(app.deps.service.savesPausedSince());
  } finally { await close(); }
});

test('the programs\' endpoints that skip the Origin check each refuse a caller with no credential', async () => {
  const { app, close } = await boot();
  try {
    for (const [method, path] of [['POST', '/api/folder-report'], ['POST', '/api/skills/report'], ['POST', '/api/skills/upload']] as const) {
      const res = await fetch(app.baseUrl + path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401, path);
      const bad = await fetch(app.baseUrl + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' });
      assert.equal(bad.status, 401, `${path} with a made-up device token`);
    }
    assert.equal((await fetch(app.baseUrl + '/api/image-upload/nope', { method: 'PUT', body: 'x' })).status, 410);
  } finally { await close(); }
});

test('the session cookie is HttpOnly and SameSite=Lax, a logged-out cookie is dead on the server, and a session can be revoked from Settings', async () => {
  const { app, close } = await boot();
  try {
    const res = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'correct horse battery', code: app.nextTotp() }) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('mem_session='))!;
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    const cookie = set.split(';')[0]!;
    const ok = await fetch(app.baseUrl + '/facts', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(ok.status, 200);
    await fetch(app.baseUrl + '/logout', { method: 'POST', headers: { Cookie: cookie, Origin: app.baseUrl }, redirect: 'manual' });
    const after = await fetch(app.baseUrl + '/facts', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(after.status, 302, 'a replayed cookie after logout is refused');
  } finally { await close(); }
});

test('desktop: a Host that is not localhost:<port> or 127.0.0.1:<port> (DNS rebinding) gets 421 on every route, with or without a session', async () => {
  const { app, routes, close } = await boot({ localMode: true });
  try {
    const cookie = await sessionCookie({ baseUrl: app.baseUrl, nextTotp: app.nextTotp });
    const port = new URL(app.baseUrl).port;
    const hosts = ['attacker.example', `attacker.example:${port}`, `localhost.attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`, `localhost:${Number(port) + 1}`, '[::1]:' + port, '0.0.0.0:' + port, `LOCALHOST.evil:${port}`];
    // fetch() forbids a custom Host, so this goes through a raw socket.
    const raw = (method: string, path: string, host: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(port), method, path, headers: { ...headers, ...(host === '' ? {} : { Host: host }) }, setHost: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    for (const host of hosts) {
      for (const r of routes.filter((x, i) => x.method === 'GET' ? i % 7 === 0 : i % 5 === 0)) {
        const status = await raw(r.method, concretePath(r.path), host, { Cookie: cookie, Origin: `http://${host}` });
        assert.equal(status, 421, `${r.method} ${r.path} with Host "${host}" answered ${status}`);
      }
    }
    assert.equal(await raw('GET', '/facts', `localhost:${port}`, { Cookie: cookie }), 200, 'the real host still works');
  } finally { await close(); }
});

test('desktop: another site (Sec-Fetch-Site cross-site / same-site) cannot read or change anything with the owner\'s cookie, except by a plain link click', async () => {
  const { app, close } = await boot({ localMode: true });
  try {
    const cookie = await sessionCookie({ baseUrl: app.baseUrl, nextTotp: app.nextTotp });
    for (const site of ['cross-site', 'same-site']) {
      const img = await fetch(app.baseUrl + '/facts', { headers: { Cookie: cookie, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' }, redirect: 'manual' });
      assert.equal(img.status, 403, `${site} subresource GET`);
      const post = await fetch(app.baseUrl + '/settings/pause', { method: 'POST', headers: { Cookie: cookie, Origin: app.baseUrl, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors' }, redirect: 'manual' });
      assert.equal(post.status, 403, `${site} POST`);
      // fetch() sets Sec-Fetch-Mode itself, so a navigation is sent over a raw socket.
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(app.baseUrl + '/facts', { headers: { Cookie: cookie, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 200, `${site} link click opens the page (it only reads; the cookie is SameSite=Lax)`);
    }
    assert.equal(app.deps.service.savesPausedSince(), null);
  } finally { await close(); }
});

test('desktop: the app key — missing, wrong, in the query string, or a stale ticket — opens no session, backs up nothing and answers like an unknown page', async () => {
  const { app, close } = await boot({ localMode: true });
  try {
    const key = app.deps.appSecret!;
    for (const headers of [{}, { 'X-App-Key': 'wrong' }, { 'X-App-Key': key.toUpperCase() }, { Authorization: `Bearer ${key}` }, { Cookie: `x-app-key=${key}` }] as Record<string, string>[]) {
      assert.equal((await fetch(app.baseUrl + '/app/ticket', { method: 'POST', headers })).status, 404, JSON.stringify(headers));
      assert.equal((await fetch(app.baseUrl + '/app/backup-now', { method: 'POST', headers })).status, 404, JSON.stringify(headers));
    }
    assert.equal((await fetch(`${app.baseUrl}/app/ticket?key=${key}&x-app-key=${key}`, { method: 'POST' })).status, 404, 'the key in the URL is not accepted');
    assert.equal((await fetch(`${app.baseUrl}/app/open?key=${key}`, { redirect: 'manual' })).status, 404, 'the key in the URL opens no session');
    assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=forged`, { redirect: 'manual' })).status, 404);
    const t = await fetch(app.baseUrl + '/app/ticket', { method: 'POST', headers: { 'X-App-Key': key } });
    const { ticket } = await t.json() as { ticket: string };
    const first = await fetch(`${app.baseUrl}/app/open?ticket=${ticket}`, { redirect: 'manual' });
    assert.equal(first.status, 303);
    assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=${ticket}`, { redirect: 'manual' })).status, 404, 'a ticket works once');
    app.advance(61_000);
    const t2 = await (await fetch(app.baseUrl + '/app/ticket', { method: 'POST', headers: { 'X-App-Key': key } })).json() as { ticket: string };
    app.advance(61_000);
    assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=${t2.ticket}`, { redirect: 'manual' })).status, 404, 'a ticket works for a minute');
  } finally { await close(); }
});

test('a server (no LOCAL_MODE) has no app key, ticket, backup-now or app pages at all, whatever header is sent', async () => {
  const { app, close } = await boot({});
  try {
    for (const [m, p] of [['POST', '/app/ticket'], ['POST', '/app/backup-now'], ['GET', '/app/open?ticket=x'], ['GET', '/app/hello?challenge=' + 'a'.repeat(64)]] as const) {
      const res = await fetch(app.baseUrl + p, { method: m, headers: { 'X-App-Key': 'test-app-secret' }, redirect: 'manual' });
      assert.equal(res.status, 404, `${m} ${p}`);
    }
  } finally { await close(); }
});
