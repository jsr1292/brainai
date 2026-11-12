import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;
const BODY = 'The cellar app.\n\n## Stack\nSwiftUI.\n\n## Gotchas\nNone yet.';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, owner);
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: BODY }, 'owner');
  return { app, f: await loggedIn(app), page };
}
const post = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });

test('creating a page from the form opens it; a new page for a project has that project chosen', async (t) => {
  const { app, f } = await start(t);
  const form = await (await f('/pages/new?project=wildlog')).text();
  assert.match(form, /<title>New page<\/title>/);
  assert.match(form, /<option value="wildlog" selected>wildlog<\/option>/);
  assert.match(form, /placeholder="wildlog — short description"/);
  const res = await f('/pages', post({ title: 'How this brain is organised', project: '', area: 'start', body: 'Facts first, pages for the whole picture.', intent: 'save' }));
  assert.equal(res.status, 303);
  const created = app.deps.pages.list().find((p) => p.title === 'How this brain is organised')!;
  assert.equal(res.headers.get('location'), `/pages/${created.id}`);
  assert.equal(created.area, 'start');
  assert.equal(created.createdBy, 'owner');
  assert.match(await (await f('/pages/new')).text(), /<option value="" selected>No project<\/option>/);
});

test('editing one section saves only that section and returns to its anchor', async (t) => {
  const { app, f, page } = await start(t);
  const form = await (await f(`/pages/${page.id}/edit?section=gotchas`)).text();
  assert.match(form, /<h1>Editing “Gotchas”<\/h1>/);
  assert.match(form, /<textarea[^>]*name="body"[^>]*>## Gotchas\nNone yet\.<\/textarea>/);
  assert.match(form, /name="base" value="1"/);
  assert.match(form, /name="section" value="gotchas"/);
  const res = await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nThe simulator needs iOS 18.', intent: 'save' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pages/${page.id}#gotchas`);
  const now = app.deps.pages.get(page.id)!;
  assert.equal(now.version, 2);
  assert.match(now.body, /## Stack\nSwiftUI\.\n\n## Gotchas\nThe simulator needs iOS 18\./);
  assert.equal((await f(`/pages/${page.id}/edit?section=nope`)).status, 404);
  const whole = await (await f(`/pages/${page.id}/edit`)).text();
  assert.doesNotMatch(whole, /<h1>/, 'the whole-page editor has no heading of its own; the title input is it');
  assert.match(whole, /<input name="title" class="ptitle-input"[^>]*value="wildlog — wine cellar"/);
});

test('preview shows the rendered text and keeps what was typed, without saving', async (t) => {
  const { app, f, page } = await start(t);
  const res = await f(`/pages/${page.id}`, post({ base: '1', section: 'stack', body: '## Stack\n**SwiftUI** <b>raw</b>', intent: 'preview' }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<div class="preview art">[\s\S]*<strong>SwiftUI<\/strong> &lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(body, /<textarea[^>]*>## Stack\n\*\*SwiftUI\*\* &lt;b&gt;raw&lt;\/b&gt;<\/textarea>/);
  assert.equal(app.deps.pages.get(page.id)!.version, 1);
  const fresh = await f('/pages', post({ title: 'Draft', area: 'tools', body: '# Hi', intent: 'preview' }));
  assert.equal(fresh.status, 200);
  assert.equal(app.deps.pages.list().length, 1);
});

test('a save based on an old version answers 409 with both texts and saves nothing', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'gotchas', text: '## Gotchas\nClaude found one.' }, 'Claude Code');
  const res = await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nMine.', intent: 'save' }));
  assert.equal(res.status, 409);
  const body = await res.text();
  assert.match(body, /Claude Code saved this page while you were editing \(version 2\)\. Nothing of yours is lost: your text is below\./);
  assert.match(body, /<pre class="theirs">## Gotchas\nClaude found one\.<\/pre>/);
  assert.match(body, /<pre class="mine">## Gotchas\nMine\.<\/pre>/);
  assert.match(body, /name="base" value="2"/);
  assert.match(body, /<textarea[^>]*>## Gotchas\nClaude found one\.<\/textarea>/);
  assert.match(body, new RegExp(`<a class="button secondary" href="/pages/${page.id}">Discard mine</a>`));
  assert.equal(app.deps.pages.get(page.id)!.version, 2);
});

test('a secret or a duplicate title answers 400 with the text kept', async (t) => {
  const { app, f, page } = await start(t);
  const secret = await f(`/pages/${page.id}`, post({ base: '1', section: 'stack', body: '## Stack\nkey ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', intent: 'save' }));
  assert.equal(secret.status, 400);
  const sb = await secret.text();
  assert.match(sb, /looks like it contains a secret/);
  assert.match(sb, /<textarea[^>]*>## Stack\nkey ghp_/);
  const dup = await f('/pages', post({ title: 'WILDLOG — wine cellar', project: 'wildlog', body: 'Another.', intent: 'save' }));
  assert.equal(dup.status, 400);
  const db = await dup.text();
  assert.match(db, /A page called “WILDLOG — wine cellar” already exists/);
  assert.match(db, /<textarea[^>]*>Another\.<\/textarea>/);
  assert.equal(app.deps.pages.list().length, 1);
});

test('history lists every version with what changed, and shows the diff of the chosen one', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'stack', text: '## Stack\nSwiftUI and SQLite.' }, 'Claude Code');
  await app.deps.pages.save(page.id, { base: 2, body: `${BODY.replace('SwiftUI.', 'SwiftUI and SQLite.')}\n\n## Run\nOpen Xcode.` }, 'owner');
  const res = await f(`/pages/${page.id}/history`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>History<\/title>/);
  const list = body.slice(body.indexOf('<ol class="vers">'), body.indexOf('</ol>', body.indexOf('<ol class="vers">')));
  assert.match(list, /<span>you · <time datetime="[^"]+" title="[^"]+">just now<\/time><\/span>/);
  assert.match(list, /Version 3[\s\S]*you[\s\S]*Run added[\s\S]*Version 2[\s\S]*Claude Code[\s\S]*Stack changed[\s\S]*Version 1[\s\S]*created/);
  assert.match(body, /<h2>Version 3 compared with version 2<\/h2>/);
  assert.match(body, /<div class="dl a"><i>\+<\/i><span>## Run<\/span><\/div>/);
  assert.match(body, /<button type="submit" class="secondary">Restore version 2<\/button>/);
  const v2 = await (await f(`/pages/${page.id}/history?v=2`)).text();
  assert.match(v2, /<div class="dl d"><i>−<\/i><span>SwiftUI\.<\/span><\/div>[\s\S]*<div class="dl a"><i>\+<\/i><span>SwiftUI and SQLite\.<\/span><\/div>/);
  const v1 = await (await f(`/pages/${page.id}/history?v=1`)).text();
  assert.match(v1, /<h2>Version 1, created<\/h2>/);
  assert.doesNotMatch(v1, /Restore version/);
  assert.equal((await f(`/pages/${page.id}/history?v=9`)).status, 404);
});

test('restoring an old version makes a new version with its text', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.save(page.id, { base: 1, body: 'Rewritten.' }, 'Claude Code');
  const res = await f(`/pages/${page.id}/restore`, post({ version: '1' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pages/${page.id}`);
  const now = app.deps.pages.get(page.id)!;
  assert.deepEqual([now.version, now.body], [3, BODY]);
  assert.equal((await f(`/pages/${page.id}/restore`, post({ version: '9' }))).status, 404);
});

test('deleting hides the page from the Pages tab and frees its title; undelete brings it back', async (t) => {
  const { app, f, page } = await start(t);
  assert.match(await (await f(`/pages/${page.id}/edit`)).text(), new RegExp(`<details class="pg-danger"><summary>Delete this page…<span class="chev"></span></summary>[\\s\\S]*action="/pages/${page.id}/delete"`));
  const del = await f(`/pages/${page.id}/delete`, post({}));
  assert.equal(del.status, 303);
  assert.equal(del.headers.get('location'), '/pages');
  assert.doesNotMatch(await (await f('/pages')).text(), new RegExp(`/pages/${page.id}"`));
  const und = await f(`/pages/${page.id}/undelete`, post({}));
  assert.equal(und.status, 303);
  assert.equal(und.headers.get('location'), `/pages/${page.id}`);
  assert.equal(app.deps.pages.get(page.id)!.deletedAt, null);
  assert.equal((await f(`/pages/${page.id}/edit`)).status, 200);
});

test('a page can be deleted from its own side rail, without opening the editor', async (t) => {
  const { f, page } = await start(t);
  const view = await (await f(`/pages/${page.id}`)).text();
  const rail = view.slice(view.indexOf('<aside class="paside">'), view.indexOf('</aside>'));
  assert.match(rail, new RegExp(`Ask an AI to update[\\s\\S]*<details class="pg-danger"><summary>Delete this page…<span class="chev"></span></summary>[\\s\\S]*action="/pages/${page.id}/delete"[\\s\\S]*On this page`));
  assert.match(rail, /you can undelete it from its address/);
});

test('every page form refuses a POST from another origin', async (t) => {
  const { app, page } = await start(t);
  for (const path of ['/pages', `/pages/${page.id}`, `/pages/${page.id}/restore`, `/pages/${page.id}/delete`, `/pages/${page.id}/undelete`]) {
    const res = await fetch(`${app.baseUrl}${path}`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'base=1&body=x&intent=save&version=1&title=x&area=start' });
    assert.equal(res.status, 403, path);
  }
  assert.equal(app.deps.pages.get(page.id)!.version, 1);
  assert.equal(app.deps.pages.list().length, 1);
});

test('a conflict with your own save elsewhere says so in plain words', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'gotchas', text: '## Gotchas\nFrom the other tab.' }, 'owner');
  const body = await (await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nMine.', intent: 'save' }))).text();
  assert.match(body, /You saved this page in another tab or on another device while you were editing \(version 2\)\./);
  assert.doesNotMatch(body, />you saved this page/);
});

test('a section edit whose section was renamed meanwhile answers 409 and keeps the typed text', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'gotchas', text: '## Gotchas and lessons\nRenamed elsewhere.' }, 'Claude Code');
  const res = await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nMy careful note.', intent: 'save' }));
  assert.equal(res.status, 409);
  const body = await res.text();
  assert.match(body, /<pre class="mine">## Gotchas\nMy careful note\.<\/pre>/);
  assert.match(body, /<pre class="theirs">[\s\S]*## Gotchas and lessons\nRenamed elsewhere\.[\s\S]*<\/pre>/);
  assert.match(body, /name="base" value="2"/);
  assert.equal(app.deps.pages.get(page.id)!.version, 2);
  assert.equal((await f(`/pages/${page.id}`, post({ base: '2', section: 'gone', body: 'x', intent: 'save' }))).status, 404);
});

test('after its project is merged into another, the editor keeps the page on the real project', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('vista', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'vista is the old cellar app name', project: 'vista' }, owner);
  const p = await app.deps.pages.create({ title: 'vista — old page', project: 'vista', body: 'Old.' }, 'owner');
  app.deps.service.addAlias('vista', 'wildlog', owner);
  const form = await (await f(`/pages/${p.id}/edit`)).text();
  assert.match(form, /<option value="wildlog" selected>wildlog<\/option>/);
  assert.match(await (await f(`/pages/${p.id}`)).text(), /<p class="crumb">Apps › <a href="\/\?project=wildlog#panel">wildlog<\/a><\/p>/);
  const res = await f(`/pages/${p.id}`, post({ base: '1', title: 'vista — old page', project: 'wildlog', area: 'start', body: 'Still here.', intent: 'save' }));
  assert.equal(res.status, 303);
  assert.equal(app.deps.pages.get(p.id)!.project, 'wildlog');
});

