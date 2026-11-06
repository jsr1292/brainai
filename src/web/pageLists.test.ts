import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { seedFlaggedWildlog } from '../testing/staleFixtures.js';
import { searchView } from './searchViews.js';

test('writers and areas look the same everywhere', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const p = await app.deps.pages.create({ title: 'Wine cellar', project: 'wildlog', body: 'Hello.' }, 'Claude Code');
  const m = await app.deps.service.remember({ kind: 'decision', content: 'Use SQLite', project: 'wildlog' }, { type: 'ai', name: 'Claude Code' });
  const pages = await (await f('/pages')).text();
  assert.match(pages, /class="ring a-apps"/);
  assert.match(pages, /class="writer w-code"/);
  const page = await (await f(`/pages/${p.id}`)).text();
  assert.match(page, /Written by <span class="writer w-code">Claude Code<\/span>/);
  const panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, /class="pfacts[\s\S]*class="writer w-/);
  assert.ok(m);
});

test('Settings counts pages and a page shows the Pages nav without loading every page body', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { pages } = app.deps;
  const p = await pages.create({ title: 'Start page', area: 'start', body: 'Hello from the brain.' }, 'owner');
  await pages.create({ title: 'Second page', area: 'tools', body: 'More.' }, 'owner');
  const f = await loggedIn(app);
  pages.list = () => { throw new Error('every page body loaded'); };
  const settings = await f('/settings');
  assert.equal(settings.status, 200);
  assert.match(await settings.text(), /\b2 pages\b/);
  const view = await f(`/pages/${p.id}`);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /Second page/);
});

// ---- May be out of date on the Pages tab and where pages are listed (round 2 section 13) ----

async function flagged(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-10-12T09:00:00Z') });
  t.after(() => app.close());
  const seeded = await seedFlaggedWildlog(app.deps, app.advance);
  const runbook = await app.deps.pages.create({ title: 'wildlog — TestFlight runbook', project: 'wildlog', body: 'Steps.\n\n## Upload\nOrganizer.' }, 'Codex');
  return { app, ...seeded, runbook, f: await loggedIn(app) };
}
const foldOf = (body: string) => { const at = body.indexOf('<details class="fold stale-fold"'); return at < 0 ? '' : body.slice(at, body.indexOf('</details>', at)); };

test('the Pages tab gathers flagged pages in one closed fold, before Projects without a page', async (t) => {
  const { app, f, page } = await flagged(t);
  const { deps } = app;
  deps.registry.create('energy', { state: 'open', area: 'home' }, 'owner');
  const status = deps.store.insert({ kind: 'summary', content: 'energy: the battery is 10 kWh', project: 'energy', tags: [], embedding: new Float32Array(384), by: 'Claude Code' });
  app.advance(60_000);
  const energy = await deps.pages.create({ title: 'energy — solar and battery', project: 'energy', body: `Solar.\n\n## Battery\nSee [[fact:${status.id}]].` }, 'Claude Code');
  app.advance(60_000);
  deps.store.update(status.id, { content: 'energy: the battery is 15 kWh', project: 'energy', tags: [], embedding: new Float32Array(384), by: 'Claude Code' });
  deps.registry.create('minipc', { state: 'open', area: 'home' }, 'owner');
  deps.store.insert({ kind: 'decision', content: 'minipc runs Proxmox', project: 'minipc', tags: [], embedding: new Float32Array(384), by: 'Claude Code' });
  deps.notes.add(page.id, { text: 'Please bring this page up to date.', anchor: 'key-decisions' });
  const body = await (await f('/pages')).text();
  const fold = foldOf(body);
  assert.match(fold, /<summary class="row nolead">May be out of date<span class="n">2<\/span><span class="chev"><\/span><\/summary>/);
  assert.doesNotMatch(body, /<details class="fold stale-fold"[^>]* open/);
  assert.ok(body.indexOf('stale-fold') < body.indexOf('Projects without a page'));
  assert.equal(body.slice(body.lastIndexOf('<ul class="group', body.indexOf('stale-fold')), body.indexOf('stale-fold')).startsWith('<ul class="group nopage-group"><li>'), true);
  const rows = [...fold.matchAll(/<a class="row nolead" href="\/pages\/([^"]+)"><span class="txt"><b>[^<]+<\/b><ul class="meta-line">(.*?)<\/ul>/g)].map((m) => [m[1], m[2]]);
  // By when the flag went up, oldest first.
  assert.deepEqual(rows, [
    [page.id, '<li>3 newer decisions</li><li>a decision it links to was changed</li><li>since 1 Nov</li><li>you asked an AI</li>'],
    [energy.id, '<li>a fact it links to was changed</li><li>since 3 Nov</li>'],
  ]);
});

