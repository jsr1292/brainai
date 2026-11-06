import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;
const claude = { type: 'ai', name: 'Claude' } as const;
const code = { type: 'ai', name: 'Claude Code' } as const;
const DAY = 86_400_000;
const XSS = '"><img src=x onerror=alert(1)>';

test('a fact opens to read, its editor and history folded', async (t) => {
  const app = await start(t);
  const id = await save(app, 'Use SQLite for the cellar.');
  await app.deps.service.update(id, { content: 'Use Postgres for the cellar.' }, owner);
  const body = await (await (await loggedIn(app))(`/memories/${id}`)).text();
  assert.match(body, /<h1 class="fact-text">Use Postgres for the cellar\.<\/h1>/);
  assert.match(body, /<details class="pfold" id="edit"><summary>Edit or delete/);
  assert.match(body, /<details class="pfold" id="history"><summary>History <span class="n">1<\/span>/);
  assert.equal((body.match(/<textarea/g) ?? []).length, 1);
  assert.ok(body.indexOf('<textarea') > body.indexOf('id="edit"'));
  assert.equal((body.match(/class="primary"/g) ?? []).length, 1);
  assert.match(body, /action="\/history\/\d+\/undo"><input type="hidden" name="part" value="history">/);
});

test('a fact page shows no zero count, puts a dot between who and when, and heads its sections alike', async (t) => {
  const app = await start(t);
  const id = await save(app, 'Never edited.');
  await app.deps.pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: 'Cellar.' }, 'owner');
  const body = await (await (await loggedIn(app))(`/memories/${id}`)).text();
  assert.match(body, /<details class="pfold" id="history"><summary>History<span class="chev"><\/span><\/summary>/, 'History without "0"');
  assert.match(body, /<li>Saved by <span class="writer w-you">You<\/span><\/li><li><time /, 'who and when are two parts of the meta line');
  assert.match(body, /<section class="where"><h3>Where it shows<\/h3>/, 'the same heading as Replaces and the timeline');
});

test('a failed save comes back with the editor open and the draft kept', async (t) => {
  const app = await start(t);
  const id = await save(app, 'Initial cellar fact');
  const f = await loggedIn(app);
  const bad = await f(`/memories/${id}`, form({ content: '', project: 'wildlog', tags: '' }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /<details class="pfold" id="edit" open>[\s\S]*?<p class="error"|<p class="error"[\s\S]*?<details class="pfold" id="edit" open>/);
  const base = app.deps.store.get(id)!.updatedAt;
  app.advance(60_000);
  await app.deps.service.update(id, { content: 'Current cellar fact' }, code);
  const stale = await f(`/memories/${id}`, form({ content: 'My draft', project: 'wildlog', tags: '', base }));
  assert.equal(stale.status, 409);
  const body = await stale.text();
  assert.match(body, /<h1 class="fact-text">Current cellar fact<\/h1>/);
  assert.match(body, /<details class="pfold" id="edit" open>/);
  assert.match(body, /<textarea[^>]*>My draft<\/textarea>/);
  assert.equal((await f(`/memories/${id}`, form({ content: 'My draft', project: 'wildlog', tags: '', base: app.deps.store.get(id)!.updatedAt }))).status, 303);
});

test('a failed undo comes back with History open', async (t) => {
  const app = await start(t);
  const id = await save(app, 'Undo me');
  await app.deps.service.update(id, { content: 'Undo this edit' }, owner);
  const f = await loggedIn(app);
  await f(`/memories/${id}/delete`, form({}));
  const h = app.deps.store.history(id).find((e) => e.action !== 'delete')!;
  const res = await f(`/history/${h.id}/undo`, form({}));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /<details class="pfold" id="history" open>/);
});

test('Mark as replaced without a pick comes back with the picker open', async (t) => {
  const app = await start(t);
  const id = await save(app, 'Old cellar fact');
  await save(app, 'New cellar fact');
  const res = await (await loggedIn(app))(`/memories/${id}/supersede`, form({}));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /<details class="pfold" id="picker" open>[\s\S]*?Pick the fact that holds now\./);
});

