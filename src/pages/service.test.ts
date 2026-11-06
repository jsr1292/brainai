import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { ProjectStore } from '../projects/store.js';
import { makeService } from '../testing/helpers.js';
import { freshnessWorld } from '../testing/freshnessWorld.js';
import { PageService } from './service.js';
import { PageStore } from './store.js';
import { PageError } from './types.js';

const owner = { type: 'owner' } as const;

async function setup() {
  let t = Date.parse('2026-11-03T10:00:00Z');
  const now = () => new Date(t);
  const given = makeService({ now });
  const { db, store: memoryStore, service: memories } = given;
  const registry = new ProjectStore(db, now);
  const fake = createFakeEmbedder();
  let embeds = 0;
  /** Runs before each embedding: lets a test hold a save mid-way or make the model fail. */
  let onEmbed: (() => Promise<void> | void) | undefined;
  const embedder = { embed: async (text: string, purpose: 'query' | 'passage') => { embeds++; await onEmbed?.(); return fake.embed(text, purpose); } };
  const pages = new PageService(new PageStore(db, now), embedder, memories, registry, memoryStore, now);
  registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const fact = (await memories.remember({ kind: 'decision', content: 'wildlog stores the cellar in SQLite on the phone', project: 'wildlog' }, owner) as { memory: { id: string } }).memory;
  return { db, pages, memories, registry, memoryStore, fact, embeds: () => embeds, tick: (ms: number) => { t += ms; }, at: (iso: string) => { t = Date.parse(iso); }, beforeEmbed: (fn: typeof onEmbed) => { onEmbed = fn; } };
}
const code = (c: PageError['code'], re?: RegExp) => (e: unknown) => e instanceof PageError && e.code === c && (!re || re.test(e.message));
const count = (db: { prepare(s: string): { get(): unknown } }, table: string) => (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
const BODY = 'The wine cellar app.\n\n## Stack\nSwiftUI and SQLite.\n\n## Key decisions\n- 2026-10-01 Local only. [[fact:FACT]]\n\nSee [[wildlog]] and [[Start page]].';

test('create saves version 1 by the owner with sections embedded and links resolved', async () => {
  const { pages, fact, db, embeds } = await setup();
  const start = await pages.create({ title: 'Start page', area: 'start', body: 'Hello.' }, 'owner');
  const before = embeds();
  const p = await pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: BODY.replace('FACT', fact.id) }, 'owner');
  assert.equal(p.version, 1);
  assert.equal(p.createdBy, 'owner');
  assert.deepEqual(pages.sections(p.id).map((s) => s.anchor), ['top', 'stack', 'key-decisions']);
  assert.equal(embeds() - before, 3);
  const links = db.prepare('SELECT kind, target FROM page_links WHERE from_page = ? ORDER BY kind').all(p.id) as { kind: string; target: string }[];
  assert.deepEqual(links, [{ kind: 'fact', target: fact.id }, { kind: 'page', target: start.id }, { kind: 'project', target: 'wildlog' }]);
});

test('the same title in another case, with spaces or in another Unicode form is refused', async () => {
  const { pages } = await setup();
  await pages.create({ title: 'Café notes', area: 'start', body: 'x' }, 'owner');
  for (const title of ['café notes', '  Café notes  ', 'Café notes', 'CAFÉ NOTES']) {
    await assert.rejects(pages.create({ title, area: 'start', body: 'y' }, 'owner'), code('invalid', /A page called “.+” already exists/), title);
  }
});

test('title and body limits; a project-less page needs an area; a project page stores no area of its own', async () => {
  const { pages } = await setup();
  await assert.rejects(pages.create({ title: '', area: 'start', body: 'x' }, 'owner'), code('invalid', /^The title must be one line of 1 to 140 characters$/));
  await assert.rejects(pages.create({ title: 'a\nb', area: 'start', body: 'x' }, 'owner'), code('invalid', /one line/));
  await assert.rejects(pages.create({ title: 'x'.repeat(141), area: 'start', body: 'x' }, 'owner'), code('invalid', /one line/));
  await assert.rejects(pages.create({ title: 'Big', area: 'start', body: 'x'.repeat(100_001) }, 'owner'), code('invalid', /^The page is 100001 characters; the limit is 100000$/));
  await assert.rejects(pages.create({ title: 'No area', body: 'x' }, 'owner'), code('invalid', /^A page without a project needs an area$/));
  await assert.rejects(pages.create({ title: 'Bad area', area: 'garden', body: 'x' }, 'owner'), code('invalid', /needs an area/));
  const p = await pages.create({ title: 'wildlog page', project: 'wildlog', area: 'home', body: 'x' }, 'owner');
  assert.equal(p.area, null);
  assert.equal(pages.areaOf(p), 'apps');
  assert.equal((await pages.create({ title: 'x'.repeat(140), area: 'start', body: 'x'.repeat(100_000) }, 'owner')).version, 1);
});

