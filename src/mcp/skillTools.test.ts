/** Shared skills (round 2 §17c): assistants list and load the skills that are On, and propose new ones. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NoteService } from '../pages/notes.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import { ProjectStore } from '../projects/store.js';
import { SkillService } from '../skills/service.js';
import { buildMcpServer } from './server.js';

async function connect(access: 'full' | 'discussions' | 'projects' = 'full') {
  const given = makeService();
  const pages = makePages(given);
  const skills = new SkillService(given.db, () => new Date());
  const server = buildMcpServer(given.service, 'Claude', {
    registry: new ProjectStore(given.db, () => new Date()), growth: makeGrowth(given), pages, notes: new NoteService(given.db, pages, () => new Date()),
    skills, access, projects: access === 'projects' ? ['wildlog'] : undefined,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' }); await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args }); return { text: r.content[0].text as string, isError: !!r.isError };
  };
  const names = async () => (await client.listTools().then((r) => r.tools.map((t) => t.name), () => [] as string[]));
  return { call, names, skills, pages };
}
const deploy = { name: 'brain-deploy', description: 'Use when deploying cairn to the mini PC.', body: '1. Back up.\n2. Tag, merge, push.' };

test('list_skills lists only skills that are On', async () => {
  const { call, skills } = await connect();
  const on = skills.create(deploy, 'owner');
  skills.setEnabled(on.id, true, 'owner');
  skills.create({ ...deploy, name: 'release-notes', description: 'Use when writing release notes.' }, 'owner');
  const r = await call('list_skills');
  assert.match(r.text, /brain-deploy/);
  assert.match(r.text, /Use when deploying cairn to the mini PC\./);
  assert.doesNotMatch(r.text, /release-notes/);
});

test('load_skill gives SKILL.md wrapped as owner-approved, lists files, loads one file, and records who loaded it', async () => {
  const { call, skills } = await connect();
  const s = skills.create({ ...deploy, files: [{ path: 'references/steps.md', text: 'Step detail.' }] }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  const r = await call('load_skill', { name: 'brain-deploy' });
  assert.equal(r.isError, false);
  assert.match(r.text, /Skill approved by the owner/);
  assert.ok(r.text.includes('name: brain-deploy'));
  assert.ok(r.text.includes('1. Back up.'));
  assert.match(r.text, /references\/steps\.md/);
  assert.match((await call('load_skill', { name: 'brain-deploy', file: 'references/steps.md' })).text, /Step detail\./);
  assert.equal((await call('load_skill', { name: 'brain-deploy', file: 'nope.md' })).isError, true);
  const after = skills.get(s.id)!;
  assert.equal(after.lastLoadedBy, 'Claude');
  assert.ok(after.lastLoadedAt);
});

test('load_skill of an Off or unknown skill says no skill by that name is on', async () => {
  const { call, skills } = await connect();
  skills.create(deploy, 'owner');
  for (const name of ['brain-deploy', 'nothing']) {
    const r = await call('load_skill', { name });
    assert.equal(r.isError, true);
    assert.match(r.text, new RegExp(`No skill named ${name} is on`));
    assert.doesNotMatch(r.text, /Back up/);
  }
});

test('propose_skill sends a proposal and says it waits for the owner; a second from the same connection replaces it', async () => {
  const { call, skills } = await connect();
  const r = await call('propose_skill', deploy);
  assert.match(r.text, /Sent to the owner: the skill "brain-deploy" waits in Approvals\. It is not on until the owner adds it\./);
  await call('propose_skill', { ...deploy, body: 'Better.' });
  assert.deepEqual(skills.pendingProposals().map((p) => p.body), ['Better.']);
  assert.deepEqual(skills.list(), []);
});

test('discussions-only and read-only connections have no skill tools', async () => {
  for (const access of ['discussions', 'projects'] as const) {
    const names = await (await connect(access)).names();
    for (const t of ['list_skills', 'load_skill', 'propose_skill']) assert.ok(!names.includes(t), `${access} ${t}`);
  }
  const full = await (await connect()).names();
  for (const t of ['list_skills', 'load_skill', 'propose_skill']) assert.ok(full.includes(t), t);
});

test('a skill never shows in recall, list_pages or read_page', async () => {
  const { call, skills } = await connect();
  const s = skills.create({ ...deploy, name: 'wildlog-runbook', description: 'wildlog runbook: how wildlog is deployed', body: 'wildlog deploy steps for the cellar app' }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  for (const [tool, args] of [['recall', { query: 'wildlog deploy runbook' }], ['list_pages', {}], ['read_page', { title: 'wildlog-runbook' }]] as const) {
    assert.doesNotMatch((await call(tool, args)).text, /wildlog deploy steps|wildlog-runbook/, tool);
  }
});