test('a long page of accented text, under the 100,000-character limit, saves and previews from the browser', async (t) => {
  const { app, f, page } = await start(t);
  const line = 'Decisión técnica: añadir el índice a la canción; ¿por qué? Porque sí.\n';
  const body = line.repeat(Math.floor(90_000 / line.length));
  assert.ok(body.length < 100_000);
  assert.ok(new URLSearchParams({ body }).toString().length > 102_400, 'the encoded form is past the old 100 KB limit');
  const created = await f('/pages', post({ title: 'Notas largas', project: '', area: 'start', body, intent: 'save' }));
  assert.equal(created.status, 303);
  assert.equal(app.deps.pages.list().find((p) => p.title === 'Notas largas')!.body, body);
  const preview = await f(`/pages/${page.id}`, post({ base: '1', title: page.title, project: 'wildlog', area: 'start', body, intent: 'preview' }));
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /<div class="preview art">/);
  const saved = await f(`/pages/${page.id}`, post({ base: '1', title: page.title, project: 'wildlog', area: 'start', body, intent: 'save' }));
  assert.equal(saved.status, 303);
  assert.equal(app.deps.pages.get(page.id)!.body, body);
});

test('a page text too long even for the page forms says so plainly, not "Bad request"', async (t) => {
  const { app, f, page } = await start(t);
  const res = await f(`/pages/${page.id}`, post({ base: '1', title: page.title, project: 'wildlog', area: 'start', body: 'ñ'.repeat(200_000), intent: 'save' }));
  assert.equal(res.status, 413);
  const text = await res.text();
  assert.match(text, /<h1>Too long to save<\/h1>/);
  assert.match(text, /100,000 characters/);
  assert.match(text, /Nothing was saved/);
  assert.equal(app.deps.pages.get(page.id)!.version, 1);
});

