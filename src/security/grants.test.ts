/**
 * Adversarial: can one connection exceed what the owner granted it? Access levels (full, read-only for chosen projects,
 * discussions only), revocation, token binding to a resource, refresh-token replay. All through the real OAuth flow and /mcp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_TOOLS } from '../mcp/server.js';
import { sha256 } from '../auth/hash.js';
import { ACCESS_TTL_SEC } from '../auth/provider.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { callTool, changedTables, connectWith, fingerprint, mcpCall, refresh, seedWorld, toolNames, writeCalls } from './support.js';

async function world() {
  const app = await startTestApp();
  try { return await seeded(app); } catch (e) { await app.close(); throw e; }
}

async function seeded(app: Awaited<ReturnType<typeof startTestApp>>) {
  const f = await loggedIn(app);
  const w = await seedWorld(app);
  await app.deps.service.remember({ kind: 'decision', project: 'secretproj', content: 'SECRETMARKER the launch is in March', newProject: true }, { type: 'owner' });
  await app.deps.service.remember({ kind: 'profile', content: 'PROFILEMARKER the owner lives in Lisbon' }, { type: 'owner' });
  const p = await app.deps.pages.create({ title: 'secretproj plan', project: 'secretproj', body: '# Plan\n\nSECRETPAGEMARKER details.' }, 'owner');
  return { app, f, w, secretPage: p.id };
}

test('a read-only grant is offered only reading tools, and every write tool is refused with nothing written', async () => {
  const { app, f, w } = await world();
  try {
    const c = await connectWith(app, f, { access: 'projects', projects: ['brainai'] });
    const offered = await toolNames(app.baseUrl, c.accessToken);
    assert.deepEqual(offered.filter((n) => WRITE_TOOLS.has(n)), [], 'no write tool is offered');
    assert.ok(!offered.includes('load_profile'), 'a read-only connection never gets the profile');
    const before = fingerprint(app.deps.db!);
    for (const [tool, args] of Object.entries(writeCalls(w))) {
      const r = await callTool(app.baseUrl, c.accessToken, tool, args);
      assert.ok(r.result?.isError === true || r.error !== undefined, `${tool} was not refused for a read-only grant: ${r.text}`);
    }
    assert.deepEqual(changedTables(before, fingerprint(app.deps.db!)), []);
  } finally { await app.close(); }
});

test('a read-only grant for one project never reads another project, the profile, or a page of another project', async () => {
  const { app, f, secretPage } = await world();
  try {
    const c = await connectWith(app, f, { access: 'projects', projects: ['brainai'] });
    const all: string[] = [];
    const ask = async (tool: string, args: Record<string, unknown> = {}) => { const r = await callTool(app.baseUrl, c.accessToken, tool, args); all.push(r.text); return r; };
    await ask('recall', { query: 'SECRETMARKER launch March' });
    await ask('recall', { query: 'launch', project: 'secretproj' });
    await ask('recall', { query: 'owner lives in Lisbon PROFILEMARKER' });
    await ask('project_brief', { project: 'secretproj' });
    await ask('list_projects');
    await ask('list_pages');
    await ask('list_pages', { project: 'secretproj' });
    await ask('read_page', { id: secretPage });
    await ask('recent_work');
    await ask('whats_left');
    await ask('weekly_review', { week: 'now' });
    await ask('view_image', { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    const joined = all.join('\n');
    assert.doesNotMatch(joined, /SECRETMARKER|SECRETPAGEMARKER|PROFILEMARKER/, 'another project or the profile leaked to a read-only grant');
    assert.doesNotMatch((await ask('list_projects')).text, /secretproj/, 'another project is not even listed');
    const own = await ask('recall', { query: 'SQLite activity feed' });
    assert.match(own.text, /SQLite/, 'its own project is readable (the checks above are not vacuous)');
  } finally { await app.close(); }
});

test('a discussions-only grant reads no memory and cannot call memory tools; its two posting tools are the only writes it has', async () => {
  const { app, f, w } = await world();
  try {
    const c = await connectWith(app, f, { access: 'discussions' });
    assert.deepEqual(await toolNames(app.baseUrl, c.accessToken), ['list_discussions', 'open_discussion', 'read_discussion', 'reply_to_discussion']);
    const before = fingerprint(app.deps.db!);
    for (const tool of [...WRITE_TOOLS].filter((t) => t !== 'open_discussion' && t !== 'reply_to_discussion')) {
      const r = await callTool(app.baseUrl, c.accessToken, tool, writeCalls(w)[tool]);
      assert.ok(r.result?.isError === true || r.error !== undefined, `${tool} reached a discussions-only grant: ${r.text}`);
    }
    for (const tool of ['recall', 'load_profile', 'project_brief', 'read_page', 'list_projects']) {
      const r = await callTool(app.baseUrl, c.accessToken, tool, { query: 'x', project: 'brainai', id: w.page });
      assert.ok(r.result?.isError === true || r.error !== undefined, `${tool} answered a discussions-only grant`);
      assert.doesNotMatch(r.text, /SQLite|Lisbon|SECRET/);
    }
    assert.deepEqual(changedTables(before, fingerprint(app.deps.db!)), []);
    // A discussion about the owner's project that is not shared with guests stays hidden from it.
    const hidden = app.deps.discussions.open({ name: 'Codex', model: 'GPT', access: 'full' }, { title: 'Personal one', question: 'PRIVATEQUESTION', includeLimited: false });
    const list = await callTool(app.baseUrl, c.accessToken, 'list_discussions', { status: 'all' });
    assert.doesNotMatch(list.text, /PRIVATEQUESTION|Personal one/);
    const read = await callTool(app.baseUrl, c.accessToken, 'read_discussion', { id: hidden.id, model: 'GPT' });
    assert.doesNotMatch(read.text, /PRIVATEQUESTION/);
  } finally { await app.close(); }
});

test('narrowing a grant in Settings applies to the very next call', async () => {
  const { app, f, w } = await world();
  try {
    const c = await connectWith(app, f);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'remember', writeCalls(w).remember)).result?.isError, undefined);
    const res = await f(`/clients/${c.grantId}/access`, { method: 'POST', body: new URLSearchParams({ access: 'projects', projects: 'brainai' }) });
    assert.equal(res.status, 303);
    const r = await callTool(app.baseUrl, c.accessToken, 'remember', { ...writeCalls(w).remember, content: 'Written after the grant was narrowed' });
    assert.ok(r.result?.isError === true || r.error !== undefined, r.text);
    assert.equal(app.deps.store.list({ project: 'brainai' }).some((m) => m.content === 'Written after the grant was narrowed'), false);
  } finally { await app.close(); }
});

test('revoking a connection kills its access token, its refresh token and its auth code at once', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'list_projects')).status, 200);
    const res = await f(`/clients/${c.grantId}/revoke`, { method: 'POST', body: new URLSearchParams({}) });
    assert.equal(res.status, 303);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'list_projects')).status, 401);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'remember', { kind: 'decision', project: 'brainai', content: 'Written after revocation' })).status, 401);
    assert.equal((await refresh(app.baseUrl, c.clientId, c.refreshToken)).status, 400);
    assert.equal(app.deps.store.list({ project: 'brainai' }).some((m) => m.content === 'Written after revocation'), false);
  } finally { await app.close(); }
});

test('refresh-token replay after the grace period revokes the whole grant, the stolen and the rotated tokens alike', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    const first = await refresh(app.baseUrl, c.clientId, c.refreshToken);
    assert.equal(first.status, 200);
    const rotated = await first.json() as { access_token: string; refresh_token: string };
    app.advance(60_000);
    const replay = await refresh(app.baseUrl, c.clientId, c.refreshToken);
    assert.equal(replay.status, 400);
    assert.equal((await callTool(app.baseUrl, rotated.access_token, 'list_projects')).status, 401, 'the legitimate holder is cut off too: theft is assumed');
    assert.equal((await refresh(app.baseUrl, c.clientId, rotated.refresh_token)).status, 400);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'list_projects')).status, 401);
  } finally { await app.close(); }
});

test('a refresh token does not work from another client, as an access token, or for another resource; an access token is no refresh token', async () => {
  const { app, f } = await world();
  try {
    const a = await connectWith(app, f, { name: 'App A' });
    const b = await connectWith(app, f, { name: 'App B' });
    assert.equal((await refresh(app.baseUrl, b.clientId, a.refreshToken)).status, 400, "another client's refresh token");
    assert.equal((await refresh(app.baseUrl, a.clientId, a.accessToken)).status, 400, 'an access token as a refresh token');
    assert.equal((await refresh(app.baseUrl, a.clientId, a.refreshToken, 'https://evil.example/mcp')).status, 400, 'a refresh for another resource');
    assert.equal((await callTool(app.baseUrl, a.refreshToken, 'list_projects')).status, 401, 'a refresh token as a bearer');
    assert.equal((await callTool(app.baseUrl, a.accessToken, 'list_projects')).status, 200, 'the failed attempts did not end the real grant');
  } finally { await app.close(); }
});

test('an access token bound to another resource, or to none, is refused at /mcp', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    const db = app.deps.db!;
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const plant = (token: string, resource: string | null) =>
      db.prepare("INSERT INTO oauth_tokens(token_hash, grant_id, type, resource, expires_at) VALUES (?, ?, 'access', ?, ?)").run(sha256(token), c.grantId, resource, expires);
    plant('tok-other-resource', 'https://other.example/mcp');
    plant('tok-no-resource', null);
    assert.equal((await callTool(app.baseUrl, 'tok-other-resource', 'list_projects')).status, 401);
    assert.equal((await callTool(app.baseUrl, 'tok-no-resource', 'list_projects')).status, 401);
  } finally { await app.close(); }
});

test('authorize refuses a resource that is not this server\'s MCP endpoint, so no token is ever issued for another one', async () => {
  const { app, f } = await world();
  try {
    const reg = await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:9999/callback'], client_name: 'X', token_endpoint_auth_method: 'none' }) });
    const { client_id: clientId } = await reg.json() as { client_id: string };
    const res = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: 'https://evil.example/mcp',
    }), { redirect: 'manual' });
    assert.match(res.headers.get('location') ?? '', /^http:\/\/localhost:9999\/callback\?error=invalid_request/);
    assert.equal(app.deps.provider.listGrants().length, 0);
  } finally { await app.close(); }
});

test('an access token expires after its hour', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    app.advance((ACCESS_TTL_SEC + 5) * 1000);
    assert.equal((await callTool(app.baseUrl, c.accessToken, 'list_projects')).status, 401);
  } finally { await app.close(); }
});

test('no token, a made-up token, a token in the query string and a session cookie all get 401 at /mcp', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    assert.equal((await mcpCall(app.baseUrl, null, 'tools/list')).status, 401);
    assert.equal((await mcpCall(app.baseUrl, 'not-a-token', 'tools/list')).status, 401);
    const viaQuery = await fetch(`${app.baseUrl}/mcp?access_token=${c.accessToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(viaQuery.status, 401);
    const session = await f('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(session.status, 401, 'the owner\'s dashboard session is not an MCP credential');
  } finally { await app.close(); }
});

test('an assistant\'s bearer token opens nothing on the dashboard', async () => {
  const { app, f } = await world();
  try {
    const c = await connectWith(app, f);
    for (const path of ['/facts', '/approvals', '/settings', '/clients', '/pages', '/memories']) {
      const r = await fetch(app.baseUrl + path, { headers: { Authorization: `Bearer ${c.accessToken}` }, redirect: 'manual' });
      assert.equal(r.status, 302, path);
      assert.match(r.headers.get('location')!, /^\/login/);
    }
    const post = await fetch(app.baseUrl + '/settings/pause', { method: 'POST', headers: { Authorization: `Bearer ${c.accessToken}`, Origin: app.baseUrl }, redirect: 'manual' });
    assert.equal(post.status, 302);
    assert.equal(app.deps.service.savesPausedSince(), null);
  } finally { await app.close(); }
});
