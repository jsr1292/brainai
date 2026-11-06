import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { MemoryStore } from './store.js';

const setup = () => { const db = openDb(':memory:'); let t = Date.parse('2026-10-17T10:00:00Z');
  const store = new MemoryStore(db, () => new Date(t)); return { db, store, tick: (ms: number) => { t += ms; } }; };
const vec = (n: number) => { const v = new Float32Array(384); v[n] = 1; return v; };

test('countCurrent leaves out deleted and replaced facts', () => {
  const { store } = setup();
  const a = store.insert({ kind: 'decision', content: 'Use SQLite', project: 'demo', tags: [], embedding: vec(0), by: 'owner' });
  const b = store.insert({ kind: 'decision', content: 'Use Postgres', project: 'demo', tags: [], embedding: vec(1), by: 'owner' });
  store.insert({ kind: 'profile', content: 'Lives in Berlin', project: null, tags: [], embedding: vec(2), by: 'owner' });
  store.supersessions.add(a.id, b.id, 'owner');
  assert.equal(store.countCurrent(), 2);
  assert.equal(store.countCurrent({ kind: 'decision', project: 'demo' }), 1);
  store.softDelete(b.id, 'owner');
  assert.equal(store.countCurrent(), 1);
});

test('update keeps the previous version in history and restore brings it back', () => {
  const { store } = setup();
  const m = store.insert({ kind: 'decision', content: 'Use OAuth', project: 'cairn', tags: [], embedding: vec(0), by: 'Claude Code' });
  store.update(m.id, { content: 'Use OAuth only', project: 'cairn', tags: ['auth'], embedding: vec(1), by: 'Claude' });
  const [h] = store.history(m.id);
  assert.equal(h.action, 'update'); assert.equal(h.content, 'Use OAuth'); assert.equal(h.changedBy, 'Claude');
  const r = store.restore(h.id, 'owner', vec(0));
  assert.equal(r.content, 'Use OAuth'); assert.equal(r.updatedBy, 'owner');
});

test('softDelete hides from list, FTS, embeddings and projects; restore undeletes', () => {
  const { store } = setup();
  const m = store.insert({ kind: 'decision', content: 'nightly backups', project: 'casa', tags: [], embedding: vec(2), by: 'x' });
  store.softDelete(m.id, 'owner');
  assert.equal(store.list({}).length, 0);
  assert.deepEqual(store.ftsSearch('"nightly"', {}, 10), []);
  assert.equal(store.activeEmbeddings({}).length, 0);
  assert.deepEqual(store.listProjects(), []);
  store.restore(store.history(m.id)[0].id, 'owner', null);
  assert.deepEqual(store.ftsSearch('"nightly"', {}, 10), [m.id]);
});

test('suggestions round-trip', () => {
  const { store } = setup();
  const s = store.addSuggestion({ action: 'add', memoryId: null, content: 'Has a NAS', tags: [], suggestedBy: 'Grok' });
  assert.equal(store.listSuggestions('pending').length, 1);
  store.resolveSuggestion(s.id, 'rejected');
  assert.equal(store.listSuggestions('pending').length, 0);
  assert.equal(store.getSuggestion(s.id)!.status, 'rejected');
});

test('touch marks the memory as reviewed without changing content, dates or history', () => {
  const { store, tick } = setup();
  const m = store.insert({ kind: 'decision', content: 'Use OAuth', project: null, tags: [], embedding: vec(0), by: 'Claude' });
  tick(60_000);
  store.touch(m.id);
  const t = store.get(m.id)!;
  assert.equal(t.content, 'Use OAuth');
  assert.equal(t.updatedAt, m.updatedAt);
  assert.equal(t.updatedBy, 'Claude');
  assert.ok(t.lastRecalledAt! > m.updatedAt);
  assert.equal(store.history(m.id).length, 0);
});

test('dismissPair is order-independent and idempotent', () => {
  const { store } = setup();
  assert.equal(store.isDismissed('b', 'a'), false);
  store.dismissPair('b', 'a');
  store.dismissPair('a', 'b');
  assert.equal(store.isDismissed('a', 'b'), true);
  assert.equal(store.isDismissed('b', 'a'), true);
  assert.equal(store.isDismissed('a', 'c'), false);
});

