/** Where a fact or a page was opened from: every list names itself in its links, the back link and lit place follow, and the fact's forms keep the origin. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { seedWildlogWeek } from '../testing/reviewFixtures.js';

const owner = { type: 'owner' } as const;

/** The header's one lit place, as tabs.test.ts reads it: a label, or null when none is lit. */
function lit(body: string): string | null {
  const header = body.split('</header>')[0]!;
  const marks = [...header.matchAll(/<a[^>]*aria-current="page"[^>]*>(?:<span class="settings-word">)?([^<]*)/g)].map((m) => m[1]!);
  assert.ok(marks.length <= 1, marks.join());
  return marks[0] ?? null;
}

async function start(t: TestContext, startAt = '2026-09-20T09:00:00Z') {
  const app = await startTestApp({ startAt: new Date(startAt) });
  t.after(() => app.close());
  return app;
}
type App = Awaited<ReturnType<typeof startTestApp>>;
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });
const save = async (app: App, content: string, extra: Record<string, unknown> = {}) => {
  const r = await app.deps.service.remember({ kind: 'decision', content, project: 'wildlog', newProject: true, allowDuplicate: true, ...extra } as any, owner) as any;
  assert.equal(r.status, 'saved', r.status);
  return r.memory.id as string;
};

test('a fact opened from Facts goes back to the same spot and lights Pages', async (t) => {
  const app = await start(t);
  const id = await save(app, 'wildlog keeps the cellar in SQLite');
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${id}?from=${encodeURIComponent('/facts?kind=decision&page=2')}`)).text();
  assert.match(body, /<a class="top-back" href="\/facts\?kind=decision&amp;page=2"><span>Facts<\/span><\/a>/);
  assert.equal(lit(body), 'Pages');
  const none = await (await f(`/memories/${id}`)).text();
  assert.match(none, /<p class="crumb back"><a href="\/\?project=wildlog#panel">‹ wildlog<\/a><\/p>/);
  assert.equal(lit(none), 'Projects');
  const evil = await (await f(`/memories/${id}?from=${encodeURIComponent('//evil.example')}`)).text();
  assert.match(evil, /‹ wildlog/);
  assert.equal(lit(evil), 'Projects');
});

test('every list links its facts and pages with its own address', async (t) => {
  const app = await start(t, '2026-10-18T08:00:00Z');
  await seedWildlogWeek(app.deps, app.advance);
  const thisWeek = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog prints the cellar labels with a thermal printer', project: 'wildlog' }, owner) as any).memory.id as string;
  const older = await save(app, 'wildlog used Core Data for the cellar');
  const newer = await save(app, 'wildlog uses SwiftData for the cellar', { supersedes: [older] });
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The cellar app.' }, 'owner');
  const d = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which icon?', question: 'Which icon?', project: 'wildlog' });
  const closed = await app.deps.discussions.close('owner', d.id, { decision: 'Use the bottle label photo.', project: 'wildlog' });
  const f = await loggedIn(app);
  // The project panel: its facts, its pages and its Replaced fold.
  const panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, /href="\/memories\/[0-9a-f-]{36}\?from=%2F%3Fproject%3Dwildlog"/);
  assert.match(panel, new RegExp(`href="/pages/${page.id}\\?from=%2F%3Fproject%3Dwildlog"`));
  // Tidy up.
  await save(app, 'wildlog labels the racks by hand');
  await save(app, 'wildlog labels the racks by hand');
  const tidy = await (await f('/facts/tidy')).text();
  assert.match(tidy, /href="\/memories\/[0-9a-f-]{36}\?from=%2Ffacts%2Ftidy"/);
  // Search.
  const search = await (await f('/search?q=cellar')).text();
  assert.match(search, /href="\/memories\/[0-9a-f-]{36}\?from=%2Fsearch%3Fq%3Dcellar"/);
  // A page's Related facts.
  const reading = await (await f(`/pages/${page.id}`)).text();
  assert.match(reading, new RegExp(`href="/memories/[0-9a-f-]{36}\\?from=%2Fpages%2F${page.id}"`));
  // Last week's decisions, and So far's Latest changes rows.
  const decided = app.deps.store.list({ project: 'wildlog', kind: 'decision' }).find((m) => m.content.startsWith('Label photos'))!;
  const review = await (await f('/review')).text();
  assert.match(review, new RegExp(`href="/memories/${decided.id}\\?from=%2Freview"`));
  const sofar = await (await f('/review/now')).text();
  assert.match(sofar, new RegExp(`href="/memories/${thisWeek}\\?from=%2Freview%2Fnow"`));
  // A closed discussion's "Open the memory", and the fact it opens.
  const disc = await (await f(`/discussions/${d.id}`)).text();
  assert.match(disc, new RegExp(`href="/memories/${closed.memoryId}\\?from=%2Fdiscussions%2F${d.id}"`));
  const opened = await (await f(`/memories/${closed.memoryId}?from=${encodeURIComponent(`/discussions/${d.id}`)}`)).text();
  assert.match(opened, new RegExp(`<a class="top-back" href="/discussions/${d.id}"><span>Discussion</span></a>`));
  assert.equal(lit(opened), 'Projects');
  // A fact's timeline links carry the fact's own plain path, never a nested origin.
  const fact = await (await f(`/memories/${newer}?from=${encodeURIComponent('/facts')}`)).text();
  assert.match(fact, new RegExp(`href="/memories/${older}\\?from=%2Fmemories%2F${newer}"`));
  assert.doesNotMatch(fact, /from=[^"' ]*from=/);
});

test('the Graph links its pages with its own address', async (t) => {
  const src = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8');
  assert.match(src, /a\.href = `\/pages\/\$\{encodeURIComponent\(pg\.id\)\}\?from=` \+ encodeURIComponent\(`\/graph\?project=\$\{p\.name\}`\);/);
  const app = await start(t);
  await save(app, 'wildlog keeps the cellar in SQLite');
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The cellar app.' }, 'owner');
  const f = await loggedIn(app);
  const project = await (await f(`/pages/${page.id}?from=${encodeURIComponent('/graph?project=wildlog')}`)).text();
  assert.match(project, /<a class="top-back" href="\/graph\?project=wildlog"><span>Graph<\/span><\/a>/);
  assert.equal(lit(project), 'Graph');
  const list = await (await f(`/pages/${page.id}?from=${encodeURIComponent('/graph?view=list')}`)).text();
  assert.match(list, /<a class="top-back" href="\/graph\?view=list"><span>Graph<\/span><\/a>/);
});

test('Show all keeps the way back', async (t) => {
  const app = await start(t);
  for (let i = 0; i < 12; i++) await save(app, `wildlog rack ${i} holds the bottles from region ${i}`);
  const id = await save(app, 'wildlog keeps the cellar in SQLite');
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${id}?from=${encodeURIComponent('/facts/tidy')}`)).text();
  assert.match(body, new RegExp(`href="/memories/${id}\\?pick=all&amp;from=%2Ffacts%2Ftidy#replace"`));
  const all = await (await f(`/memories/${id}?pick=all&from=${encodeURIComponent('/facts/tidy')}`)).text();
  assert.match(all, /<p class="crumb back"><a href="\/facts\/tidy">‹ Tidy up<\/a><\/p>/);
});

