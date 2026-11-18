import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../projects/store.js';
import { NoteService } from '../pages/notes.js';
import { LearningService } from '../learning/service.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import { buildMcpServer } from './server.js';
import { BRIEF_BUDGET } from './budget.js';

const owner = { type: 'owner' } as const;

function setup() {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const given = makeService({ now: () => new Date(t) });
  const { service, db } = given;
  const registry = new ProjectStore(db, () => new Date());
  const learning = new LearningService(db, () => new Date(), { match: () => ({ byProject: new Map(), unmatched: [], receivedAt: null, device: null }) },
    { get: (n) => registry.get(n), named: (n) => service.projectNamed(n) });
  const growth = makeGrowth(given);
  const pages = makePages(given, () => new Date(t));
  const notes = new NoteService(db, pages, () => new Date(t));
  const connect = async (o: { access?: 'full' | 'projects'; projects?: string[] } = {}) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, 'Claude Code', { registry, growth, pages, notes, learning, access: o.access ?? 'full', projects: o.projects } as never).connect(st);
    const client = new Client({ name: 't', version: '0' }); await client.connect(ct);
    return async (tool: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name: tool, arguments: args }); return r.content[0].text as string;
    };
  };
  const save = async (kind: string, content: string, project = 'big', keys?: string) => {
    t += 60_000;
    return service.remember({ kind: kind as never, content, project, allowDuplicate: true, keys }, owner);
  };
  const tick = () => { t += 60_000; };
  return { connect, save, registry, pages, notes, tick };
}
const dataOf = (text: string) => JSON.parse(text.slice(text.indexOf('<memories>\n') + 11, text.lastIndexOf('\n</memories>')));
const roadmap = 'Now: ' + 'r'.repeat(1400) + '\nNext: ship';
const pad = (label: string, n: number) => (label + ' ' + 'x'.repeat(n)).slice(0, n);

async function bigProject() {
  const s = setup();
  s.registry.create('big', { state: 'open', area: 'apps' }, 'owner');
  await s.save('roadmap', roadmap);
  for (let i = 0; i < 5; i++) await s.save('summary', pad(`STATUS${i}`, 1000));
  for (let i = 0; i < 40; i++) await s.save('decision', pad(`DECISION${String(i).padStart(2, '0')}`, 1000));
  for (let i = 0; i < 4; i++) {
    const p = await s.pages.create({ title: `big page ${i}`, project: 'big', body: `Lead ${i} of the page, long enough.\n\n## Stack\nSomething.` }, 'owner');
    s.notes.add(p.id, { text: `NOTE${i} ` + 'n'.repeat(480) });
  }
  for (const other of ['alpha', 'beta', 'gamma']) {
    s.registry.create(other, { state: 'open', area: 'apps' }, 'owner');
    await s.save('decision', `${other} is small`, other);
  }
  const c = await s.connect();
  for (const other of ['alpha', 'beta', 'gamma']) await c('record_lesson', { title: `Topic of ${other}`, level: 'helped', project: other });
  await c('record_lesson', { title: 'Topic of big', level: 'helped', project: 'big' });
  return { ...s, c };
}

test('a big project brief stays within the budget, with roadmap and latest status in full', async () => {
  const { c } = await bigProject();
  const text = await c('project_brief', { project: 'big' });
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  const d = dataOf(text);
  assert.equal(d.roadmap.content, roadmap);
  assert.equal(d.statuses[0].content, pad('STATUS4', 1000));
  const full = d.decisions.filter((m: any) => !m.excerpt);
  const cut = d.decisions.filter((m: any) => m.excerpt);
  assert.ok(full.length >= 3 && cut.length > 10);
  // Newest decisions are the full ones; every shortened one is older and keeps its id and a short excerpt.
  assert.ok(full.every((m: any) => m.content.length === 1000));
  assert.ok(cut.every((m: any) => m.id && m.date && m.content.length <= 160));
  assert.ok(full.some((m: any) => m.content.startsWith('DECISION39')));
  assert.ok(cut.some((m: any) => m.content.startsWith('DECISION')));
  assert.match(text, /older decisions shown as excerpts; call project_brief with all_decisions: true for them in full, or recall for one/);
  assert.equal(d.shortened.decisions_as_excerpts, cut.length);
  assert.equal(d.shortened.statuses_as_excerpts, 4);
  assert.equal(full.length + cut.length + (d.shortened.decisions_not_listed ?? 0), 40, 'every decision is shown or counted');
  // The owner's open notes are part of the floor (up to 5): all 4 are listed, each cut to 300 characters.
  // Pages give way before the older decisions do: what is not listed is counted, with a pointer.
  assert.equal(d.open_notes.length, 4);
  assert.equal(d.shortened.notes_not_listed ?? 0, 0);
  assert.equal(d.pages.length + (d.shortened.pages_not_listed ?? 0), 4);
  assert.ok(d.open_notes.every((n: any) => n.text.length <= 300 && n.text_cut === true));
  assert.doesNotMatch(text, /more notes are waiting/);
  assert.match(text, /more pages are not listed: list_pages\./);
});