test('recentActivity lists creations and history changes newest first, limited', () => {
  const { store, tick } = setup();
  const m = store.insert({ kind: 'decision', content: 'One', project: null, tags: [], embedding: vec(0), by: 'Claude' });
  tick(1000);
  store.update(m.id, { content: 'Two', project: null, tags: [], embedding: vec(1), by: 'owner' });
  tick(1000);
  store.softDelete(m.id, 'owner');
  const all = store.recentActivity(100);
  assert.deepEqual(all.map((a) => [a.action, a.by]), [['deleted', 'owner'], ['updated', 'owner'], ['created', 'Claude']]);
  assert.equal(all[0]!.memoryId, m.id);
  assert.equal(all[0]!.content, 'Two');
  assert.equal(store.recentActivity(2).length, 2);
});

test('the memory version changes with every change the tidy page and the map depend on, and only then', () => {
  const { store, tick } = setup();
  const seen = new Set<string>();
  const changed = (what: string) => { tick(1000); const v = store.memoryVersion(); assert.ok(!seen.has(v), what); seen.add(v); };
  changed('start');
  const a = store.insert({ kind: 'decision', content: 'Use OAuth', project: 'p', tags: [], embedding: vec(0), by: 'x' });
  changed('insert');
  const b = store.insert({ kind: 'decision', content: 'Use SQLite', project: 'p', tags: [], embedding: vec(1), by: 'x' });
  changed('second insert');
  store.update(a.id, { content: 'Use OAuth only', project: 'p', tags: [], embedding: vec(0), by: 'x' });
  changed('update');
  store.relabel(a.id, { project: 'q', tags: [], by: 'x' });
  changed('relabel');
  store.dismissPair(a.id, b.id);
  changed('dismiss pair');
  store.dismissProjects('p', 'q');
  changed('dismiss projects');
  store.softDelete(b.id, 'x');
  changed('delete');
  const before = store.memoryVersion();
  store.logToolCall('Claude', 'recall');
  assert.equal(store.memoryVersion(), before, 'a tool call alone changes nothing');
});

test('recalls and "Still true" change only the recall version, so the pair checks and the map stay cached', () => {
  const { store, tick } = setup();
  const a = store.insert({ kind: 'decision', content: 'Use OAuth', project: 'p', tags: [], embedding: vec(0), by: 'x' });
  const memory = store.memoryVersion();
  let recalls = store.recallVersion();
  tick(1000);
  store.markRecalled([a.id]);
  assert.equal(store.memoryVersion(), memory, 'a recall leaves the memory version alone');
  assert.notEqual(store.recallVersion(), recalls, 'a recall changes the recall version');
  recalls = store.recallVersion();
  tick(1000);
  store.touch(a.id);
  assert.equal(store.memoryVersion(), memory, '"Still true" leaves the memory version alone');
  assert.notEqual(store.recallVersion(), recalls, '"Still true" changes the recall version');
});

test('a memory saved under a new project creates its registry row in state open', () => {
  const { db, store, tick } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'newproj', tags: [], embedding: vec(0), by: 'Claude' });
  assert.equal(store.projectState('newproj'), 'open');
  const first = (db.prepare("SELECT created_at FROM projects WHERE name = 'newproj'").get() as any).created_at;
  tick(60_000);
  store.insert({ kind: 'decision', content: 'B', project: 'newproj', tags: [], embedding: vec(1), by: 'Grok' });
  assert.equal((db.prepare("SELECT created_at FROM projects WHERE name = 'newproj'").get() as any).created_at, first);
});

test('a profile memory creates no registry row, even with a project name', () => {
  const { db, store } = setup();
  store.insert({ kind: 'profile', content: 'Lives in Berlin', project: null, tags: [], embedding: vec(0), by: 'owner' });
  store.insert({ kind: 'profile', content: 'Likes karting', project: 'someproj', tags: [], embedding: vec(1), by: 'owner' });
  assert.equal(store.projectState('someproj'), undefined);
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as any).n, 0);
});

