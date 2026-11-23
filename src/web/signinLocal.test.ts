import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { MAX_NEW_CLIENTS_PER_DAY } from '../auth/clientsStore.js';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { appOfGrant } from '../setup/texts.js';
import { hasSignedIn } from './toolSignIn.js';
import type { ToolState } from '../desktop/tools.js';

const META = '/.well-known/oauth-authorization-server';
const meta = async (baseUrl: string, path = META) => await (await fetch(baseUrl + path)).json() as Record<string, unknown>;
const viaDoorCall = (port: number, host: string, method: string, path: string, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json', Origin: `https://${host}` } : {}) } }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});

test('local mode does not advertise client-ID metadata documents on localhost, so sign-in needs no internet', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const m = await meta(app.baseUrl);
  assert.notEqual(m.client_id_metadata_document_supported, true);
  assert.notEqual((await meta(app.baseUrl, META + '/mcp')).client_id_metadata_document_supported, true, 'the suffixed path too');
  assert.equal(m.registration_endpoint, `${app.baseUrl}/register`);
});

test('a server (not local mode) keeps advertising client-ID metadata documents', async (t) => {
  const app = await startTestApp({ localMode: false });
  t.after(() => app.close());
  assert.equal((await meta(app.baseUrl)).client_id_metadata_document_supported, true);
  assert.equal((await meta(app.baseUrl, META + '/mcp')).client_id_metadata_document_supported, true);
});

test('the public address of a local-mode brain (through the door) keeps advertising them', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-cimd-'));
  const app = await startTestApp({ localMode: true, statusDir });
  t.after(() => app.close());
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  for (const path of [META, META + '/mcp']) {
    const body = JSON.parse((await viaDoorCall(port, host, 'GET', path)).body) as Record<string, unknown>;
    assert.equal(body.client_id_metadata_document_supported, true, path);
    assert.equal(body.issuer, `https://${host}/`);
    assert.notEqual((await meta(app.baseUrl, path)).client_id_metadata_document_supported, true, `${path}: while localhost still does not`);
  }
});

for (const [name, slug, tool] of [['Claude Code (brainai)', 'claude-code', { id: 'claude-code', name: 'Claude Code' }], ['Codex', 'codex', { id: 'codex', name: 'Codex' }]] as const) {
  test(`local mode: ${name} signs in by dynamic registration (register, authorize, consent, token, refresh) and is recognised`, async (t) => {
    const app = await startTestApp({ localMode: true });
    t.after(() => app.close());
    const f = await loggedIn(app);
    const { accessToken, refreshToken, clientId } = await connectClient(app.baseUrl, f, name);
    assert.ok(accessToken);
    assert.ok(!clientId.startsWith('https://'), 'a registered id, not a document address');
    const grants = app.deps.provider.listGrants();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.clientName, name);
    assert.equal(appOfGrant(grants[0]!.clientName), slug);
    assert.equal(hasSignedIn(tool as Pick<ToolState, 'id' | 'name'>, grants), true);
    assert.equal(hasSignedIn({ id: 'opencode', name: 'OpenCode' }, grants), false);
    const refreshed = await fetch(app.baseUrl + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: `${app.baseUrl}/mcp` }),
    });
    assert.equal(refreshed.status, 200);
  });
}

test('local mode: a loopback callback on 127.0.0.1 (what Codex and Claude Code use) registers', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const res = await fetch(app.baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:60382/callback/abc'], client_name: 'Codex', token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201);
});

const reg = JSON.stringify({ redirect_uris: ['http://127.0.0.1:60382/callback/abc'], client_name: 'Codex', token_endpoint_auth_method: 'none' });

test('local mode: the daily registration cap, filled by public-door callers, does not block a localhost registration', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-cap-'));
  const app = await startTestApp({ localMode: true, statusDir });
  t.after(() => app.close());
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const now = new Date().toISOString();
  const ins = app.deps.db!.prepare("INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES (?, 'x', '{}', 0, ?)");
  for (let i = 0; i < MAX_NEW_CLIENTS_PER_DAY; i++) ins.run(`filler-${i}`, now);
  assert.equal((await viaDoorCall(port, host, 'POST', '/register', reg)).status, 400, 'the door is capped');
  const local = await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reg });
  assert.equal(local.status, 201, await local.clone().text());
});

test('a server still caps registrations per day', async (t) => {
  const app = await startTestApp({ localMode: false });
  t.after(() => app.close());
  const now = new Date().toISOString();
  const ins = app.deps.db!.prepare("INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES (?, 'x', '{}', 0, ?)");
  for (let i = 0; i < MAX_NEW_CLIENTS_PER_DAY; i++) ins.run(`filler-${i}`, now);
  assert.equal((await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reg })).status, 400);
});

test('local mode: a client signed in earlier with a CIMD id still refreshes when its document cannot be fetched (cache fallback)', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const id = 'https://chatgpt.com/oauth/codex/OBIxj_9oCcr-/client.json';
  const cb = 'http://127.0.0.1:60382/callback/abc';
  const doc = { client_id: id, client_name: 'Codex', redirect_uris: [cb], token_endpoint_auth_method: 'none' };
  app.deps.allowlist.add('https://chatgpt.com/oauth/codex/');
  // Cached two days ago: stale, so each use tries to fetch (noNetwork fails) and falls back to this copy.
  app.deps.db!.prepare("INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at, fetched_at) VALUES (?, 'Codex', ?, 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run(id, JSON.stringify(doc));
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: cb, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${app.baseUrl}/mcp` }), { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const approve = await f(auth.headers.get('location')!, { method: 'POST', body: new URLSearchParams({ decision: 'approve' }) });
  const code = new URL(approve.headers.get('location')!, app.baseUrl).searchParams.get('code')!;
  const post = (body: Record<string, string>) => fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, resource: `${app.baseUrl}/mcp`, ...body }) });
  const tok = await post({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: cb });
  assert.equal(tok.status, 200, await tok.clone().text());
  const { refresh_token } = await tok.json() as { refresh_token: string };
  const again = await post({ grant_type: 'refresh_token', refresh_token });
  assert.equal(again.status, 200, await again.clone().text());
});