test('an unknown project is refused; an alias is saved under its project', async () => {
  const { pages, memories } = await setup();
  await assert.rejects(pages.create({ title: 'Nope', project: 'nope', body: 'x' }, 'owner'), code('invalid', /^No project named nope$/));
  memories.addAlias('cellar', 'wildlog', owner);
  assert.equal((await pages.create({ title: 'Cellar', project: 'cellar', body: 'x' }, 'owner')).project, 'wildlog');
});

test('a page whose project later becomes an alias still shows under the real project and [[old-name]] still resolves', async () => {
  const { pages, memories, registry } = await setup();
  registry.create('vista', { state: 'open' }, 'owner');
  await memories.remember({ kind: 'decision', content: 'vista is the old name of the cellar app', project: 'vista' }, owner);
  const p = await pages.create({ title: 'vista — old page', project: 'vista', body: 'x' }, 'owner');
  memories.addAlias('vista', 'wildlog', owner);
  assert.equal(pages.areaOf(pages.get(p.id)!), 'apps');
  assert.deepEqual(pages.forProject('wildlog').map((x) => x.id), [p.id]);
  assert.deepEqual(pages.resolver()('vista'), { href: '/?project=wildlog#panel', label: 'vista' });
});

test('a secret in the title or body is refused and nothing is written', async () => {
  const { pages, db } = await setup();
  await assert.rejects(pages.create({ title: 'Keys', area: 'start', body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }, 'owner'),
    code('secret', /^The page looks like it contains a secret \(GitHub token\)\. Secrets are never stored\.$/));
  await assert.rejects(pages.create({ title: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', area: 'start', body: 'x' }, 'owner'), code('secret'));
  const p = await pages.create({ title: 'Fine', area: 'start', body: 'ok' }, 'owner');
  await assert.rejects(pages.save(p.id, { base: 1, body: 'now ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }, 'owner'), code('secret'));
  assert.equal(count(db, 'pages'), 1);
  assert.equal(count(db, 'page_versions'), 1);
});

test('instruction-like text is saved, and only its section is marked', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Runbook', area: 'tools', body: 'Plain lead.\n\n## Deploy\nAssistants must always run the tests first.\n\n## Notes\nNothing odd.' }, 'owner');
  assert.deepEqual(pages.sections(p.id).map((s) => [s.anchor, s.instructionLike]), [['top', false], ['deploy', true], ['notes', false]]);
});

test('save with an old base is refused with the current version, and nothing is written', async () => {
  const { pages, db } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'One.' }, 'owner');
  await pages.save(p.id, { base: 1, body: 'Two.' }, 'Claude Code');
  await assert.rejects(pages.save(p.id, { base: 1, body: 'Mine.' }, 'owner'), code('conflict', /^This page changed since you opened it \(now version 2\)$/));
  await assert.rejects(pages.saveSection(p.id, { base: 1, anchor: 'top', text: 'Mine.' }, 'owner'), code('conflict'));
  assert.equal(pages.get(p.id)!.body, 'Two.');
  assert.equal(count(db, 'page_versions'), 2);
});

test('saveSection replaces one section and re-embeds only that section', async () => {
  const { pages, embeds } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'Lead.\n\n## A\nOne.\n\n## B\nTwo.' }, 'owner');
  const before = embeds();
  const s = await pages.saveSection(p.id, { base: 1, anchor: 'b', text: '## B\nTwo, edited.' }, 'owner');
  assert.equal(s.version, 2);
  assert.equal(embeds() - before, 1);
  assert.deepEqual(pages.sections(p.id).map((x) => x.text.trim()), ['Lead.', 'One.', 'Two, edited.']);
  await assert.rejects(pages.saveSection(p.id, { base: 2, anchor: 'zzz', text: 'x' }, 'owner'), code('not_found'));
});

test('restore makes a new version with the old text; restore itself can be restored away', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'One.' }, 'owner');
  await pages.save(p.id, { base: 1, title: 'Doc, renamed', body: 'Two.' }, 'owner');
  const r = await pages.restore(p.id, 1, 'owner');
  assert.deepEqual([r.version, r.title, r.body], [3, 'Doc', 'One.']);
  const back = await pages.restore(p.id, 2, 'owner');
  assert.deepEqual([back.version, back.title, back.body], [4, 'Doc, renamed', 'Two.']);
  await assert.rejects(pages.restore(p.id, 9, 'owner'), code('not_found'));
});