test('moving or relabelling a memory into a new project creates its row', () => {
  const { store } = setup();
  const m = store.insert({ kind: 'decision', content: 'A', project: 'one', tags: [], embedding: vec(0), by: 'Claude' });
  store.relabel(m.id, { project: 'two', tags: [], by: 'owner' });
  assert.equal(store.projectState('two'), 'open');
  store.moveProject('two', 'three', 'owner');
  assert.equal(store.projectState('three'), 'open');
});

test('mergeProjectRow renames when the target has no row, deletes the source when it does', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  db.prepare("UPDATE projects SET state = 'parked' WHERE name = 'coyote'").run();
  store.mergeProjectRow('coyote', 'inflow');
  assert.equal(store.projectState('coyote'), undefined);
  assert.equal(store.projectState('inflow'), 'parked');
  store.insert({ kind: 'decision', content: 'B', project: 'dossier-app', tags: [], embedding: vec(1), by: 'Claude' });
  store.mergeProjectRow('dossier-app', 'inflow');
  assert.equal(store.projectState('dossier-app'), undefined);
  assert.equal(store.projectState('inflow'), 'parked');
});

test('a memory restored under a name that is now an alias files its row under the real project', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  const m = store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  store.softDelete(m.id, 'owner');
  store.addAlias('coyote', 'inflow', 'owner');
  db.prepare("DELETE FROM projects WHERE name = 'coyote'").run();
  store.restore(store.history(m.id)[0]!.id, 'owner', null);
  assert.equal(store.projectState('coyote'), undefined);
});

test('a memory restored under a name that is now an alias goes back into the real project, undeleted or an older version', () => {
  const { store } = setup();
  store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  const del = store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  const ed = store.insert({ kind: 'decision', content: 'C', project: 'coyote', tags: [], embedding: vec(2), by: 'Claude' });
  store.softDelete(del.id, 'owner');
  store.update(ed.id, { content: 'C2', project: 'coyote', tags: [], embedding: vec(3), by: 'owner' });
  store.moveProject('coyote', 'inflow', 'owner');
  store.addAlias('coyote', 'inflow', 'owner');
  assert.equal(store.restore(store.history(del.id).find((h) => h.action === 'delete')!.id, 'owner', null).project, 'inflow');
  const before = store.history(ed.id).find((h) => h.content === 'C')!;
  assert.equal(before.project, 'coyote');
  assert.equal(store.restore(before.id, 'owner', vec(2)).project, 'inflow');
  assert.deepEqual(store.listProjects(), [{ project: 'inflow', count: 3 }]);
  assert.deepEqual(store.ftsSearch('"A"', { project: 'inflow' }, 10), [del.id]);
});

test('mergeProjectRow keeps the source\'s description, area, folder and URL where the target has none', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  db.prepare("UPDATE projects SET one_liner = 'Video player', area = 'apps', folder = 'Coyote', url = 'https://coyote.example' WHERE name = 'coyote'").run();
  db.prepare("UPDATE projects SET area = 'home' WHERE name = 'inflow'").run();
  store.mergeProjectRow('coyote', 'inflow');
  assert.deepEqual({ ...(db.prepare("SELECT one_liner, area, folder, url FROM projects WHERE name = 'inflow'").get() as any) },
    { one_liner: 'Video player', area: 'home', folder: 'Coyote', url: 'https://coyote.example' });
});

test('update() moving a memory to a new project creates its row', () => {
  const { store } = setup();
  const m = store.insert({ kind: 'decision', content: 'A', project: 'one', tags: [], embedding: vec(0), by: 'Claude' });
  store.update(m.id, { content: 'A2', project: 'brand-new', tags: [], embedding: vec(1), by: 'Claude' });
  assert.equal(store.projectState('brand-new'), 'open');
});

test('removing an alias gives the old name its own row again when memories still use it', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  store.addAlias('coyote', 'inflow', 'owner');
  const m = store.insert({ kind: 'decision', content: 'A', project: 'inflow', tags: [], embedding: vec(0), by: 'Claude' });
  db.prepare("UPDATE memories SET project = 'coyote' WHERE id = ?").run(m.id);
  store.removeAlias('coyote');
  assert.equal(store.projectState('coyote'), 'open');
});