test('without a session the page forms keep the small body limit', async (t) => {
  const { app } = await start(t);
  const res = await fetch(`${app.baseUrl}/pages`, { method: 'POST', redirect: 'manual', headers: { origin: app.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: `body=${'x'.repeat(200_000)}` });
  assert.equal(res.status, 413);
});

test('the page text field has a name on every editor screen', async (t) => {
  const { app, f, page } = await start(t);
  const named = (body: string) => body.match(/<textarea name="body"[^>]*>/)![0];
  assert.match(named(await (await f('/pages/new')).text()), /aria-label="Page text \(Markdown\)"/);
  assert.match(named(await (await f(`/pages/${page.id}/edit`)).text()), /aria-label="Page text \(Markdown\)"/);
  assert.match(named(await (await f(`/pages/${page.id}/edit?section=gotchas`)).text()), /aria-label="Text of the Gotchas section \(Markdown\)"/);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'gotchas', text: '## Gotchas\nClaude found one.' }, 'Claude Code');
  const conflict = await (await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nMine.', intent: 'save' }))).text();
  assert.match(named(conflict), /aria-label="Text of the Gotchas section \(Markdown\)"/);
});

test('Write and Preview say which one is showing', async (t) => {
  const { f, page } = await start(t);
  const write = await (await f(`/pages/${page.id}/edit`)).text();
  assert.match(write, /<button type="submit" name="intent" value="write" class="ptool on" aria-pressed="true" formnovalidate>Write<\/button><button type="submit" name="intent" value="preview" class="ptool" aria-pressed="false" formnovalidate>Preview<\/button>/);
  const preview = await (await f(`/pages/${page.id}`, post({ base: '1', title: page.title, project: 'wildlog', area: 'start', body: 'Hi', intent: 'preview' }))).text();
  assert.match(preview, /value="write" class="ptool" aria-pressed="false" formnovalidate>Write<\/button><button [^>]*value="preview" class="ptool on" aria-pressed="true" formnovalidate>Preview/);
});

