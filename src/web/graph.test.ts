import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
type App = Awaited<ReturnType<typeof start>>['app'];
const remember = async (app: App, content: string, project?: string, kind: 'decision' | 'profile' | 'summary' = 'decision') => {
  const r = await app.deps.service.remember({ kind, content, project }, owner);
  assert.equal(r.status, 'saved');
  return (r as { memory: { id: string } }).memory;
};

test('the graph data needs a login and is never cached', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'restic nightly backups', 'demo');
  for (const path of ['/graph.json', '/graph/projects/x.json', '/graph/find.json?q=a']) {
    const anonymous = await fetch(app.baseUrl + path, { redirect: 'manual' });
    assert.equal(anonymous.status, 302, path);
    assert.match(anonymous.headers.get('location')!, /^\/login/, path);
  }
  const res = await f('/graph.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json() as Record<string, unknown>;
  for (const k of ['projects', 'threads', 'profileFacts', 'places']) assert.ok(k in body, k);
  assert.deepEqual((body.projects as { name: string }[]).map((p) => p.name), ['demo']);
});

test('the 3D page holds the list, and the window starts hidden', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'restic nightly backups', 'demo');
  const page = await (await f('/graph')).text();
  assert.match(page, /<div class="graph" role="application"[^>]*aria-roledescription="3D graph"[^>]*hidden/);
  assert.match(page, /aria-label="Graph of 1 project"/, 'Unsorted is not an area, and no area is left out, not shown as 0');
  assert.match(page, /aria-describedby="graph-keys"/);
  assert.match(page, /<section class="graph-list"[^>]*>/);
  assert.doesNotMatch(page, /<section class="graph-list"[^>]*hidden/);
  assert.match(page, /<script type="module" src="\/static\/graph3d\.js\?v=[0-9a-f]{10}"><\/script>/);
  assert.doesNotMatch(page, /map\.js|globe\.js|sky/);
  assert.match(page, /<title>Graph<\/title>/);
  assert.match(page, /<a href="\/graph" aria-current="page">Graph<\/a>/);
  const win = page.slice(page.indexOf('<div class="graph"'));
  const firstControl = win.match(/<(a|button|input)\b[^>]*>([^<]*)/)!;
  assert.equal(firstControl[2], 'Show as list');
  assert.match(page, /<canvas class="graph-canvas" aria-hidden="true"><\/canvas>/);
  assert.match(page, /<label for="graph-q" class="visually-hidden">Find in the graph<\/label><input id="graph-q" type="search" maxlength="200"/);  // The card and the phone's sheet both announce a selection.
  assert.match(page, /<div class="graph-card" aria-live="polite" hidden>/);
  assert.match(page, /<div class="graph-sheet-body" aria-live="polite"><\/div>/);
});

test('the area count leaves Unsorted out', async (t) => {
  const { app, f } = await start(t);
  for (const [p, area] of [['wildlog', 'apps'], ['outline', 'home'], ['loose', null]] as const) {
    await remember(app, `${p} notes`, p);
    if (area) app.deps.registry.setInfo(p, { area }, 'owner');
  }
  const page = await (await f('/graph')).text();
  assert.match(page, /aria-label="Graph of 3 projects in 2 areas"/);
  assert.match(page, /<p class="lede">3 projects in 2 areas · /);
});

test('a list row\'s meta line reads as one line with one kind of separator, Touched capitalised as on the card', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'wildlog notes', 'wildlog');
  await remember(app, 'outline notes', 'outline');
  app.deps.registry.setInfo('wildlog', { runsOn: ['minipc', 'pi'] }, 'owner');
  await app.deps.service.remember({ kind: 'roadmap', content: 'Now: x\nWaiting on you: one (by 2020-01-01); two', project: 'wildlog' }, owner);
  const page = await (await f('/graph', { headers: { Cookie: 'graph-view=list' } })).text();
  const meta = (name: string) => {
    const li = page.slice(page.indexOf(`<li id="g-${name}">`));
    // A meta line is a list, one item per part; the dots between them are drawn by CSS.
    const line = li.match(/<ul class="meta-line">([\s\S]*?)<\/ul>/)![1]!;
    return [...line.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '')).join(' · ');
  };
  assert.equal(meta('wildlog'), '2 waiting · 1 late · Touched today · Runs on Mini PC, Pi');
  assert.equal(meta('outline'), 'Touched today');
});