test('Where it shows names the project, its pages and the discussion', async (t) => {
  const app = await start(t);
  const d = app.deps.discussions.open({ name: 'Claude Code', model: 'Opus', access: 'full' }, { title: 'Which icon?', question: 'Which?', project: 'wildlog' });
  const closed = await app.deps.discussions.close('owner', d.id, { decision: 'Use the bottle.' });
  const page = await app.deps.pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: 'Cellar.' }, 'owner');
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${closed.memoryId}`)).text();
  assert.match(body, /<section class="where">[\s\S]*?Where it shows/);
  assert.match(body, /href="\/\?project=wildlog#panel"/);
  assert.match(body, new RegExp(`href="/pages/${page.id}\\?from=%2Fmemories%2F${closed.memoryId}"`));
  assert.match(body, new RegExp(`Decided in: <a href="/discussions/${d.id}">Which icon\\?</a>`));
  const alone = app.deps.store.insert({ kind: 'decision', content: 'Unplaced', project: null, tags: [], embedding: new Float32Array(384), by: 'owner' });
  assert.doesNotMatch(await (await f(`/memories/${alone.id}`)).text(), /<section class="where">/);
});

test('a deleted fact reads as deleted with History open', async (t) => {
  const app = await start(t);
  const id = await save(app, 'A fact to delete');
  const f = await loggedIn(app);
  await f(`/memories/${id}/delete`, form({}));
  const body = await (await f(`/memories/${id}`)).text();
  assert.match(body, /<h1 class="fact-text">A fact to delete<\/h1>/);
  assert.match(body, /Deleted [\s\S]*?Use Undo in History to bring it back\./);
  assert.match(body, /<details class="pfold" id="history" open>/);
  assert.doesNotMatch(body, /id="edit"/);
});

test('Facts sits under Pages with three quick views', async (t) => {
  const app = await start(t);
  await save(app, 'Keep local decisions');
  await save(app, 'Lives in Berlin', owner, { kind: 'profile', project: null });
  const old = await save(app, 'Use SQLite');
  const newer = await save(app, 'Use Postgres');
  app.deps.service.supersede([old], newer, owner);
  const f = await loggedIn(app);
  const body = await (await f('/facts')).text();
  assert.match(body, /<nav class="subnav" aria-label="Pages">[\s\S]*?href="\/facts" aria-current="page">Facts/);
  assert.match(body, /<h1>Facts <span class="n">3 current<\/span><\/h1>/);
  assert.match(body, /About you 1/);
  assert.match(body, /Replaced 1/);
});

test('the filter folds into one pill that says what it shows', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const plain = await (await f('/facts')).text();
  assert.match(plain, /<details class="fold filter-fold"><summary>Filter · all projects · all kinds/);
  const filtered = await (await f('/facts?project=wildlog&kind=decision')).text();
  assert.match(filtered, /Filter · wildlog · decision/);
  assert.match(filtered, /href="\/\?project=wildlog#panel"[^>]*>‹ wildlog/);
  assert.match(filtered, /aria-label="Show"/);
});

test('About you says what it is', async (t) => {
  const app = await start(t);
  await save(app, 'Lives in Berlin', owner, { kind: 'profile', project: null });
  const f = await loggedIn(app);
  const body = await (await f('/facts?kind=profile')).text();
  assert.match(body, /What every assistant loads about you at the start of a conversation\. Assistants can only suggest changes here; you approve them on Projects\./);
  assert.match(body, /href="\/facts"[^>]*>‹ Facts/);
  assert.match(body, /href="\/facts\?kind=profile"[^>]*aria-current="page"/);
});

test('Tidy up lives at /facts/tidy and old addresses redirect', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const tidy = await f('/facts/tidy');
  assert.equal(tidy.status, 200);
  const body = await tidy.text();
  assert.match(body, /Nothing to tidy\./);
  assert.match(body, /href="\/pages" aria-current="page">Pages/);
  assert.match(body, /href="\/facts">‹ Facts/);
  for (const path of ['/settings/tidy', '/tidy']) {
    const res = await f(path);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/facts/tidy');
  }
});

test('an empty brain says so once', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const body = await (await f('/facts')).text();
  assert.match(body, /No facts yet\. Assistants save them as you work\./);
  assert.doesNotMatch(body, /tidy-line|About you \d|Replaced \d/);
  assert.match(body, /href="\/memories\/new"[^>]*><span class="txt"><b>New fact<\/b>/);
});

test('Tidy up is a line on Facts only when there is something', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  assert.doesNotMatch(await (await f('/facts')).text(), /class="tidy-line"/);
  await save(app, 'Use SQLite');
  await save(app, 'Use SQLite');
  const body = await (await f('/facts')).text();
  assert.match(body, /<p class="tidy-line">Tidy up: 2 facts look like duplicates\. <a href="\/facts\/tidy">Have a look<\/a><\/p>/);
  await save(app, 'A separate decision');
  let checked = 0;
  const original = app.deps.service.duplicates.bind(app.deps.service);
  app.deps.service.duplicates = ((...args: Parameters<typeof original>) => { checked++; return original(...args); }) as typeof original;
  await f('/');
  assert.equal(checked, 0);
});

test('every fact row goes back to the same list', async (t) => {
  const app = await start(t);
  for (let i = 0; i < 51; i++) app.deps.store.insert({ kind: 'decision', content: `Decision ${i}`, project: null, tags: [], embedding: new Float32Array(384), by: 'owner' });
  const f = await loggedIn(app);
  const body = await (await f('/facts?kind=decision&page=2')).text();
  assert.match(body, /class="card-link" href="\/memories\/[^" ]+\?from=%2Ffacts%3Fkind%3Ddecision%26page%3D2"/);
});

test('a new fact accepts a project from the list', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  assert.match(await (await f('/memories/new?project=wildlog')).text(), /name="project" value="wildlog"/);
});

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-09-20T09:00:00Z') });
  t.after(() => app.close());
  return app;
}
type App = Awaited<ReturnType<typeof start>>;
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });
const save = async (app: App, content: string, by: typeof owner | typeof claude | typeof code = owner, extra: Record<string, unknown> = {}) => {
  const r = await app.deps.service.remember({ kind: 'decision', content, project: 'wildlog', newProject: true, allowDuplicate: true, ...extra } as any, by) as any;
  assert.equal(r.status, 'saved', r.status);
  return r.memory.id as string;
};

/** The mockup's chain: the owner's producer notes (20 Sep) → Claude's Cellarium (5 Oct, edited 12 Oct) → Claude Code's by hand (30 Oct). */
async function chain(app: App) {
  const a = await save(app, "Drinking windows come from the producer's notes, typed in by hand.");
  app.advance(15 * DAY);
  const b = await save(app, 'Drinking windows come from Cellarium.', claude, { supersedes: [a] });
  app.advance(7 * DAY);
  await app.deps.service.update(b, { content: 'Drinking windows come from the Cellarium import.' }, claude);
  app.advance(18 * DAY);
  const c = await save(app, 'Drinking windows are set by hand per bottle; the Cellarium import was dropped because its export has no API (2026-10-30).', code, { supersedes: [b] });
  const ab = app.deps.store.supersessions.liveFor(a)!;
  const bc = app.deps.store.supersessions.liveFor(b)!;
  return { a, b, c, ab, bc };
}

test('a replaced fact\'s page opens with the calm note, the current fact and one Undo', async (t) => {
  const app = await start(t);
  const { b, c, bc } = await chain(app);
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${b}`)).text();
  assert.match(body, /<span class="chip plain">replaced<\/span>/);
  assert.match(body, /Replaced on 30 Oct<\/strong> by <span class="writer w-code">Claude Code<\/span>\. Assistants no longer find this when they search\. It stays here, in its project and in the nightly export\./);
  assert.match(body, new RegExp(`<a class="now" href="/memories/${c}\\?from=%2Fmemories%2F${b}">Drinking windows are set by hand per bottle[^<]*<small>Current · decision · wildlog</small></a>`));
  assert.match(body, new RegExp(`<form method="post" action="/supersessions/${bc.id}/undo"[^>]*>[\\s\\S]*?Undo: bring this back</button>`));
  assert.equal(body.match(/Undo: bring this back/g)!.length, 1);
  assert.match(body, /<h3>This decision over time<\/h3>\s*<ol class="chain">/);
  assert.match(body, /<li class="here">/);
  assert.match(body, /<li class="cur">/);
  assert.match(body, /<details class="pfold" id="edit"><summary>Edit or delete<span class="chev"><\/span><\/summary><p class="quiet">Editing a replaced fact keeps it replaced\.<\/p>[\s\S]*?class="editor"[\s\S]*?\/delete"[\s\S]*?<\/details>/);
  assert.doesNotMatch(body, /Has a newer fact replaced this one\?/);
  assert.doesNotMatch(body, /\sstyle=/);
});

