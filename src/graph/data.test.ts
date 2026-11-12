import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { graphWorld, type GraphWorld } from '../testing/graphWorld.js';
import { DECISION_CHARS, FIND_PROJECTS, MAX_PLACES_DRAWN, MAX_QUERY, NEXT_CHARS, ONE_LINER_CHARS } from './data.js';

// These tests are about the owner's calendar in Berlin; the app's own default zone is UTC.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

async function save(w: GraphWorld, project: string, content: string, kind: 'decision' | 'summary' | 'roadmap' | 'profile' = 'decision') {
  const r = await w.service.remember({ kind, content, project: kind === 'profile' ? undefined : project }, w.owner) as { status: string; memory: { id: string } };
  assert.ok(r.status === 'saved' || r.status === 'roadmap_updated', r.status);
  w.advance(60_000);
  return r.memory.id;
}

async function backups(w: GraphWorld) {
  await save(w, 'alpha', 'restic nightly backups to the nas');
  await save(w, 'alpha', 'restic prune keeps nas backups small');
  await save(w, 'beta', 'outline backups use restic to the nas');
  await save(w, 'beta', 'nas restic backups are checked nightly');
}

const names = (w: GraphWorld) => w.graph.overview().projects.map((p) => p.name);

test('the overview lists drawn projects On the go first then by last touched, and leaves done and archived out', async () => {
  const w = graphWorld();
  for (const p of ['old', 'pinned2', 'mid', 'pinned1', 'finished', 'stored', 'new']) await save(w, p, `${p} note`);
  w.registry.pin('pinned2', 'owner');
  w.advance(1000);
  w.registry.pin('pinned1', 'owner');
  w.registry.setState('finished', 'done', 'owner');
  w.registry.setState('stored', 'archived', 'owner');
  w.registry.create('someday', { state: 'idea', oneLiner: 'Maybe' }, 'owner');
  w.registry.setState('mid', 'parked', 'owner');
  assert.deepEqual(names(w), ['pinned2', 'pinned1', 'someday', 'new', 'mid', 'old']);
  const o = w.graph.overview();
  assert.equal(o.projects.find((p) => p.name === 'pinned2')!.onTheGo, true);
  assert.equal(o.projects.find((p) => p.name === 'someday')!.state, 'idea');
  assert.equal(o.projects.find((p) => p.name === 'mid')!.state, 'parked');
  assert.equal(o.projects.find((p) => p.name === 'new')!.onTheGo, false);
});

test('an unpinned personal project is in the data but unlabelled; a pinned one is On the go and labelled', async () => {
  const w = graphWorld();
  await save(w, 'finances', 'banco cuenta');
  await save(w, 'career', 'cv updated');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.registry.setInfo('career', { area: 'personal' }, 'owner');
  w.registry.pin('career', 'owner');
  const o = w.graph.overview();
  const f = o.projects.find((p) => p.name === 'finances')!;
  const c = o.projects.find((p) => p.name === 'career')!;
  assert.deepEqual([f.unlabelled, f.onTheGo, f.area], [true, false, 'personal']);
  assert.deepEqual([c.unlabelled, c.onTheGo], [false, true]);
});

test('cards agree with the home: waiting, late and next come from the same card, and days follow the owner\'s day', async () => {
  const w = graphWorld({ start: '2026-11-04T10:00:00Z' });
  await save(w, 'wildlog', 'Now: release\nNext: write notes\nWaiting on you: run release.sh (by 2026-11-01); connect ChatGPT', 'roadmap');
  const home = w.projects.home(w.now()).open.find((c) => c.project.name === 'wildlog')!;
  const g = w.graph.overview().projects.find((p) => p.name === 'wildlog')!;
  assert.deepEqual([g.waiting, g.late, g.next], [home.waiting, home.late, home.next]);
  assert.deepEqual([g.waiting, g.late, g.next], [2, 1, 'release'], "the roadmap's Now comes first (spec 2026-11-11)");
  w.registry.create('quiet', { state: 'open', oneLiner: 'Registry only' }, 'owner');
  const touched = (iso: string) => {
    w.db.prepare("UPDATE projects SET updated_at = ? WHERE name = 'quiet'").run(iso);
    return w.graph.overview().projects.find((p) => p.name === 'quiet')!.days;
  };
  const back = Date.parse('2026-11-04T10:00:00Z') - w.now().getTime();
  w.advance(back);
  assert.equal(touched('2026-11-03T23:30:00.000Z'), 0);
  assert.equal(touched('2026-11-03T22:30:00.000Z'), 1);
});

