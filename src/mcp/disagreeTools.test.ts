import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../projects/store.js';
import { NoteService } from '../pages/notes.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import type { Memory } from '../memory/types.js';
import { buildMcpServer } from './server.js';

const owner = { type: 'owner' } as const;

function setup() {
  const given = makeService();
  const { service, db } = given;
  const growth = makeGrowth(given);
  const pages = makePages(given);
  const notes = new NoteService(db, pages, () => new Date());
  const connect = async (name: string, access: 'full' | 'projects' = 'full', projects?: string[]) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, name, { registry: new ProjectStore(db, () => new Date()), growth, pages, notes, access, projects } as never).connect(st);
    const client = new Client({ name: 't', version: '0' }); await client.connect(ct);
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name: tool, arguments: args }); return { text: r.content[0].text as string, isError: !!r.isError };
    };
    return { client, call };
  };
  const save = async (content: string, project: string | undefined = 'homelab', kind: 'decision' | 'profile' = 'decision') => {
    const r = await service.remember({ kind, content, project, allowDuplicate: true }, owner);
    return (r as { memory: Memory }).memory;
  };
  return { service, connect, save };
}

const dataOf = (text: string) => JSON.parse(text.slice(text.indexOf('<memories>\n') + 11, text.lastIndexOf('\n</memories>')));
const profileOf = (text: string) => JSON.parse(text.slice(text.indexOf('<memories>\n') + 11, text.indexOf('\n</memories>')));

test('a full connection can flag a disagreement; a read-only one cannot', async () => {
  const { connect } = setup();
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
  assert.ok((await names((await connect('Claude Code')).client)).includes('flag_disagreement'));
  assert.ok(!(await names((await connect('Grok', 'projects', ['homelab'])).client)).includes('flag_disagreement'));
});

test('after a save, the closest facts of the same project and kind are shown, with how to flag a disagreement', async () => {
  const { connect, save } = setup();
  const old = await save('The media server listens on port 3000 behind the reverse proxy');
  await save('Jellyfin keeps its media on the NAS share', 'other-project');
  const c = await connect('Claude Code');
  const r = await c.call('remember', { kind: 'decision', project: 'homelab', content: 'The media server listens on port 3100 behind the proxy' });
  assert.match(r.text, /^Saved\./);
  assert.match(r.text, /can't both be true, call flag_disagreement/);
  const data = dataOf(r.text);
  assert.deepEqual(data.at(-1).close_facts.map((f: any) => f.id), [old.id]);

  const far = await c.call('remember', { kind: 'decision', project: 'homelab', content: 'Nightly backups copy everything offsite' });
  assert.doesNotMatch(far.text, /flag_disagreement/);
});

test('flag_disagreement flags once, then says it is already flagged; mistakes come back as errors', async () => {
  const { connect, save } = setup();
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100');
  const c = await connect('Claude Code');
  const first = await c.call('flag_disagreement', { a: a.id, b: b.id, why: 'Two different ports' });
  assert.equal(first.isError, false);
  assert.match(first.text, /^Flagged: the owner will settle it on the dashboard\./);
  assert.match((await c.call('flag_disagreement', { a: b.id, b: a.id, why: 'again' })).text, /already flagged/);
  assert.equal((await c.call('flag_disagreement', { a: a.id, b: a.id, why: 'x' })).isError, true);
});

test('recall, project_brief and load_profile mark a fact in an open disagreement, until the owner settles it', async () => {
  const { service, connect, save } = setup();
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100');
  const p1 = await save('Prefers short answers', undefined, 'profile');
  const p2 = await save('Prefers long detailed answers', undefined, 'profile');
  const c = await connect('Claude Code');
  await c.call('flag_disagreement', { a: a.id, b: b.id, why: 'Two different ports' });
  await c.call('flag_disagreement', { a: p1.id, b: p2.id, why: 'Short or long' });

  const recall = await c.call('recall', { query: 'which port does the server listen on' });
  const byId = new Map(dataOf(recall.text).map((m: any) => [m.id, m]));
  assert.deepEqual((byId.get(a.id) as any).disagrees_with, [{ id: b.id, why: 'Two different ports' }]);
  assert.match(recall.text, /disagrees_with/);
  assert.match(recall.text, /not settled yet/);

  const brief = await c.call('project_brief', { project: 'homelab' });
  const decisions = JSON.parse(brief.text.slice(brief.text.indexOf('<memories>\n') + 11, brief.text.lastIndexOf('\n</memories>'))).decisions;
  assert.deepEqual(decisions.find((m: any) => m.id === b.id).disagrees_with, [{ id: a.id, why: 'Two different ports' }]);

  const profile = profileOf((await c.call('load_profile')).text);
  assert.deepEqual(profile.find((m: any) => m.id === p1.id).disagrees_with, [{ id: p2.id, why: 'Short or long' }]);

  for (const d of service.openDisagreements()) service.settleDisagreement(d.id, 'both', owner);
  const after = dataOf((await c.call('recall', { query: 'which port does the server listen on' })).text);
  assert.ok(after.every((m: any) => m.disagrees_with === undefined));
});

test('a connection limited to some projects never hears of a fact outside them', async () => {
  const { connect, save } = setup();
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100', 'secret-project');
  const full = await connect('Claude Code');
  await full.call('flag_disagreement', { a: a.id, b: b.id, why: 'Two different ports' });
  const limited = await connect('Grok', 'projects', ['homelab']);
  const recall = dataOf((await limited.call('recall', { query: 'which port does the server listen on', project: 'homelab' })).text);
  assert.equal(recall.find((m: any) => m.id === a.id).disagrees_with, undefined);
});