test('a current fact\'s page folds its editor and shows Replaces, the timeline and the picker', async (t) => {
  const app = await start(t);
  const { b, c } = await chain(app);
  for (let i = 0; i < 13; i++) { app.advance(60_000); await save(app, `wildlog rack ${i} holds the bottles from region ${i}`); }
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${c}`)).text();
  assert.ok(body.indexOf('id="edit"') > 0 && body.indexOf('class="editor"') > body.indexOf('id="edit"') && body.indexOf('class="editor"') < body.indexOf('replaces-box'));
  assert.match(body, /<section class="replaces-box">\s*<h3>Replaces<\/h3>/);
  assert.match(body, new RegExp(`<a href="/memories/${b}\\?from=%2Fmemories%2F${c}">Drinking windows come from the Cellarium import\\.</a>`));
  assert.match(body, /<span class="writer w-claude">Claude<\/span> wrote it 5 Oct · replaced by <span class="writer w-code">Claude Code<\/span> 30 Oct/);
  assert.match(body, /<details class="pfold" id="picker"><summary>Has a newer fact replaced this one\?<span class="chev"><\/span><\/summary>/);
  assert.match(body, /<fieldset class="picker" id="replace">\s*<legend>Current wildlog decisions, most alike first<\/legend>/);
  assert.equal((body.match(/<label class="choice"><input type="radio" name="by" value="/g) ?? []).length, 10);
  assert.match(body, /Mark as replaced/);
  assert.match(body, new RegExp(`<a href="/memories/${c}\\?pick=all#replace">Show all 13 decisions</a>`));
  const picker = body.slice(body.indexOf('<details class="pfold" id="picker"><summary>Has a newer'), body.indexOf('</details>', body.indexOf('Has a newer')));
  assert.doesNotMatch(picker, /<select/);
  assert.match(body, /<li class="cur here">/);
  const all = await (await f(`/memories/${c}?pick=all`)).text();
  assert.equal((all.match(/<input type="radio" name="by" value="/g) ?? []).length, 13);
  assert.match(all, /<details class="pfold" id="picker" open><summary>Has a newer fact replaced this one\?<span class="chev"><\/span><\/summary>/);
  assert.match(all, /Current wildlog decisions, newest first/);
});

test('History mixes edits and replacements', async (t) => {
  const app = await start(t);
  const { b, bc } = await chain(app);
  app.advance(DAY);
  app.deps.service.undoSupersession(bc.id, owner);
  app.advance(DAY);
  const d = await save(app, 'Drinking windows are typed in per bottle.', code);
  const [row] = app.deps.service.supersede([b], d, code);
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${b}`)).text();
  assert.match(body, /<details class="pfold" id="history"><summary>History <span class="n">4<\/span>/);
  assert.match(body, new RegExp(`Replaced by <span class="writer w-code">Claude Code</span> · 1 Nov</span>\\s*<form method="post" action="/supersessions/${row!.id}/undo"`));
  assert.match(body, /Brought back by <span class="writer w-you">You<\/span> · 31 Oct<\/p>/);
  assert.doesNotMatch(body, new RegExp(`action="/supersessions/${bc.id}/undo"`));
  assert.match(body, /Undo to this/);
});