test('a whole-page conflict shows a changed title and project under Yours, next to the current ones', async (t) => {
  const { app, f, page } = await start(t);
  await app.deps.pages.save(page.id, { base: 1, body: 'Rewritten by Claude.' }, 'Claude Code');
  const res = await f(`/pages/${page.id}`, post({ base: '1', title: 'Cellar app notes', project: '', area: 'tools', body: 'Mine.', intent: 'save' }));
  assert.equal(res.status, 409);
  const body = await res.text();
  const two = body.slice(body.indexOf('<div class="two">'), body.indexOf('<div class="actions">'));
  const [current, yours] = two.split('<h2>Yours');
  assert.match(current!, /<li>Title: wildlog — wine cellar<\/li><li>Project: wildlog<\/li>/);
  assert.match(yours!, /<li>Title: Cellar app notes<\/li><li>Project: No project<\/li><li>Area: Tools &amp; AI<\/li>/);
  assert.match(yours!, /<pre class="mine">Mine\.<\/pre>/);
  assert.match(body, /name="title" [^>]*value="Cellar app notes"/, 'the editor below keeps the typed title');
  assert.equal(app.deps.pages.get(page.id)!.title, 'wildlog — wine cellar');
  const same = await (await f(`/pages/${page.id}`, post({ base: '1', title: page.title, project: 'wildlog', area: 'start', body: 'Mine again.', intent: 'save' }))).text();
  assert.doesNotMatch(same, /Title: /, 'nothing extra when only the text differs');
});

