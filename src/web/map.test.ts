import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-11-11T10:00:00Z') });
  t.after(() => app.close());
  const r = app.deps.registry;
  r.create('larder', { state: 'open', area: 'apps', oneLiner: 'Wine cellar' }, 'owner');
  r.create('gpx', { state: 'open', area: 'apps', oneLiner: 'Kart telemetry' }, 'owner');
  r.create('homelab', { state: 'parked', area: 'home', oneLiner: 'The mini PC' }, 'owner');
  r.create('someday', { state: 'idea', area: 'apps', oneLiner: 'Maybe' }, 'owner');
  r.create('budget', { state: 'open', area: 'personal', oneLiner: 'Bills' }, 'owner');
  return { app, f: await loggedIn(app) };
}

test('the map lists every in-scope project by area with its five cells', async (t) => {
  const { f } = await start(t);
  const page = await (await f('/map')).text();
  assert.match(page, /<h1>Five areas<\/h1>/);
  assert.ok(page.indexOf('id="map-apps"') > 0 && page.indexOf('id="map-home"') > page.indexOf('id="map-apps"'));
  for (const name of ['larder', 'gpx', 'homelab']) assert.match(page, new RegExp(`<a href="/\\?project=${name}#p-areas">${name}</a>`));
  for (const name of ['someday', 'budget']) assert.doesNotMatch(page, new RegExp(`project=${name}`), name);
  const at = page.indexOf('<th scope="row"><a href="/?project=larder#p-areas">');
  const row = page.slice(at, page.indexOf('</tr>', at));
  assert.equal((row.match(/<td class="mcell/g) ?? []).length, 5);
  for (const name of ['Work is safe', 'Clear finish line', 'Runs by itself', 'You&#39;d know if it broke', 'Kept up to date']) assert.match(page, new RegExp(`<th scope="col"[^>]*>${name}`), name);
});

test('a cell shows its note and date', async (t) => {
  const { app, f } = await start(t);
  app.deps.learning.set('gpx', 'auto', { status: 'look', note: 'tests run in Xcode only' }, 'Claude Code');
  const page = await (await f('/map')).text();
  assert.match(page, /<td class="mcell st-look"[^>]*><a class="mlink"[^>]*><span class="pdot a-st-look"[^>]*><\/span><\/a><span class="mnote">worth a look · tests run in Xcode only · <time/);
});

test('the map names the next area to learn and links the handbook', async (t) => {
  const { app, f } = await start(t);
  for (const a of ['finish', 'auto', 'alerts', 'upkeep'] as const) app.deps.learning.set('larder', a, { status: 'done', note: 'ok' }, 'x');
  app.deps.learning.set('homelab', 'finish', { status: 'done', note: 'ok' }, 'x');
  const page = await (await f('/map')).text();
  assert.match(page, /3 projects · next to learn: Clear finish line, on <a href="\/\?project=gpx#p-areas">gpx<\/a>\./);
  assert.match(page, /<a href="\/\?project=developer-handbook#panel">Your handbook<\/a>/);
});

test('viewing the map records this week once and shows the history', async (t) => {
  const { app, f } = await start(t);
  app.deps.learning.set('gpx', 'finish', { status: 'done', note: 'v1 defined' }, 'x');
  await f('/map');
  await f('/map');
  const history = app.deps.learning.history(8);
  assert.deepEqual(history.filter((h) => h.area === 'finish' && h.status === 'done'), [{ week: '2026-11-09', area: 'finish', status: 'done', count: 1 }]);
  assert.match(await (await f('/map')).text(), /aria-label="Clear finish line: done on 1 project this week"/);
});

test('the Projects page links to the map once, by its links row; the list beside an open project keeps its row', async (t) => {
  const { f } = await start(t);
  const home = await (await f('/')).text();
  assert.doesNotMatch(home, /map-link/, 'no second card of the same links');
  assert.doesNotMatch(home, /<b>All discussions<\/b>/);
  assert.equal((home.match(/href="\/map"/g) ?? []).filter(Boolean).length >= 1, true);
  assert.match(await (await f('/?pane=projects')).text(), /<a class="row nolead map-link" href="\/map"><span class="txt"><b>Five areas<\/b> · every project against the five areas<\/span>/);
});

test('review M7: every Map cell links to the project\'s five areas', async (t) => {
  const { f } = await start(t);
  const page = await (await f('/map')).text();
  const at = page.indexOf('<th scope="row"><a href="/?project=gpx#p-areas">');
  const row = page.slice(at, page.indexOf('</tr>', at));
  assert.equal((row.match(/<td class="mcell[^>]*><a class="mlink" href="\/\?project=gpx#p-areas"/g) ?? []).length, 5);
});

test('the Five areas page and the project panel carry the key to the marks; an empty one says what it waits for', async (t) => {
  const { f } = await start(t);
  const page = await (await f('/map')).text();
  assert.match(page, /<title>Five areas<\/title>/);
  assert.match(page, /<p class="key area-key"[^>]*>(?:<span>[\s\S]*?<\/span>){5}<\/p>/);
  assert.ok(page.indexOf('class="key area-key"') < page.indexOf('<table'), 'the key is above the first table');
  assert.match(page, /done<\/span><span><span class="pdot a-st-look"[^>]*><\/span> worth a look<\/span><span><span class="pdot a-st-todo"[^>]*><\/span> not started<\/span><span><span class="pdot a-st-unknown"[^>]*><\/span> unknown<\/span><span><span class="adash"[^>]*>–<\/span> not needed/);
  const panel = await (await f('/?project=larder')).text();
  assert.match(panel, /<h3 id="p-areas">Five areas<\/h3>\s*<p class="area-intro">Five things that make a project safe to leave alone\. Your assistants fill these in as you work together\.<\/p>\s*<p class="key area-key"/);
  const empty = await startTestApp();
  t.after(() => empty.close());
  assert.match(await (await (await loggedIn(empty))('/map')).text(), /Nothing here yet\. This fills in when you have a project\./);
});

test('the Projects page keys its dots and ends with a row of links', async (t) => {
  const { f } = await start(t);
  const home = await (await f('/')).text();
  assert.match(home, /<p class="key dot-key"[^>]*><span><span class="pdot d-wait"[^>]*><\/span> waiting on you<\/span><span><span class="pdot d-on"[^>]*><\/span> being worked on<\/span><span><span class="pdot d-quiet"[^>]*><\/span> quiet<\/span><\/p>/);
  assert.match(home, /<p class="home-links"><a href="\/map">Five areas<\/a><a href="\/graph">Graph<\/a><a href="\/discussions">Discussions<\/a><\/p>/);
});
