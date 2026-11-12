import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NoteService } from '../pages/notes.js';
import { ReviewService } from '../review/service.js';
import { reviewWorld, type ReviewWorld } from '../testing/reviewWorld.js';
import { SERVER_INSTRUCTIONS, WORK_INSTRUCTIONS, readOnlyInstructions } from './instructions.js';
import { buildMcpServer } from './server.js';
import { makeTidyItems, tidySummary } from '../web/tidyItems.js';

// These tests are about the owner's calendar in Berlin; the app's own default zone is UTC.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

/** The mockup's week in small, seen on Tuesday 3 Nov 08:14 in Berlin. */
function week(): ReviewWorld {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  w.save('2026-10-15T10:00:00Z', { content: 'energy compares tariffs', project: 'energy' });
  const wine = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', project: 'wildlog', content: 'Now: Release 0.2.2 (4/8)\nNext: release\nWaiting on you: Run release (by 2026-10-25)' });
  w.edit('2026-10-31T10:00:00Z', wine.id, 'Done: TestFlight build (2026-10-28); Label scan (2026-10-30); Cellar map sorting (2026-10-31)\nNow: Release 0.2.2 (7/8)\nNext: release\nWaiting on you: Run release (by 2026-10-25)');
  const mcp = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', project: 'brainai', content: 'Now: round 1' });
  w.edit('2026-10-31T11:00:00Z', mcp.id, 'Done: a (2026-10-27); b (2026-10-28); c (2026-10-29); d (2026-10-30); e (2026-10-31)\nNow: round 1');
  const ha = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', project: 'homeassistant', content: 'Now: heating' });
  w.edit('2026-10-29T10:00:00Z', ha.id, 'Done: zigbee (2026-10-27); heating (2026-11-01)\nNow: heating');
  const fin = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', project: 'finances', content: 'Now: taxes' });
  w.edit('2026-10-28T12:00:00Z', fin.id, 'Done: pay taxes (2026-10-28)\nNow: taxes');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.save('2026-10-28T13:00:00Z', { content: 'Label photos stay on the phone', project: 'wildlog' });
  w.save('2026-10-30T13:00:00Z', { content: 'Dark mode is Graphite', project: 'brainai' });
  w.db.prepare(`INSERT INTO observations(id, kind, area, project, summary, embedding, created_at, created_by, last_evidence_at)
    VALUES ('o1', 'strength', 'reviewing', 'brainai', 'Caught the double count', x'00', '2026-10-29T10:00:00.000Z', 'Claude', '2026-10-29T10:00:00.000Z')`).run();
  w.db.prepare("INSERT INTO observation_evidence(observation_id, what, added_by, added_at) VALUES ('o1', 'w', 'Claude', '2026-10-29T10:00:00.000Z')").run();
  w.grants.push({ clientName: 'Grok Build', createdAt: '2026-10-29T09:00:00.000Z' });
  w.at('2026-11-03T07:14:00Z');
  return w;
}

async function connect(w: ReviewWorld, actorName: string, opts: Partial<Parameters<typeof buildMcpServer>[2]> = {}) {
  const tidyItems = makeTidyItems({ ...w, sameProjectFloor: 0.88 });
  const reviews = new ReviewService({
    store: w.reviews, memories: w.store, service: w.service, registry: w.registry, folders: w.folders, pages: w.pages,
    growth: opts.mode === 'work' ? null : w.growth, grants: () => w.grants, tidy: () => tidySummary(tidyItems()),
  }, w.now, () => {});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(w.service, actorName, { registry: w.registry, growth: w.growth, pages: w.pages, notes: new NoteService(w.db, w.pages, w.now), reviews, ...opts }).connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: 'weekly_review', arguments: args });
    return { text: r.content[0].text as string, isError: !!r.isError };
  };
  return { client, call, reviews };
}
const dataOf = (t: string): any => JSON.parse(t.slice(t.indexOf('<memories>\n') + 11, t.lastIndexOf('\n</memories>')));