test('merging into a bare row made automatically keeps the merged project\'s state, pin and snooze', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  const b = store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  store.softDelete(b.id, 'Claude');
  db.prepare("UPDATE projects SET state = 'parked', pinned_at = NULL, snoozed_until = '2026-12-01T00:00:00.000Z', created_by = 'owner' WHERE name = 'coyote'").run();
  store.mergeProjectRow('coyote', 'inflow');
  assert.deepEqual({ ...(db.prepare("SELECT state, snoozed_until FROM projects WHERE name = 'inflow'").get() as any) }, { state: 'parked', snoozed_until: '2026-12-01T00:00:00.000Z' });
  // An automatic target that holds memories of its own is a real project: it keeps its state.
  store.insert({ kind: 'decision', content: 'E', project: 'stray', tags: [], embedding: vec(4), by: 'Claude' });
  store.insert({ kind: 'decision', content: 'F', project: 'real', tags: [], embedding: vec(5), by: 'Claude' });
  db.prepare("UPDATE projects SET state = 'archived', updated_by = 'owner' WHERE name = 'stray'").run();
  store.mergeProjectRow('stray', 'real');
  assert.equal(store.projectState('real'), 'open');
  // A target the owner already set keeps its own state.
  store.insert({ kind: 'decision', content: 'C', project: 'dossier-app', tags: [], embedding: vec(2), by: 'Claude' });
  store.insert({ kind: 'decision', content: 'D', project: 'dossiers', tags: [], embedding: vec(3), by: 'Claude' });
  db.prepare("UPDATE projects SET state = 'done' WHERE name = 'dossier-app'").run();
  db.prepare("UPDATE projects SET state = 'open', updated_by = 'owner', one_liner = 'DossierApp' WHERE name = 'dossiers'").run();
  store.mergeProjectRow('dossier-app', 'dossiers');
  assert.equal(store.projectState('dossiers'), 'open');
});

test('update refuses a deleted memory and leaves it out of search', () => {
  const { store } = setup();
  const m = store.insert({ kind: 'decision', content: 'app uses sqlite', project: 'wildlog', tags: [], embedding: vec(0), by: 'x' });
  store.softDelete(m.id, 'owner');
  assert.throws(() => store.update(m.id, { content: 'app uses postgres', project: 'wildlog', tags: [], embedding: vec(1), by: 'Claude' }), /deleted/);
  assert.equal(store.get(m.id)!.content, 'app uses sqlite');
  assert.deepEqual(store.ftsSearch('"postgres"', {}, 10), []);
});

test('merging a project keeps the target\'s places, or takes the merged one\'s when it has none', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'coyote', tags: [], embedding: vec(0), by: 'Claude' });
  store.insert({ kind: 'decision', content: 'B', project: 'inflow', tags: [], embedding: vec(1), by: 'Claude' });
  store.insert({ kind: 'decision', content: 'C', project: 'kodi', tags: [], embedding: vec(2), by: 'Claude' });
  db.prepare(`UPDATE projects SET runs_on = '["nas"]' WHERE name = 'coyote'`).run();
  db.prepare(`UPDATE projects SET runs_on = '["pi"]' WHERE name = 'kodi'`).run();
  store.mergeProjectRow('coyote', 'inflow');
  assert.equal((db.prepare("SELECT runs_on FROM projects WHERE name = 'inflow'").get() as any).runs_on, '["nas"]');
  store.mergeProjectRow('kodi', 'inflow');
  assert.equal((db.prepare("SELECT runs_on FROM projects WHERE name = 'inflow'").get() as any).runs_on, '["nas"]');
});

test('a new alias with no registry row merges into a project with no places', () => {
  const { db, store } = setup();
  store.insert({ kind: 'decision', content: 'A', project: 'wildlog', tags: [], embedding: vec(0), by: 'Claude' });
  assert.equal(db.prepare("SELECT 1 FROM projects WHERE name = 'fresh-name'").get(), undefined);
  store.addAlias('fresh-name', 'wildlog', 'owner');
  assert.equal((db.prepare("SELECT runs_on FROM projects WHERE name = 'wildlog'").get() as any).runs_on, '[]');
});