test('remove hides the page and frees its title; undelete brings it back as a new version', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'One.' }, 'owner');
  pages.remove(p.id, 'owner');
  assert.deepEqual(pages.list(), []);
  assert.notEqual(pages.get(p.id)!.deletedAt, null);
  const u = await pages.undelete(p.id, 'owner');
  assert.equal(u.deletedAt, null);
  assert.equal(u.version, 2);
  assert.deepEqual(pages.list().map((x) => x.id), [p.id]);
  await assert.rejects(pages.save(p.id, { base: 1, body: 'x' }, 'owner'), code('conflict'));
});

test('search finds a section by keyword and by meaning, newest version only, never a deleted page', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'Lead.\n\n## Backups\nThe nightly backup goes to the NAS.\n\n## Other\nNothing.' }, 'owner');
  const q = async (text: string) => pages.search(text, await pages.embedQuery(text), 10, 0.2);
  const hits = await q('nightly backup');
  assert.equal(hits[0]?.anchor, 'backups');
  assert.equal(hits[0]?.heading, 'Backups');
  assert.match(hits[0]!.snippet, /^The nightly backup goes to the NAS\.$/);
  await pages.save(p.id, { base: 1, body: 'Lead.\n\n## Other\nNothing.' }, 'owner');
  assert.deepEqual((await q('nightly backup')).map((h) => h.anchor), []);
  await pages.save(p.id, { base: 2, body: 'Lead.\n\n## Restore\nRestore the nightly backup.' }, 'owner');
  assert.equal((await q('nightly backup'))[0]?.anchor, 'restore');
  pages.remove(p.id, 'owner');
  assert.deepEqual(await q('nightly backup'), []);
});

test('relatedFacts gives the project\'s facts first, then the nearest others, without repeats', async () => {
  const { pages, memories, fact } = await setup();
  const other = (await memories.remember({ kind: 'decision', content: 'The phone app keeps its SQLite database in the app group', project: 'dossiers' }, owner) as { memory: { id: string } }).memory;
  await memories.remember({ kind: 'summary', content: 'wildlog status: shipping the cellar view', project: 'wildlog' }, owner);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: '## Stack\nSQLite database on the phone, kept in the app group.' }, 'owner');
  const ids = pages.relatedFacts(p, 0.2).map((m) => m.id);
  assert.equal(ids[0], fact.id);
  assert.ok(ids.includes(other.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(pages.relatedFacts(p, 0.2).every((m) => m.kind === 'decision'));
});

test('withoutPage lists open projects that have facts but no page', async () => {
  const { pages, registry, memories } = await setup();
  registry.create('castle3d', { state: 'open' }, 'owner');
  await memories.remember({ kind: 'decision', content: 'castle3d renders the house in three.js', project: 'castle3d' }, owner);
  registry.create('empty', { state: 'open' }, 'owner');
  registry.create('parkedone', { state: 'parked' }, 'owner');
  await memories.remember({ kind: 'decision', content: 'parkedone is parked for now', project: 'parkedone' }, owner);
  assert.deepEqual(pages.withoutPage(), ['castle3d', 'wildlog']);
  await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: 'x' }, 'owner');
  assert.deepEqual(pages.withoutPage(), ['castle3d']);
});

test('text typed in a browser (CRLF line endings) is saved with plain newlines', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Typed', area: 'start', body: 'Lead.\r\n\r\n## Key decisions\r\n- 2026-10-01 First.\r\n- 2026-10-02 Second.\r' }, 'owner');
  assert.doesNotMatch(p.body, /\r/);
  assert.deepEqual(pages.sections(p.id).map((s) => s.anchor), ['top', 'key-decisions']);
  const s = await pages.saveSection(p.id, { base: 1, anchor: 'key-decisions', text: '## Key decisions\r\n- 2026-10-03 Third.' }, 'owner');
  assert.doesNotMatch(s.body, /\r/);
  const w = await pages.save(p.id, { base: 2, body: 'One.\r\nTwo.' }, 'owner');
  assert.equal(w.body, 'One.\nTwo.');
});