test('the handbook shows this project\'s topics in full and the others as title and level', async () => {
  const { c } = await bigProject();
  const d = dataOf(await c('project_brief', { project: 'big' }));
  assert.deepEqual(d.handbook.map((t: any) => t.title), ['Topic of big']);
  assert.deepEqual(d.handbook_other_topics.map((t: any) => [t.title, t.level]).sort(), [['Topic of alpha', 'helped'], ['Topic of beta', 'helped'], ['Topic of gamma', 'helped']]);
  assert.ok(d.handbook_other_topics.every((t: any) => Object.keys(t).sort().join() === 'level,title'));
});

test('all_decisions returns the decisions in full, still capped at 40', async () => {
  const { c } = await bigProject();
  const text = await c('project_brief', { project: 'big', all_decisions: true });
  const d = dataOf(text);
  assert.equal(d.decisions.length, 40);
  assert.ok(d.decisions.every((m: any) => !m.excerpt && m.content.length === 1000));
  assert.equal(d.shortened?.decisions_as_excerpts, undefined);
});

test('a small project brief is not shortened', async () => {
  const { c, save, registry } = await (async () => { const s = setup(); s.registry.create('tiny', { state: 'open', area: 'apps' }, 'owner'); return { ...s, c: await s.connect() }; })();
  await save('roadmap', 'Now: ship', 'tiny');
  await save('summary', 'Status: fine', 'tiny');
  await save('summary', 'Older status', 'tiny');
  await save('decision', 'Uses SQLite', 'tiny');
  await save('decision', 'Uses SwiftUI', 'tiny');
  void registry;
  const text = await c('project_brief', { project: 'tiny' });
  const d = dataOf(text);
  assert.equal(d.shortened, undefined);
  assert.equal(d.decisions.length, 2);
  assert.ok(d.decisions.every((m: any) => m.excerpt === undefined));
  assert.equal(d.statuses.length, 2);
  assert.doesNotMatch(text, /excerpts/);
});

test('a read-only connection gets the same budget and still only its own project', async () => {
  const s = await bigProject();
  const ro = await s.connect({ access: 'projects', projects: ['big'] });
  const text = await ro('project_brief', { project: 'big' });
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  assert.deepEqual(dataOf(text).handbook.map((t: any) => t.title), ['Topic of big']);
  assert.match(await ro('project_brief', { project: 'alpha' }), /not one of the projects this connection can read/);
});

/** The floor: the roadmap, the latest status and the newest 3 decisions in full. */
function assertFloor(d: any, newest: string[]) {
  assert.equal(d.roadmap.content, roadmap);
  assert.equal(d.statuses[0].excerpt, undefined);
  const full = d.decisions.filter((m: any) => !m.excerpt).map((m: any) => m.content);
  for (const label of newest) assert.ok(full.some((c: string) => c.startsWith(label) && c.length === 1000), `${label} is in full`);
}
async function withDecisions(n: number, s = setup()) {
  s.registry.create('big', { state: 'open', area: 'apps' }, 'owner');
  await s.save('roadmap', roadmap);
  await s.save('summary', pad('STATUS', 1000));
  for (let i = 0; i < n; i++) await s.save('decision', pad(`DECISION${String(i).padStart(2, '0')}`, 1000));
  return s;
}

test('70 pages stay within the budget: the most relevant first, the rest counted with a pointer', async () => {
  const s = await withDecisions(10);
  for (let p = 0; p < 70; p++) {
    s.tick();
    await s.pages.create({ title: `big page ${p} with a fairly long descriptive title`, project: 'big', body: `${'Lead text of the page that is long enough to be summarised. '.repeat(5)}\n\n## Stack\nSomething.` }, 'owner');
  }
  const text = await (await s.connect())('project_brief', { project: 'big' });
  const d = dataOf(text);
  console.log('70 pages:', text.length, 'listed', d.pages.length);
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  assertFloor(d, ['DECISION09', 'DECISION08', 'DECISION07']);
  assert.ok(d.pages.length > 0 && d.pages.length < 70);
  assert.equal(d.shortened.pages_not_listed, 70 - d.pages.length);
  assert.match(text, new RegExp(`${70 - d.pages.length} more pages are not listed: list_pages\\.`));
  // Most recently updated first (none has notes or a flag).
  assert.match(d.pages[0].title, /big page 69 /);
});

