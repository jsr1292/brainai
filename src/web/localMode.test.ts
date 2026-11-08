/** The desktop app's local mode (D1): answers only to localhost, signs the owner in until a password exists, and the app's key. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { startTestApp, TEST_PASSWORD } from '../testing/helpers.js';

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** One request with a Host header of our choosing (fetch does not allow setting Host). */
function send(baseUrl: string, path: string, host: string | null, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method, setHost: false, headers: { ...(host === null ? {} : { Host: host }), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('in local mode only localhost:<port> and 127.0.0.1:<port> are answered; DNS rebinding gets 421', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const port = new URL(app.baseUrl).port;
  for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
    assert.notEqual((await send(app.baseUrl, '/login', host)).status, 421, host);
  }
  for (const host of ['attacker.example', `attacker.example:${port}`, 'localhost', 'localhost:1', `[::1]:${port}`, '']) {
    const a = await send(app.baseUrl, '/', host);
    assert.equal(a.status, 421, host);
    assert.equal(a.body, 'This address only answers to localhost.');
  }
  // No Host at all never reaches the app: Node's HTTP server refuses it first (400).
  assert.ok([400, 421].includes((await send(app.baseUrl, '/', null)).status), 'no Host at all is refused');
  assert.equal((await send(app.baseUrl, '/mcp', 'attacker.example', 'POST')).status, 421);
});

test('outside local mode the Host header is not checked (the home server sits behind its tunnel)', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const a = await send(app.baseUrl, '/', 'attacker.example');
  assert.equal(a.status, 302);
  assert.match(String(a.headers.location), /^\/login/);
});

const CALLBACK = 'http://localhost:9999/callback';

/** A page load as a browser sends it (Node's fetch always says Sec-Fetch-Mode: cors, so it cannot stand in for one). */
async function openPage(baseUrl: string, path: string, extra: Record<string, string> = {}): Promise<Answer & { cookie: string }> {
  const a = await send(baseUrl, path, `localhost:${new URL(baseUrl).port}`, 'GET', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...extra });
  const set = a.headers['set-cookie'];
  return { ...a, cookie: (Array.isArray(set) ? set : set ? [set] : []).map((c) => c.split(';')[0]).join('; ') };
}
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

