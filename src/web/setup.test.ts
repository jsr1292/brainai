/** Guided setup (round 2 §17b): one page per app with the connector address, the setup text and a live check. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { SETUP_VERSION, setupText } from '../setup/texts.js';

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

test("an app's setup page shows the address and the text, each with Copy, in three steps", async (t) => {
  const { app, f } = await start(t);
  const res = await f('/settings/setup/chatgpt');
  assert.equal(res.status, 200);
  const body = await res.text();
  const url = new URL('/mcp', app.baseUrl).href;
  assert.match(body, /<h1>Set up ChatGPT<\/h1>/);
  assert.ok(body.includes(`data-copy="${attr(url)}"`), 'the address has a Copy button');
  assert.ok(body.includes(`data-copy="${attr(setupText('chatgpt', 'personal', url))}"`), 'the text has a Copy button');
  assert.deepEqual([...body.matchAll(/<li><h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['Connect', 'Paste the setup text', 'Check']);
  assert.match(body, /data-setup-status="\/settings\/setup\/chatgpt\/status"/);
});

test('an unknown app is 404, and the page needs the owner', async (t) => {
  const { app, f } = await start(t);
  assert.equal((await f('/settings/setup/nope')).status, 404);
  const anon = await fetch(app.baseUrl + '/settings/setup/chatgpt', { redirect: 'manual' });
  assert.equal(anon.status, 302);
});

test("the check line waits, then says up to date once the app reports the newest text", async (t) => {
  const { app, f } = await start(t);
  assert.match(await (await f('/settings/setup/chatgpt/status')).text(), /No ChatGPT connection yet/);
  await connectClient(app.baseUrl, f, 'ChatGPT');
  assert.match(await (await f('/settings/setup/chatgpt/status')).text(), /Waiting: ChatGPT hasn(’|&#39;|')t reported a setup text yet/);
  (app.deps.provider as any).db.prepare("UPDATE oauth_grants SET setup_version = ?, setup_seen_at = ? WHERE name = 'ChatGPT'").run(SETUP_VERSION, new Date().toISOString());
  assert.match(await (await f('/settings/setup/chatgpt/status')).text(), new RegExp(`ChatGPT reports setup text ${SETUP_VERSION} · up to date ✓`));
});

test('the work brain sets up only Claude Code and Codex', async (t) => {
  const { f } = await start(t, { mode: 'work' });
  assert.equal((await f('/settings/setup/claude-code')).status, 200);
  assert.equal((await f('/settings/setup/chatgpt')).status, 404);
  const body = await (await f('/settings')).text();
  const list = body.slice(body.indexOf('<h3 id="setup">'));
  assert.ok(list.includes('/settings/setup/codex') && !list.includes('/settings/setup/grok'));
});

test("the owner's overlay sets the setup number and adds its lines to the setup pages and Connections (O1)", async (t) => {
  const overlay = { version: 5, extra: { coding: ['- Push to the backup remote when the work is done.'] } };
  const { app, f } = await start(t, { setupOverlay: overlay });
  const page = await (await f('/settings/setup/claude-code')).text();
  assert.match(page, /pass setup: 5\./);
  assert.match(page, /Push to the backup remote/);
  assert.match(page, /Setup text 5\./);
  await connectClient(app.baseUrl, f, 'Claude Code');
  (app.deps.provider as any).db.prepare("UPDATE oauth_grants SET setup_version = 5 WHERE name = 'Claude Code'").run();
  assert.match(await (await f('/settings')).text(), /Setup text 5 · up to date ✓/);
  assert.match(await (await f('/settings/setup/claude-code/status')).text(), /reports setup text 5 · up to date ✓/);
});

const form = (o: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(o), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

test('ChatGPT, Grok and Codex pages offer to allow their sign-in address; Claude and Claude Code need nothing', async (t) => {
  const { app, f } = await start(t);
  const list = () => (app.deps as any).allowlist.list() as string[];
  for (const slug of ['claude', 'claude-code']) assert.doesNotMatch(await (await f(`/settings/setup/${slug}`)).text(), /action="\/settings\/setup\/[a-z-]+\/allow"/);
  const grok = await (await f('/settings/setup/grok')).text();
  assert.match(grok, /<form method="post" action="\/settings\/setup\/grok\/allow"[^>]*><button[^>]*>Allow Grok to sign in<\/button><\/form>/);
  const res = await f('/settings/setup/grok/allow', form({}));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/settings/setup/grok#allow');
  assert.ok(list().includes('https://grok.com/connectors-oauth-exchange-code/'));
  assert.match(await (await f('/settings/setup/grok')).text(), /Grok may sign in ✓/);
  assert.equal((await f('/settings/setup/codex/allow', form({}))).status, 303);
  assert.ok(list().includes('https://chatgpt.com/oauth/codex/'));
  assert.equal((await f('/settings/setup/chatgpt/allow', form({}))).status, 303);
  assert.ok(list().includes('https://chatgpt.com/connector_platform_oauth_redirect'));
  // Claude needs nothing, so there is nothing to allow.
  assert.equal((await f('/settings/setup/claude/allow', form({}))).status, 404);
});

test('a refused sign-in address is listed on the setup pages with Allow; only a listed address can be allowed', async (t) => {
  const { app, f } = await start(t);
  const list = () => (app.deps as any).allowlist.list() as string[];
  const odd = 'https://chatgpt.com/connector/oauth/AbC123';
  const reg = await fetch(app.baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [odd], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  assert.equal(reg.status, 400);
  const page = await (await f('/settings/setup/chatgpt')).text();
  // The name is whatever the anonymous client said, so it is shown as a claim, isolated, with the host in bold.
  assert.match(page, /An app calling itself “<bdi>ChatGPT<\/bdi>” tried to sign in from <strong>chatgpt\.com<\/strong> <code>https:\/\/chatgpt\.com\/connector\/oauth\/AbC123<\/code>/);
  // An address nobody asked for, or one with a query, is refused: the button never takes free text.
  for (const uri of ['https://evil.example/cb', `${odd}?x=1`]) {
    assert.equal((await f('/settings/setup/chatgpt/allow', form({ uri }))).status, 400, uri);
  }
  assert.ok(!list().some((e) => e.includes('evil.example')));
  assert.equal((await f('/settings/setup/chatgpt/allow', form({ uri: odd }))).status, 303);
  assert.ok(list().includes(odd));
  assert.doesNotMatch(await (await f('/settings/setup/chatgpt')).text(), /tried to sign in from/);
  // Allowed some other way (here: the terminal), it leaves the list too.
  const other = 'https://grok.com/other-callback';
  await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok', redirect_uris: [other], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  assert.match(await (await f('/settings/setup/grok')).text(), /grok\.com\/other-callback/);
  (app.deps as any).allowlist.add(other);
  assert.doesNotMatch(await (await f('/settings/setup/grok')).text(), /tried to sign in from/);
  // Without the owner's session nothing is added (another site's form is refused by the app-wide Origin check).
  const anon = await fetch(app.baseUrl + '/settings/setup/grok/allow', { ...form({}), redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: app.baseUrl } });
  assert.notEqual(anon.status, 303);
  assert.ok(!list().includes('https://grok.com/connectors-oauth-exchange-code/'));
});
