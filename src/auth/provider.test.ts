import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { openDb } from '../db.js';
import { COMMANDS } from '../cli.js';
import { OwnerAuth } from './owner.js';
import { RedirectAllowlist } from './redirects.js';
import { ClientsStore } from './clientsStore.js';
import { MemoryOAuthProvider, REFRESH_REUSE_GRACE_SEC } from './provider.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = new URL('https://memory.example.com/mcp');

async function setup() {
  let now = new Date('2026-01-01T00:00:00Z');
  const clock = () => now;
  const advance = (sec: number) => { now = new Date(now.getTime() + sec * 1000); };
  const db = openDb(':memory:');
  const allowlist = new RedirectAllowlist(db);
  const clients = new ClientsStore(db, allowlist, clock, (async () => { throw new Error('no network in tests'); }) as any);
  const p = new MemoryOAuthProvider(db, clients, allowlist, clock, RESOURCE);
  const client = await clients.registerClient!({ redirect_uris: [CALLBACK], client_name: 'Claude', token_endpoint_auth_method: 'none' } as any);
  return { db, p, client, clients, allowlist, advance };
}

function fakeRes() {
  const res = { status: 0, location: '', redirect(status: number, url: string) { res.status = status; res.location = url; } };
  return res;
}

async function startAuthorize(p: MemoryOAuthProvider, client: OAuthClientInformationFull, state = 's1') {
  const res = fakeRes();
  await p.authorize(client, { codeChallenge: 'chal', redirectUri: CALLBACK, state,
    resource: new URL('https://memory.example.com/mcp') }, res as any);
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/consent\//);
  return res.location.split('/consent/')[1];
}

async function authorizeAndApprove(p: MemoryOAuthProvider, client: OAuthClientInformationFull) {
  const id = await startAuthorize(p, client);
  assert.equal(p.getPending(id)!.redirectUri, CALLBACK);
  const url = new URL(await p.approvePending(id));
  assert.equal(url.origin + url.pathname, CALLBACK);
  assert.equal(url.searchParams.get('state'), 's1');
  return url.searchParams.get('code')!;
}

test('full flow: authorize → consent → code → tokens → verify', async () => {
  const { p, client, db } = await setup();
  const id = await startAuthorize(p, client);
  assert.deepEqual(p.getPending(id), { clientId: client.client_id, clientName: 'Claude', redirectUri: CALLBACK, suggestedAccess: 'full' });
  const url = new URL(await p.approvePending(id));
  const code = url.searchParams.get('code')!;
  assert.equal(p.getPending(id), undefined, 'pending row is consumed');
  await assert.rejects(p.approvePending(id), InvalidRequestError);
  // Codes are stored hashed, never in clear.
  const stored = db.prepare('SELECT code_hash, resource FROM oauth_codes').get() as any;
  assert.notEqual(stored.code_hash, code);
  assert.equal(stored.resource, 'https://memory.example.com/mcp');

  assert.equal(await p.challengeForAuthorizationCode(client, code), 'chal');
  const t = await p.exchangeAuthorizationCode(client, code, undefined, CALLBACK);
  assert.equal(t.token_type, 'Bearer');
  assert.equal(t.expires_in, 3600);
  assert.equal(t.scope, 'memory');
  assert.ok(t.access_token && t.refresh_token && t.access_token !== t.refresh_token);
  const tokenRows = db.prepare('SELECT token_hash FROM oauth_tokens').all() as any[];
  assert.ok(tokenRows.every((r) => r.token_hash !== t.access_token && r.token_hash !== t.refresh_token));

  const info = await p.verifyAccessToken(t.access_token);
  assert.equal(info.clientId, client.client_id);
  assert.equal(info.token, t.access_token);
  assert.deepEqual(info.scopes, ['memory']);
  assert.equal(info.expiresAt, Date.parse('2026-01-01T01:00:00Z') / 1000);
  assert.equal(info.resource!.href, 'https://memory.example.com/mcp');

  // Refreshed tokens keep the resource.
  const t2 = await p.exchangeRefreshToken(client, t.refresh_token!);
  assert.equal((await p.verifyAccessToken(t2.access_token)).resource!.href, 'https://memory.example.com/mcp');
});