test('Save, Undo and Mark as replaced keep the origin', async (t) => {
  const app = await start(t);
  const id = await save(app, 'wildlog keeps the cellar in SQLite');
  const other = await save(app, 'wildlog keeps the cellar in GRDB');
  const f = await loggedIn(app);
  const saved = await f(`/memories/${id}`, form({ content: 'wildlog keeps the cellar in SQLite on the phone', project: 'wildlog', tags: '', base: app.deps.store.get(id)!.updatedAt, from: '/facts/tidy' }));
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), `/memories/${id}?from=%2Ffacts%2Ftidy`);
  const entry = app.deps.store.history(id).find((e) => e.action === 'update')!;
  const undone = await f(`/history/${entry.id}/undo`, form({ part: 'history', from: '/facts/tidy' }));
  assert.equal(undone.status, 303);
  assert.equal(undone.headers.get('location'), `/memories/${id}?from=%2Ffacts%2Ftidy`);
  const marked = await f(`/memories/${id}/supersede`, form({ by: other, from: '/facts/tidy' }));
  assert.equal(marked.status, 303);
  assert.equal(marked.headers.get('location'), `/memories/${id}?from=%2Ffacts%2Ftidy`);
  const plain = await f(`/memories/${other}`, form({ content: 'wildlog keeps the cellar in GRDB on the phone', project: 'wildlog', tags: '', base: app.deps.store.get(other)!.updatedAt, from: 'https://evil.example/' }));
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get('location'), `/memories/${other}`, 'a rejected origin is dropped');
});

test('Delete returns to the back target', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const from = await save(app, 'wildlog keeps the cellar in SQLite');
  assert.equal((await f(`/memories/${from}/delete`, form({ from: '/facts/tidy' }))).headers.get('location'), '/facts/tidy');
  const noFrom = await save(app, 'wildlog racks the cellar in wood');
  assert.equal((await f(`/memories/${noFrom}/delete`, form({}))).headers.get('location'), '/?project=wildlog#panel');
  const home = await save(app, 'wildlog chills the cellar at 12 degrees');
  assert.equal((await f(`/memories/${home}/delete`, form({ back: 'home' }))).headers.get('location'), '/');
  const tidy = await save(app, 'wildlog chills the whites colder');
  assert.equal((await f(`/memories/${tidy}/delete`, form({ back: 'tidy' }))).headers.get('location'), '/facts/tidy');
});

test('a Location header never leaves the site', async (t) => {
  const app = await start(t);
  const id = await save(app, 'wildlog keeps the cellar in SQLite');
  const other = await save(app, 'wildlog keeps the cellar in GRDB');
  await app.deps.service.update(other, { content: 'wildlog keeps the cellar in GRDB, v2' }, owner);
  const entry = app.deps.store.history(other).find((e) => e.action === 'update')!;
  const f = await loggedIn(app);
  const posts: [string, Record<string, string>][] = [
    [`/memories/${id}`, { content: 'wildlog keeps the cellar in SQLite on the phone', project: 'wildlog', tags: '', base: app.deps.store.get(id)!.updatedAt }],
    [`/history/${entry.id}/undo`, { part: 'history' }],
    [`/memories/${other}/supersede`, { by: id }],
    [`/memories/${id}/delete`, {}],
  ];
  for (const [path, fields] of posts) {
    const res = await f(path, form({ ...fields, from: 'https://evil.example/' }));
    assert.equal(res.status, 303, path);
    const location = res.headers.get('location')!;
    assert.match(location, /^\//, path);
    assert.doesNotMatch(location, /^\/\//, path);
  }
});
