import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('search finds a project by its one-liner and a fact by its words', async (t) => {
  const { app, f } = await start(t);
  const m = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog keeps its backups in the shared iCloud folder', project: 'wildlog' }, ai) as any).memory;
  app.deps.registry.setInfo('wildlog', { oneLiner: 'Shared wine cellar app' }, 'owner');
  const res = await f('/search?q=' + encodeURIComponent('wine cellar'));
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<title>Search<\/title>/);
  assert.match(page, /<ul class="group"><li><a class="row nolead" href="\/\?project=wildlog#panel"><span class="txt"><b>wildlog<\/b>/);
  assert.match(page, /value="wine cellar"/);
  const facts = await (await f('/search?q=' + encodeURIComponent('iCloud backups'))).text();
  assert.match(facts, new RegExp(`href="/memories/${m.id}\\?from=%2Fsearch%3Fq%3DiCloud%2520backups"`));
  // A fact row is its text and a meta line led by the project; the leading "wildlog" stays (no "wildlog:" prefix here).
  assert.match(facts, new RegExp(`<a class="row nolead" href="/memories/${m.id}\\?from=%2Fsearch%3Fq%3DiCloud%2520backups"><span class="txt">wildlog keeps its backups[^<]*<ul class="meta-line"><li><span class="chip plain">wildlog</span></li>`));
  const none = await (await f('/search?q=' + encodeURIComponent('pebble'))).text();
  assert.match(none, /<p class="quiet empty">Nothing matches “pebble”\. Try fewer words\.<\/p>/);
});

test('search with an empty query shows no results and answers 200', async (t) => {
  const { f } = await start(t);
  for (const q of ['', '   ']) {
    const res = await f('/search?q=' + encodeURIComponent(q));
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /Type something to search\./);
    assert.doesNotMatch(page, /<h2>Facts/);
  }
  assert.equal((await f('/search')).status, 200);
});

test('a hostile or very long query is escaped and cut, and answers 200', async (t) => {
  const { f } = await start(t);
  const hostile = await (await f('/search?q=' + encodeURIComponent('<script>alert(1)</script>'))).text();
  assert.doesNotMatch(hostile, /<script>alert/);
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const long = await f('/search?q=' + 'a'.repeat(500));
  assert.equal(long.status, 200);
  assert.match(await long.text(), new RegExp(`value="${'a'.repeat(200)}"`));
});