test('with nothing flagged the Pages tab has no such fold', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  await app.deps.pages.create({ title: 'Start page', area: 'start', body: 'Hello.' }, 'owner');
  const body = await (await (await loggedIn(app))('/pages')).text();
  assert.doesNotMatch(body, /stale-fold|May be out of date|may be out of date/);
});

test('a flagged page carries a quiet chip in Recently updated, in its project\'s panel and in search results', async (t) => {
  const { f, page, runbook } = await flagged(t);
  const chip = '<span class="chip soon">may be out of date</span>';
  const pages = await (await f('/pages')).text();
  const recent = pages.slice(pages.indexOf('<h2>Recently updated</h2>'), pages.indexOf('<h2>Start here</h2>'));
  assert.match(recent, new RegExp(`href="/pages/${page.id}"><span class="txt"><b>[^<]+</b><ul class="meta-line">.*?<li>${chip}</li></ul>`));
  assert.doesNotMatch(recent.slice(recent.indexOf(runbook.id), recent.indexOf('</li>', recent.indexOf(runbook.id))), /chip soon/);
  const panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, new RegExp(`<li><a href="[^"]*/pages/${page.id}[^"]*">[^<]+</a> ${chip}</li>`));
  assert.match(panel, new RegExp(`<li><a href="[^"]*/pages/${runbook.id}[^"]*">[^<]+</a></li>`));
  const search = await (await f('/search?q=garage')).text();
  assert.match(search, new RegExp(`/pages/${page.id}[^"]*"><span class="txt"><b>[^<]+</b>(<span class="sub">[^<]*</span>)?<ul class="meta-line"><li>${chip}</li></ul>`));
});

test('in search, a flagged page carries the chip once, on its first hit, not on every section', async (t) => {
  const { page, runbook } = await flagged(t);
  const hit = (p: typeof page, anchor: string, heading: string, stale: boolean) => ({ page: p, anchor, heading, snippet: '', stale });
  const body = searchView({ q: 'wildlog', projects: [], facts: [], pages: [
    hit(page, 'run-build-and-deploy', 'Run, build and deploy', true),
    hit(runbook, 'upload', 'Upload', false),
    hit(page, 'top', '', true),
    hit(page, 'gotchas-and-lessons', 'Gotchas and lessons', true),
    hit(page, 'stack-and-where-it-lives', 'Stack and where it lives', true),
  ] }).value;
  const rows = [...body.matchAll(/<li><a class="row nolead" href="([^"]*)">(.*?)<\/a><\/li>/g)]
    .map((m) => [m[1]!.includes(page.id) ? 'main' : 'runbook', m[1]!.split('#')[1], m[2]!.includes('may be out of date')]);
  assert.deepEqual(rows, [
    ['main', 'run-build-and-deploy', true],
    ['runbook', 'upload', false],
    ['main', 'top', false],
    ['main', 'gotchas-and-lessons', false],
    ['main', 'stack-and-where-it-lives', false],
  ]);
});

test('the left page list shows no mark on flagged pages', async (t) => {
  const { f, page, runbook } = await flagged(t);
  const body = await (await f(`/pages/${runbook.id}`)).text();
  const nav = body.slice(body.indexOf('<nav class="pnav"'), body.indexOf('</nav>', body.indexOf('<nav class="pnav"')));
  assert.match(nav, new RegExp(`<li><a href="/pages/${page.id}">[^<]+</a></li>`));
  assert.doesNotMatch(nav, /chip|out of date|hint/);
});