test('Mark as replaced posts and reloads the page with the calm note', async (t) => {
  const app = await start(t);
  const a = await save(app, 'wildlog uses Core Data');
  app.advance(DAY);
  const b = await save(app, 'wildlog uses SwiftData');
  const s = await save(app, 'wildlog status: migrating', owner, { kind: 'summary' });
  const f = await loggedIn(app);
  const res = await f(`/memories/${a}/supersede`, form({ by: b }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/memories/${a}`);
  assert.match(await (await f(`/memories/${a}`)).text(), /<div class="replaced-note" role="note">/);
  const c = await save(app, 'wildlog uses Realm');
  const bad = await f(`/memories/${c}/supersede`, form({ by: s }));
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.match(text, /<p class="error" role="alert">A decision can only replace a decision, and a status a status\.<\/p>/);
  assert.match(text, /Has a newer fact replaced this one\?/);
  assert.equal((await f(`/memories/${c}/supersede`, form({}))).status, 400);
});

test('Undo brings the fact back once, and a second Undo is an error line, not a crash', async (t) => {
  const app = await start(t);
  const a = await save(app, 'wildlog uses Core Data');
  const b = await save(app, 'wildlog uses SwiftData');
  const f = await loggedIn(app);
  const undo = async (back?: string) => {
    const [row] = app.deps.service.supersede([a], b, owner);
    const res = await f(`/supersessions/${row!.id}/undo`, form(back === undefined ? {} : { back }));
    return { res, row: row! };
  };
  const first = await undo();
  assert.equal(first.res.status, 303);
  assert.equal(first.res.headers.get('location'), `/memories/${a}`);
  const again = await f(`/supersessions/${first.row.id}/undo`, form({}));
  assert.equal(again.status, 400);
  assert.match(await again.text(), /<p class="error" role="alert">This was already brought back\.<\/p>/);
  assert.equal((await f('/supersessions/99999/undo', form({}))).status, 404);
  assert.equal((await f('/supersessions/abc/undo', form({}))).status, 404);
  assert.equal((await undo('panel')).res.headers.get('location'), '/?project=wildlog#panel');
  assert.equal((await undo('tidy')).res.headers.get('location'), '/facts/tidy');
  assert.equal((await undo('facts')).res.headers.get('location'), '/facts?show=replaced');
  assert.equal((await undo('https://evil.example')).res.headers.get('location'), `/memories/${a}`);
});

test('the replacement deleted: the note says so and links to the deleted fact', async (t) => {
  const app = await start(t);
  const a = await save(app, 'homeassistant heating follows the Hive schedule');
  app.advance(DAY);
  const b = await save(app, 'homeassistant heating follows the Ecobee schedule', code, { supersedes: [a] });
  app.advance(DAY);
  app.deps.service.forget(b, code);
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${a}`)).text();
  assert.match(body, new RegExp(`<a href="/memories/${b}\\?from=%2Fmemories%2F${a}">Its replacement was deleted on 22 Sep\\.</a> Assistants no longer find this when they search\\.`));
  assert.match(body, /Undo: bring this back/);
  assert.doesNotMatch(body, /<a class="now"/);
});