/** Register and authorize a client: returns the consent page's path, as an app's sign-in would. */
async function startConnection(baseUrl: string): Promise<string> {
  const reg = await fetch(baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Codex', token_endpoint_auth_method: 'none' }) });
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${baseUrl}/mcp` }), { redirect: 'manual' });
  assert.equal(auth.status, 302);
  return auth.headers.get('location')!;
}

test('local mode with no password: the dashboard opens signed in, and the consent page needs only the Allow click', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const home = await openPage(app.baseUrl, '/', { 'Sec-Fetch-Site': 'none' });
  assert.equal(home.status, 200);
  assert.match(home.cookie, /mem_session=/);
  assert.match(String(home.headers['set-cookie']), /HttpOnly/i);
  const login = await openPage(app.baseUrl, '/login?next=%2Fsettings');
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/settings');
  const consent = await startConnection(app.baseUrl);
  // The app opens the consent page in the browser: a navigation from outside (Sec-Fetch-Site: none).
  const page = await openPage(app.baseUrl, consent, { 'Sec-Fetch-Site': 'none' });
  assert.equal(page.status, 200, 'the consent page opens without a login');
  const c2 = page.cookie;
  // Another site's form is still refused by the Origin check.
  const foreign = await fetch(app.baseUrl + consent, { method: 'POST', redirect: 'manual', headers: { Cookie: c2, Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approve' }) });
  assert.equal(foreign.status, 403);
  const approve = await fetch(app.baseUrl + consent, { method: 'POST', redirect: 'manual', headers: { Cookie: c2, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approve' }) });
  assert.equal(approve.status, 302);
  assert.ok(new URL(approve.headers.get('location')!).searchParams.get('code'), 'the app gets its code');
  // The app's own endpoints are left alone: no session cookie on them.
  assert.equal((await fetch(app.baseUrl + '/mcp', { method: 'POST' })).headers.getSetCookie().length, 0);
});

test('once a password is set, local mode asks for it like a server', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  await app.deps.owner.setPassword(TEST_PASSWORD);
  const home = await fetch(app.baseUrl + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location')!, /^\/login/);
  assert.equal(home.headers.getSetCookie().filter((c) => c.startsWith('mem_session=')).length, 0);
});

test('outside local mode nothing signs in by itself, even with no password', async (t) => {
  const app = await startTestApp({ noPassword: true });
  t.after(() => app.close());
  const home = await fetch(app.baseUrl + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location')!, /^\/login/);
});

test('the app exchanges its key for a one-time ticket; the ticket opens a session once, within a minute', async (t) => {
  const key = 'k'.repeat(40);
  const app = await startTestApp({ localMode: true, appSecret: key });
  t.after(() => app.close());
  const unknown = await fetch(`${app.baseUrl}/no-such-page`, { redirect: 'manual' });
  const ticketFor = (k: string | null) => fetch(`${app.baseUrl}/app/ticket`, { method: 'POST', headers: k === null ? {} : { 'X-App-Key': k } });
  for (const bad of [null, '', 'x'.repeat(40), `${key}x`]) assert.equal((await ticketFor(bad)).status, unknown.status, String(bad));
  const res = await ticketFor(key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { ticket } = await res.json() as { ticket: string };
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  const open = await fetch(`${app.baseUrl}/app/open?ticket=${ticket}&next=%2Fsettings`, { redirect: 'manual' });
  assert.equal(open.status, 303);
  assert.equal(open.headers.get('location'), '/settings');
  assert.match(cookieOf(open), /mem_session=/);
  // Used once: the same ticket again is an unknown page.
  assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=${ticket}`, { redirect: 'manual' })).status, unknown.status);
  // A minute later a fresh ticket has expired.
  const late = (await (await ticketFor(key)).json() as { ticket: string }).ticket;
  app.advance(61_000);
  assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=${late}`, { redirect: 'manual' })).status, unknown.status);
  // The key itself never opens anything by URL, and next cannot leave the site.
  assert.equal((await fetch(`${app.baseUrl}/app/open?key=${key}`, { redirect: 'manual' })).status, unknown.status);
  const t2 = (await (await ticketFor(key)).json() as { ticket: string }).ticket;
  assert.equal((await fetch(`${app.baseUrl}/app/open?ticket=${t2}&next=%2F%2Fevil.example`, { redirect: 'manual' })).headers.get('location'), '/');
});

test('outside local mode there is no app ticket and no app link, even with a key set', async (t) => {
  const key = 'k'.repeat(40);
  const app = await startTestApp({ appSecret: key });
  t.after(() => app.close());
  const unknown = await fetch(`${app.baseUrl}/no-such-page`, { redirect: 'manual' });
  assert.equal((await fetch(`${app.baseUrl}/app/ticket`, { method: 'POST', headers: { 'X-App-Key': key } })).status, unknown.status);
});

test('another site cannot use the local server: subresource requests are refused and never create sessions', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const count = () => (app.deps.sessions as any).list().length as number;
  const before = count();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${app.baseUrl}/search?q=secret`, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } });
    assert.equal(r.status, 403);
  }
  for (const site of ['same-site', 'cross-site']) {
    assert.equal((await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors' } })).status, 403, site);
  }
  assert.equal(count(), before, 'no session was created');
  // A link followed from elsewhere still opens BrainAI (one session), and the browser's own requests work.
  const nav = await openPage(app.baseUrl, '/', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(nav.status, 200);
  assert.equal(count(), before + 1);
  const same = await fetch(`${app.baseUrl}/search?q=x`, { redirect: 'manual', headers: { Cookie: nav.cookie, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
  assert.notEqual(same.status, 403);
  // A same-origin subresource without a cookie does not get a session of its own either.
  await fetch(`${app.baseUrl}/search?q=x`, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
  assert.equal(count(), before + 1);
});

test('127.0.0.1 pages redirect to localhost, so the dashboard has one address and its forms work', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const port = new URL(app.baseUrl).port;
  const a = await send(app.baseUrl, '/settings?x=1', `127.0.0.1:${port}`);
  assert.equal(a.status, 308);
  assert.equal(a.headers.location, `http://localhost:${port}/settings?x=1`);
  // The apps' own endpoints answer on either name.
  assert.notEqual((await send(app.baseUrl, '/mcp', `127.0.0.1:${port}`, 'POST')).status, 308);
  assert.notEqual((await send(app.baseUrl, '/.well-known/oauth-authorization-server', `127.0.0.1:${port}`)).status, 308);
});

test('the app can check it is talking to its own server: /app/hello answers the challenge with an HMAC of the key', async (t) => {
  const key = 's'.repeat(40);
  const challenge = 'ab'.repeat(32);
  const app = await startTestApp({ localMode: true, appSecret: key });
  t.after(() => app.close());
  const unknown = await fetch(`${app.baseUrl}/no-such-page`, { redirect: 'manual' });
  const res = await fetch(`${app.baseUrl}/app/hello?challenge=${challenge}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  const proof = createHmac('sha256', key).update(challenge).digest('hex');
  assert.deepEqual(JSON.parse(body), { proof });
  // The shared test vector: the Rust shell's proof::expected test asserts the same value.
  assert.equal(proof, '37a85455aabcc6be6a2858724eedc808f442dcf49c52a8752dd900a9e54e4ab3');
  assert.doesNotMatch(body, new RegExp(key));
  for (const bad of ['xyz', 'ab'.repeat(31) + 'a', 'ab'.repeat(33), 'AB'.repeat(32), '']) {
    assert.equal((await fetch(`${app.baseUrl}/app/hello?challenge=${bad}`)).status, unknown.status, bad);
  }
  const server = await startTestApp({ appSecret: key });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.baseUrl}/app/hello?challenge=${challenge}`)).status, unknown.status, 'not in local mode');
});

test("the app's own requests never make extra sessions: the check makes none, the ticket exactly one", async (t) => {
  const key = 'k'.repeat(40);
  const app = await startTestApp({ localMode: true, noPassword: true, appSecret: key });
  t.after(() => app.close());
  const count = () => (app.deps.sessions as any).list().length as number;
  for (let i = 0; i < 3; i++) await send(app.baseUrl, `/app/hello?challenge=${'ab'.repeat(32)}`, `localhost:${new URL(app.baseUrl).port}`);
  assert.equal(count(), 0, 'the check is not a page load');
  const { ticket } = await (await fetch(`${app.baseUrl}/app/ticket`, { method: 'POST', headers: { 'X-App-Key': key } })).json() as { ticket: string };
  const open = await openPage(app.baseUrl, `/app/open?ticket=${ticket}`, { 'Sec-Fetch-Site': 'none' });
  assert.equal(open.status, 303);
  assert.equal(count(), 1, 'one session, from the ticket');
});

test('only the three app addresses are exempt: any other /app/… path keeps the Origin check, and the ticket link goes to localhost first', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true, appSecret: 'k'.repeat(40) });
  t.after(() => app.close());
  const port = new URL(app.baseUrl).port;
  const foreign = await fetch(`${app.baseUrl}/app/anything-new`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(foreign.status, 403);
  const viaLoopback = await send(app.baseUrl, '/app/open?ticket=abc', `127.0.0.1:${port}`);
  assert.equal(viaLoopback.status, 308);
  assert.equal(viaLoopback.headers.location, `http://localhost:${port}/app/open?ticket=abc`);
});
