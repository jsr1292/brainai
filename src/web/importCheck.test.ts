import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { seedMoved, type MovedDoc } from '../testing/movedFixtures.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;
const doc = (id: string, collection: string, title: string, text: string): MovedDoc => ({ id, collection, title, text, updatedAt: '2026-11-03T11:00:00Z' });

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const { registry, service, store, pages } = app.deps;
  registry.create('wildlog', { state: 'open' }, 'owner');
  await service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, owner);
  const db = (store as unknown as { db: import('../db.js').DB }).db;
  const deps = { pages, registry, memories: service, memoryStore: store, db, now: app.deps.now };
  await seedMoved(deps, [
    doc('o1', 'Apps', 'wildlog — wine cellar', 'The cellar app.\n\n## Stack\nSwiftUI.'),
    doc('o2', 'Home & infrastructure', 'Home network and servers — overview', 'Network <script>alert(1)</script> notes.'),
    doc('o3', 'Apps', 'castle3d — 3D house', 'A house.'),
  ]);
  return { app, f: await loggedIn(app) };
}
const post = (body: Record<string, string> = {}) => ({ method: 'POST', body: new URLSearchParams(body) });

test('the move is out of Settings: Pages names it at its foot', async (t) => {
  const { f } = await start(t);
  const settings = await (await f('/settings')).text();
  assert.doesNotMatch(settings, /id="moved"|Moved from Outline/);
  const pages = await (await f('/pages')).text();
  assert.match(pages, /Moved from Outline: 3 pages came over/);
});

test('the import list links each document to its page and its comparison', async (t) => {
  const { app, f } = await start(t);
  const body = await (await f('/pages/moved')).text();
  assert.match(body, /<title>Moved from Outline<\/title>/);
  const wine = app.deps.pages.list().find((p) => p.title.startsWith('wildlog'))!;
  assert.match(body, new RegExp(`<a href="/pages/${wine.id}">wildlog — wine cellar</a>`));
  assert.match(body, /href="\/pages\/moved\/o1">Compare<\/a>/);
  assert.equal((body.match(/not checked yet/g) ?? []).length, 3);
});

test('the comparison shows the original escaped next to the rendered page', async (t) => {
  const { f } = await start(t);
  const body = await (await f('/pages/moved/o2')).text();
  assert.match(body, /<pre class="original">Network &lt;script&gt;alert\(1\)&lt;\/script&gt; notes\.<\/pre>/);
  assert.match(body, /<div class="art moved">[\s\S]*Network &lt;script&gt;alert\(1\)&lt;\/script&gt; notes\./);
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /<form method="post" action="\/pages\/moved\/o2\/check"><button type="submit">Looks right<\/button><\/form>/);
});

test('Looks right marks it checked and goes to the next unchecked document', async (t) => {
  const { f } = await start(t);
  const first = await f('/pages/moved/o3/check', post());
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/pages/moved/o1', 'the next unchecked one in list order: Apps, by title');
  assert.equal((await f('/pages/moved/o1/check', post())).headers.get('location'), '/pages/moved/o2');
  const last = await f('/pages/moved/o2/check', post());
  assert.equal(last.headers.get('location'), '/pages/moved');
  const moved = await (await f('/pages/moved')).text();
  assert.equal((moved.match(/>checked</g) ?? []).length, 3);
});

test('the import pages need the owner, and an unknown id answers 404', async (t) => {
  const { app, f } = await start(t);
  for (const path of ['/pages/moved', '/pages/moved/o1']) {
    const res = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 302, path);
  }
  assert.equal((await f('/pages/moved/nope')).status, 404);
  assert.equal((await f('/pages/moved/nope/check', post())).status, 404);
});

test('old Moved from Outline addresses and the check form still work', async (t) => {
  const { f } = await start(t);
  for (const [oldPath, next] of [['/settings/import', '/pages/moved'], ['/settings/import/o1', '/pages/moved/o1']]) {
    const res = await f(oldPath, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), next);
  }
  const checked = await f('/settings/import/o3/check', post());
  assert.equal(checked.status, 303);
  assert.equal(checked.headers.get('location'), '/pages/moved/o1');
});

test('Moved from Outline is under Pages with a back link on both screens', async (t) => {
  const { f } = await start(t);
  for (const [path, back] of [['/pages/moved', 'Pages'], ['/pages/moved/o1', 'Moved from Outline']]) {
    const body = await (await f(path)).text();
    assert.match(body, /<a href="\/pages" aria-current="page">Pages<\/a>/);
    assert.match(body, new RegExp(`‹ ${back}`));
  }
});