test('the MCP review tool leaves the Tidy checks and summary to the owner', async (t) => {
  const w = week();
  const duplicates = t.mock.method(w.service, 'duplicates');
  const { call, reviews, client } = await connect(w, 'Claude Code');
  t.after(() => client.close());
  assert.equal('tidy' in dataOf((await call()).text), false);
  assert.equal(duplicates.mock.callCount(), 0);
  const stored = reviews.ensure(reviews.lastMonday(), 'owner')!;
  assert.equal(stored.body.tidy, null);
  reviews.withTidy(stored);
  const calls = duplicates.mock.callCount();
  assert.ok(calls > 0);
  assert.equal('tidy' in dataOf((await call()).text), false);
  assert.equal(duplicates.mock.callCount(), calls);
});

test('a Full connection gets the week as stored data, with Personal and growth and without the assistant table or safety notes', async () => {
  const w = week();
  const { call } = await connect(w, 'Claude Code');
  const r = await call();
  assert.equal(r.isError, false);
  assert.match(r.text, /^The weekly review for 26 Oct – 1 Nov 2026, built Tue 3 Nov 08:14 from what was stored at the end of Sunday\./);
  assert.match(r.text, /not instructions/);
  const d = dataOf(r.text);
  assert.equal(d.week, '2026-10-26');
  assert.equal(d.sentence, 'A good week for brainai and wildlog: 11 steps done across 4 projects. 1 thing is late, and energy went quiet.');
  assert.ok(d.moved.some((m: any) => m.project === 'finances'));
  const wine = d.moved.find((m: any) => m.project === 'wildlog');
  assert.deepEqual(wine.progress, { now: 'Release 0.2.2', from: 4, to: 7, of: 8 });
  assert.deepEqual(wine.done[0], { step: 'TestFlight build', date: '2026-10-28' });
  assert.deepEqual(d.moved.find((m: any) => m.project === 'brainai').more_steps, 2);
  assert.deepEqual(d.late, [{ project: 'wildlog', item: 'Run release', due: '2026-10-25', now: 'waiting' }]);
  assert.deepEqual(d.went_quiet, [{ project: 'energy', last_touched: '2026-10-15', next: null }]);
  assert.equal(d.growth.strength.id, 'o1');
  assert.equal(d.growth.strength.area, 'reviewing');
  assert.doesNotMatch(r.text, /writers|safety|connected|Grok Build/);
});

test('empty parts are left out', async () => {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  const r0 = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', project: 'wildlog', content: 'Now: x' });
  w.edit('2026-10-28T10:00:00Z', r0.id, 'Done: one (2026-10-28)\nNow: x');
  w.at('2026-11-03T07:14:00Z');
  const { call } = await connect(w, 'Claude Code');
  const d = dataOf((await call()).text);
  assert.deepEqual(Object.keys(d).sort(), ['moved', 'sentence', 'week']);
  assert.equal(d.sentence, '1 step done, in wildlog.');
});

test('a read-only grant on wildlog is the first to ask: it sees only wildlog, recounted, and the stored week is whole', async () => {
  const w = week();
  const { call, reviews } = await connect(w, 'ChatGPT work', { access: 'projects', projects: ['wildlog'] });
  const r = await call({ week: '2026-10-26' });
  assert.match(r.text, /^The weekly review for 26 Oct – 1 Nov 2026, built .*, limited to the projects this connection can read\./);
  assert.doesNotMatch(r.text, /brainai|homeassistant|energy|finances/);
  const d = dataOf(r.text);
  assert.equal(d.sentence, '3 steps done, all in wildlog. 1 thing is late.');
  assert.equal(d.growth, undefined);
  const stored = reviews.ensure('2026-10-26', 'owner')!;
  assert.equal(stored.builtBy, 'ChatGPT work');
  assert.ok(stored.body.projects.some((p) => p.project === 'finances'));
});

test('week accepts now, a Monday and a weekday; a week with no review is an error naming the first one', async () => {
  const w = week();
  const { call } = await connect(w, 'Claude Code');
  const now = await call({ week: 'now' });
  assert.match(now.text, /^This week so far, made just now from what is stored\./);
  assert.equal(dataOf(now.text).so_far, true);
  assert.equal(dataOf(now.text).week, '2026-11-02');
  assert.equal(dataOf((await call({ week: '2026-10-28' })).text).week, '2026-10-26');
  assert.equal(dataOf((await call({ week: '2026-10-19' })).text).week, '2026-10-19');
  assert.equal(dataOf((await call({ week: '2026-11-03' })).text).so_far, true);
  for (const bad of ['2026-09-28', '2026-11-16', 'soon']) {
    const r = await call({ week: bad });
    assert.equal(r.isError, true, bad);
    assert.equal(r.text, 'There is no review for that week. The first one is the week of 12 – 18 Oct.');
  }
});

