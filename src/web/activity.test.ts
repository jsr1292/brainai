import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp, TEST_PASSWORD } from '../testing/helpers.js';
import { ACTIVITY_PAGE_SIZE } from '../memory/assistantActivity.js';

const DAY = 86_400_000;
const codex = { type: 'ai', name: 'Codex' } as const;
const claude = { type: 'ai', name: 'Claude Code' } as const;
const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('brainai', { state: 'open', area: 'apps' }, 'owner');
  const f = await loggedIn(app);
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    f(path, { method: 'POST', body: new URLSearchParams(body), headers });
  const save = async (actor: typeof codex | typeof claude | typeof owner, content: string, extra: Record<string, unknown> = {}) => {
    app.advance(1000);
    const r = await app.deps.service.remember({ kind: 'decision', project: 'brainai', content, ...extra } as never, actor);
    assert.equal(r.status, 'saved', content);
    return (r as any).memory as { id: string; content: string };
  };
  const body = async (path = '/activity') => (await f(path)).text();
  return { app, f, post, save, body, svc: app.deps.service, store: app.deps.store };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const rowsOf = (html: string) => html.split('<li class="entry').slice(1);

test('/activity needs the owner, and Undo needs the owner too', async (t) => {
  const { app, save, store } = await start(t);
  const m = await save(codex, 'Codex saved this decision about caching');
  const res = await fetch(`${app.baseUrl}/activity`, { redirect: 'manual' });
  assert.deepEqual([res.status, res.headers.get('location')], [302, '/login?next=%2Factivity']);
  const post = await fetch(`${app.baseUrl}/activity/undo`, { method: 'POST', body: new URLSearchParams({ kind: 'saved', ref: m.id }), redirect: 'manual', headers: { origin: app.baseUrl } });
  assert.equal(post.status, 302);
  assert.match(post.headers.get('location') ?? '', /^\/login/);
  assert.equal(store.get(m.id)!.deletedAt, null, 'nothing was undone without a login');
});

