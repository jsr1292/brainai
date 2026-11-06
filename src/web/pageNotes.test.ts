import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, owner);
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The cellar app.\n\n## Stack\nSwiftUI.\n\n## Deploy\nTestFlight.' }, 'owner');
  return { app, f: await loggedIn(app), page };
}
const post = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });
const notesBlock = (body: string) => body.slice(body.indexOf('<section class="pnotes" id="ai_notes"'), body.indexOf('</section>', body.indexOf('<section class="pnotes" id="ai_notes"')));

test('the owner leaves a note on a section and sees it waiting', async (t) => {
  const { app, f, page } = await start(t);
  const form = await (await f(`/pages/${page.id}`)).text();
  assert.match(form, new RegExp(`<details class="asknote" id="ask_ai"><summary class="link">Ask an AI to update</summary>[\\s\\S]*<form method="post" action="/pages/${page.id}/notes#ask_ai"[^>]*>`));
  assert.match(form, /<select name="section"><option value="">The whole page<\/option><option value="stack">Stack<\/option><option value="deploy">Deploy<\/option><\/select>/);
  assert.match(form, /<textarea name="text" maxlength="500" required placeholder="What should change\? e\.g\. the port changed to 8443">/);
  const res = await f(`/pages/${page.id}/notes`, post({ text: 'Deploys go through Xcode Cloud now', section: 'deploy' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pages/${page.id}#ai_notes`);
  const body = await (await f(`/pages/${page.id}`)).text();
  const block = notesBlock(body);
  assert.match(block, /<h2>Notes for the AIs<\/h2>/);
  assert.match(block, /<li><a href="#deploy">Deploy<\/a><\/li><li>waiting for an assistant<\/li>[\s\S]*Deploys go through Xcode Cloud now/);
  const note = app.deps.notes.forPage(page.id)[0]!;
  assert.match(block, new RegExp(`<form method="post" action="/pages/${page.id}/notes/${note.id}/withdraw"><button type="submit" class="ghost small" aria-label="Withdraw note: Deploys go through Xcode Cloud now">Withdraw</button></form>`));
  assert.match(body, /<h2 id="deploy">Deploy<\/h2> <a class="sec-edit"[^>]*>Edit<\/a> <a class="note-mark" href="#ai_notes">note<\/a><\/div>/);
  assert.doesNotMatch(body, /<h2 id="stack">Stack<\/h2> <a class="sec-edit"[^>]*>Edit<\/a> <a class="note-mark"/);
});

test('a resolved note shows the assistant\'s reply', async (t) => {
  const { app, f, page } = await start(t);
  const n = app.deps.notes.add(page.id, { text: 'Port changed to 8443' });
  app.deps.notes.resolve(n.id, 'Updated the Run section to port 8443.', 'Claude Code');
  const block = notesBlock(await (await f(`/pages/${page.id}`)).text());
  assert.match(block, /Port changed to 8443[\s\S]*Claude Code: Updated the Run section to port 8443\./);
  assert.doesNotMatch(block, /waiting for an assistant|Withdraw/);
});

test('withdrawing an open note removes it from the page', async (t) => {
  const { app, f, page } = await start(t);
  const n = app.deps.notes.add(page.id, { text: 'Never mind this' });
  const res = await f(`/pages/${page.id}/notes/${n.id}/withdraw`, post({}));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pages/${page.id}#ai_notes`);
  assert.doesNotMatch(await (await f(`/pages/${page.id}`)).text(), /Never mind this/);
  assert.equal(app.deps.notes.get(n.id)!.status, 'withdrawn');
  assert.equal((await f(`/pages/${page.id}/notes/nope/withdraw`, post({}))).status, 404);
});

test('an empty note or one with a secret answers 400 and keeps the page', async (t) => {
  const { app, f, page } = await start(t);
  const empty = await f(`/pages/${page.id}/notes`, post({ text: '   ', section: '' }));
  assert.equal(empty.status, 400);
  const eb = await empty.text();
  assert.match(eb, /A note is 1 to 500 characters/);
  assert.match(eb, /<h1>wildlog — wine cellar<\/h1>/);
  const secret = await f(`/pages/${page.id}/notes`, post({ text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', section: '' }));
  assert.equal(secret.status, 400);
  assert.match(await secret.text(), /looks like it contains a secret/);
  assert.deepEqual(app.deps.notes.forPage(page.id), []);
});

test('the note form and the notes are escaped', async (t) => {
  const { app, f, page } = await start(t);
  app.deps.notes.add(page.id, { text: '<script>alert(1)</script> please' });
  const body = await (await f(`/pages/${page.id}`)).text();
  assert.match(notesBlock(body), /&lt;script&gt;alert\(1\)&lt;\/script&gt; please/);
  assert.doesNotMatch(body, /<script>alert/);
});

test('a note on a deleted or unknown page answers 404', async (t) => {
  const { app, f, page } = await start(t);
  assert.equal((await f('/pages/00000000-0000-0000-0000-000000000000/notes', post({ text: 'x' }))).status, 404);
  app.deps.pages.remove(page.id, 'owner');
  assert.equal((await f(`/pages/${page.id}/notes`, post({ text: 'x' }))).status, 404);
});

test('a page with its own "Notes" heading still lands on the notes panel, and no id is used twice', async (t) => {
  const { app, f } = await start(t);
  const p = await app.deps.pages.create({ title: 'Field notes', area: 'tools', body: 'Intro.\n\n## Setup\nOne.\n\n## Notes\nMy own notes section.' }, 'owner');
  const res = await f(`/pages/${p.id}/notes`, post({ text: 'Add the new port', section: 'notes' }));
  assert.equal(res.status, 303);
  const target = new URL(res.headers.get('location')!, app.baseUrl).hash.slice(1);
  const body = await (await f(`/pages/${p.id}`)).text();
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  assert.match(body, new RegExp(`<section class="pnotes" id="${target}"><h2>Notes for the AIs</h2>`));
  assert.match(body, new RegExp(`<a class="note-mark" href="#${target}">note</a>`));
});

test('a refused note keeps the form open with the typed text, the chosen section and the reason', async (t) => {
  const { app, f, page } = await start(t);
  const res = await f(`/pages/${page.id}/notes`, post({ text: 'Deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB now', section: 'deploy' }));
  assert.equal(res.status, 400);
  const body = await res.text();
  const form = body.slice(body.indexOf('<details class="asknote"'), body.indexOf('</details>', body.indexOf('<details class="asknote"')));
  assert.match(form, /^<details class="asknote" id="ask_ai" open>/);
  assert.match(form, /<option value="deploy" selected>Deploy<\/option>/);
  assert.match(form, /<textarea name="text"[^>]*>Deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB now<\/textarea>/);
  assert.match(form, /<p class="error" id="note_error" role="alert">[^<]*looks like it contains a secret/);
  assert.match(form, /<textarea name="text"[^>]*aria-describedby="note_error"/);
  assert.equal(body.match(/looks like it contains a secret/g)?.length, 1, 'the reason is shown once, beside the form');
  assert.deepEqual(app.deps.notes.forPage(page.id), []);
  const fresh = await (await f(`/pages/${page.id}`)).text();
  assert.match(fresh, /<details class="asknote" id="ask_ai"><summary/);
  assert.doesNotMatch(fresh, /note_error/);
});

test('a refused note opens the page at the note form, and the reason is announced', async (t) => {
  // On a phone or tablet the form sits far below the article: without a fragment the page reloads at the top and looks saved.
  const { f, page } = await start(t);
  const form = await (await f(`/pages/${page.id}`)).text();
  assert.match(form, new RegExp(`<details class="asknote" id="ask_ai">[\\s\\S]*<form method="post" action="/pages/${page.id}/notes#ask_ai"`));
  const res = await f(`/pages/${page.id}/notes`, post({ text: 'Deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB now', section: '' }));
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /<details class="asknote" id="ask_ai" open>/);
  assert.match(body, /<p class="error" id="note_error" role="alert">[^<]*looks like it contains a secret/);
  // A saved note still lands on the notes panel: the redirect's own fragment replaces the form's.
  const ok = await f(`/pages/${page.id}/notes#ask_ai`, post({ text: 'Port changed to 8443', section: '' }));
  assert.equal(ok.headers.get('location'), `/pages/${page.id}#ai_notes`);
});
