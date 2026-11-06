import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderMarkdown } from '../pages/markdown.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';

async function world(t: TestContext) {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const img = a.deps.images.add(await fx.jpegWithGps(), { alt: 'The old cellar list', by: 'Claude Code' });
  const line = `![The old cellar list](/images/${img.id}.jpg)`;
  const p = await a.deps.pages.create({ title: 'wildlog — screens', area: 'apps', body: `Lead.\n\n${line}` }, 'owner');
  await a.deps.pages.save(p.id, { base: 1, body: `Lead again.\n\n${line}` }, 'owner');
  await a.deps.pages.save(p.id, { base: 2, body: 'Lead, no picture now.' }, 'owner');
  const post = (path: string) => f(path, { method: 'POST', body: new URLSearchParams({}) });
  return { a, f, img, p, line, post };
}

test('Review lists a picture no current page shows, with the version that removed it and the old versions that use it', async (t) => {
  const { a, f, img, p } = await world(t);
  const shown = a.deps.images.add(await fx.pngWithText(), { alt: 'Still shown', by: 'owner' });
  await a.deps.pages.create({ title: 'Other', area: 'apps', body: `![s](/images/${shown.id}.png)` }, 'owner');
  const body = await (await f('/settings/pictures')).text();
  assert.match(body, /<h1>Pictures no current page shows<\/h1>/);
  assert.match(body, /The old cellar list/);
  assert.match(body, new RegExp(`<a href="/pages/${p.id}">wildlog — screens</a>`));
  assert.match(body, /removed in version 3/);
  assert.match(body, /versions 1 to 2 still use it/);
  assert.match(body, /Added by Claude Code/);
  assert.match(body, new RegExp(`href="/settings/pictures/${img.id}/delete">Delete for good…</a>`));
  assert.doesNotMatch(body, /Still shown/);
  assert.match(body, new RegExp(`<p class="meta"><span>On <a href="/pages/${p.id}">wildlog — screens</a> · removed in version 3 · versions 1 to 2 still use it</span></p>`), 'one run of text in the flex meta row');
});

test('the confirmation says exactly what happens; Delete for good removes the row\'s file and old versions say so', async (t) => {
  const { a, f, img, line, post } = await world(t);
  const confirm = await (await f(`/settings/pictures/${img.id}/delete`)).text();
  const today = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(a.deps.now());
  for (const sentence of [
    "It disappears from the brain now, and from any phone's offline copy at its next update.",
    `Versions 1 to 2 of the page show "This picture was deleted on ${today}" in its place, and their text stays.`,
    'The nightly backup copies drop it within 30 days and the off-site copy within 90 days.',
    'The git export never had it.',
  ]) assert.ok(confirm.includes(sentence.replace(/"/g, '&quot;')) || confirm.includes(sentence), sentence);
  assert.match(confirm, /<a class="button secondary" href="\/settings\/pictures">Keep it<\/a>/);
  assert.match(confirm, new RegExp(`<form method="post" action="/settings/pictures/${img.id}/delete"><button type="submit" class="danger">Delete for good</button></form>`));
  const path = a.deps.images.path(img);
  const r = await post(`/settings/pictures/${img.id}/delete`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings/pictures?deleted=1');
  assert.ok(!existsSync(path));
  assert.ok(a.deps.images.get(img.id)!.removedAt);
  assert.match(renderMarkdown(line, () => null, a.deps.pages.pictures(line)).value, new RegExp(`This picture was deleted on ${today}`));
  assert.match(await (await f('/settings/pictures?deleted=1')).text(), /Deleted for good\./);
  assert.equal((await post(`/settings/pictures/${img.id}/delete`)).status, 404, 'a second press');
  assert.equal((await post('/settings/pictures/nope/delete')).status, 404);
});

test('a picture shown again since the list was opened is refused and kept; a deleted first page is named, not linked', async (t) => {
  const { a, img, line, p, post } = await world(t);
  await a.deps.pages.create({ title: 'Back again', area: 'apps', body: line }, 'owner');
  const r = await post(`/settings/pictures/${img.id}/delete`);
  assert.equal(r.status, 409);
  assert.ok(existsSync(a.deps.images.path(img)));
  const loose = a.deps.images.add(await fx.gifWithComment(), { alt: 'Orphan', by: 'owner', pageId: p.id });
  a.deps.pages.remove(p.id, 'owner');
  const body = await (await (await loggedIn(a))('/settings/pictures')).text();
  assert.match(body, /Orphan[\s\S]*a deleted page/);
  void loose;
});

test('the Review screen is the owner\'s only', async (t) => {
  const { a } = await world(t);
  assert.equal((await fetch(`${a.baseUrl}/settings/pictures`, { redirect: 'manual' })).status, 302);
});