test('50 open notes stay within the budget: counted with a pointer, long ones cut', async () => {
  const s = await withDecisions(10);
  const p = await s.pages.create({ title: 'big page', project: 'big', body: 'Lead.\n\n## Stack\nSomething.' }, 'owner');
  for (let n = 0; n < 50; n++) s.notes.add(p.id, { text: `NOTE${n} ` + 'n'.repeat(480) });
  const text = await (await s.connect())('project_brief', { project: 'big' });
  const d = dataOf(text);
  console.log('50 notes:', text.length, 'listed', d.open_notes.length);
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  assertFloor(d, ['DECISION09', 'DECISION08', 'DECISION07']);
  assert.equal(d.open_notes.length + d.shortened.notes_not_listed, 50);
  assert.match(text, /more notes are waiting: list_pages, then read_page/);
  assert.match(text, /The owner left notes on this project's pages/);
});

test('a flagged page with 15 newer long decisions: its flag is ids, dates and short excerpts, and the brief keeps its newest 3 decisions in full', async () => {
  const s = await withDecisions(0);
  await s.pages.create({ title: 'big — overview', project: 'big', body: 'Lead.\n\n## Key decisions\n- x' }, 'owner');
  s.tick();
  for (let i = 0; i < 15; i++) await s.save('decision', pad(`DECISION${String(i).padStart(2, '0')}`, 1000));
  const c = await s.connect();
  const text = await c('project_brief', { project: 'big' });
  const d = dataOf(text);
  const flag = d.pages[0].may_be_out_of_date;
  console.log('flagged:', text.length, 'flag', JSON.stringify(flag).length);
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  assertFloor(d, ['DECISION14', 'DECISION13', 'DECISION12']);
  assert.equal(flag.newer_decisions.length, 10);
  assert.equal(flag.more_decisions, 5);
  assert.ok(flag.newer_decisions.every((x: any) => Object.keys(x).sort().join() === 'date,excerpt,id,near_section,why' && x.excerpt.length <= 80 && /^\d{4}-\d\d-\d\d$/.test(x.date)));
  assert.ok(JSON.stringify(flag).length < 2500);
  // read_page keeps the whole text of the same decisions.
  const readPage = await c('read_page', { id: d.pages[0].id });
  assert.match(readPage, /"text":"DECISION14 x{20}/);
});

test('founding decisions are short excerpts, and the oldest non-founding ones are dropped first', async () => {
  const s = setup();
  s.registry.create('big', { state: 'open', area: 'apps' }, 'owner');
  await s.save('roadmap', roadmap);
  for (let i = 0; i < 5; i++) await s.save('summary', pad(`STATUS${i}`, 1000));
  // Long search words make even the excerpts too big, so some decisions are not listed at all.
  const keys = Array(15).fill('abcdefghijkl').join(' ');
  for (let i = 0; i < 60; i++) await s.save('decision', pad(`DECISION${String(i).padStart(2, '0')}`, 1000), 'big', keys);
  const text = await (await s.connect())('project_brief', { project: 'big' });
  const d = dataOf(text);
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length} characters`);
  const tag = (m: any) => Number(m.content.slice(8, 10));
  const listed = d.decisions.map(tag);
  // 40 are kept by the brief (5 founding + the 35 newest); some of the middle are not listed, the founding ones are.
  assert.deepEqual(listed.slice(0, 5), [0, 1, 2, 3, 4]);
  for (const m of d.decisions.slice(0, 5)) assert.ok(m.excerpt && m.content.length <= 80, `founding ${m.content.slice(0, 10)}`);
  assert.ok(d.shortened.decisions_not_listed > 0);
  assert.ok(!listed.includes(25) || listed.indexOf(25) > 4);
  assert.deepEqual(listed.slice(-3), [57, 58, 59]);
  assert.ok(d.decisions.slice(-3).every((m: any) => !m.excerpt));
  assert.match(text, /older decisions are not listed/);
  assert.doesNotMatch(text, /oldest decisions are not listed/);
  // The not-listed ones are the oldest after the founding five, so what is listed after them is a newer run.
  const rest = listed.slice(5);
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
  assert.equal(rest[0], 60 - 35 + d.shortened.decisions_not_listed);
});

test('all_decisions does not shorten statuses: a small project shows all 3 statuses in full with and without it', async () => {
  const s = setup();
  s.registry.create('big', { state: 'open', area: 'apps' }, 'owner');
  for (let i = 0; i < 3; i++) await s.save('summary', pad(`STATUS${i}`, 400));
  await s.save('decision', 'Uses SQLite');
  const c = await s.connect();
  for (const args of [{ project: 'big' }, { project: 'big', all_decisions: true }]) {
    const d = dataOf(await c('project_brief', args));
    assert.equal(d.statuses.length, 3);
    assert.ok(d.statuses.every((m: any) => !m.excerpt && m.content.length === 400), JSON.stringify(args));
    assert.equal(d.shortened, undefined);
  }
});
