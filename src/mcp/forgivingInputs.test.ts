import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../projects/store.js';
import { makeService } from '../testing/helpers.js';
import { buildMcpServer } from './server.js';

const NOW = new Date('2026-11-19T10:00:00Z');

async function connect() {
  const given = makeService({ now: () => NOW });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(given.service, 'Codex', { registry: new ProjectStore(given.db, () => NOW), access: 'full', projects: [] } as never);
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((b: any) => b.text).join('\n') as string, isError: !!r.isError };
  };
  return { ...given, call, client };
}

const ITEM = { content: 'harbor staging runs on a small box that the owner calls lantern', kind: 'decision', project: 'harbor' };

test('remember takes keys as a list and joins it with commas', async () => {
  const { call, store } = await connect();
  const r = await call('remember', { kind: 'decision', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor', new_project: true, keys: ['deploy', 'docker compose', 'staging'] });
  assert.equal(r.isError, false, r.text);
  assert.equal(store.list({ project: 'harbor' })[0]!.keys, 'deploy, docker compose, staging');
});

test('keys as a list also works in update_memory and suggest_memories', async () => {
  const { call, store } = await connect();
  const saved = await call('remember', { kind: 'decision', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor', new_project: true });
  assert.equal(saved.isError, false, saved.text);
  const id = store.list({ project: 'harbor' })[0]!.id;
  const u = await call('update_memory', { id, keys: ['deploy', 'compose'] });
  assert.equal(u.isError, false, u.text);
  assert.equal(store.get(id)!.keys, 'deploy, compose');
  const s = await call('suggest_memories', { session: 'a', items: [{ ...ITEM, keys: ['lantern', 'staging'] }] });
  assert.equal(s.isError, false, s.text);
});

test('keys as a string still works, and a list of non-strings is refused', async () => {
  const { call } = await connect();
  const ok = await call('remember', { kind: 'decision', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor', new_project: true, keys: 'deploy, compose' });
  assert.equal(ok.isError, false, ok.text);
  const bad = await call('remember', { kind: 'decision', content: 'harbor logs go to a file on the staging box', project: 'harbor', keys: [1, 2] });
  assert.equal(bad.isError, true);
});

test('unknown extra fields are ignored instead of failing', async () => {
  const { call } = await connect();
  const r = await call('remember', { kind: 'decision', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor', new_project: true, session_label: 'x', whatever: 1 });
  assert.equal(r.isError, false, r.text);
  const s = await call('suggest_memories', { session: 'a', session_label: 'b', items: [{ ...ITEM, extra: true }] });
  assert.equal(s.isError, false, s.text);
});

test('an unknown kind is refused with the valid kinds listed', async () => {
  const { call } = await connect();
  for (const [tool, args] of [
    ['remember', { kind: 'note', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor' }],
    ['suggest_memories', { session: 'a', items: [{ ...ITEM, kind: 'note' }] }],
    ['recall', { query: 'harbor', kind: 'note' }],
  ] as const) {
    const r = await call(tool, { ...args });
    assert.equal(r.isError, true, tool);
    for (const k of ['profile', 'decision', 'summary', 'roadmap'].filter((k) => tool !== 'suggest_memories' || k !== 'roadmap')) assert.match(r.text, new RegExp(k), `${tool}: ${r.text}`);
    assert.match(r.text, /kind/, tool);
  }
});

test('an empty list of keys leaves them alone; only an empty string clears them', async () => {
  const { call, store } = await connect();
  await call('remember', { kind: 'decision', content: 'harbor deploys with a single compose file on the staging box', project: 'harbor', new_project: true, keys: 'deploy, compose' });
  const id = store.list({ project: 'harbor' })[0]!.id;
  const r = await call('update_memory', { id, content: 'harbor deploys with a single compose file on the staging box, via ssh', keys: [] });
  assert.equal(r.isError, false, r.text);
  assert.equal(store.get(id)!.keys, 'deploy, compose');
  await call('update_memory', { id, keys: ['', '  '] });
  assert.equal(store.get(id)!.keys, 'deploy, compose');
  await call('update_memory', { id, keys: '' });
  assert.equal(store.get(id)!.keys, '');
});

test('the published schema keeps keys a plain string, with no anyOf', async () => {
  const { client } = await connect();
  for (const t of (await client.listTools()).tools) {
    const keys = (t.inputSchema.properties as any)?.keys ?? (t.inputSchema.properties as any)?.items?.items?.properties?.keys;
    if (keys) { assert.equal(keys.type, 'string', t.name); assert.equal(keys.anyOf, undefined, t.name); }
  }
});