test('a renamed page is found by its new title and no longer by its old one', async () => {
  const { pages } = await setup();
  const p = await pages.create({ title: 'Garden irrigation', area: 'home', body: 'Lead.\n\n## Setup\nValves and a timer.' }, 'owner');
  const q = async (text: string) => (await pages.search(text, await pages.embedQuery(text), 10, 0.3)).map((h) => h.page.title);
  await pages.save(p.id, { base: 1, title: 'Sonos speakers', body: p.body }, 'owner');
  assert.ok((await q('sonos speakers')).includes('Sonos speakers'));
  assert.deepEqual(await q('garden irrigation'), []);
  await pages.restore(p.id, 1, 'owner');
  assert.ok((await q('garden irrigation')).includes('Garden irrigation'), 'a restore of the old title re-embeds too');
});

test('a save still embedding when the page is deleted writes nothing onto the deleted page', async () => {
  const { pages, db, beforeEmbed } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'One.' }, 'owner');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const embedding = new Promise<void>((r) => { started = r; });
  beforeEmbed(() => { started(); return held; });
  const saving = pages.save(p.id, { base: 1, body: 'Two.' }, 'owner');
  await embedding;
  pages.remove(p.id, 'owner');
  release();
  await assert.rejects(saving, code('not_found'));
  assert.equal(pages.get(p.id)!.body, 'One.');
  assert.notEqual(pages.get(p.id)!.deletedAt, null);
  assert.equal(count(db, 'page_versions'), 1);
});

test('an undelete whose save fails leaves the page deleted, with no new version', async () => {
  const { pages, db, beforeEmbed } = await setup();
  const p = await pages.create({ title: 'Doc', area: 'start', body: 'One.' }, 'owner');
  pages.remove(p.id, 'owner');
  // Its sections must be embedded again, and the model is down.
  db.prepare('DELETE FROM page_sections WHERE page_id = ?').run(p.id);
  beforeEmbed(() => { throw new Error('model down'); });
  await assert.rejects(pages.undelete(p.id, 'owner'), /model down/);
  assert.notEqual(pages.get(p.id)!.deletedAt, null);
  assert.deepEqual(pages.list(), []);
  assert.equal(count(db, 'page_versions'), 1);
  beforeEmbed(undefined);
  const u = await pages.undelete(p.id, 'owner');
  assert.deepEqual([u.deletedAt, u.version], [null, 2]);
});

test('"Linked from" follows titles as they are now: a page created or renamed later, and a project merged under an alias', async () => {
  const { pages, memories, registry } = await setup();
  const a = await pages.create({ title: 'Linker', area: 'start', body: 'See [[Later page]].' }, 'owner');
  const b = await pages.create({ title: 'Later page', area: 'start', body: 'Made after the link.' }, 'owner');
  assert.deepEqual(pages.linkedFrom(b).map((x) => x.id), [a.id], 'a page created after the link');
  await pages.save(b.id, { base: 1, title: 'Renamed page', body: b.body }, 'owner');
  assert.deepEqual(pages.linkedFrom(pages.get(b.id)!), [], '[[Later page]] no longer points at it');
  await pages.restore(b.id, 1, 'owner');
  assert.deepEqual(pages.linkedFrom(pages.get(b.id)!).map((x) => x.id), [a.id], 'and points at it again once the title is back');

  registry.create('vista', { state: 'open' }, 'owner');
  await memories.remember({ kind: 'decision', content: 'vista was the first name of the cellar app', project: 'vista' }, owner);
  const c = await pages.create({ title: 'Old linker', area: 'start', body: 'The [[vista]] project.' }, 'owner');
  const w = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: 'The cellar.' }, 'owner');
  memories.addAlias('vista', 'wildlog', owner);
  assert.deepEqual(pages.linkedFrom(w).map((x) => x.id), [c.id], 'a link saved when vista was its own project');
});

