/*
 * The [[ link picker (UI round, task 4): the pages and facts a page can point at, and the route the editor asks
 * for them.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { linkInsert, type LinkTarget } from './linkTargets.js';

const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'the cellar app is a SwiftUI app', project: 'wildlog' }, owner);
  await app.deps.service.remember({ kind: 'summary', content: 'homelab reaches the outside only through a tunnel' }, owner);
  const page = await app.deps.pages.create({ title: 'homelab — the mini PC at home', project: 'wildlog', body: 'Home.' }, 'owner');
  await app.deps.pages.create({ title: 'the cellar app', project: 'wildlog', body: 'Cellar.' }, 'owner');
  return { app, f: await loggedIn(app), page };
}

test('a title becomes a link, unless it cannot be written that way', () => {
  assert.equal(linkInsert('Plain'), '[[Plain]]');
  assert.equal(linkInsert('homelab — the mini PC at home'), '[[homelab — the mini PC at home]]');
  assert.equal(linkInsert('a]]b'), null);
  assert.equal(linkInsert('a[[b'), null);
  assert.equal(linkInsert('x\ny'), null);
  assert.equal(linkInsert('x\r\ny'), null);
});

test('the picker\'s route is the owner\'s, and a short word asks for nothing', async (t) => {
  const { app, f } = await start(t);
  const anon = await fetch(`${app.baseUrl}/pages/link-targets.json?q=hom`, { redirect: 'manual' });
  assert.equal(anon.status, 302, 'not signed in: the same redirect as the other owner pages');
  assert.match(anon.headers.get('location') ?? '', /^\/login\?next=/);
  let calls = 0;
  const recall = app.deps.service.recall.bind(app.deps.service);
  app.deps.service.recall = (async (q: Parameters<typeof recall>[0]) => { calls++; return recall(q); }) as typeof app.deps.service.recall;
  const short = await (await f('/pages/link-targets.json?q=a')).json() as LinkTarget[];
  assert.deepEqual(short, [], 'one letter is not enough to look for anything');
  assert.equal(calls, 0, 'and nothing is asked of the facts');
  const none = await (await f('/pages/link-targets.json?q=zzzznothing')).json() as LinkTarget[];
  assert.deepEqual(none, []);
});

test('the picker offers the pages first, then the facts, and never more than eight', async (t) => {
  const { app, f } = await start(t);
  const res = await f('/pages/link-targets.json?q=cellar');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const items = await res.json() as LinkTarget[];
  assert.ok(items.length <= 8, `at most eight (got ${items.length})`);
  const page = items.find((x) => x.kind === 'page');
  assert.ok(page, 'the page is offered');
  assert.equal(page.label, 'the cellar app');
  assert.equal(page.insert, '[[the cellar app]]');
  assert.equal(page.detail, 'wildlog', 'the project it belongs to');
  const fact = items.find((x) => x.kind === 'fact');
  assert.ok(fact, 'the fact is offered too');
  assert.match(fact.insert, /^\[\[fact:[0-9a-f-]{36}\]\]$/, 'a fact is linked by its id');
  assert.equal(fact.label, 'the cellar app is a SwiftUI app');
  assert.equal(fact.detail, 'wildlog');
  // The pages come before the facts.
  const firstFact = items.findIndex((x) => x.kind === 'fact');
  assert.ok(items.slice(0, firstFact).every((x) => x.kind === 'page'));
  void app;
});

test('the picker never offers more than eight things, even when there are many', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 9; i++) await app.deps.pages.create({ title: `cellar page ${i}`, project: 'wildlog', body: 'x' }, 'owner');
  for (let i = 0; i < 3; i++) await app.deps.service.remember({ kind: 'summary', content: `the cellar holds ${i} bottles` }, owner);
  const items = await (await f('/pages/link-targets.json?q=cellar')).json() as LinkTarget[];
  assert.equal(items.length, 8, 'six pages and two facts, not nine');
  const firstFact = items.findIndex((x) => x.kind === 'fact');
  assert.ok(firstFact > 0 && items.slice(0, firstFact).every((x) => x.kind === 'page'), 'the pages come first');
});