test('code exchange validates client, redirect_uri, resource and unknown codes', async () => {
  const { p, client, clients } = await setup();
  const other = await clients.registerClient!({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } as any);
  const code = await authorizeAndApprove(p, client);
  await assert.rejects(p.challengeForAuthorizationCode(client, 'nope'), InvalidGrantError);
  await assert.rejects(p.challengeForAuthorizationCode(other, code), InvalidGrantError);
  await assert.rejects(p.exchangeAuthorizationCode(other, code), InvalidGrantError);
  await assert.rejects(p.exchangeAuthorizationCode(client, 'nope'), InvalidGrantError);
  await assert.rejects(p.exchangeAuthorizationCode(client, code, undefined, 'https://claude.com/api/mcp/auth_callback'), InvalidGrantError);
  await assert.rejects(p.exchangeAuthorizationCode(client, code, undefined, CALLBACK, new URL('https://other.example/mcp')), InvalidGrantError);
  // None of the failed attempts consumed the code.
  const t = await p.exchangeAuthorizationCode(client, code, undefined, CALLBACK, new URL('https://memory.example.com/mcp'));
  await p.verifyAccessToken(t.access_token);
});

test('authorization codes are single-use; reuse revokes the grant', async () => {
  const { p, client } = await setup();
  const code = await authorizeAndApprove(p, client);
  const t = await p.exchangeAuthorizationCode(client, code);
  await p.verifyAccessToken(t.access_token);
  // The SDK token handler asks for the challenge first; it must still answer so the reuse reaches the exchange.
  assert.equal(await p.challengeForAuthorizationCode(client, code), 'chal');
  await assert.rejects(p.exchangeAuthorizationCode(client, code), InvalidGrantError);
  await assert.rejects(p.verifyAccessToken(t.access_token), InvalidTokenError);
  await assert.rejects(p.exchangeRefreshToken(client, t.refresh_token!), InvalidGrantError);
  assert.ok(p.listGrants()[0].revokedAt);
});

test('refresh rotates; replaying an old refresh token after the grace period revokes the whole grant', async () => {
  const { p, client, advance } = await setup();
  const t1 = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  const t2 = await p.exchangeRefreshToken(client, t1.refresh_token!);
  assert.equal(t2.token_type, 'Bearer');
  assert.equal(t2.expires_in, 3600);
  assert.equal(t2.scope, 'memory');
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  await p.verifyAccessToken(t2.access_token);
  advance(REFRESH_REUSE_GRACE_SEC + 1);
  await assert.rejects(p.exchangeRefreshToken(client, t1.refresh_token!), InvalidGrantError); // replay
  await assert.rejects(p.verifyAccessToken(t2.access_token), InvalidTokenError); // grant revoked
  await assert.rejects(p.exchangeRefreshToken(client, t2.refresh_token!), InvalidGrantError);
});

test('a refresh token replayed within the grace period gets fresh tokens and keeps the grant', async () => {
  // Several sessions of one app share a login; two may refresh with the same token at nearly the same moment.
  const { p, client, advance } = await setup();
  const t1 = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  const t2 = await p.exchangeRefreshToken(client, t1.refresh_token!);
  advance(REFRESH_REUSE_GRACE_SEC);
  const t3 = await p.exchangeRefreshToken(client, t1.refresh_token!);
  assert.notEqual(t3.refresh_token, t2.refresh_token);
  await p.verifyAccessToken(t2.access_token);
  await p.verifyAccessToken(t3.access_token);
  await p.exchangeRefreshToken(client, t2.refresh_token!);
  await p.exchangeRefreshToken(client, t3.refresh_token!);
  assert.equal(p.listGrants()[0].revokedAt, null);
});

test('a revoked refresh token gets no grace period', async () => {
  const { p, client } = await setup();
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  await p.revokeToken(client, { token: t.refresh_token! });
  await assert.rejects(p.exchangeRefreshToken(client, t.refresh_token!), InvalidGrantError);
  assert.ok(p.listGrants()[0].revokedAt);
});

test('refresh rejects other clients, access tokens and unknown tokens', async () => {
  const { p, client, clients } = await setup();
  const other = await clients.registerClient!({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } as any);
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  await assert.rejects(p.exchangeRefreshToken(other, t.refresh_token!), InvalidGrantError);
  await assert.rejects(p.exchangeRefreshToken(client, t.access_token), InvalidGrantError);
  await assert.rejects(p.exchangeRefreshToken(client, 'nope'), InvalidGrantError);
  await assert.rejects(p.verifyAccessToken(t.refresh_token!), InvalidTokenError);
  await assert.rejects(p.verifyAccessToken('nope'), InvalidTokenError);
  // Still usable by its own client.
  await p.exchangeRefreshToken(client, t.refresh_token!);
});