test('Show as list is remembered, and the list page has no canvas', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'restic nightly backups', 'demo');
  const chose = await f('/graph?view=list');
  assert.equal(chose.status, 303);
  assert.equal(chose.headers.get('location'), '/graph');
  const cookie = chose.headers.getSetCookie().find((c) => c.startsWith('graph-view=list'));
  assert.ok(cookie);
  assert.match(cookie, /Max-Age=\d+/);
  assert.match(cookie, /SameSite=Lax/i);
  const list = await (await f('/graph', { headers: { Cookie: 'graph-view=list' } })).text();
  assert.doesNotMatch(list, /<canvas/);
  assert.match(list, /href="\/graph\?view=3d">Show in 3D/);
  assert.doesNotMatch(list, /graph3d\.js/);
  const back = await f('/graph?view=3d');
  assert.equal(back.status, 303);
  assert.ok(back.headers.getSetCookie().some((c) => c.startsWith('graph-view=3d')));
  assert.equal((await f('/graph?view=nonsense')).status, 200);
});

test('old Map and Globe addresses go to the Graph tab in one hop', async (t) => {
  const { f } = await start(t);
  for (const path of ['/graph?view=map', '/graph?view=globe', '/overview?view=globe', '/overview?view=map', '/?view=map', '/?view=globe']) {
    const res = await f(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), '/graph', path);
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('sky-view')), path);
  }
  assert.equal((await f('/map.json')).status, 404);
});

test('the list puts an unpinned personal project in the closed Personal fold and finished ones in the closed Done and archived fold', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'banco cuenta', 'finances');
  await remember(app, 'cv updated', 'career');
  await remember(app, 'all shipped', 'finished');
  app.deps.registry.setInfo('finances', { area: 'personal' }, 'owner');
  app.deps.registry.setInfo('career', { area: 'personal' }, 'owner');
  app.deps.registry.pin('career', 'owner');
  app.deps.registry.setState('finished', 'done', 'owner');
  await remember(app, 'loose notes', 'loose');
  const page = await (await f('/graph?view=list').then(() => f('/graph', { headers: { Cookie: 'graph-view=list' } }))).text();
  // One Personal section: the pinned project under its heading, then the closed fold of the others, before Unsorted.
  assert.equal(page.split('Personal').length - 1, 1, 'one Personal heading, no second Personal section');
  assert.match(page, /<h2>Personal<\/h2>\s*<ul class="graph-rows"><li id="g-career">[\s\S]*?<\/ul>\s*<details class="fold"><summary>Not pinned <span class="n">1<\/span><span class="chev"><\/span><\/summary>[\s\S]*?finances[\s\S]*?<\/details>\s*<h2>Unsorted<\/h2>/);
  const fold = page.slice(page.indexOf('<details class="fold"><summary>Not pinned'));
  assert.doesNotMatch(fold.slice(0, fold.indexOf('</details>')), /career/);
  assert.match(page, /<details class="fold"><summary>Done and archived <span class="n">1<\/span><span class="chev"><\/span><\/summary>[\s\S]*?finished/);
  assert.doesNotMatch(page, /<details class="fold" open/);
});

test('find.json cuts q to 200 characters', async (t) => {
  const { app, f } = await start(t);
  const embed = mock.method(app.deps.pages, 'embedQuery');
  t.after(() => embed.mock.restore());
  const res = await f(`/graph/find.json?q=${'x'.repeat(300)}`);
  assert.equal(res.status, 200);
  assert.equal(embed.mock.callCount(), 1);
  assert.equal((embed.mock.calls[0]!.arguments[0] as string).length, 200);
  assert.equal(((await res.json()) as { q: string }).q.length, 200);
});

