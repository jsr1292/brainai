import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { operatingRules, operatingRulesBlock, OPERATING_RULES, SERVER_INSTRUCTIONS } from '../mcp/instructions.js';
import { buildMcpServer } from '../mcp/server.js';
import { ProjectStore } from '../projects/store.js';
import { NoteService } from '../pages/notes.js';
import { loggedIn, makeGrowth, makePages, makeService, startTestApp } from '../testing/helpers.js';
import { LearningService } from './service.js';
import { COACHING_SWITCH, coachingOn } from './coaching.js';

const owner = { type: 'owner' } as const;
const switchOf = (db: Database.Database) => (db.prepare("SELECT value FROM brain_switches WHERE name = 'developer_coaching'").get() as { value: string } | undefined)?.value ?? null;

test('migration 44: a new brain has coaching off', () => {
  assert.equal(switchOf(openDb(':memory:')), null);
});

for (const [label, insert] of [
  ['a project area', "INSERT INTO project_checks(project, area, status, set_by, set_at) VALUES ('p','safe','done','owner','2026-01-01')"],
  ['a lesson', "INSERT INTO handbook_topics(slug, title, level, updated_at) VALUES ('git','Git','seen','2026-01-01')"],
] as const) {
  test(`migration 44: a brain with ${label} gets coaching on`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'coaching-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'memory.db');
    const db = openDb(path);
    db.exec(insert);
    // Back to schema 43 with the switch undone, then migrate again.
    db.exec("DELETE FROM brain_switches WHERE name = 'developer_coaching'; UPDATE schema_version SET version = 43");
    db.close();
    const again = openDb(path);
    assert.equal(switchOf(again), 'on');
    again.close();
  });
}

test('migration 44: a brain with only growth observations stays off', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coaching-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const db = openDb(path);
  db.exec("INSERT INTO observations(id, kind, area, summary, embedding, created_at, created_by, last_evidence_at) VALUES ('o1','strength','testing','x', zeroblob(4), '2026-01-01', 'Claude', '2026-01-01')");
  db.exec("DELETE FROM brain_switches WHERE name = 'developer_coaching'; UPDATE schema_version SET version = 43");
  db.close();
  const again = openDb(path);
  assert.equal(switchOf(again), null);
  again.close();
});

test('the rules: coaching off leaves out Growth and Learning and numbers stay continuous', () => {
  const on = operatingRules(true).split('\n'), off = operatingRules(false).split('\n');
  assert.equal(on.length, 17);
  assert.equal(off.length, 15);
  off.forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), l.slice(0, 20)));
  on.forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), l.slice(0, 20)));
  const offText = off.join('\n');
  for (const word of ['note_observation', 'set_project_area', 'record_lesson', 'five areas', 'handbook']) {
    assert.doesNotMatch(offText, new RegExp(word), word);
    assert.match(on.join('\n'), new RegExp(word), word);
  }
  assert.match(off[12]!, /^13\. Facts and pages/);
  assert.match(off[14]!, /^15\. Skills/);
  assert.equal(OPERATING_RULES, operatingRules(true));
  assert.match(operatingRulesBlock(false), /^BrainAI operating rules/);
  assert.doesNotMatch(operatingRulesBlock(false), /note_observation/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /growth|five areas|handbook|learning/i);
});

test('rule on pages: language of the owner, no career sentence, work pages keep their limits', () => {
  for (const c of [true, false]) {
    const r = operatingRules(c);
    assert.match(r, /Write pages in the language the owner uses with you, unless their profile says otherwise; quote UI text in its own language as it is\./);
    assert.doesNotMatch(r, /Career plans/);
    assert.doesNotMatch(r, /Write pages in English/);
    assert.match(r, /Work pages hold no financial figures, account numbers, colleagues' names or company data\./);
  }
});

function mcp() {
  const given = makeService();
  const { service, db } = given;
  const registry = new ProjectStore(db, () => new Date());
  const learning = new LearningService(db, () => new Date(), { match: () => ({ byProject: new Map(), unmatched: [], receivedAt: null, device: null }) },
    { get: (n) => registry.get(n), named: (n) => service.projectNamed(n) });
  const growth = makeGrowth(given);
  const pages = makePages(given);
  const notes = new NoteService(db, pages, () => new Date());
  const connect = async (coaching: boolean | undefined) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, 'Claude Code', { registry, growth, pages, notes, learning, access: 'full', coaching } as never).connect(st);
    const client = new Client({ name: 't', version: '0' }); await client.connect(ct);
    const call = async (tool: string, args: Record<string, unknown> = {}) => (await client.callTool({ name: tool, arguments: args }) as any).content as { text: string }[];
    return { names: async () => (await client.listTools()).tools.map((x) => x.name), call };
  };
  registry.create('larder', { state: 'open', area: 'apps' }, 'owner');
  return { connect, service };
}