test('hostile text in a replaced or replacing fact is escaped everywhere on the page', async (t) => {
  const app = await start(t);
  const a = await save(app, `old ${XSS}`);
  const b = await save(app, `new ${XSS}`, code, { supersedes: [a] });
  const c = await save(app, `other ${XSS}`);
  const f = await loggedIn(app);
  for (const id of [a, b, c]) {
    const body = await (await f(`/memories/${id}`)).text();
    assert.doesNotMatch(body, /<img src=x/);
  }
});

test('All facts shows Current by default and offers Replaced and Everything', async (t) => {
  const app = await start(t);
  const { a, b, c } = await chain(app);
  for (let i = 0; i < 5; i++) { app.advance(60_000); const o = await save(app, `wildlog shelf rule ${i}`); await save(app, `wildlog shelf rule ${i} revised`, code, { supersedes: [o] }); }
  const f = await loggedIn(app);
  const cur = await (await f('/facts?q=&kind=decision&project=wildlog')).text();
  void cur;
  const def = await (await f('/facts?kind=decision&project=wildlog')).text();
  assert.match(def, /<span class="seg" role="group" aria-label="Show">/);
  assert.match(def, /<a href="\/facts\?kind=decision&amp;project=wildlog" class="on" aria-current="true">Current<\/a>/);
  assert.match(def, /<a href="\/facts\?kind=decision&amp;project=wildlog&amp;show=replaced">Replaced<\/a>/);
  assert.match(def, /<a href="\/facts\?kind=decision&amp;project=wildlog&amp;show=everything">Everything<\/a>/);
  assert.ok(!def.includes(`/memories/${a}?from=`) && def.includes(`/memories/${c}?from=`));
  const rep = await (await f('/facts?show=replaced')).text();
  assert.equal((rep.match(/<li class="card rep">/g) ?? []).length, 7);
  assert.match(rep, /7 replaced facts, newest replacement first\. You and your assistants don't find them in search\. Deleted ones are not listed\./);
  assert.match(rep, new RegExp(`<p class="by">→ replaced by <a href="/memories/${b}\\?from=%2Ffacts%3Fshow%3Dreplaced">Drinking windows come from the Cellarium import\\.</a> <span class="badge">also replaced</span></p>`));
  assert.match(rep, /replaced by <span class="writer w-code">Claude Code<\/span> 30 Oct/);
  const every = await (await f('/facts?show=everything&project=wildlog')).text();
  assert.ok(every.includes(`/memories/${a}?from=`) && every.includes(`/memories/${c}?from=`));
  assert.match(every, new RegExp(`<li class="card rep"[^>]*>\\s*<a class="card-link" href="/memories/${a}\\\?from=`));
  const hits = await (await f('/facts?show=replaced&q=' + encodeURIComponent('drinking windows'))).text();
  assert.ok(hits.includes(`/memories/${a}?from=`) && !hits.includes(`<a class="card-link" href="/memories/${c}"`));
  const curHits = await (await f('/facts?q=' + encodeURIComponent('drinking windows'))).text();
  assert.ok(curHits.includes(`/memories/${c}?from=`) && !curHits.includes(`<a class="card-link" href="/memories/${a}?from=`));
  assert.match(await (await f('/facts?show=nonsense')).text(), /href="\/facts" aria-current="page">All \d+/);
  const paged = await (await f('/facts?show=replaced&page=2')).text();
  assert.equal(paged.match(/<li class="card rep">/g), null);
});

test('a Replaced-only search marks nothing as recalled', async (t) => {
  const app = await start(t);
  const { a, c } = await chain(app);
  const f = await loggedIn(app);
  const recalled = () => (app.deps.store.list({ replaced: 'include' }).map((m) => [m.id, m.lastRecalledAt]));
  const before = JSON.stringify(recalled());
  await f('/facts?show=replaced&q=' + encodeURIComponent('drinking windows'));
  assert.equal(JSON.stringify(recalled()), before);
  app.advance(60_000);
  await f('/facts?q=' + encodeURIComponent('drinking windows'));
  assert.notEqual(app.deps.store.get(c)!.lastRecalledAt, null);
  app.advance(60_000);
  const at = app.deps.store.get(c)!.lastRecalledAt;
  await f('/facts?show=everything&q=' + encodeURIComponent('drinking windows'));
  assert.notEqual(app.deps.store.get(c)!.lastRecalledAt, at);
  assert.equal(app.deps.store.get(a)!.lastRecalledAt, null);
});

test('All facts › Replaced cuts the replacing fact to a short excerpt', async (t) => {
  const app = await start(t);
  const a = await save(app, 'Drinking windows come from Cellarium.');
  const b = await save(app, 'Drinking windows are set by hand per bottle; the Cellarium import was dropped because its export has no API (2026-10-30).', owner, { supersedes: [a] });
  const f = await loggedIn(app);
  const rep = await (await f('/facts?show=replaced')).text();
  assert.match(rep, new RegExp(`<p class="by">→ replaced by <a href="/memories/${b}\\?from=%2Ffacts%3Fshow%3Dreplaced">Drinking windows are set by hand per bottle; the Cellarium import was dropped…</a></p>`));
});

test('All facts › Replaced says when the replacement was deleted', async (t) => {
  const app = await start(t);
  const a = await save(app, 'Home Assistant runs on a Raspberry Pi 4.');
  const b = await save(app, 'Home Assistant runs on a Raspberry Pi 5 in the server rack.', code, { supersedes: [a] });
  app.advance(DAY);
  app.deps.service.forget(b, code);
  const f = await loggedIn(app);
  const rep = await (await f('/facts?show=replaced')).text();
  assert.match(rep, new RegExp(`<p class="by">→ <a href="/memories/${b}\\?from=%2Ffacts%3Fshow%3Dreplaced">Its replacement was deleted on 21 Sep\\.</a></p>`));
  assert.doesNotMatch(rep, /replaced by <a href="\/memories\/[^"]+">Home Assistant runs on a Raspberry Pi 5/);
});

test("the fact page's Delete says assistants will ask before saving it again", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const m = (await app.deps.service.remember({ kind: 'decision', project: 'wildlog', content: 'The cellar list sorts by drinking window' }, { type: 'owner' }) as any).memory;
  const body = await (await (await loggedIn(app))(`/memories/${m.id}`)).text();
  const edit = body.slice(body.indexOf('<details class="pfold" id="edit">'), body.indexOf('</details>', body.indexOf('<details class="pfold" id="edit">')));
  assert.match(edit, /<p class="meta">It leaves search for you and your assistants\. Assistants that try to save it again will ask you first\. You can bring it back from its History\.<\/p>/);
  // Inside the delete form: the Mac's fact sheet hides that form (its Delete… question says the same), so no stray copy.
  assert.match(edit, /<form method="post" action="\/memories\/[^"]+\/delete" class="danger">[\s\S]*Assistants that try to save it again will ask you first\.[\s\S]*<\/form>/);
});
