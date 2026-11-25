/** Local mode with no password: a tool's sign-in waits in the browser and is approved in BrainAI's window. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appSession, startTestApp } from '../testing/helpers.js';

const CALLBACK = 'http://localhost:9999/callback';

/** Register a client and start /authorize, as a tool's sign-in does: returns the consent page's path. */
async function startConnection(baseUrl: string, name = 'Codex'): Promise<string> {
  const reg = await fetch(baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none' }) });
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${baseUrl}/mcp` }), { redirect: 'manual' });
  assert.equal(auth.status, 302);
  return auth.headers.get('location')!;
}

const decide = (baseUrl: string, path: string, cookie: string, decision: 'approve' | 'deny') =>
  fetch(baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision, from: 'window' }) });
const waitFor = async (baseUrl: string, path: string) => (await fetch(`${baseUrl}${path}/wait`)).json() as Promise<{ state: string; location?: string }>;

test('a tool sign-in with no password waits in the browser, shows in BrainAI\'s window, and reaches the tool\'s callback once approved there', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const consent = await startConnection(app.baseUrl);
  const id = consent.split('/').pop()!;

  const waiting = await fetch(app.baseUrl + consent, { redirect: 'manual' });
  assert.equal(waiting.status, 200);
  const text = await waiting.text();
  assert.match(text, /Codex/);
  assert.match(text, /BrainAI&#39;s window/);
  assert.match(text, new RegExp(`data-consent-wait="${consent}/wait"`));

  const list = await fetch(app.baseUrl + '/consents/waiting', { headers: { Cookie: cookie } });
  assert.deepEqual(await list.json(), [{ id, clientName: 'Codex', origin: new URL(CALLBACK).origin }]);
  assert.deepEqual(await waitFor(app.baseUrl, consent), { state: 'pending' });

  const approve = await decide(app.baseUrl, consent, cookie, 'approve');
  assert.equal(approve.status, 200);
  assert.match(await approve.text(), /Approved: Codex finishes connecting in your browser\./);

  const done = await waitFor(app.baseUrl, consent);
  assert.equal(done.state, 'done');
  const to = new URL(done.location!);
  assert.equal(to.origin + to.pathname, CALLBACK);
  assert.ok(to.searchParams.get('code'), 'the callback carries the code');
  assert.deepEqual(await waitFor(app.baseUrl, consent), { state: 'gone' }, 'the location is given once');
  assert.deepEqual(await (await fetch(app.baseUrl + '/consents/waiting', { headers: { Cookie: cookie } })).json(), []);
});

test('a request denied in the window sends the browser back to the tool with access_denied', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const consent = await startConnection(app.baseUrl);
  await fetch(app.baseUrl + consent);
  const deny = await decide(app.baseUrl, consent, cookie, 'deny');
  assert.equal(deny.status, 200);
  assert.match(await deny.text(), /Denied/);
  const done = await waitFor(app.baseUrl, consent);
  assert.equal(done.state, 'done');
  assert.equal(new URL(done.location!).searchParams.get('error'), 'access_denied');
});

test('nobody without a session can approve, list or read a waiting request', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const consent = await startConnection(app.baseUrl);
  await fetch(app.baseUrl + consent);
  const post = await fetch(app.baseUrl + consent, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approve', from: 'window' }) });
  assert.equal(post.status, 302);
  assert.match(post.headers.get('location')!, /^\/login/);
  assert.deepEqual(await waitFor(app.baseUrl, consent), { state: 'pending' });
  const list = await fetch(app.baseUrl + '/consents/waiting', { redirect: 'manual' });
  assert.equal(list.status, 302);
  assert.match(list.headers.get('location')!, /^\/login/);
  assert.deepEqual(await waitFor(app.baseUrl, '/consent/no-such-id'), { state: 'gone' });
});

test('a waiting request older than its pending lifetime is no longer listed or approvable', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const consent = await startConnection(app.baseUrl);
  await fetch(app.baseUrl + consent);
  app.advance(601_000);
  const cookie2 = await appSession(app);
  assert.deepEqual(await (await fetch(app.baseUrl + '/consents/waiting', { headers: { Cookie: cookie2 } })).json(), []);
  assert.deepEqual(await waitFor(app.baseUrl, consent), { state: 'gone' });
  assert.equal((await decide(app.baseUrl, consent, cookie2, 'approve')).status, 404);
});

test('owner pages in local mode carry the waiting-requests poller', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const home = await fetch(app.baseUrl + '/', { headers: { Cookie: cookie } });
  assert.match(await home.text(), /<body[^>]*data-consents-waiting="\/consents\/waiting"/);
});

test('once the owner account is set up, pages no longer carry the waiting-requests poller (nothing waits any more)', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  assert.equal(app.deps.owner.isConfigured(), true);
  const cookie = await appSession(app);
  const home = await fetch(app.baseUrl + '/', { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  assert.doesNotMatch(await home.text(), /data-consents-waiting/);
});

test('one tool starting many sign-ins cannot push another tool\'s waiting sign-in out', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const other = await startConnection(app.baseUrl, 'Cursor');
  await fetch(app.baseUrl + other);
  const reg = await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Codex', token_endpoint_auth_method: 'none' }) });
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const mine: string[] = [];
  for (let i = 0; i < 60; i++) {
    const auth = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: createHash('sha256').update(String(i)).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${app.baseUrl}/mcp` }), { redirect: 'manual' });
    const path = auth.headers.get('location')!;
    await fetch(app.baseUrl + path);
    mine.push(path);
  }
  assert.deepEqual(await waitFor(app.baseUrl, other), { state: 'pending' }, 'the other tool\'s request is still waiting');
  assert.deepEqual(await waitFor(app.baseUrl, mine[0]!), { state: 'gone' }, 'the flooding tool lost its own oldest');
  assert.deepEqual(await waitFor(app.baseUrl, mine.at(-1)!), { state: 'pending' });
});