test('expiry: access token after 1h, code after 5min, pending after 10min', async () => {
  const { p, client, advance } = await setup();
  // Pending request expires after 10 minutes.
  const id = await startAuthorize(p, client);
  advance(599);
  assert.ok(p.getPending(id));
  advance(2);
  assert.equal(p.getPending(id), undefined);
  await assert.rejects(p.approvePending(id), InvalidRequestError);

  // Code expires after 5 minutes.
  const code = await authorizeAndApprove(p, client);
  advance(301);
  await assert.rejects(p.exchangeAuthorizationCode(client, code), InvalidGrantError);

  // Access token expires after 1 hour; refresh token after 90 days.
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  advance(3599);
  await p.verifyAccessToken(t.access_token);
  advance(2);
  await assert.rejects(p.verifyAccessToken(t.access_token), InvalidTokenError);
  const t2 = await p.exchangeRefreshToken(client, t.refresh_token!);
  advance(90 * 86400 + 1);
  await assert.rejects(p.exchangeRefreshToken(client, t2.refresh_token!), InvalidGrantError);
});

test('authorize refuses a redirect that is not on the allowlist', async () => {
  const { p, client, db, allowlist } = await setup();
  const res = fakeRes();
  await assert.rejects(p.authorize({ ...client, redirect_uris: ['https://evil.example/cb'] },
    { codeChallenge: 'chal', redirectUri: 'https://evil.example/cb', state: 's' }, res as any), InvalidRequestError);
  assert.equal(res.location, '');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM oauth_pending').get() as any).n, 0);

  // A redirect removed from the allowlist after consent started cannot be approved either.
  const id = await startAuthorize(p, client);
  allowlist.remove(CALLBACK);
  await assert.rejects(p.approvePending(id), InvalidRequestError);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM oauth_codes').get() as any).n, 0);
});