test('another site cannot press Undo: a form from a foreign origin, or one with no Origin, is refused and nothing changes', async (t) => {
  const { app, save, store } = await start(t);
  const m = await save(codex, 'Codex saved this decision about caching');
  const login = await fetch(`${app.baseUrl}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  for (const headers of [{ Cookie: cookie, Origin: 'https://evil.example' }, { Cookie: cookie }] as Record<string, string>[]) {
    const res = await fetch(`${app.baseUrl}/activity/undo`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ kind: 'saved', ref: m.id }) });
    assert.equal(res.status, 403);
  }
  assert.equal(store.get(m.id)!.deletedAt, null);
  const ok = await fetch(`${app.baseUrl}/activity/undo`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl }, body: new URLSearchParams({ kind: 'saved', ref: m.id }) });
  assert.equal(ok.status, 303, 'the same form from our own page works');
});

test('rows by kind: a save, a change with before and after, a deletion, a replacement and a page edit; newest first; the owner is left out', async (t) => {
  const { app, save, body, svc } = await start(t);
  const a = await save(codex, 'Codex saved: the beds are raised');
  const b = await save(codex, 'Codex will change this text soon');
  app.advance(1000);
  await svc.update(b.id, { content: 'Codex changed this text later' }, codex);
  const c = await save(codex, 'Codex deletes this fact');
  app.advance(1000);
  svc.forget(c.id, codex);
  const old = await save(claude, 'Claude Code: the old way of deploying');
  app.advance(1000);
  const fresh = await svc.remember({ kind: 'decision', project: 'brainai', content: 'Claude Code: the new way of deploying', supersedes: [old.id] }, claude);
  assert.equal(fresh.status, 'saved');
  const p = await app.deps.pages.create({ title: 'brainai — overview', project: 'brainai', body: 'Lead.\n\n## Stack\nx' }, 'Codex');
  app.advance(1000);
  await app.deps.pages.save(p.id, { base: 1, title: 'brainai — overview', body: 'Lead.\n\n## Stack\ny' }, 'Codex');
  // The owner's own save, edit and delete are never listed.
  const mine = await save(owner, 'Owner wrote this one themselves');
  app.advance(1000);
  await svc.update(mine.id, { content: 'Owner rewrote it' }, owner);
  const gone = await save(owner, 'Owner deleted this fact');
  svc.forget(gone.id, owner);

  const html = await body();
  assert.match(html, /<title>Activity<\/title>/);
  const rows = rowsOf(html);
  assert.ok(!/Owner (wrote|rewrote|deleted)/.test(html), 'the owner\'s own work is not assistant activity');
  const kinds = rows.map((r) => /<span class="verb">([^<]+)<\/span>/.exec(r)![1]);
  // Newest first: page v2, page v1, replaced and the new fact saved in the same instant (the replacement lists first), the old fact, deleted, saved (c), changed, saved (b), saved (a).
  assert.deepEqual(kinds, ['edited a page', 'edited a page', 'replaced', 'saved', 'saved', 'deleted', 'saved', 'changed', 'saved', 'saved']);
  assert.ok(html.indexOf('Edited “Stack”: y.') < html.indexOf('Created the page.'), 'newest first, and the edit says where it happened and what changed');
  assert.match(text(html), /Edited “Stack”: y\. Page history has the earlier versions to restore\./, 'no stray space before punctuation');
  const change = rows.find((r) => r.includes('Codex changed this text later'))!;
  assert.match(text(change), /Codex will change this text soon → became Codex changed this text later/);
  assert.match(rows.find((r) => r.includes('Codex deletes this fact') && r.includes('deleted'))!, /Undo/);
  assert.match(text(rows.find((r) => r.includes('the old way of deploying') && r.includes('replaced'))!), /Replaced by a newer fact/);
  const page = rows.find((r) => r.includes('Edited “Stack”'))!;
  assert.match(page, new RegExp(`href="/pages/${p.id}/history"`));
  assert.doesNotMatch(page, /Undo/, 'a page edit links to its history, undo is there');
  void a;
});

test('rows are grouped by day: Today, Yesterday, then the date', async (t) => {
  const { app, save, body } = await start(t);
  await save(codex, 'Three days ago the assistant saved this');
  app.advance(2 * DAY);
  await save(codex, 'Yesterday the assistant saved this');
  app.advance(DAY);
  await save(codex, 'Today the assistant saved this');
  const html = await body();
  const heads = [...html.matchAll(/<div class="panel-head"><h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.equal(heads[0], 'Today');
  assert.equal(heads[1], 'Yesterday');
  assert.match(heads[2]!, /^[A-Z][a-z]+ \d{1,2} [A-Z][a-z]{2}$/);
  assert.ok(html.indexOf('Today the assistant') < html.indexOf('Yesterday the assistant') && html.indexOf('Yesterday the assistant') < html.indexOf('Three days ago'));
});

test('the filter lists the assistants and shows one assistant only; an unknown name is no filter', async (t) => {
  const { save, body } = await start(t);
  await save(codex, 'Codex saved this one');
  await save(claude, 'Claude Code saved that one');
  const all = await body();
  assert.match(all, /<nav class="act-filter" aria-label="Assistant"><a href="\/activity" aria-current="page">All<\/a><a href="\/activity\?by=Claude%20Code">Claude Code<\/a><a href="\/activity\?by=Codex">Codex<\/a>/);
  assert.equal(rowsOf(all).length, 2);
  const only = await body('/activity?by=Codex');
  assert.equal(rowsOf(only).length, 1);
  assert.match(only, /Codex saved this one/);
  assert.doesNotMatch(only, /Claude Code saved that one/);
  assert.match(only, /<a href="\/activity\?by=Codex" aria-current="page">Codex<\/a>/);
  assert.equal(rowsOf(await body('/activity?by=Nobody')).length, 2, 'unknown name: no filter');
  assert.equal(rowsOf(await body('/activity?by=owner')).length, 2, 'the owner is never a filter');
});

test('50 rows a page with Older and Newer', async (t) => {
  const { save, body } = await start(t);
  for (let i = 0; i < ACTIVITY_PAGE_SIZE + 5; i++) await save(codex, `Decision number ${String(i).padStart(3, '0')} about the activity feed`);
  const first = await body();
  assert.equal(rowsOf(first).length, 50);
  assert.match(first, /<a href="\/activity\?page=2">Older<\/a>/);
  assert.doesNotMatch(first, />Newer</);
  assert.match(first, /number 054/);
  assert.doesNotMatch(first, /number 004/);
  const second = await body('/activity?page=2');
  assert.equal(rowsOf(second).length, 5);
  assert.match(second, /number 004/);
  assert.match(second, /<a href="\/activity">Newer<\/a>/);
  assert.doesNotMatch(second, />Older</);
  assert.equal(rowsOf(await body('/activity?page=junk')).length, 50, 'a bad page number is page 1');
  assert.equal(rowsOf(await body('/activity?page=9')).length, 0);
});

test('an empty feed says so', async (t) => {
  const { body } = await start(t);
  assert.match(await body(), /Nothing yet\. What your assistants save or change shows up here/);
});

test('Undo of a new fact counts as the owner deleting it, so a similar AI save is held as "the owner deleted this"', async (t) => {
  const { app, save, post, store, svc } = await start(t);
  const m = await save(codex, 'Codex saved: use pnpm for the workspace');
  const res = await post('/activity/undo', { kind: 'saved', ref: m.id, by: 'Codex', page: '1' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/activity?by=Codex&page=1&undone=saved');
  const row = app.deps.db!.prepare('SELECT deleted_at, deleted_by FROM memories WHERE id = ?').get(m.id) as { deleted_at: string | null; deleted_by: string };
  assert.ok(row.deleted_at);
  assert.equal(row.deleted_by, 'owner');
  assert.equal(store.history(m.id)[0]!.changedBy, 'owner');
  // Forgetting-that-sticks applies: the assistant cannot save it straight back.
  app.advance(1000);
  const again = await svc.remember({ kind: 'decision', project: 'brainai', content: 'Codex saved: use pnpm for the workspace' }, codex);
  assert.equal(again.status, 'suggested');
  assert.match((again as any).suggestion.reason, /you deleted/);
  assert.equal((again as any).suggestion.deletedMatch, m.id);
});

test('Undo of a change brings the version before it back', async (t) => {
  const { app, save, post, store, svc } = await start(t);
  const m = await save(codex, 'The first text of the fact');
  app.advance(1000);
  await svc.update(m.id, { content: 'The second text of the fact' }, codex);
  const hid = store.history(m.id)[0]!.id;
  const res = await post('/activity/undo', { kind: 'updated', ref: String(hid) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/activity?page=1&undone=updated');
  assert.equal(store.get(m.id)!.content, 'The first text of the fact');
  assert.equal(store.get(m.id)!.updatedBy, 'owner');
});

test('Undo of a deletion restores the fact', async (t) => {
  const { app, save, post, store, svc } = await start(t);
  const m = await save(codex, 'A fact the assistant deleted');
  app.advance(1000);
  svc.forget(m.id, codex);
  const hid = store.history(m.id)[0]!.id;
  assert.equal((await post('/activity/undo', { kind: 'deleted', ref: String(hid) })).status, 303);
  assert.equal(store.get(m.id)!.deletedAt, null);
});

test('a fact that replaced older ones cannot be undone until the replacement is: no older fact is left replaced by a deleted one', async (t) => {
  const { app, save, post, body, store, svc } = await start(t);
  const old = await save(claude, 'The old deploy way');
  app.advance(1000);
  const fresh = (await svc.remember({ kind: 'decision', project: 'brainai', content: 'The new deploy way', supersedes: [old.id] }, claude)) as any;
  const html = await body();
  const row = rowsOf(html).find((r) => r.includes('The new deploy way') && r.includes('verb">saved'))!;
  assert.doesNotMatch(row, /<button/);
  assert.equal((await post('/activity/undo', { kind: 'saved', ref: fresh.memory.id })).status, 303);
  assert.equal(store.get(fresh.memory.id)!.deletedAt, null);
  assert.match(text(row), /Can't be undone here: stands in for replaced facts\./);
  await post('/activity/undo', { kind: 'replaced', ref: String(store.supersessions.liveFor(old.id)!.id) });
  assert.equal((await post('/activity/undo', { kind: 'saved', ref: fresh.memory.id })).status, 303);
});

test('Undo of a replacement brings the older fact back', async (t) => {
  const { app, save, post, store, svc, f } = await start(t);
  const old = await save(claude, 'The old deploy way');
  app.advance(1000);
  await svc.remember({ kind: 'decision', project: 'brainai', content: 'The new deploy way', supersedes: [old.id] }, claude);
  const row = store.supersessions.liveFor(old.id)!;
  assert.equal((await post('/activity/undo', { kind: 'replaced', ref: String(row.id) })).status, 303);
  assert.equal(store.supersessions.liveFor(old.id), undefined);
  // Pressing it again is refused plainly.
  const again = await post('/activity/undo', { kind: 'replaced', ref: String(row.id) });
  assert.equal(again.status, 303, 'post, redirect, get: the refusal is a page of its own, safe to reload');
  const shown = await f(again.headers.get('location')!);
  assert.equal(shown.status, 200);
  const html = await shown.text();
  assert.match(html, /Not undone: the older fact was already brought back\./);
  assert.match(html, new RegExp(`href="/memories/${old.id}">Open the fact</a>`));
  assert.match(text(rowsOf(html).find((r) => r.includes('The old deploy way'))!), /Can't be undone here: already undone\./);
});

test('Undo is refused with a plain message when the fact changed since, and nothing is touched', async (t) => {
  const { app, save, post, body, store, svc, f } = await start(t);
  // A new fact the owner edited afterwards.
  const m = await save(codex, 'Codex saved the first words');
  app.advance(1000);
  await svc.update(m.id, { content: 'Owner edited the words afterwards' }, owner);
  const r1 = await post('/activity/undo', { kind: 'saved', ref: m.id });
  assert.equal(r1.status, 303);
  assert.match(r1.headers.get('location')!, /^\/activity\?page=1&refused=changed&fact=/);
  const shown = await (await f(r1.headers.get('location')!)).text();
  assert.match(shown, /Not undone: that fact changed after this, so it was left as it is\./);
  assert.match(shown, new RegExp(`<a href="/memories/${m.id}">Open the fact</a>`));
  assert.equal(store.get(m.id)!.deletedAt, null);
  assert.equal(store.get(m.id)!.content, 'Owner edited the words afterwards');
  // The list no longer offers Undo on it.
  assert.match(text(rowsOf(await body()).find((r) => r.includes('Codex saved the first words') || r.includes('Owner edited'))!), /Can't be undone here: changed since\./);

  // An assistant change followed by another change: only the latest can be undone.
  const n = await save(codex, 'Version one of the second fact');
  app.advance(1000);
  await svc.update(n.id, { content: 'Version two of the second fact' }, codex);
  const first = store.history(n.id)[0]!.id;
  app.advance(1000);
  await svc.update(n.id, { content: 'Version three of the second fact' }, claude);
  const r2 = await post('/activity/undo', { kind: 'updated', ref: String(first) });
  assert.equal(r2.status, 303);
  assert.equal(store.get(n.id)!.content, 'Version three of the second fact');

  // A deletion the owner already restored.
  const d = await save(codex, 'A fact deleted by the assistant');
  app.advance(1000);
  svc.forget(d.id, codex);
  const hid = store.history(d.id)[0]!.id;
  await svc.undo(hid, owner);
  const r3 = await post('/activity/undo', { kind: 'deleted', ref: String(hid) });
  assert.equal(r3.status, 303);
  assert.match(text(rowsOf(await body()).find((r) => r.includes('A fact deleted by the assistant') && r.includes('deleted'))!), /Can't be undone here: already undone\./);
});

test('bad Undo requests are refused', async (t) => {
  const { post } = await start(t);
  assert.equal((await post('/activity/undo', { kind: 'bogus', ref: '1' })).status, 400);
  assert.equal((await post('/activity/undo', { kind: 'updated', ref: 'abc' })).status, 400);
  assert.equal((await post('/activity/undo', { kind: 'saved' })).status, 400);
  assert.equal((await post('/activity/undo', { kind: 'updated', ref: '99999' })).status, 409);
});

test('the Week place has Activity: sidebar sub-place, the Week sub-navigation, and the phone reaches it from Week', async (t) => {
  const { body } = await start(t);
  const html = await body('/review/now');
  assert.match(html, /<a class="side-sub" href="\/activity">Activity<\/a>/);
  assert.match(html, /<nav class="subnav" aria-label="Week">[\s\S]*?<a href="\/activity">Activity<\/a>/);
  const own = await body('/activity');
  assert.match(own, /<a class="side-sub" href="\/activity" aria-current="page">Activity<\/a>/);
  assert.match(own, /<a class="side-place" href="\/review" aria-current="true">Week/);
});