/** Starts a sign-in for a new client (made directly, as /register is limited to 20 an hour) and opens its waiting page. */
async function wait(app: { baseUrl: string; deps: { clients: { registerClient?: (c: never) => unknown } } }, name: string): Promise<{ path: string; status: number; body: string }> {
  const c = await app.deps.clients.registerClient!({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none' } as never) as { client_id: string };
  const auth = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: CALLBACK, code_challenge: createHash('sha256').update(name).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${app.baseUrl}/mcp` }), { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const path = auth.headers.get('location')!;
  const page = await fetch(app.baseUrl + path);
  return { path, status: page.status, body: await page.text() };
}

test('when the waiting list is full, a new sign-in is refused and nobody already waiting is pushed out', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const first: string[] = [];
  for (let i = 0; i < 50; i++) { const r = await wait(app, `Tool ${i}`); assert.equal(r.status, 200); first.push(r.path); }
  const extra = await wait(app, 'Tool 50');
  assert.equal(extra.status, 503);
  assert.doesNotMatch(extra.body, /class="side"/, 'a browser with no session gets no owner sidebar');
  assert.deepEqual(await waitFor(app.baseUrl, first[0]!), { state: 'pending' }, 'the oldest is still waiting');
  assert.deepEqual(await waitFor(app.baseUrl, extra.path), { state: 'gone' });
});

test('a sign-in still waiting when the owner account gets set up keeps the poller on the pages, so it is not stranded', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const consent = await startConnection(app.baseUrl);
  await fetch(app.baseUrl + consent);
  await app.deps.owner.setPassword('a long enough test password');
  app.deps.owner.setTotpSecret('JBSWY3DPEHPK3PXP');
  assert.equal(app.deps.owner.isConfigured(), true);
  const home = await fetch(app.baseUrl + '/', { headers: { Cookie: await appSession(app) } });
  assert.match(await home.text(), /data-consents-waiting/);
});

test('outside local mode a tool sign-in still needs a login', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const consent = await startConnection(app.baseUrl);
  const r = await fetch(app.baseUrl + consent, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location')!, /^\/login/);
});

test('with a password but no authenticator yet, a tool sign-in waits for the window and is approved there, and no browser can sign in', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  await app.deps.owner.setPassword('a long enough test password');
  assert.equal(app.deps.owner.isConfigured(), false, 'password set, no authenticator');
  const cookie = await appSession(app);

  const login = await fetch(app.baseUrl + '/login', { redirect: 'manual' });
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Open BrainAI&#39;s window/);

  const consent = await startConnection(app.baseUrl);
  const id = consent.split('/').pop()!;
  const waiting = await fetch(app.baseUrl + consent, { redirect: 'manual' });
  assert.equal(waiting.status, 200);
  assert.match(await waiting.text(), /BrainAI&#39;s window/);
  assert.deepEqual(await (await fetch(app.baseUrl + '/consents/waiting', { headers: { Cookie: cookie } })).json(), [{ id, clientName: 'Codex', origin: new URL(CALLBACK).origin }]);

  const attempt = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'a long enough test password', code: '000000' }) });
  assert.equal(attempt.status, 503, 'a browser cannot sign in');
  assert.equal(attempt.headers.get('set-cookie'), null);

  const approve = await decide(app.baseUrl, consent, cookie, 'approve');
  assert.equal(approve.status, 200);
  assert.equal((await waitFor(app.baseUrl, consent)).state, 'done');
});

test('an unknown or expired consent id shows the owner\'s sidebar only to the window\'s session', async (t) => {
  const app = await startTestApp({ localMode: true, noPassword: true });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const path = '/consent/not-a-real-id';
  const stranger = await fetch(app.baseUrl + path, { redirect: 'manual' });
  assert.equal(stranger.status, 404);
  const strangerText = await stranger.text();
  assert.match(strangerText, /Request expired/);
  assert.doesNotMatch(strangerText, /class="side"/, 'no sidebar without a session');
  const owner = await fetch(app.baseUrl + path, { headers: { Cookie: cookie } });
  assert.equal(owner.status, 404);
  assert.match(await owner.text(), /class="side"/, 'the window keeps its sidebar');
});