test("Enter (or a phone's Go key) in the page's Title field saves, it does not quietly redraw the editor", async (t) => {
  // The browser sends a form's first submit button on Enter. That used to be the Write tab, which saves nothing.
  const { f, page } = await start(t);
  const firstSubmit = (body: string) => {
    const form = body.slice(body.indexOf('<form method="post" action="/pages'), body.indexOf('</form>', body.indexOf('<form method="post" action="/pages')));
    return form.match(/<button type="submit"[^>]*>/)![0];
  };
  for (const path of ['/pages/new', `/pages/${page.id}/edit`]) {
    const first = firstSubmit(await (await f(path)).text());
    assert.match(first, /name="intent" value="save"/, path);
    // Out of sight and out of the Tab order: the visible Save button stays the one people use.
    assert.match(first, /class="visually-hidden" tabindex="-1" aria-hidden="true"/, path);
    assert.doesNotMatch(first, /formnovalidate/, `${path}: a new page still needs its title`);
  }
});

test('choosing a version in History opens the page at its diff and Restore, not at the top of the list', async (t) => {
  // On a phone the list and the diff stack in one column: with 30 versions the diff starts three screens down.
  const { app, f, page } = await start(t);
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'stack', text: '## Stack\nSwiftUI and SQLite.' }, 'Claude Code');
  const body = await (await f(`/pages/${page.id}/history`)).text();
  const list = body.slice(body.indexOf('<ol class="vers">'), body.indexOf('</ol>', body.indexOf('<ol class="vers">')));
  for (const n of [1, 2]) assert.match(list, new RegExp(`<a href="/pages/${page.id}/history\\?v=${n}#diff">`));
  assert.match(body, /<section class="panel diff" id="diff">/);
  assert.equal(body.match(/\sid="diff"/g)?.length, 1);
});