test('a replaced fact is missing from list, activeEmbeddings, ftsSearch and listProjects counts, and present with include', () => {
  const { store } = setup();
  const a = store.insert({ kind: 'decision', content: 'restic backs up the cellar photos', project: 'wildlog', tags: [], embedding: vec(3), by: 'owner' });
  const b = store.insert({ kind: 'decision', content: 'Time Machine backs up the cellar photos', project: 'wildlog', tags: [], embedding: vec(4), by: 'owner' });
  store.supersessions.add(a.id, b.id, 'owner');
  const ids = (ms: { id: string }[]) => ms.map((m) => m.id).sort();
  assert.deepEqual(ids(store.list({})), [b.id]);
  assert.deepEqual(ids(store.list({ project: 'wildlog' })), [b.id]);
  assert.deepEqual(store.activeEmbeddings({}).map((e) => [e.id, e.replaced]), [[b.id, false]]);
  assert.deepEqual(store.ftsSearch('"restic"', {}, 10), []);
  assert.deepEqual(ids(store.list({ replaced: 'include' })), [a.id, b.id].sort());
  assert.deepEqual(store.activeEmbeddings({ replaced: 'include' }).map((e) => [e.id, e.replaced]).sort(), [[a.id, true], [b.id, false]].sort());
  assert.deepEqual(store.ftsSearch('"restic"', { replaced: 'include' }, 10), [a.id]);
  assert.deepEqual(ids(store.list({ replaced: 'only' })), [a.id]);
  assert.deepEqual(store.activeEmbeddings({ replaced: 'only' }).map((e) => [e.id, e.replaced]), [[a.id, true]]);
  assert.deepEqual(store.ftsSearch('"photos"', { replaced: 'only' }, 10), [a.id]);
  assert.deepEqual(store.listProjects(), [{ project: 'wildlog', count: 1 }]);
  assert.deepEqual(store.listProjects({ replaced: 'include' }), [{ project: 'wildlog', count: 2 }]);
  assert.equal(store.get(a.id)?.content, 'restic backs up the cellar photos');
});

test('undoing brings it back to every reader', () => {
  const { store } = setup();
  const a = store.insert({ kind: 'decision', content: 'restic backs up the cellar photos', project: 'wildlog', tags: [], embedding: vec(3), by: 'owner' });
  const b = store.insert({ kind: 'decision', content: 'Time Machine backs up the cellar photos', project: 'wildlog', tags: [], embedding: vec(4), by: 'owner' });
  const row = store.supersessions.add(a.id, b.id, 'owner');
  store.supersessions.undo(row.id, 'owner');
  assert.equal(store.list({}).length, 2);
  assert.equal(store.activeEmbeddings({}).length, 2);
  assert.deepEqual(store.ftsSearch('"restic"', {}, 10), [a.id]);
  assert.deepEqual(store.listProjects(), [{ project: 'wildlog', count: 2 }]);
});

test('a project merge moves replaced facts too, and removing an alias still sees them', () => {
  const { db, store } = setup();
  const a1 = store.insert({ kind: 'decision', content: 'Coyote keeps the posters and subtitles', project: 'coyote', tags: [], embedding: vec(5), by: 'owner' });
  const a2 = store.insert({ kind: 'decision', content: 'Coyote keeps the posters', project: 'coyote', tags: [], embedding: vec(6), by: 'owner' });
  store.supersessions.add(a2.id, a1.id, 'owner');
  assert.equal(store.moveProject('coyote', 'inflow', 'owner'), 2);
  assert.equal(store.get(a2.id)?.project, 'inflow');
  const o1 = store.insert({ kind: 'decision', content: 'Old name keeps the artwork', project: 'old', tags: [], embedding: vec(7), by: 'owner' });
  const o2 = store.insert({ kind: 'decision', content: 'Old name keeps the artwork and logos', project: 'inflow', tags: [], embedding: vec(8), by: 'owner' });
  store.supersessions.add(o1.id, o2.id, 'owner');
  store.addAlias('old', 'inflow', 'owner');
  // The alias holds one replaced fact still filed under `old` (aliases are added without moving, as an old import did).
  db.prepare('UPDATE memories SET project = ? WHERE id = ?').run('old', o1.id);
  db.prepare("DELETE FROM projects WHERE name = 'old'").run();
  assert.equal(store.removeAlias('old'), true);
  assert.equal(store.projectState('old'), 'open');
});