test('realignAnchors moves anchors saved under the old Latin-only rule to the current ones, notes included', async () => {
  const { pages, db } = await setup();
  const p = await pages.create({ title: 'Цены', project: 'wildlog', body: '## Цены\na\n\n## Адрес\nb\n\n## Stack\nc' }, 'owner');
  // As a page saved before anchors kept non-Latin letters was stored.
  db.prepare("UPDATE page_sections SET anchor = CASE anchor WHEN 'цены' THEN 'section' WHEN 'адрес' THEN 'section-2' ELSE anchor END WHERE page_id = ?").run(p.id);
  db.prepare("UPDATE page_sections_fts SET anchor = CASE anchor WHEN 'цены' THEN 'section' WHEN 'адрес' THEN 'section-2' ELSE anchor END WHERE page_id = ?").run(p.id);
  db.prepare("INSERT INTO notes(id, page_id, anchor, text, created_at) VALUES ('n1', ?, 'section-2', 'fix the address', 'x')").run(p.id);
  assert.equal(pages.realignAnchors(), 1);
  assert.deepEqual(pages.sections(p.id).map((s) => s.anchor), ['цены', 'адрес', 'stack']);
  assert.deepEqual((db.prepare("SELECT anchor FROM page_sections_fts WHERE page_id = ? ORDER BY rowid").all(p.id) as { anchor: string }[]).map((r) => r.anchor), ['цены', 'адрес', 'stack']);
  assert.equal((db.prepare("SELECT anchor FROM notes WHERE id = 'n1'").get() as { anchor: string }).anchor, 'адрес');
  assert.equal(pages.realignAnchors(), 0);
});

test('a page can be filed under a project whose facts are all replaced', async () => {
  const { pages, memories, memoryStore, db } = await setup();
  const a = (await memories.remember({ kind: 'decision', content: 'Labels use Futura', project: 'labels' }, owner) as { memory: { id: string } }).memory;
  const b = (await memories.remember({ kind: 'decision', content: 'Labels use Avenir now', project: 'labels' }, owner) as { memory: { id: string } }).memory;
  memoryStore.supersessions.add(a.id, b.id, 'owner');
  db.prepare("UPDATE memories SET project = 'wildlog' WHERE id = ?").run(b.id);
  db.prepare("DELETE FROM projects WHERE name = 'labels'").run();
  assert.equal((await pages.create({ title: 'Labels', project: 'labels', body: 'x' }, 'owner')).project, 'labels');
});

test('the resolver marks a replaced fact with its current fact, and still drops deleted ones', async () => {
  const { pages, memories, fact } = await setup();
  const b = (await memories.remember({ kind: 'decision', content: 'wildlog stores the cellar in SwiftData', project: 'wildlog' }, owner) as { memory: { id: string } }).memory;
  const c = (await memories.remember({ kind: 'decision', content: 'wildlog stores the cellar in CloudKit', project: 'wildlog' }, owner) as { memory: { id: string } }).memory;
  const resolve = pages.resolver();
  assert.equal(resolve(`fact:${fact.id}`)!.replacedHref, undefined);
  memories.supersede([fact.id], b.id, owner);
  memories.supersede([b.id], c.id, owner);
  assert.equal(resolve(`fact:${fact.id}`)!.replacedHref, `/memories/${c.id}`);
  assert.equal(resolve(`fact:${fact.id}`)!.href, `/memories/${fact.id}`);
  memories.forget(c.id, owner);
  assert.equal(resolve(`fact:${fact.id}`)!.replacedHref, `/memories/${fact.id}`);
  assert.equal(resolve(`fact:${c.id}`), null);
});

test('related facts on a page leave replaced facts out', async () => {
  const { pages, memories, fact } = await setup();
  const b = (await memories.remember({ kind: 'decision', content: 'wildlog stores the cellar in SwiftData', project: 'wildlog' }, owner) as { memory: { id: string } }).memory;
  const p = await pages.create({ title: 'Storage', project: 'wildlog', body: 'wildlog stores the cellar' }, 'owner');
  assert.ok(pages.relatedFacts(p, 0.2).some((m) => m.id === fact.id));
  memories.supersede([fact.id], b.id, owner);
  assert.ok(!pages.relatedFacts(p, 0.2).some((m) => m.id === fact.id));
});

// ---- When a page counts as brought up to date (round 2 section 13) ----

const T1 = '2026-11-03T11:00:00.000Z', T2 = '2026-11-03T12:00:00.000Z', T3 = '2026-11-03T13:00:00.000Z', T4 = '2026-11-03T14:00:00.000Z', T5 = '2026-11-03T15:00:00.000Z';
const THREE = 'The cellar.\n\n## What it does\nKeeps bottles.\n\n## Run, build and deploy\nXcode.\n\n## Key decisions\n- 2026-10-12 Offline first.';