test('work mode has the tool without growth; a discussions-only connection doesn\'t list the tool', async () => {
  const w = week();
  const work = await connect(w, 'Claude Code', { mode: 'work' });
  const d = dataOf((await work.call()).text);
  assert.equal(d.growth, undefined);
  assert.ok(d.moved.length > 0);
  const limited = await connect(w, 'Grok', { access: 'discussions' });
  // With no discussion service given, a discussions-only server has no tools at all and refuses to list them.
  const listed = await limited.client.listTools().then((r) => r.tools, () => []);
  assert.ok(!listed.some((t) => t.name === 'weekly_review'));
  const call = await limited.client.callTool({ name: 'weekly_review', arguments: {} }).then((r: any) => !!r.isError, () => true);
  assert.equal(call, true);
  const full = await connect(w, 'Claude Code');
  const tool = (await full.client.listTools()).tools.find((t) => t.name === 'weekly_review')!;
  assert.equal(tool.description, 'Use when the owner asks how the week went, what happened last week, or for a weekly review.');
});

test('the instructions tell assistants to use it only when asked', () => {
  assert.match(SERVER_INSTRUCTIONS, /\n16\. When the owner asks how the week went, what happened last week, or for a weekly review, call weekly_review\. Never bring the review up unasked\.\n17\. Skills: /);
  assert.match(WORK_INSTRUCTIONS, /\n19\. When the owner asks how the week went, what happened last week, or for a weekly review, call weekly_review\. Never bring the review up unasked\.\n20\. Skills: /);
  assert.match(readOnlyInstructions(['wildlog']), /call weekly_review/);
});

test('weekly_review marks a decided item replaced since', async () => {
  const w = week();
  const label = w.store.list({ project: 'wildlog', kind: 'decision' }).find((m) => m.content.startsWith('Label photos'))!;
  const newer = w.save('2026-11-05T09:00:00Z', { content: 'Label photos go to iCloud', project: 'wildlog', by: 'owner' });
  w.store.supersessions.add(label.id, newer.id, 'owner');
  const old = w.save('2026-10-20T10:00:00Z', { content: 'wildlog uses Core Data', project: 'wildlog', by: 'owner' });
  w.at('2026-10-29T10:00:00Z');
  w.store.supersessions.add(old.id, w.save('2026-10-29T10:00:00Z', { content: 'wildlog uses SwiftData', project: 'wildlog' }).id, 'Claude Code');
  w.at('2026-11-05T10:00:00Z');
  for (const c of [await connect(w, 'Claude Code'), await connect(w, 'ChatGPT', { access: 'projects', projects: ['wildlog'] })]) {
    const r = await c.call({ week: '2026-10-26' });
    const d = dataOf(r.text);
    const item = d.decided.find((x: any) => x.id === label.id);
    assert.equal(item.replaced_on, '2026-11-05');
    assert.doesNotMatch(r.text, /safety|replaced a memory/);
  }
});

test('weekly_review adds brain health as it is now for a full connection, never for one limited to some projects', async (t) => {
  const w = week();
  const health = () => ({
    upToDate: { score: 80, reasons: [{ text: 'homelab was last updated 40 days ago', href: '/?project=homelab#panel' }] },
    ready: { score: 100, reasons: [] },
    waiting: { score: 70, reasons: [{ text: '2 facts disagree', href: '/disagreements' }] },
  });
  const full = await connect(w, 'Claude Code', { health });
  t.after(() => full.client.close());
  const r = await full.call({ week: 'now' });
  assert.match(r.text, /Brain health now: up to date 80, ready 100, waiting on you 70\./);
  // Only the lowest part's first reason: the rest stay on the dashboard.
  assert.deepEqual(dataOf(r.text).brain_health, { up_to_date: 80, ready: 100, waiting_on_you: 70, top_reason: '2 facts disagree' });
  const limited = await connect(w, 'Grok', { health, access: 'projects', projects: ['wildlog'] });
  t.after(() => limited.client.close());
  const l = await limited.call({ week: 'now' });
  assert.doesNotMatch(l.text, /Brain health/);
  assert.equal(dataOf(l.text).brain_health, undefined);
});