test('memoryVersion changes when a fact is replaced and when it is brought back', () => {
  const { store } = setup();
  const a = store.insert({ kind: 'decision', content: 'one', project: 'wildlog', tags: [], embedding: vec(3), by: 'owner' });
  const b = store.insert({ kind: 'decision', content: 'two', project: 'wildlog', tags: [], embedding: vec(4), by: 'owner' });
  const v0 = store.memoryVersion();
  const row = store.supersessions.add(a.id, b.id, 'owner');
  const v1 = store.memoryVersion();
  assert.notEqual(v1, v0);
  store.supersessions.undo(row.id, 'owner');
  assert.notEqual(store.memoryVersion(), v1);
});

test('activity lists replaced and brought back, with the old fact\'s text', () => {
  const { store, tick } = setup();
  const a = store.insert({ kind: 'decision', content: 'Use the Brother printer', project: 'wildlog', tags: [], embedding: vec(3), by: 'owner' });
  tick(1000);
  const b = store.insert({ kind: 'decision', content: 'Use the Dymo printer', project: 'wildlog', tags: [], embedding: vec(4), by: 'Claude Code' });
  tick(1000);
  const row = store.supersessions.add(a.id, b.id, 'Claude Code');
  tick(1000);
  store.supersessions.undo(row.id, 'owner');
  const [first, second] = store.recentActivity(5);
  assert.deepEqual([first!.action, first!.by, first!.memoryId, first!.content], ['brought back', 'owner', a.id, 'Use the Brother printer']);
  assert.deepEqual([second!.action, second!.by, second!.memoryId, second!.content], ['replaced', 'Claude Code', a.id, 'Use the Brother printer']);
});

test('projectActivity is recentActivity for one project: creations, edits and replacements, newest first, limited', () => {
  const { store, tick } = setup();
  const a1 = store.insert({ kind: 'decision', content: 'A one', project: 'a', tags: [], embedding: vec(0), by: 'Claude' });
  tick(1000);
  store.insert({ kind: 'decision', content: 'B one', project: 'b', tags: [], embedding: vec(1), by: 'Claude' });
  tick(1000);
  const a2 = store.insert({ kind: 'decision', content: 'A two', project: 'a', tags: [], embedding: vec(2), by: 'Grok' });
  tick(1000);
  store.update(a1.id, { content: 'A one, edited', project: 'a', tags: [], embedding: vec(0), by: 'owner' });
  tick(1000);
  store.supersessions.add(a2.id, a1.id, 'Claude Code');
  tick(1000);
  store.insert({ kind: 'decision', content: 'B two', project: 'b', tags: [], embedding: vec(3), by: 'Claude' });
  const rows = store.projectActivity('a', 10);
  assert.deepEqual(rows.map((r) => [r.action, r.by, r.memoryId]), [
    ['replaced', 'Claude Code', a2.id], ['updated', 'owner', a1.id], ['created', 'Grok', a2.id], ['created', 'Claude', a1.id],
  ]);
  // the same rows recentActivity gives, in its order, for this project only
  const ids = new Set([a1.id, a2.id]);
  assert.deepEqual(rows, store.recentActivity(100).filter((r) => ids.has(r.memoryId)));
  assert.equal(store.projectActivity('a', 2).length, 2);
  assert.deepEqual(store.projectActivity('nope', 5), []);
});

test('projectActivity rows say what kind of memory changed', () => {
  const { store, tick } = setup();
  store.insert({ kind: 'decision', content: 'wildlog uses SwiftUI', project: 'wildlog', tags: [], embedding: vec(0), by: 'owner' });
  tick(1000);
  store.insert({ kind: 'roadmap', content: 'Now: work', project: 'wildlog', tags: [], embedding: vec(1), by: 'owner' });
  assert.deepEqual(new Set(store.projectActivity('wildlog', 10).map((r) => r.kind)), new Set(['decision', 'roadmap']));
});