test('tools: coaching off registers no growth or learning tool and the brief leaves out the five areas', async () => {
  const { connect, service } = mcp();
  await service.remember({ kind: 'decision', content: 'larder is a small app', project: 'larder' }, owner);
  const off = await connect(false);
  const offNames = await off.names();
  for (const n of ['note_observation', 'set_project_area', 'record_lesson']) assert.ok(!offNames.includes(n), n);
  assert.ok(offNames.includes('project_brief'));
  const brief = (await off.call('project_brief', { project: 'larder' }))[0]!.text;
  for (const k of ['five_areas', 'next_area', 'handbook']) assert.doesNotMatch(brief, new RegExp(k), k);
  const profile = await off.call('load_profile');
  assert.doesNotMatch(profile[0]!.text, /note_observation/);
  assert.match(profile[0]!.text, /13\. Facts and pages/);
});

test('tools: coaching on (or left out) behaves as before', async () => {
  const { connect, service } = mcp();
  await service.remember({ kind: 'decision', content: 'larder is a small app', project: 'larder' }, owner);
  for (const flag of [true, undefined]) {
    const c = await connect(flag);
    const names = await c.names();
    for (const n of ['note_observation', 'set_project_area', 'record_lesson']) assert.ok(names.includes(n), n);
    const brief = (await c.call('project_brief', { project: 'larder' }))[0]!.text;
    for (const k of ['five_areas', 'next_area', 'handbook']) assert.match(brief, new RegExp(k), k);
    assert.match((await c.call('load_profile'))[0]!.text, /14\. Learning/);
  }
});

async function start(t: TestContext, coaching?: boolean) {
  const app = await startTestApp({ coaching });
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const csrfPost = (app: { baseUrl: string }, body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body), redirect: 'manual' as const, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

test('web: the switch is read from the brain, and the settings route flips it (owner only)', async (t) => {
  const { app, f } = await start(t, false);
  assert.equal(coachingOn(app.deps.store), false);
  const anon = await fetch(`${app.baseUrl}/settings/coaching`, { ...csrfPost(app, { coaching: 'on' }), headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location') ?? '', /^\/login/);
  assert.equal(coachingOn(app.deps.store), false);
  assert.match(await (await f('/settings')).text(), /id="coaching"/);
  const on = await f('/settings/coaching', csrfPost(app, { coaching: 'on' }));
  assert.equal(on.status, 303);
  assert.equal(app.deps.store.switchValue(COACHING_SWITCH), 'on');
  const off = await f('/settings/coaching', csrfPost(app, {}));
  assert.equal(off.status, 303);
  assert.equal(app.deps.store.switchValue(COACHING_SWITCH), null);
});

test('web: off hides Growth, Five areas and the handbook; the pages stay and say so; on brings them back', async (t) => {
  const { app, f } = await start(t, false);
  app.deps.registry.create('larder', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'larder is a small app', project: 'larder' }, owner);
  const side = async () => (await (await f('/')).text());
  let body = await side();
  assert.doesNotMatch(body, /href="\/growth"/);
  assert.doesNotMatch(body, /href="\/map"/);
  const detail = await (await f('/?project=larder')).text();
  assert.doesNotMatch(detail, /id="p-areas"/);
  for (const path of ['/growth', '/map']) {
    const res = await f(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.match(text, /Developer coaching is off/, path);
    assert.match(text, /href="\/settings#coaching"/, path);
  }
  await f('/settings/coaching', csrfPost(app, { coaching: 'on' }));
  body = await side();
  assert.match(body, /href="\/growth"/);
  assert.match(body, /href="\/map"/);
  assert.match(await (await f('/?project=larder')).text(), /id="p-areas"/);
  assert.doesNotMatch(await (await f('/growth')).text(), /Developer coaching is off/);
});

test('web: the Graph tab is off the sidebar until there is more than one project; the page stays reachable', async (t) => {
  const { app, f } = await start(t);
  const sideGraph = async () => /<a class="side-place" href="\/graph"/.test(await (await f('/')).text());
  app.deps.registry.create('one', { state: 'open' }, 'owner');
  assert.equal(await sideGraph(), false);
  assert.equal((await f('/graph')).status, 200);
  app.deps.registry.create('two', { state: 'open' }, 'owner');
  assert.equal(await sideGraph(), true);
});