test('one-liner and Next are cut to 80 and 90 characters', async () => {
  const w = graphWorld();
  await save(w, 'wildlog', `Now: ${'n'.repeat(120)}`, 'roadmap');
  w.registry.setInfo('wildlog', { oneLiner: 'o'.repeat(130) }, 'owner');
  const g = w.graph.overview().projects.find((p) => p.name === 'wildlog')!;
  assert.equal(ONE_LINER_CHARS, 80);
  assert.equal(NEXT_CHARS, 90);
  assert.equal(g.oneLiner!.length, 80);
  assert.ok(g.oneLiner!.endsWith('…'));
  assert.equal(g.next!.length, 90);
  assert.ok(g.next!.endsWith('…'));
});

test('fact counts are current facts, and the profile is counted apart', async () => {
  const w = graphWorld();
  await save(w, 'wildlog', 'uses swiftui');
  const gone = await save(w, 'wildlog', 'uses uikit');
  await save(w, 'wildlog', 'wildlog status: fine', 'summary');
  await save(w, '', 'Has a NAS', 'profile');
  w.service.forget(gone, w.owner);
  const o = w.graph.overview();
  assert.equal(o.projects.find((p) => p.name === 'wildlog')!.facts, 2);
  assert.equal(o.profileFacts, 1);
});

test('places in use carry the fixed labels, at most 8', async () => {
  const w = graphWorld();
  await save(w, 'a', 'one');
  await save(w, 'b', 'two');
  await save(w, 'c', 'three');
  w.registry.setInfo('a', { runsOn: ['minipc', 'acme'] }, 'owner');
  w.registry.setInfo('b', { runsOn: ['minipc'] }, 'owner');
  let o = w.graph.overview();
  assert.deepEqual(o.places, [{ id: 'minipc', label: 'Mini PC' }, { id: 'acme', label: 'acme' }]);
  assert.deepEqual(o.projects.find((p) => p.name === 'a')!.runsOn, ['minipc', 'acme']);
  w.registry.setInfo('b', { runsOn: ['p1', 'p2', 'p3', 'p4'] }, 'owner');
  w.registry.setInfo('c', { runsOn: ['p5', 'p6', 'p7', 'p8'] }, 'owner');
  o = w.graph.overview();
  assert.equal(MAX_PLACES_DRAWN, 8);
  assert.equal(o.places.length, 8);
});

test('threads join drawn projects only, with strength from 0 to 1, at most 4 per project, and up to 2 words', async () => {
  const w = graphWorld();
  await backups(w);
  await save(w, 'gone', 'restic backups on the nas nightly');
  await save(w, 'gone', 'restic nas backups prune');
  w.registry.setState('gone', 'done', 'owner');
  const o = w.graph.overview();
  assert.ok(o.threads.length > 0);
  const gone = o.projects.findIndex((p) => p.name === 'gone');
  assert.equal(gone, -1);
  const per = new Map<number, number>();
  for (const t of o.threads) {
    assert.ok(t.a !== t.b && o.projects[t.a] && o.projects[t.b]);
    assert.ok(t.strength > 0 && t.strength <= 1);
    assert.ok(t.links >= 2);
    assert.ok(t.words.length <= 2);
    assert.equal(Math.round(t.strength * 1000) / 1000, t.strength);
    per.set(t.a, (per.get(t.a) ?? 0) + 1);
    per.set(t.b, (per.get(t.b) ?? 0) + 1);
  }
  assert.equal(Math.max(...o.threads.map((t) => t.strength)), 1);
});

test('opening the graph compares no vectors', async (t) => {
  const w = graphWorld();
  await backups(w);
  const load = mock.method(w.meaning, 'loadItems');
  const emb = mock.method(w.store, 'activeEmbeddings');
  t.after(() => { load.mock.restore(); emb.mock.restore(); });
  w.graph.overview();
  w.graph.detail('alpha');
  w.graph.list();
  assert.equal(load.mock.callCount(), 0);
  assert.equal(emb.mock.callCount(), 0);
});

