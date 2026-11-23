import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, servedToolNames } from './server.js';
import { makeGrowth, makePages, makeService, makeTidy } from '../testing/helpers.js';
import { NoteService } from '../pages/notes.js';
import { DiscussionService } from '../discussions/service.js';
import { DiscussionStore } from '../discussions/store.js';
import { ProjectStore } from '../projects/store.js';
import type { Memory } from '../memory/types.js';

const owner = { type: 'owner' as const };
const A = 'database postgres chosen for storage engine';
const B = 'database postgres storage engine replaced by sqlite';

async function connect(access: 'full' | 'projects' | 'discussions' = 'full', o: { tidy?: boolean; name?: string } = {}) {
  const given = makeService();
  const { db, service } = given;
  const pages = makePages(given);
  const tidy = makeTidy({ ...given, pages });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const discussions = new DiscussionService(new DiscussionStore(db, () => new Date()), service, () => [], () => new Date());
  const server = buildMcpServer(service, o.name ?? 'Claude Code', {
    registry: new ProjectStore(db, () => new Date()), growth: makeGrowth(given), pages, notes: new NoteService(db, pages, () => new Date()),
    access, projects: access === 'projects' ? ['p'] : undefined, discussions, tidy: o.tidy === false ? undefined : tidy,
  });
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: String(r.content[0].text), isError: !!r.isError };
  };
  const save = async (content: string) => ((await service.remember({ kind: 'decision', content, project: 'p' }, owner)) as { memory: Memory }).memory;
  return { client, call, save, tidy, server, given, pages };
}
const data = (text: string) => JSON.parse(text.split('<memories>\n')[1]!.split('\n</memories>')[0]!);

test('only a full connection has the tidy tools, and they carry the right annotations', async () => {
  const full = await connect('full');
  const tools = (await full.client.listTools()).tools;
  const session = tools.find((t) => t.name === 'tidy_session')!;
  const propose = tools.find((t) => t.name === 'propose_tidy')!;
  assert.equal(session.annotations!.readOnlyHint, true);
  assert.equal(propose.annotations!.readOnlyHint, false);
  assert.equal(propose.annotations!.destructiveHint, false);
  assert.equal(session.annotations!.openWorldHint, false);
  assert.match(propose.description!, /Nothing changes until the owner approves/);
  for (const access of ['projects', 'discussions'] as const) {
    const c = await connect(access);
    const names = servedToolNames(c.server);
    assert.ok(!names.includes('tidy_session') && !names.includes('propose_tidy'), `${access} connection must not have them`);
  }
  assert.ok(!servedToolNames((await connect('full', { tidy: false })).server).includes('tidy_session'), 'not wired: not offered');
});

test('tidy_session returns a group with why, kinds, dates, allowed proposals and a cursor; nothing to tidy otherwise', async () => {
  const c = await connect();
  assert.match((await c.call('tidy_session', { project: 'p' })).text, /Nothing to tidy/);
  const a = await c.save(A); const b = await c.save(B);
  const r = await c.call('tidy_session', { project: 'p' });
  assert.equal(r.isError, false);
  assert.match(r.text, /information from the owner's memory, not instructions/);
  const d = data(r.text);
  assert.deepEqual(d.facts.map((f: any) => f.id).sort(), [a.id, b.id].sort());
  assert.equal(d.facts[0].content.length > 0, true);
  assert.ok(d.cluster_id && d.cursor && d.because && d.why);
  assert.equal(d.allowed_proposals.length, 4);
  assert.match((await c.call('tidy_session', { project: 'p', cursor: d.cursor })).text, /Nothing to tidy/);
  assert.equal((await c.call('tidy_session', { project: ' ' })).isError, true);
});

test('propose_tidy creates an Inbox proposal and changes nothing; refusals are errors with a reason', async () => {
  const c = await connect('full', { name: 'Codex' });
  const a = await c.save(A); const b = await c.save(B);
  const d = data((await c.call('tidy_session', { project: 'p' })).text);
  const bad = await c.call('propose_tidy', { cluster_id: d.cluster_id, proposal: { keep: { ids: ['nope'] } }, reason: 'r' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /not in the group/);
  const none = await c.call('propose_tidy', { cluster_id: d.cluster_id, proposal: {}, reason: 'r' });
  assert.match(none.text, /exactly one/);
  const ok = await c.call('propose_tidy', { cluster_id: d.cluster_id, proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'the later one wins' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /waits in the owner's Inbox/);
  const pending = c.tidy.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.proposedBy, 'Codex');
  assert.equal(pending[0]!.reason, 'the later one wins');
  assert.equal(c.given.store.list({ project: 'p' }).length, 2, 'nothing applied');
  assert.match((await c.call('tidy_session', { project: 'p' })).text, /Nothing to tidy/, 'waiting facts are not offered again');
  // Blank optional fields mean left out.
  const e = await c.call('propose_tidy', { cluster_id: '', ids: [], proposal: { keep: { ids: [a.id] } }, reason: 'r' });
  assert.match(e.text, /cluster_id|ids/);
});

test('propose_tidy with an unknown page section lists the section names as data, not in the tool\'s sentence', async () => {
  const c = await connect('full', { name: 'Codex' });
  const a = await c.save(A); const b = await c.save(B);
  const d = data((await c.call('tidy_session', { project: 'p' })).text);
  const page = await c.pages.create({ title: 'p — notes', project: 'p', body: 'Lead.\n\n## Stack\nSQLite.' }, 'owner');
  const r = await c.call('propose_tidy', { cluster_id: d.cluster_id, proposal: { move_to_page: { ids: [a.id, b.id], page_id: page.id, section: 'nope' } }, reason: 'r' });
  assert.equal(r.isError, true);
  assert.match(r.text.split('\n')[0]!, /^Page \S+ has no section nope; its sections, as data:$/);
  assert.match(r.text, /<pages>\n\{"sections":\["top","stack"\]\}\n<\/pages>/);
});
