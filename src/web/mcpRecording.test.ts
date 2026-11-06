/** Guided setup (round 2 §17b): the /mcp route remembers which tools each connection last saw, and its setup version. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';

async function world(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const { accessToken } = await connectClient(app.baseUrl, f, 'ChatGPT');
  const post = async (body: unknown) => {
    const res = await fetch(app.baseUrl + '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  };
  const grant = () => app.deps.provider.listGrants().find((g) => !g.revokedAt)!;
  return { app, post, grant };
}

test('tools/list records the tool names on the grant', async (t) => {
  const { post, grant } = await world(t);
  assert.equal(grant().toolNames, null);
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const g = grant();
  assert.ok(g.toolNames!.includes('remember') && g.toolNames!.includes('load_profile'), String(g.toolNames));
  assert.deepEqual(g.toolNames, [...g.toolNames!].sort());
  assert.ok(g.toolsSeenAt);
});

test('a batch holding tools/list records too', async (t) => {
  const { post, grant } = await world(t);
  await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
  assert.ok(grant().toolNames?.includes('recall'));
});

test('a discussions-only grant records its own smaller set', async (t) => {
  const { app, post, grant } = await world(t);
  app.deps.provider.setGrantAccess(grant().id, 'discussions');
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(!grant().toolNames!.includes('remember'), String(grant().toolNames));
});

test('load_profile with setup records the version and the time', async (t) => {
  const { post, grant } = await world(t);
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'load_profile', arguments: { setup: 2 } } });
  assert.equal(grant().setupVersion, 2);
  assert.ok(grant().setupSeenAt);
});

test('a failure to record the tool list never fails the request', async (t) => {
  const { app, post } = await world(t);
  (app.deps.provider as any).recordTools = () => { throw new Error('SQLITE_BUSY'); };
  assert.equal(await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), 200);
});