test('a page drawn from a form POST tells the installed app not to refresh it; a plain GET page does not', async (t) => {
  const { f, page } = await start(t);
  const preview = await (await f('/pages', post({ title: 'Draft', area: 'tools', body: '# Hi', intent: 'preview' }))).text();
  assert.match(preview, /<body data-fresh="off" class="app" data-desk="[^"]+">/, 'a GET of /pages would show the Pages home, not this draft');
  const conflict = await f(`/pages/${page.id}`, post({ base: '0', section: 'gotchas', body: '## Gotchas\nMine.', intent: 'save' }));
  assert.match(await conflict.text(), /<body data-fresh="off" class="app" data-desk="[^"]+">/);
  const reading = await (await f(`/pages/${page.id}`)).text();
  assert.match(reading, /<body class="app" data-desk="[^"]+">/);
  assert.equal((await (await f('/pages/nope-not-there')).text()).includes('data-fresh="off"'), true, 'a page that is not the 200 answer to its URL is not refreshed either');
});

test('every editor carries the Add picture button, its file input and status line, hidden until its script runs', async (t) => {
  const { f, page } = await start(t);
  const sec = (await (await f(`/pages/${page.id}`)).text()).match(/href="\/pages\/[^"]+\/edit\?section=([^"]+)"/)![1];
  for (const path of ['/pages/new', `/pages/${page.id}/edit`, `/pages/${page.id}/edit?section=${sec}`]) {
    const body = await (await f(path)).text();
    assert.match(body, /<form method="post" action="[^"]+" class="peditor" data-pics="\/static\/editor-pics\.js\?v=[0-9a-f]{10}" data-cm="\/static\/editor-cm\.js\?v=[0-9a-f]{10}">/, path);
    assert.match(body, /<button type="button" class="ptool add-pic" hidden>＋ Add picture<\/button><input type="file" class="pic-input" accept="image\/\*" multiple hidden>/, path);
    assert.match(body, /<p class="pic-strip" role="status" hidden><\/p>/, path);
    assert.doesNotMatch(body, /image\/heic/, path);
  }
});

// ---- The editor's layout (UI round, task 2) ----

test('the editor sits alone in the reading column: no pages tree, the title input as its heading', async (t) => {
  const { f, page } = await start(t);
  const whole = await (await f(`/pages/${page.id}/edit`)).text();
  assert.doesNotMatch(whole, /class="pnav"/, 'no pages tree on the edit screen');
  assert.doesNotMatch(whole, /All pages by area/);
  assert.match(whole, /<input name="title" class="ptitle-input" aria-label="Title"/);
  assert.match(whole, /<title>Editing wildlog — wine cellar<\/title>/, 'the tab title keeps the page name');
  const section = await (await f(`/pages/${page.id}/edit?section=gotchas`)).text();
  assert.doesNotMatch(section, /class="pnav"/, 'the section editor has no pages tree either');
  assert.match(section, /<h1>Editing “Gotchas”<\/h1>/, 'section mode keeps its own heading');
});

test('Project and Area sit under Details, closed for a page that has them; Area only without a project', async (t) => {
  const { app, f, page } = await start(t);
  const withProject = await (await f(`/pages/${page.id}/edit`)).text();
  const fold = withProject.slice(withProject.indexOf('<details class="pdetails"'), withProject.indexOf('</details>', withProject.indexOf('<details class="pdetails"')));
  assert.match(fold, /^<details class="pdetails">/, 'closed: the page has a project');
  assert.match(fold, /<summary>Details/);
  assert.match(fold, /name="project"/);
  assert.doesNotMatch(withProject, /name="area"/, 'a project page has no Area field');
  const plain = await app.deps.pages.create({ title: 'Standalone notes', body: 'No project.', area: 'start' }, 'owner');
  const without = await (await f(`/pages/${plain.id}/edit`)).text();
  const fold2 = without.slice(without.indexOf('<details class="pdetails"'), without.indexOf('</details>', without.indexOf('<details class="pdetails"')));
  assert.match(fold2, /^<details class="pdetails">/, 'closed: the page has a project or an area already');
  assert.match(fold2, /name="area"[^>]*data-area-for-no-project|data-area-for-no-project[^>]*name="area"/, 'the Area field is marked for the script');
  assert.match(fold2, /name="project"/);
  const fresh = await (await f('/pages/new')).text();
  assert.match(fresh, /<details class="pdetails" open>/, 'a new page opens Details');
  assert.match(fresh, /name="area"/, 'a new page shows Area until a project is chosen');
});

test('the save bar says which version saving makes, and the old footer line is gone', async (t) => {
  const { f, page } = await start(t);
  const edit = await (await f(`/pages/${page.id}/edit`)).text();
  const bar = edit.slice(edit.indexOf('<div class="psavebar">'), edit.indexOf('</div>', edit.indexOf('<div class="psavebar">')));
  assert.match(bar, /<button type="submit" name="intent" value="save" class="primary">Save page/);
  assert.match(bar, />Cancel<\/a>/);
  assert.match(bar, /Saving makes version 2\./, 'the page is at version 1');
  assert.doesNotMatch(edit, /Saved as version/, 'the old footer line is gone');
  const fresh = await (await f('/pages/new')).text();
  assert.match(fresh, /Saving makes version 1\./);
  const section = await (await f(`/pages/${page.id}/edit?section=gotchas`)).text();
  assert.match(section, /Saving makes version 2\./);
});

test('the toolbar sits above the text and says how a link is written', async (t) => {
  const { f, page } = await start(t);
  const edit = await (await f(`/pages/${page.id}/edit`)).text();
  assert.match(edit, /<div class="ptools">[\s\S]*<\/div>/);
  assert.match(edit, /<span class="phint">\[\[ links a page or fact<\/span>/);
  assert.doesNotMatch(edit, /links a page ·/, 'the long syntax hint is gone');
});

test('the body textarea is the mount point for the live editor', async (t) => {
  const { f, page } = await start(t);
  const edit = await (await f(`/pages/${page.id}/edit`)).text();
  assert.match(edit, /<textarea name="body"[^>]*data-editor/);
  const section = await (await f(`/pages/${page.id}/edit?section=gotchas`)).text();
  assert.match(section, /<textarea name="body"[^>]*data-editor/);
});

test('every editor screen carries the editor\'s own script, so the live editor can mount', async (t) => {
  const { app, f, page } = await start(t);
  const cm = /<form method="post" action="[^"]+" class="peditor" data-pics="\/static\/editor-pics\.js\?v=[0-9a-f]{10}" data-cm="\/static\/editor-cm\.js\?v=[0-9a-f]{10}">/;
  assert.match(await (await f('/pages/new')).text(), cm);
  assert.match(await (await f(`/pages/${page.id}/edit`)).text(), cm);
  assert.match(await (await f(`/pages/${page.id}/edit?section=gotchas`)).text(), cm);
  // A conflict and a refusal both come back as the editor again, with the text the server put in the box.
  await app.deps.pages.saveSection(page.id, { base: 1, anchor: 'gotchas', text: '## Gotchas\nClaude found one.' }, 'Claude Code');
  const conflict = await (await f(`/pages/${page.id}`, post({ base: '1', section: 'gotchas', body: '## Gotchas\nMine.', intent: 'save' }))).text();
  assert.match(conflict, cm);
  assert.match(conflict, /<textarea name="body"[^>]*data-editor[^>]*>## Gotchas\nClaude found one\.<\/textarea>/, 'the editor under a conflict holds the version now saved');
  assert.match(conflict, /<pre class="mine">## Gotchas\nMine\.<\/pre>/, 'the typed words are still there, beside it');
  const refused = await (await f('/pages', post({ title: 'WILDLOG — wine cellar', project: 'wildlog', body: 'Another.', intent: 'save' }))).text();
  assert.match(refused, cm);
  assert.match(refused, /<textarea name="body"[^>]*data-editor[^>]*>Another\.<\/textarea>/, 'the refusal keeps the typed text');
});