test('search needs the owner', async (t) => {
  const { app } = await start(t);
  const res = await fetch(app.baseUrl + '/search?q=x', { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('search finds a page section by a word in it and links to its anchor', async (t) => {
  const { app, f } = await start(t);
  const p = await app.deps.pages.create({ title: 'backups — recovery patterns', area: 'home', body: 'How copies are kept.\n\n## Off-site copy\nAn encrypted archive goes to Google Drive every Sunday.' }, 'owner');
  const body = await (await f('/search?q=' + encodeURIComponent('encrypted archive'))).text();
  assert.match(body, /<section class="search-group"><h2>Pages<\/h2>/);
  assert.match(body, new RegExp(`<a class="row nolead" href="/pages/${p.id}\\?from=%2Fsearch%3Fq%3Dencrypted%2520archive#off-site-copy"><span class="txt"><b>backups — recovery patterns › Off-site copy</b>`));
  assert.match(body, /An encrypted archive goes to Google Drive every Sunday\./);
  const lead = await (await f('/search?q=' + encodeURIComponent('copies kept'))).text();
  assert.match(lead, new RegExp(`<a class="row nolead" href="/pages/${p.id}\\?from=%2Fsearch%3Fq%3Dcopies%2520kept#top"><span class="txt"><b>backups — recovery patterns</b>`));
});

test('search groups projects, facts and pages in that order', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('zanzibar', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'zanzibar ships the quokka build', project: 'zanzibar' }, ai);
  await app.deps.pages.create({ title: 'zanzibar notes', area: 'apps', body: 'The quokka build for zanzibar.' }, 'owner');
  const body = await (await f('/search?q=zanzibar')).text();
  const at = (h: string) => body.indexOf(`<h2>${h}</h2>`);
  assert.ok(at('Projects') > 0 && at('Projects') < at('Facts') && at('Facts') < at('Pages'), `${at('Projects')} ${at('Facts')} ${at('Pages')}`);
});

test('a deleted page is not found', async (t) => {
  const { app, f } = await start(t);
  const p = await app.deps.pages.create({ title: 'Old runbook', area: 'tools', body: 'Restart the flamingo service.' }, 'owner');
  app.deps.pages.remove(p.id, 'owner');
  assert.doesNotMatch(await (await f('/search?q=flamingo')).text(), /<h2>Pages<\/h2>/);
});

test('the header search embeds the query once', async (t) => {
  const { app, f } = await start(t);
  let pageEmbeds = 0;
  const embedQuery = app.deps.pages.embedQuery.bind(app.deps.pages);
  app.deps.pages.embedQuery = (q: string) => { pageEmbeds++; return embedQuery(q); };
  const inner = (app.deps.service as any).embedder;
  let factEmbeds = 0;
  const embed = inner.embed.bind(inner);
  inner.embed = (q: string, p: string) => { factEmbeds++; return embed(q, p); };
  await f('/search?q=wildlog');
  assert.deepEqual([pageEmbeds, factEmbeds], [1, 0]);
});

test('search finds a project by a one-liner in Cyrillic, Arabic or Japanese, and still ignores accents', async (t) => {
  const { app, f } = await start(t);
  const projects: [string, string, string][] = [
    ['kassa', 'Учёт домашней кассы', 'кассы'], ['souk', 'تطبيق السوق العائلي', 'السوق'], ['kura', '家族のワイン蔵', 'ワイン蔵'], ['cafe', 'Café menu', 'cafe'],
  ];
  for (const [name, oneLiner] of projects) {
    await app.deps.service.remember({ kind: 'decision', content: `${name} keeps its data in SQLite`, project: name, newProject: true }, ai);
    app.deps.registry.setInfo(name, { oneLiner }, 'owner');
  }
  for (const [name, , q] of projects) {
    const page = await (await f('/search?q=' + encodeURIComponent(q))).text();
    assert.match(page, new RegExp(`<a class="row nolead" href="/\\?project=${name}#panel"><span class="txt"><b>${name}</b>`), q);
    for (const [other] of projects) if (other !== name) assert.doesNotMatch(page, new RegExp(`project=${other}#panel`), `${q} / ${other}`);
  }
});

test('header search leaves replaced facts out and counts those that ranked among the results', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const save = async (content: string, supersedes?: string[]) => ((await s.remember({ kind: 'decision', content, project: 'wildlog', newProject: true, allowDuplicate: true, supersedes }, ai)) as any).memory.id as string;
  const o1 = await save('wildlog drinking windows come from Cellarium');
  const o2 = await save('wildlog drinking windows come from Vivino');
  const n = await save('wildlog drinking windows are set by hand', [o1, o2]);
  let page = await (await f('/search?q=' + encodeURIComponent('drinking windows'))).text();
  assert.ok(page.includes(`/memories/${n}?from=`) && !page.includes(`/memories/${o1}?from=`));
  assert.match(page, /<p class="also-line">Also 2 replaced facts match\. <a href="\/facts\?q=drinking%20windows&amp;show=replaced">Show them<\/a><\/p>/);
  s.undoSupersession(app.deps.store.supersessions.liveFor(o2)!.id, { type: 'owner' });
  page = await (await f('/search?q=' + encodeURIComponent('drinking windows'))).text();
  assert.match(page, /<p class="also-line">Also 1 replaced fact matches\. <a href="[^"]+">Show it<\/a><\/p>/);
  page = await (await f('/search?q=' + encodeURIComponent('restic backups'))).text();
  assert.doesNotMatch(page, /also-line/);
});

test('the "Also N" line and the page it opens agree', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const save = async (content: string, kind: 'decision' | 'summary' | 'roadmap' = 'decision') => ((await s.remember({ kind, content, project: 'wildlog', newProject: true, allowDuplicate: true }, ai)) as any).memory.id as string;
  await save('Now: cellar import\nNext: labels', 'roadmap');
  const current = [];
  for (let i = 0; i < 3; i++) current.push(await save(`wildlog cellar import step ${i} reads the spreadsheet`));
  for (let i = 0; i < 7; i++) {
    const old = await save(`wildlog cellar import rule ${i} from the spreadsheet`);
    s.supersede([old], current[i % 3]!, { type: 'owner' });
  }
  for (const q of ['cellar import spreadsheet', 'how is wildlog going with the cellar import']) {
    const page = await (await f('/search?q=' + encodeURIComponent(q))).text();
    const n = Number(page.match(/Also (\d+) replaced facts? match/)?.[1] ?? 0);
    assert.equal(n, 7, q);
    const list = await (await f(`/facts?q=${encodeURIComponent(q)}&show=replaced`)).text();
    assert.equal((list.match(/<li class="card rep">/g) ?? []).length, n, q);
  }
});