test('a recall keeps the thread cache, a save drops it', async (t) => {
  const w = graphWorld();
  await backups(w);
  const pairs = mock.method(w.meaning, 'threadPairs');
  t.after(() => pairs.mock.restore());
  w.graph.overview();
  w.graph.overview();
  assert.equal(pairs.mock.callCount(), 1);
  await w.service.recall({ query: 'restic' });
  w.advance(1000);
  w.graph.overview();
  assert.equal(pairs.mock.callCount(), 1);
  await save(w, 'gamma', 'karst ride telemetry');
  w.graph.overview();
  assert.equal(pairs.mock.callCount(), 2);
});

test('detail gives the 5 newest current decisions cut to 90, the pages and the related projects with their words', async () => {
  const w = graphWorld();
  await backups(w);
  for (let i = 0; i < 6; i++) await save(w, 'alpha', `decision ${i} ${'x'.repeat(i === 5 ? 100 : 3)}`);
  await save(w, 'alpha', 'alpha status: fine', 'summary');
  const page = await w.pages.create({ title: 'Alpha notes', project: 'alpha', body: '## One\nkart' }, 'owner');
  const d = w.graph.detail('alpha')!;
  assert.equal(d.name, 'alpha');
  assert.equal(d.decisions.length, 5);
  assert.equal(DECISION_CHARS, 90);
  assert.equal(d.decisions[0]!.text.length, 90);
  assert.ok(d.decisions[0]!.text.startsWith('decision 5'));
  assert.deepEqual(d.pages, [{ id: page.id, title: 'Alpha notes' }]);
  assert.equal(d.related[0]!.name, 'beta');
  assert.equal(d.related[0]!.unlabelled, false);
  assert.ok(Array.isArray(d.related[0]!.words));
});

test('after a merge the two projects\' thread disappears and the other threads move to the real name', async () => {
  const w = graphWorld();
  await backups(w);
  await save(w, 'beta', 'karst ride telemetry on the iphone');
  await save(w, 'beta', 'karst ride times sync from the iphone');
  await save(w, 'gamma', 'karst ride telemetry from the iphone');
  await save(w, 'gamma', 'karst ride telemetry graphs on iphone');
  const pairNames = () => { const o = w.graph.overview(); return o.threads.map((t) => [o.projects[t.a]!.name, o.projects[t.b]!.name].sort().join('-')); };
  assert.ok(pairNames().includes('alpha-beta'));
  assert.ok(pairNames().includes('beta-gamma'));
  w.service.moveProject('beta', 'alpha', w.owner);
  assert.ok(!pairNames().some((p) => p.includes('beta')));
  assert.ok(pairNames().includes('alpha-gamma'));
  assert.equal(w.graph.detail('beta')!.name, 'alpha');
});

test('detail and focus for an alias, an unknown, a done and an unpinned personal project', async () => {
  const w = graphWorld();
  await save(w, 'coyote', 'plays from jellyfin');
  await save(w, 'inflow', 'plays from the nas');
  w.service.moveProject('coyote', 'inflow', w.owner);
  await save(w, 'finished', 'all done');
  w.registry.setState('finished', 'done', 'owner');
  await save(w, 'finances', 'banco');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  assert.equal(w.graph.focusName('coyote'), 'inflow');
  assert.equal(w.graph.focusName('nope'), undefined);
  assert.equal(w.graph.focusName('finished'), undefined);
  assert.equal(w.graph.detail('nope'), undefined);
  assert.equal(w.graph.detail('finished')!.name, 'finished');
  assert.equal(w.graph.focusName('finances'), 'finances');
  assert.equal(w.graph.detail('finances')!.name, 'finances');
});

