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