test('opening the graph compares no vectors', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'Use SQLite for storage', 'demo');
  await remember(app, 'Deploy with Docker', 'other');
  const store = app.deps.store;
  const read = store.activeEmbeddings.bind(store);
  let reads = 0;
  store.activeEmbeddings = (...args) => { reads++; return read(...args); };
  const load = mock.method(app.deps.graph.meaning, 'loadItems');
  t.after(() => load.mock.restore());
  const readsFor = async (path: string) => { reads = 0; assert.equal((await f(path)).status, 200, path); return reads; };
  for (const path of ['/graph', '/graph.json', '/graph/projects/demo.json']) assert.equal(await readsFor(path), 0, path);
  await app.deps.service.recall({ query: 'SQLite' });
  for (const path of ['/graph', '/graph.json', '/graph/projects/demo.json']) assert.equal(await readsFor(path), 0, path);
  assert.equal(load.mock.callCount(), 0);
});

test('a deep link flies to the project, through an alias too; unknown and finished names open the overview', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'swiftui app', 'wildlog');
  await remember(app, 'plays films', 'inflow');
  await remember(app, 'plays from jellyfin', 'coyote');
  app.deps.service.moveProject('coyote', 'inflow', owner);
  await remember(app, 'all done', 'finished');
  app.deps.registry.setState('finished', 'done', 'owner');
  assert.match(await (await f('/graph?project=wildlog')).text(), /<div class="graph"[^>]*data-project="wildlog"/);
  assert.match(await (await f('/graph?project=coyote')).text(), /<div class="graph"[^>]*data-project="inflow"/);
  for (const name of ['nope', 'finished']) {
    const res = await f(`/graph?project=${name}`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /data-project=/);
  }
  const missing = await f('/graph/projects/nope.json');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });
  assert.equal((await f('/graph/projects/coyote.json')).status, 200);
  const withList = await (await f('/graph?project=wildlog', { headers: { Cookie: 'graph-view=list' } })).text();
  assert.match(withList, /<div class="graph"[^>]*data-project="wildlog"/);
  assert.match(withList, /<canvas/);
});

test('AI-written text is escaped in the list and graph3d.js never writes markup', async (t) => {
  const { app, f } = await start(t);
  await remember(app, 'swiftui app', 'wildlog');
  app.deps.registry.setInfo('wildlog', { oneLiner: '<img src=x onerror=alert(1)>' }, 'owner');
  (app.deps.store as unknown as { db: import("../db.js").DB }).db.prepare(`UPDATE projects SET runs_on = '["x\\"y"]' WHERE name = 'wildlog'`).run();
  const page = await (await f('/graph')).text();
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /Runs on x&quot;y/);
  const js = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style|cssText/);
});

test('find.json answers odd queries calmly', async (t) => {
  const { app, f } = await start(t);
  const embed = mock.method(app.deps.pages, 'embedQuery');
  t.after(() => embed.mock.restore());
  for (const path of ['/graph/find.json?q=a&q=b', '/graph/find.json?q=', '/graph/find.json']) {
    const res = await f(path);
    assert.equal(res.status, 200, path);
    assert.deepEqual(await res.json(), { q: '', projects: [] }, path);
  }
  assert.equal(embed.mock.callCount(), 0);
});

test('the list never names an unpinned Personal project outside its fold', async (t) => {
  const { app, f } = await start(t);
  for (const c of ['banco cuenta ahorro transferencia mensual', 'banco cuenta ahorro nomina mensual']) await remember(app, c, 'wildlog');
  for (const c of ['banco cuenta ahorro transferencia anual', 'banco cuenta ahorro nomina anual']) await remember(app, c, 'finances');
  app.deps.registry.setInfo('finances', { area: 'personal' }, 'owner');
  assert.ok(app.deps.graph.overview().threads.length > 0, 'the two projects are related');
  const page = await (await f('/graph')).text();
  const li = page.slice(page.indexOf('<li id="g-wildlog">'));
  assert.doesNotMatch(li.slice(0, li.indexOf('</li>')), /finances/);
  const fold = page.slice(page.indexOf('<summary>Personal <span class="n">1</span><span class="chev"></span></summary>'));
  assert.match(fold.slice(0, fold.indexOf('</details>')), /finances/);
});