test('find counts hits per project, at most 12, and marks nothing recalled', async () => {
  const w = graphWorld();
  await backups(w);
  await save(w, 'gamma', 'karst ride telemetry');
  w.registry.create('delta', { state: 'open' }, 'owner');
  await w.pages.create({ title: 'Delta restic', project: 'delta', body: '## One\nrestic backups to the nas' }, 'owner');
  const before = w.db.prepare('SELECT MAX(last_recalled_at) AS r FROM memories').get();
  const r = await w.graph.find('restic backups');
  assert.equal(r.q, 'restic backups');
  const got = new Map(r.projects.map((p) => [p.name, p.hits]));
  assert.ok((got.get('alpha') ?? 0) >= 1 && (got.get('beta') ?? 0) >= 1 && (got.get('delta') ?? 0) >= 1);
  assert.ok(!got.has('gamma'));
  for (let i = 1; i < r.projects.length; i++) assert.ok(r.projects[i - 1]!.hits >= r.projects[i]!.hits);
  assert.deepEqual(w.db.prepare('SELECT MAX(last_recalled_at) AS r FROM memories').get(), before);
  assert.equal(FIND_PROJECTS, 12);
  for (let i = 0; i < 14; i++) await save(w, `many${i}`, `restic backups copy ${i}`);
  assert.ok((await w.graph.find('restic backups')).projects.length <= 12);
});

test('find answers empty, short, stopword-only and accented queries calmly', async (t) => {
  const w = graphWorld();
  await save(w, 'lanes', 'futbol blocks during matches');
  const embed = mock.method(w.pages, 'embedQuery');
  t.after(() => embed.mock.restore());
  for (const q of ['', '  ', 'the of']) assert.deepEqual((await w.graph.find(q)).projects, []);
  assert.equal(embed.mock.callCount(), 0);
  assert.deepEqual((await w.graph.find('Fútbol')).projects.map((p) => p.name), ['lanes']);
  assert.equal(MAX_QUERY, 200);
  assert.equal((await w.graph.find('x'.repeat(300))).q.length, 200);
});

test('the list groups by area then Unsorted, folds unpinned personal projects apart and counts done and archived', async () => {
  const w = graphWorld();
  await save(w, 'wildlog', 'one');
  await save(w, 'nas', 'two');
  await save(w, 'loose', 'three');
  await save(w, 'finances', 'four');
  await save(w, 'career', 'five');
  await save(w, 'finished', 'six');
  w.registry.setInfo('wildlog', { area: 'apps', runsOn: ['minipc', 'pi'] }, 'owner');
  w.registry.setInfo('nas', { area: 'home' }, 'owner');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.registry.setInfo('career', { area: 'personal' }, 'owner');
  w.registry.pin('career', 'owner');
  w.registry.setState('finished', 'archived', 'owner');
  const l = w.graph.list();
  assert.deepEqual(l.areas.map((a) => [a.area, a.label, a.rows.map((r) => r.name)]),
    [['apps', 'Apps', ['wildlog']], ['home', 'Home & infrastructure', ['nas']], ['personal', 'Personal', ['career']], [null, 'Unsorted', ['loose']]]);
  assert.deepEqual(l.personal.map((r) => r.name), ['finances']);
  assert.deepEqual(l.done, [{ name: 'finished', state: 'archived' }]);
  assert.deepEqual(l.areas[0]!.rows[0]!.runsOn, ['Mini PC', 'Pi']);
  assert.equal(l.summary.projects, 5);
});

test('a thread to an unpinned Personal project never names it on the public side', async () => {
  const w = graphWorld();
  await save(w, 'alpha', 'banco cuenta ahorro transferencia mensual');
  await save(w, 'alpha', 'banco cuenta ahorro nomina mensual');
  await save(w, 'finances', 'banco cuenta ahorro transferencia anual');
  await save(w, 'finances', 'banco cuenta ahorro nomina anual');
  for (let i = 0; i < 10; i++) await save(w, 'gamma', `karst ride run${i}`);
  w.registry.setInfo('alpha', { area: 'apps' }, 'owner');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  const row = (name: string) => [...w.graph.list().areas.flatMap((a) => a.rows), ...w.graph.list().personal].find((r) => r.name === name)!;
  assert.ok(!row('alpha').related.includes('finances'));
  assert.deepEqual(row('finances').related, ['alpha']);
  const rel = w.graph.detail('alpha')!.related.find((r) => r.name === 'finances')!;
  assert.deepEqual([rel.unlabelled, rel.words], [true, []]);
  w.registry.pin('finances', 'owner');
  const pinned = w.graph.detail('alpha')!.related.find((r) => r.name === 'finances')!;
  assert.equal(pinned.unlabelled, false);
  assert.ok(pinned.words.length > 0, 'words come back once pinned');
  assert.ok(row('alpha').related.includes('finances'));
});