test('a new page and a whole-page save are brought up to date now, by their writer', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  assert.deepEqual(p.caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
  at(T2);
  const s = await pages.save(p.id, { base: 1, body: `${THREE}\n- 2026-11-01 Two.` }, 'owner');
  assert.deepEqual(s.caughtUp, { at: T2, how: 'saved', by: 'owner' });
});

test('editing another section keeps the caught-up time; editing Key decisions sets it', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T2);
  const r = await pages.saveSection(p.id, { base: 1, anchor: 'run-build-and-deploy', text: '## Run, build and deploy\nXcode 17.' }, 'Grok');
  assert.deepEqual(r.caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
  assert.equal(pages.version(p.id, 2)!.caughtUpAt, T1);
  at(T3);
  const k = await pages.saveSection(p.id, { base: 2, anchor: 'key-decisions', text: '## Key decisions\n- 2026-10-12 Offline first.\n- 2026-11-01 iCloud.' }, 'Grok');
  assert.deepEqual(k.caughtUp, { at: T3, how: 'key_decisions', by: 'Grok' });
});

test('renaming or removing Key decisions, or adding it inside another section, counts as editing it', async () => {
  for (const [anchor, text] of [
    ['key-decisions', '## Decisions\n- 2026-10-12 Offline first.'],
    ['key-decisions', ''],
    ['run-build-and-deploy', '## Run, build and deploy\nXcode.\n\n## Key decisions\n- 2026-11-01 x'],
  ] as const) {
    const { pages, at } = await setup();
    at(T1);
    const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
    at(T2);
    const k = await pages.saveSection(p.id, { base: 1, anchor, text }, 'owner');
    assert.deepEqual(k.caughtUp, { at: T2, how: 'key_decisions', by: 'owner' }, `${anchor}: ${text}`);
  }
});

test('a section edit on a page without Key decisions brings it up to date', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — TestFlight runbook', project: 'wildlog', body: 'Steps.\n\n## Upload\nArchive.' }, 'owner');
  at(T2);
  const s = await pages.saveSection(p.id, { base: 1, anchor: 'upload', text: '## Upload\nArchive, then upload.' }, 'Claude Code');
  assert.deepEqual(s.caughtUp, { at: T2, how: 'saved', by: 'Claude Code' });
});

test('a section edit from an old version saves nothing and keeps the caught-up time', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  await pages.saveSection(p.id, { base: 1, anchor: 'run-build-and-deploy', text: '## Run, build and deploy\nXcode 17.' }, 'owner');
  at(T2);
  await assert.rejects(pages.saveSection(p.id, { base: 1, anchor: 'key-decisions', text: '## Key decisions\n- 2026-11-01 x' }, 'owner'), code('conflict'));
  assert.equal(pages.versions(p.id).length, 2);
  assert.deepEqual(pages.get(p.id)!.caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
});

test('restoring an old version takes the earlier caught-up time, never a newer one', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T3);
  await pages.saveSection(p.id, { base: 1, anchor: 'key-decisions', text: '## Key decisions\n- 2026-11-01 x' }, 'owner');
  at(T4);
  const r = await pages.restore(p.id, 1, 'owner');
  assert.deepEqual(r.caughtUp, { at: T1, how: 'restored', by: 'owner' });
  at(T5);
  const back = await pages.restore(p.id, 2, 'Grok');
  assert.deepEqual(back.caughtUp, { at: T1, how: 'restored', by: 'owner' });
  assert.equal(pages.version(p.id, 4)!.caughtUpAt, T1);
});

test('restoring a version saved before migration 23 uses its saved time', async () => {
  const { pages, at, db } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T3);
  await pages.save(p.id, { base: 1, body: `${THREE}\n- 2026-11-01 Two.` }, 'owner');
  db.prepare('UPDATE page_versions SET caught_up_at = NULL, saved_at = ? WHERE page_id = ? AND version = 1').run(T2, p.id);
  at(T4);
  const r = await pages.restore(p.id, 1, 'owner');
  assert.deepEqual(r.caughtUp, { at: T2, how: 'restored', by: 'owner' });
});

test('undeleting a page keeps its caught-up time', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T2);
  pages.remove(p.id, 'owner');
  at(T3);
  const u = await pages.undelete(p.id, 'owner');
  assert.deepEqual(u.caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
});