test('revokeGrant invalidates its tokens; listGrants shows the client name and last use', async () => {
  const { p, client, advance } = await setup();
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  let [g] = p.listGrants();
  assert.equal(g.clientId, client.client_id);
  assert.equal(g.clientName, 'Claude');
  assert.equal(g.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(g.lastUsedAt, null);
  assert.equal(g.revokedAt, null);

  advance(10);
  await p.verifyAccessToken(t.access_token);
  assert.equal(p.listGrants()[0].lastUsedAt, '2026-01-01T00:00:10.000Z');
  advance(30);
  await p.verifyAccessToken(t.access_token);
  assert.equal(p.listGrants()[0].lastUsedAt, '2026-01-01T00:00:10.000Z', 'updated at most once a minute');
  advance(31);
  await p.verifyAccessToken(t.access_token);
  assert.equal(p.listGrants()[0].lastUsedAt, '2026-01-01T00:01:11.000Z');

  p.revokeGrant(g.id);
  [g] = p.listGrants();
  assert.equal(g.revokedAt, '2026-01-01T00:01:11.000Z');
  await assert.rejects(p.verifyAccessToken(t.access_token), InvalidTokenError);
  await assert.rejects(p.exchangeRefreshToken(client, t.refresh_token!), InvalidGrantError);
  assert.throws(() => p.revokeGrant('nope'));
});

test('revokeToken revokes the matching token and ignores unknown ones', async () => {
  const { p, client, clients } = await setup();
  const other = await clients.registerClient!({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' } as any);
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  await p.revokeToken!(client, { token: 'nope' });
  await p.revokeToken!(other, { token: t.access_token }); // not theirs: no effect
  await p.verifyAccessToken(t.access_token);
  await p.revokeToken!(client, { token: t.access_token });
  await assert.rejects(p.verifyAccessToken(t.access_token), InvalidTokenError);
});

test('revoking a refresh token revokes the whole grant, so an older rotated token gets no grace (logout)', async () => {
  const { p, client, advance } = await setup();
  const t1 = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  const t2 = await p.exchangeRefreshToken(client, t1.refresh_token!);
  await p.revokeToken!(client, { token: t2.refresh_token! });
  await assert.rejects(p.verifyAccessToken(t2.access_token), InvalidTokenError);
  advance(1);
  await assert.rejects(p.exchangeRefreshToken(client, t1.refresh_token!), InvalidGrantError);
  assert.ok(p.listGrants()[0].revokedAt);
});

test('revoking an already rotated refresh token also ends its grace', async () => {
  const { p, client, advance } = await setup();
  const t1 = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  await p.exchangeRefreshToken(client, t1.refresh_token!);
  await p.revokeToken!(client, { token: t1.refresh_token! });
  advance(1);
  await assert.rejects(p.exchangeRefreshToken(client, t1.refresh_token!), InvalidGrantError);
  assert.ok(p.listGrants()[0].revokedAt);
});

test('denyPending returns access_denied with state and issuer', async () => {
  const { p, client, db } = await setup();
  const id = await startAuthorize(p, client, 'xyz');
  const url = new URL(p.denyPending(id));
  assert.equal(url.origin + url.pathname, CALLBACK);
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(url.searchParams.get('iss'), 'https://memory.example.com/');
  assert.equal(url.searchParams.get('code'), null);
  assert.equal(p.getPending(id), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM oauth_pending').get() as any).n, 0);
  assert.throws(() => p.denyPending(id), InvalidRequestError);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM oauth_grants').get() as any).n, 0);
});

test('cli clients list / revoke', async () => {
  const { p, client, db } = await setup();
  const t = await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  const [g] = p.listGrants();
  const ctx = (args: string[]) => ({ db, owner: new OwnerAuth(db, () => new Date()), args });
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    await COMMANDS.clients(ctx(['list']));
    await COMMANDS.clients(ctx(['revoke', g.id]));
  } finally {
    console.log = orig;
  }
  assert.ok(logged[0].includes(g.id) && logged[0].includes('Claude'));
  await assert.rejects(p.verifyAccessToken(t.access_token), InvalidTokenError);
  await assert.rejects(COMMANDS.clients(ctx(['revoke'])));
  await assert.rejects(COMMANDS.clients(ctx(['revoke', 'nope'])));
  await assert.rejects(COMMANDS.clients(ctx([])));
});

async function pendingResource(p: MemoryOAuthProvider, client: OAuthClientInformationFull, resource: URL | undefined) {
  const res = fakeRes();
  await p.authorize(client, { codeChallenge: 'chal', redirectUri: CALLBACK, resource }, res as any);
  const id = res.location.split('/consent/')[1]!;
  const code = new URL(await p.approvePending(id)).searchParams.get('code')!;
  const t = await p.exchangeAuthorizationCode(client, code, undefined, CALLBACK);
  return (await p.verifyAccessToken(t.access_token)).resource?.href;
}

test('authorize binds a missing resource to the MCP endpoint', async () => {
  const { p, client } = await setup();
  assert.equal(await pendingResource(p, client, undefined), 'https://memory.example.com/mcp');
});

test('authorize accepts the MCP resource up to fragment and one trailing slash', async () => {
  const { p, client } = await setup();
  assert.equal(await pendingResource(p, client, new URL('https://memory.example.com/mcp/')), 'https://memory.example.com/mcp/');
  assert.equal(await pendingResource(p, client, new URL('https://memory.example.com/mcp#x')), 'https://memory.example.com/mcp#x');
});

test('authorize rejects a resource other than the MCP endpoint', async () => {
  const { p, client, db } = await setup();
  for (const r of ['https://other.example.com/mcp', 'https://memory.example.com/mcp/other', 'https://memory.example.com/', 'http://memory.example.com/mcp']) {
    const res = fakeRes();
    await assert.rejects(p.authorize(client, { codeChallenge: 'chal', redirectUri: CALLBACK, resource: new URL(r) }, res as any),
      (e: unknown) => e instanceof InvalidRequestError && /resource/i.test((e as Error).message), r);
    assert.equal(res.status, 0, r);
  }
  assert.equal((db.prepare('SELECT count(*) c FROM oauth_pending').get() as any).c, 0);
});

test('approve accepts a loopback redirect on another port than registered (RFC 8252 §7.3)', async () => {
  const { p, clients } = await setup();
  const native = await clients.registerClient!({ redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none' } as any);
  const res = fakeRes();
  await p.authorize(native, { codeChallenge: 'chal', redirectUri: 'http://localhost:12345/callback', state: 's' }, res as any);
  const url = new URL(await p.approvePending(res.location.split('/consent/')[1]!));
  assert.equal(url.origin + url.pathname, 'http://localhost:12345/callback');
  const code = url.searchParams.get('code')!;
  // The code keeps the requested URI, so /token's redirect_uri check matches what the client used.
  await assert.rejects(p.exchangeAuthorizationCode(native, code, undefined, 'http://localhost:9999/callback'), InvalidGrantError);
  const res2 = fakeRes();
  await p.authorize(native, { codeChallenge: 'chal', redirectUri: 'http://localhost:12345/callback' }, res2 as any);
  const code2 = new URL(await p.approvePending(res2.location.split('/consent/')[1]!)).searchParams.get('code')!;
  assert.ok((await p.exchangeAuthorizationCode(native, code2, undefined, 'http://localhost:12345/callback')).access_token);
});

test('approve still rejects a non-loopback redirect that differs only in port', async () => {
  const { p, client, allowlist } = await setup();
  allowlist.add('https://claude.ai:8443/api/mcp/auth_callback');
  const res = fakeRes();
  await p.authorize(client, { codeChallenge: 'chal', redirectUri: 'https://claude.ai:8443/api/mcp/auth_callback' }, res as any);
  const id = res.location.split('/consent/')[1]!;
  await assert.rejects(p.approvePending(id), InvalidRequestError);
  assert.ok(p.getPending(id), 'pending request untouched');
});

test('approvePending stores the chosen access and name', async () => {
  const { p, client, clients } = await setup();
  const id = await startAuthorize(p, client);
  await p.approvePending(id, { name: ' Grok Build ', access: 'discussions' });
  const [g] = p.listGrants();
  assert.equal(g!.access, 'discussions');
  assert.equal(g!.clientName, 'Grok Build');
  assert.equal(p.grantAccess(g!.id), 'discussions');
  assert.equal(clients.clientName(client.client_id), 'Grok Build');
  p.setGrantAccess(g!.id, 'full');
  assert.equal(p.grantAccess(g!.id), 'full');
  // An unchanged name is not stored as a display name.
  const id2 = await startAuthorize(p, client);
  await p.approvePending(id2, { name: 'Grok Build' });
  assert.deepEqual(p.listGrants().map((g) => g.access).sort(), ['full', 'full']);
  const id3 = await startAuthorize(p, client);
  await assert.rejects(p.approvePending(id3, { name: 'owner' }), /owner/);
  assert.ok(p.getPending(id3));
});

test('two connections of one app keep their own names; the next consent suggests the latest one', async () => {
  const { p, client, clients } = await setup();
  await p.approvePending(await startAuthorize(p, client), { name: 'WorkCodex', access: 'discussions' });
  await p.approvePending(await startAuthorize(p, client), { name: 'Codex' });
  const named = () => p.listGrants().map((g) => `${g.clientName} ${g.access}`).sort();
  assert.deepEqual(named(), ['Codex full', 'WorkCodex discussions']);
  const work = p.listGrants().find((g) => g.access === 'discussions')!;
  assert.equal(p.grantName(work.id), 'WorkCodex');
  assert.equal(p.getPending(await startAuthorize(p, client))!.clientName, 'Codex');
  // Renaming one connection leaves the other, and the app's suggested name, as they were.
  p.setGrantName(work.id, ' Work laptop ');
  assert.deepEqual(named(), ['Codex full', 'Work laptop discussions']);
  assert.equal(clients.clientName(client.client_id), 'Codex');
  assert.throws(() => p.setGrantName(work.id, 'owner'), /owner/);
  assert.throws(() => p.setGrantName('no-such-grant', 'x'), /Unknown grant/);
  assert.deepEqual(p.activeConnections().sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'Codex', access: 'full' }, { name: 'Work laptop', access: 'discussions' }]);
  // A consent with no name takes the app's name at that moment, and keeps it.
  await p.approvePending(await startAuthorize(p, client));
  clients.setDisplayName(client.client_id, 'Renamed later');
  assert.deepEqual(named(), ['Codex full', 'Codex full', 'Work laptop discussions']);
  assert.equal(p.grantName('no-such-grant'), 'Unknown client');
});

test('a connection with no stored name keeps the name it showed when its app is renamed at a later consent', async () => {
  const { db, p, client } = await setup();
  await p.approvePending(await startAuthorize(p, client));
  // As migration 24 leaves a grant whose app had no name at all.
  db.prepare('UPDATE oauth_grants SET name = NULL').run();
  const [old] = p.listGrants();
  assert.equal(old!.clientName, 'Claude');
  await p.approvePending(await startAuthorize(p, client), { name: 'Claude Laptop', access: 'full' });
  assert.equal(p.grantName(old!.id), 'Claude');
});

test('new grants default to full access', async () => {
  const { db, p, client } = await setup();
  await authorizeAndApprove(p, client);
  assert.equal(p.listGrants()[0]!.access, 'full');
  db.prepare("UPDATE oauth_grants SET access = 'discussions'").run();
  assert.equal(p.listGrants()[0]!.access, 'discussions');
  // Fails closed: an unknown grant gets discussions only.
  assert.equal(p.grantAccess('no-such-grant'), 'discussions');
});

test('the suggested access follows the earlier grants to clients registered under the same name', async () => {
  const { p, client, clients } = await setup();
  const register = (name?: string) => clients.registerClient!({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none' } as any);
  const pendingFor = async (c: OAuthClientInformationFull) => p.getPending(await startAuthorize(p, c))!;
  assert.equal((await pendingFor(client)).suggestedAccess, 'full');
  // Approved as discussions-only and renamed: the registered name ("Claude") still matches, the display name does not.
  await p.approvePending(await startAuthorize(p, client), { name: 'Claude Laptop', access: 'discussions' });
  assert.equal((await pendingFor(await register('Claude'))).suggestedAccess, 'discussions');
  assert.equal((await pendingFor(await register('Claude Laptop'))).suggestedAccess, 'full');
  assert.equal((await pendingFor(await register('Other'))).suggestedAccess, 'full');
  assert.equal((await pendingFor(await register(undefined))).suggestedAccess, 'full');
  // An app already connected with full access may be a second account of it (a work ChatGPT): the owner chooses.
  const other = await register('Other');
  await p.approvePending(await startAuthorize(p, other));
  assert.equal((await pendingFor(await register('Other'))).suggestedAccess, null);
  // Once the same app has connections with different levels (two accounts of one app), nothing is preselected.
  const again = await register('Claude');
  await p.approvePending(await startAuthorize(p, again), { access: 'full' });
  assert.equal((await pendingFor(await register('Claude'))).suggestedAccess, null);
});

test('verifyAccessToken reports the grant id', async () => {
  const { p, client } = await setup();
  const code = await authorizeAndApprove(p, client);
  const tokens = await p.exchangeAuthorizationCode(client, code, 'v', CALLBACK, RESOURCE);
  const info = await p.verifyAccessToken(tokens.access_token);
  assert.equal((info.extra as any).grantId, p.listGrants()[0]!.id);
});

test('activeConnections lists names used in the last 30 days, once each', async () => {
  const { db, p, client, clients, advance } = await setup();
  const c2 = await clients.registerClient!({ redirect_uris: [CALLBACK], client_name: 'Grok', token_endpoint_auth_method: 'none' } as any);
  const c3 = await clients.registerClient!({ redirect_uris: [CALLBACK], client_name: 'Old', token_endpoint_auth_method: 'none' } as any);
  await p.approvePending(await startAuthorize(p, client), { access: 'discussions' });
  await p.approvePending(await startAuthorize(p, client), { access: 'full' });
  await p.approvePending(await startAuthorize(p, c2), { access: 'discussions' });
  await p.approvePending(await startAuthorize(p, c3));
  advance(40 * 86400);
  // Re-create the recent ones' activity by marking them used now.
  const now = new Date('2026-01-01T00:00:00Z').getTime() + 40 * 86400_000;
  db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE client_id IN (?, ?)').run(new Date(now - 86400_000).toISOString(), client.client_id, c2.client_id);
  const list = p.activeConnections();
  assert.deepEqual(list.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'Claude', access: 'full' }, { name: 'Grok', access: 'discussions' }]);
  const g = p.listGrants().find((x) => x.clientId === client.client_id && x.access === 'full')!;
  p.revokeGrant(g.id);
  assert.deepEqual(p.activeConnections().map((x) => x.name).sort(), ['Claude', 'Grok']);
  assert.equal(p.activeConnections().find((x) => x.name === 'Claude')!.access, 'discussions');
});

test('authorize refuses an oversized state or code challenge before storing anything', async () => {
  const { p, client, db } = await setup();
  await assert.rejects(p.authorize(client, { codeChallenge: 'chal', redirectUri: CALLBACK, state: 's'.repeat(1025) }, fakeRes() as any), InvalidRequestError);
  await assert.rejects(p.authorize(client, { codeChallenge: 'c'.repeat(129), redirectUri: CALLBACK, state: 's' }, fakeRes() as any), InvalidRequestError);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM oauth_pending').get() as any).n, 0);
  await p.authorize(client, { codeChallenge: 'c'.repeat(128), redirectUri: CALLBACK, state: 's'.repeat(1024) }, fakeRes() as any);
});

test('cli clients purge-unused deletes registrations that never got a grant, now', async () => {
  const { p, client, db } = await setup();
  await p.exchangeAuthorizationCode(client, await authorizeAndApprove(p, client));
  db.prepare(`INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES ('unused', 'X', '{}', 0, ?)`).run(new Date().toISOString());
  const ctx = (args: string[]) => ({ db, owner: new OwnerAuth(db, () => new Date()), args });
  const orig = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try { await COMMANDS.clients(ctx(['purge-unused'])); } finally { console.log = orig; }
  assert.deepEqual(logged, ['Deleted 1 unused registration.']);
  assert.deepEqual(db.prepare('SELECT client_id FROM oauth_clients').all().map((r: any) => r.client_id), [client.client_id]);
});

test('cli clients purge-unused keeps a registration whose sign-in is waiting for consent', async () => {
  const { p, client, db } = await setup();
  await startAuthorize(p, client);
  // The CLI runs on the real clock; this test's provider clock is in January.
  db.prepare('UPDATE oauth_pending SET expires_at = ?').run(new Date(Date.now() + 600_000).toISOString());
  const ctx = (args: string[]) => ({ db, owner: new OwnerAuth(db, () => new Date()), args });
  const orig = console.log;
  console.log = () => {};
  try { await COMMANDS.clients(ctx(['purge-unused'])); } finally { console.log = orig; }
  assert.deepEqual(db.prepare('SELECT client_id FROM oauth_clients').all().map((r: any) => r.client_id), [client.client_id]);
});

test('a read-only grant stores its projects; other access levels have none', async () => {
  const { p, client } = await setup();
  await p.approvePending(await startAuthorize(p, client), { access: 'projects', projects: ['trellis', 'office-pool'] });
  const [g] = p.listGrants();
  assert.equal(g!.access, 'projects');
  assert.deepEqual(g!.projects, ['trellis', 'office-pool']);
  assert.deepEqual(p.grantProjects(g!.id), ['trellis', 'office-pool']);
  p.setGrantAccess(g!.id, 'projects', ['trellis']);
  assert.deepEqual(p.grantProjects(g!.id), ['trellis']);
  // Leaving read-only drops the list, so a later switch back starts from nothing.
  p.setGrantAccess(g!.id, 'full');
  assert.deepEqual(p.grantProjects(g!.id), []);
  assert.deepEqual(p.grantProjects('no-such-grant'), []);
});

test('read-only access needs at least one valid project name, and the request stays open', async () => {
  const { p, client } = await setup();
  const id = await startAuthorize(p, client);
  await assert.rejects(p.approvePending(id, { access: 'projects' }), InvalidRequestError);
  await assert.rejects(p.approvePending(id, { access: 'projects', projects: [] }), InvalidRequestError);
  await assert.rejects(p.approvePending(id, { access: 'projects', projects: ['Not A Name'] }), InvalidRequestError);
  assert.ok(p.getPending(id));
  assert.equal(p.listGrants().length, 0);
  await p.approvePending(id, { access: 'full', projects: ['trellis'] });
  assert.deepEqual(p.grantProjects(p.listGrants()[0]!.id), []);
  assert.throws(() => p.setGrantAccess(p.listGrants()[0]!.id, 'projects', []));
});

test('read-only connections are not offered as discussion participants', async () => {
  const { p, client, clients } = await setup();
  const work = await clients.registerClient!({ redirect_uris: [CALLBACK], client_name: 'ChatGPT', token_endpoint_auth_method: 'none' } as any);
  await p.approvePending(await startAuthorize(p, client));
  await p.approvePending(await startAuthorize(p, work), { access: 'projects', projects: ['trellis'] });
  assert.deepEqual(p.activeConnections(), [{ name: 'Claude', access: 'full' }]);
});
