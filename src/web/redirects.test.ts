import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { seedMoved, type MovedDoc } from '../testing/movedFixtures.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('old Memories and What\'s left addresses redirect, keeping what they pointed at', async (t) => {
  const { f } = await start(t);
  for (const [from, to] of [
    ['/memories', '/facts'], ['/memories?project=wildlog&kind=decision', '/facts?project=wildlog&kind=decision'],
    ['/left', '/'], ['/left?project=vpn', '/?project=vpn#panel'],
  ]) {
    const res = await f(from!);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
  assert.equal((await f('/left/x/park', { method: 'POST' })).status, 404);
});

test('Activity goes to So far Latest changes', async (t) => {
  const { f } = await start(t);
  const res = await f('/activity');
  assert.deepEqual([res.status, res.headers.get('location')], [301, '/review/now#latest']);
});

test('every old address lands on its new home', async (t) => {
  const { f } = await start(t);
  for (const [from, to] of [
    ['/settings/growth', '/growth'], ['/settings/tidy', '/facts/tidy'], ['/tidy', '/facts/tidy'],
    ['/settings/import', '/pages/moved'], ['/settings/import/x1', '/pages/moved/x1'],
    ['/activity', '/review/now#latest'], ['/memories', '/facts'], ['/clients', '/settings#connections'],
    ['/graph?view=map', '/graph'],
  ] as const) {
    const res = await f(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('old form paths still work for one release', async (t) => {
  const { app, f } = await start(t);
  const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });
  // Growth: the react form's old address still marks the observation.
  app.deps.registry.create('wildlog', { state: 'open' }, 'owner');
  const { observation } = await app.deps.growth.note({ kind: 'strength', area: 'reviewing', what: 'Caught the missing alias case in review', project: 'wildlog' }, 'Claude Code');
  const react = await f(`/settings/growth/${observation.id}/react`, form({ reaction: 'agree' }));
  assert.equal(react.status, 303);
  assert.equal(react.headers.get('location'), `/growth#o-${observation.id}`);
  assert.equal(app.deps.growth.list()[0]!.observation.reaction, 'agree');
  // Moved from Outline: the check form's old address still checks and moves on.
  const registry = app.deps.registry, service = app.deps.service, store = app.deps.store, pages = app.deps.pages;
  await service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, { type: 'owner' });
  const db = (store as unknown as { db: import('../db.js').DB }).db;
  const deps = { pages, registry, memories: service, memoryStore: store, db, now: app.deps.now };
  await seedMoved(deps, [
    { id: 'o1', collection: 'Apps', title: 'wildlog — wine cellar', text: 'The cellar app.', updatedAt: '2026-11-03T11:00:00Z' },
    { id: 'o3', collection: 'Apps', title: 'castle3d — 3D house', text: 'A house.', updatedAt: '2026-11-03T11:00:00Z' },
  ]);
  const checked = await f('/settings/import/o3/check', form({}));
  assert.equal(checked.status, 303);
  assert.equal(checked.headers.get('location'), '/pages/moved/o1');
  // Ignored folders: the unignore form's old address still lists the folder again.
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'old-repo', git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] }]);
  await f('/folders/ignore', form({ name: 'old-repo' }));
  const undo = await f('/settings/folders/unignore', form({ name: 'old-repo' }));
  assert.equal(undo.status, 303);
  assert.equal(undo.headers.get('location'), '/#notyet');
  assert.match(await (await f('/')).text(), /Not in the brain yet<span class="n">1<\/span>[\s\S]*old-repo/);
});

test('every owner page renders in the new shell: the brain header, and no old navigation', async (t) => {
  const { app, f } = await start(t);
  const m = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog uses SwiftUI', project: 'wildlog' }, { type: 'owner' }) as any).memory;
  const pg = await app.deps.pages.create({ title: 'How this brain is organised', area: 'start', body: 'Facts and pages.' }, 'owner');
  const dsc = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which course?', question: 'Which one?', ask: ['Grok'] });
  for (const path of ['/', '/?project=wildlog', '/graph', '/settings', '/facts/tidy', '/growth', '/facts', '/memories/new', `/memories/${m.id}`, '/search?q=wildlog', '/discussions', `/discussions/${dsc.id}`, '/review', '/review/now', '/review/all', '/pages', `/pages/${pg.id}`]) {
    const res = await f(path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.match(body, /<nav class="tabs" aria-label="Main"><a href="\/"[^>]*>Projects<\/a><a href="\/pages"[^>]*>Pages<\/a><a href="\/review"[^>]*>Week<\/a><a href="\/graph"[^>]*>Graph<\/a><\/nav>/, path);
    assert.match(body, /<a class="settings-link" href="\/settings"/, path);
    assert.doesNotMatch(body, /href="\/overview"|href="\/left|href="\/clients"|href="\/activity"|href="\/tidy"|href="\/memories"[ >]/, path);
    // The old header's More menu; the review's own "N more" folds live in the page, not the header.
    assert.doesNotMatch(body.slice(0, body.indexOf('</header>')), /class="more(?: [^"]*)?"|<details class="more/, path);
  }
});
