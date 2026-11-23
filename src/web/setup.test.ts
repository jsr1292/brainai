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
  assert.ok(body.includes(`data-copy="${attr(setupText('chatgpt', url))}"`), 'the text has a Copy button');
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
  assert.match(decodeEntities(await (await f('/settings/setup/chatgpt/status')).text()), /Waiting: ChatGPT hasn(’|')t reported a setup text yet/);
  (app.deps.provider as any).db.prepare("UPDATE oauth_grants SET setup_version = ?, setup_seen_at = ? WHERE name = 'ChatGPT'").run(SETUP_VERSION, new Date().toISOString());
  assert.match(await (await f('/settings/setup/chatgpt/status')).text(), new RegExp(`ChatGPT reports setup text ${SETUP_VERSION} · up to date ✓`));
});

test("the owner's overlay sets the setup number and adds its lines to the setup pages and Connections (O1)", async (t) => {
  const overlay = { version: 5, extra: { coding: ['- Push to the backup remote when the work is done.'] } };
  const { app, f } = await start(t, { setupOverlay: overlay });
  const page = await (await f('/settings/setup/claude-code')).text();
  assert.match(page, /pass setup: 5\./);
  assert.match(page, /Push to the backup remote/);
  assert.match(page, /Version 5 of the setup text\./);
  assert.doesNotMatch(page, /Setup text 5\./);
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

test('a refused address shows with its name only on the app whose hosts it uses; others are "unknown app" behind a warning; a cross-site Origin records nothing', async (t) => {
  const { app, f } = await start(t);
  const reg = (name: string, uri: string, origin?: string) => fetch(app.baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ client_name: name, redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  await reg('ChatGPT', 'https://chatgpt.com.connector-auth.example/cb');
  await reg('Claude', 'https://planted.example/cb', 'https://evil.example');
  for (const slug of ['chatgpt', 'claude']) {
    const page = await (await f(`/settings/setup/${slug}`)).text();
    assert.doesNotMatch(page, /calling itself/, slug);
    assert.doesNotMatch(page, /planted\.example/, slug);
    assert.match(page, /unknown app tried to sign in from <strong>chatgpt\.com\.connector-auth\.example<\/strong>/, slug);
    assert.match(page, /<details class="refused">/, slug);
  }
});

// Cloud apps (Claude, ChatGPT, Grok) are called from the vendors' servers, which cannot reach localhost.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession } from '../testing/helpers.js';
import { setupApps } from '../setup/texts.js';
import { decodeEntities } from '../testing/entities.js';

async function local(t: TestContext, o: { noPassword?: boolean } = {}) {
  const app = await startTestApp({ localMode: true, noPassword: o.noPassword, statusDir: mkdtempSync(join(tmpdir(), 'brainai-setup-')) });
  t.after(() => app.close());
  const cookie = await appSession(app);
  return { app, get: async (p: string) => (await fetch(app.baseUrl + p, { headers: { Cookie: cookie } })).text() };
}
const reachOn = (app: { deps: any }, url: string) => { app.deps.reach.url = () => new URL(url); };

test('cloud apps are flagged on the app, not by slug checks', () => {
  assert.deepEqual(setupApps().filter((a) => a.cloud).map((a) => a.slug), ['claude', 'chatgpt', 'grok']);
});

test('local mode with Reach off: a cloud app page sends the owner to Reach, with no localhost address or steps', async (t) => {
  const { get } = await local(t, { noPassword: true });
  for (const slug of ['claude', 'chatgpt', 'grok']) {
    const body = await get(`/settings/setup/${slug}`);
    assert.match(decodeEntities(body), /can(’|')t see this (Mac|computer) yet\. Turn on Reach first, then come back here\./, slug);
    assert.match(body, /<a [^>]*class="[^"]*primary[^"]*"[^>]*href="\/settings\/reach"[^>]*>Turn on Reach<\/a>|<a [^>]*href="\/settings\/reach"[^>]*class="[^"]*primary[^"]*"[^>]*>Turn on Reach<\/a>/, slug);
    assert.doesNotMatch(body, /localhost/, slug);
    assert.doesNotMatch(body, /data-copy=/, slug);
    assert.doesNotMatch(body, /setup-steps/, slug);
  }
  assert.match(await get('/settings/setup/claude'), /Claude’s desktop app can connect without Reach: use <a href="\/settings\/tools">Tools on this (Mac|computer)<\/a>\./);
  assert.doesNotMatch(await get('/settings/setup/chatgpt'), /\/settings\/tools/);
});

test('local mode with Reach on: a cloud app uses the public address in the address and the setup text', async (t) => {
  const { app, get } = await local(t);
  reachOn(app, 'https://brain.example.ts.net');
  const body = await get('/settings/setup/claude');
  assert.ok(body.includes('data-copy="https://brain.example.ts.net/mcp"'));
  assert.match(body, /the brain \(brain\.example\.ts\.net\)/);
  assert.doesNotMatch(body, /localhost/);
  assert.match(body, /You sign in with your brain password and code/);
});

test('local tools: the setup pages send the owner to Tools on this computer for the one-click way', async (t) => {
  const { get } = await local(t, { noPassword: true });
  for (const slug of ['claude-code', 'codex', 'opencode']) {
    const body = await get(`/settings/setup/${slug}`);
    assert.match(body, /On this computer, use <a href="\/settings\/tools">Tools on this (Mac|computer)<\/a>: one click does all of this\. The steps below are for another computer\./, slug);
  }
});

test('local tools: the manual steps are for another computer, so they need Reach and name the server brainai', async (t) => {
  const { app, get } = await local(t, { noPassword: true });
  for (const slug of ['claude-code', 'codex', 'opencode']) {
    const body = await get(`/settings/setup/${slug}`);
    assert.match(body, /Another computer can only reach this brain through Reach/, slug);
    assert.match(body, /href="\/settings\/reach"/, slug);
    assert.doesNotMatch(body, /localhost|data-copy=|setup-steps/, slug);
  }
  reachOn(app, 'https://brain.example.ts.net');
  const body = await get('/settings/setup/claude-code');
  assert.ok(body.includes('data-copy="https://brain.example.ts.net/mcp"'));
  assert.match(body, /claude mcp add --transport http brainai https:\/\/brain\.example\.ts\.net\/mcp -s user/);
  assert.doesNotMatch(body, /localhost|http memory/);
  assert.match(body, /You sign in with your brain password and code/);
  assert.match(await get('/settings/setup/codex'), /codex mcp add brainai --url https:\/\/brain\.example\.ts\.net\/mcp/);
});

test('the Claude setup page has no Tools box: only the three terminal tools get it', async (t) => {
  const { app, get } = await local(t);
  reachOn(app, 'https://brain.example.ts.net');
  assert.doesNotMatch(await get('/settings/setup/claude'), /one click does all of this/);
});

test('the setup page says what the check line does, per app', async (t) => {
  const { app, get } = await local(t);
  reachOn(app, 'https://brain.example.ts.net');
  assert.match(await get('/settings/setup/claude'), /This page shows when Claude is connected and using this text\./);
  assert.match(await get('/settings/setup/claude-code'), /This page shows when Claude Code is connected and using this text\./);
  assert.match(await get('/settings/setup/claude'), /Version \d+ of the setup text\./);
});

test('with a password and code set, local tools say the password and code', async (t) => {
  const { app, get } = await local(t);
  reachOn(app, 'https://brain.example.ts.net');
  assert.match(await get('/settings/setup/claude-code'), /You sign in with your brain password and code/);
});

test('server mode is unchanged: cloud apps show the address and the password-and-code line', async (t) => {
  const { app, f } = await start(t);
  const body = await (await f('/settings/setup/claude')).text();
  assert.ok(body.includes(`data-copy="${attr(new URL('/mcp', app.baseUrl).href)}"`));
  assert.match(body, /<p class="meta">You sign in with your brain password and code, then pick its access\.<\/p>/);
  assert.doesNotMatch(body, /Turn on Reach/);
});

test('server mode: the Claude Code and Codex setup pages name the server memory and have no Tools box', async (t) => {
  const { app, f } = await start(t);
  for (const slug of ['claude-code', 'codex']) {
    const body = await (await f(`/settings/setup/${slug}`)).text();
    assert.match(body, /\bmemory\b/, slug);
    assert.doesNotMatch(body, /brainai/, slug);
    assert.doesNotMatch(body, /Tools on this (Mac|computer)/, slug);
    assert.doesNotMatch(body, /\/settings\/tools/, slug);
    assert.ok(body.includes(new URL('/mcp', app.baseUrl).href), slug);
  }
});