test('every write tells the meaning index once, restore and undelete included', async () => {
  const { pages } = await setup();
  const told: string[] = [];
  pages.setMeaningHook({ factsChanged() {}, pageChanged: (id: string) => { told.push(id); }, projectChanged() {}, factsBroughtBack() {} });
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'owner');
  await pages.save(p.id, { base: 1, body: `${THREE}\n- 2026-11-01 Two.` }, 'owner');
  await pages.saveSection(p.id, { base: 2, anchor: 'run-build-and-deploy', text: '## Run, build and deploy\nXcode 17.' }, 'owner');
  await pages.restore(p.id, 1, 'owner');
  pages.remove(p.id, 'owner');
  await pages.undelete(p.id, 'owner');
  assert.deepEqual(told, [p.id, p.id, p.id, p.id, p.id]);
});

test('Still true is the owner\'s, and Undo after a section save is refused with a plain reason', async () => {
  const { pages, at } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T2);
  assert.deepEqual(pages.stillTrue(p.id).caughtUp, { at: T2, how: 'still_true', by: 'owner' });
  at(T3);
  await pages.saveSection(p.id, { base: 1, anchor: 'key-decisions', text: '## Key decisions\n- 2026-11-01 x' }, 'Claude Code');
  assert.throws(() => pages.undoStillTrue(p.id), code('conflict', /^Something else brought this page up to date since, so Undo is no longer available\.$/));
  assert.deepEqual(pages.get(p.id)!.caughtUp, { at: T3, how: 'key_decisions', by: 'Claude Code' });
  pages.remove(p.id, 'owner');
  assert.throws(() => pages.stillTrue(p.id), code('not_found'));
});

test('Still true tapped twice 200 ms apart is one check, and only one Undo is possible', async () => {
  const { pages, at, tick, db } = await setup();
  at(T1);
  const p = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: THREE }, 'Claude Code');
  at(T2);
  pages.stillTrue(p.id);
  tick(200);
  pages.stillTrue(p.id);
  assert.equal(count(db, 'page_checks'), 1);
  assert.equal(pages.get(p.id)!.caughtUp.at, T2);
  assert.deepEqual(pages.undoStillTrue(p.id).caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
  assert.throws(() => pages.undoStillTrue(p.id), code('conflict'));
  assert.deepEqual(pages.get(p.id)!.caughtUp, { at: T1, how: 'created', by: 'Claude Code' });
});

test('Still true on a page already still true is a no-op only while it is not flagged', async () => {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const p = await w.page('2026-10-21T09:00:00.000Z', 'wildlog — cellar', 'wildlog', THREE);
  w.at(T1);
  w.pages.stillTrue(p.id);
  w.at(T2);
  w.pages.stillTrue(p.id);
  assert.equal(count(w.db, 'page_checks'), 1);
  w.decision('2026-11-03T12:10:00.000Z', 'a', 'wildlog');
  w.decision('2026-11-03T12:20:00.000Z', 'b', 'wildlog');
  w.decision('2026-11-03T12:30:00.000Z', 'c', 'wildlog');
  assert.notEqual(w.pages.freshness.forPage(w.pages.get(p.id)!), null);
  w.at(T3);
  assert.deepEqual(w.pages.stillTrue(p.id).caughtUp, { at: T3, how: 'still_true', by: 'owner' });
  assert.equal(count(w.db, 'page_checks'), 2);
  assert.deepEqual(w.pages.undoStillTrue(p.id).caughtUp, { at: T1, how: 'still_true', by: 'owner' });
  assert.throws(() => w.pages.undoStillTrue(p.id), code('conflict'));
});

test('page_images follows every save: create, a save without one picture, and a restore', async () => {
  const { db, pages } = await setup();
  const a = 'a'.repeat(24), b = 'b'.repeat(24);
  const ids = (id: string) => (db.prepare('SELECT image_id FROM page_images WHERE page_id = ? ORDER BY image_id').all(id) as { image_id: string }[]).map((r) => r.image_id);
  const p = await pages.create({ title: 'Pictures', area: 'apps', body: `One ![x](/images/${a}.jpg)\n\n![y](/images/${b}.png "Two")` }, 'owner');
  assert.deepEqual(ids(p.id), [a, b]);
  const p2 = await pages.save(p.id, { base: 1, body: `Only ![y](/images/${b}.png)` }, 'owner');
  assert.deepEqual(ids(p.id), [b]);
  await pages.restore(p.id, 1, 'owner');
  assert.deepEqual(ids(p2.id), [a, b]);
});
