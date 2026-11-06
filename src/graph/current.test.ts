import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePages, makeService } from '../testing/helpers.js';
import { currentFactCounts, graphCacheKey, isCurrentFactSql, newestCurrentDecisions } from './current.js';

const owner = { type: 'owner' } as const;

function world() {
  let t = Date.parse('2026-11-04T10:00:00Z');
  const now = () => new Date(t);
  const given = makeService({ now });
  const pages = makePages(given, now);
  return { ...given, pages, advance: (ms = 1000) => { t += ms; } };
}

const saved = async (w: ReturnType<typeof world>, kind: 'decision' | 'summary' | 'profile' | 'roadmap', content: string, project?: string, tags?: string[]) => {
  const r = await w.service.remember({ kind, content, project, tags }, owner) as { status: string; memory: { id: string } };
  assert.ok(r.status === 'saved' || r.status === 'roadmap_updated', r.status);
  w.advance();
  return r.memory.id;
};

test('the current-fact rule is one SQL condition on the given alias', () => {
  assert.match(isCurrentFactSql('m'), /^m\.deleted_at IS NULL AND NOT EXISTS \(SELECT 1 FROM supersessions s WHERE s\.old_id = m\.id AND s\.undone_at IS NULL\)$/);
});

test('a forgotten fact is not current: counts and decisions leave it out', async () => {
  const w = world();
  await saved(w, 'decision', 'wildlog uses SwiftUI', 'wildlog');
  const gone = await saved(w, 'decision', 'wildlog uses UIKit', 'wildlog');
  w.service.forget(gone, owner);
  assert.equal(currentFactCounts(w.db).byProject.get('wildlog'), 1);
  assert.deepEqual(newestCurrentDecisions(w.db, ['wildlog'], 5).map((d) => d.content), ['wildlog uses SwiftUI']);
});

test('fact counts follow aliases and keep profile facts apart', async () => {
  const w = world();
  await saved(w, 'decision', 'coyote plays from jellyfin', 'coyote');
  await saved(w, 'decision', 'inflow plays from the nas', 'inflow');
  await saved(w, 'profile', 'Has a NAS');
  w.service.moveProject('coyote', 'inflow', owner);
  // A fact filed straight under the alias name still counts for the real project.
  const raw = await saved(w, 'decision', 'subtitles come from opensubtitles', 'inflow');
  w.db.prepare("UPDATE memories SET project = 'coyote' WHERE id = ?").run(raw);
  const c = currentFactCounts(w.db);
  assert.equal(c.byProject.get('inflow'), 3);
  assert.equal(c.byProject.get('coyote'), undefined);
  assert.equal(c.profile, 1);
});

test('newest decisions skip statuses and roadmaps and come newest first', async () => {
  const w = world();
  await saved(w, 'decision', 'first decision', 'wildlog');
  await saved(w, 'summary', 'wildlog status: shipped', 'wildlog');
  await saved(w, 'decision', 'tagged status', 'wildlog', ['status']);
  await saved(w, 'roadmap', 'Now: release', 'wildlog');
  await saved(w, 'decision', 'second decision', 'wildlog');
  await saved(w, 'decision', 'other project', 'cairn');
  const d = newestCurrentDecisions(w.db, ['wildlog'], 5);
  assert.deepEqual(d.map((x) => x.content), ['second decision', 'first decision']);
  assert.equal(newestCurrentDecisions(w.db, ['wildlog'], 1).length, 1);
  assert.ok(d.every((x) => typeof x.id === 'string'));
});

test('the cache key changes on a save, an edit, a forget, a page save and an alias, and not on a recall', async () => {
  const w = world();
  const { db, service, pages } = w;
  await saved(w, 'decision', 'restic nightly backups', 'a');
  const k0 = graphCacheKey(db);
  await service.recall({ query: 'restic' });
  w.advance();
  assert.equal(graphCacheKey(db), k0);
  const id = await saved(w, 'decision', 'x restic', 'a');
  const k1 = graphCacheKey(db);
  assert.notEqual(k1, k0);
  await service.update(id, { content: 'y restic' }, owner);
  w.advance();
  const k2 = graphCacheKey(db);
  assert.notEqual(k2, k1);
  service.forget(id, owner);
  w.advance();
  const k3 = graphCacheKey(db);
  assert.notEqual(k3, k2);
  const p = await pages.create({ title: 'Backups', project: 'a', body: '## One\nrestic' }, 'owner');
  w.advance();
  const k4 = graphCacheKey(db);
  assert.notEqual(k4, k3);
  await pages.save(p.id, { base: p.version, body: '## One\nrestic and the nas' }, 'owner');
  w.advance();
  const k5 = graphCacheKey(db);
  assert.notEqual(k5, k4);
  service.addAlias('b', 'a', owner);
  w.advance();
  const k6 = graphCacheKey(db);
  assert.notEqual(k6, k5);
  db.prepare("INSERT INTO meaning_indexed(kind, id, anchor, fingerprint, indexed_at) VALUES ('m', 'x', '', 'f', '2026-11-04T10:00:00.000Z')").run();
  assert.notEqual(graphCacheKey(db), k6);
});

test('a replaced fact is not current: counts and decisions leave it out, and come back on undo', async () => {
  const w = world();
  const old = await saved(w, 'decision', 'wildlog uses Core Data', 'wildlog');
  const now = await saved(w, 'decision', 'wildlog uses SwiftData', 'wildlog');
  const [row] = w.service.supersede([old], now, owner);
  assert.equal(currentFactCounts(w.db).byProject.get('wildlog'), 1);
  assert.deepEqual(newestCurrentDecisions(w.db, ['wildlog'], 5).map((d) => d.content), ['wildlog uses SwiftData']);
  w.service.undoSupersession(row!.id, owner);
  assert.equal(currentFactCounts(w.db).byProject.get('wildlog'), 2);
  assert.deepEqual(newestCurrentDecisions(w.db, ['wildlog'], 5).map((d) => d.content), ['wildlog uses SwiftData', 'wildlog uses Core Data']);
});

test('the key changes on a replacement and on its undo', async () => {
  const w = world();
  const old = await saved(w, 'decision', 'wildlog uses Core Data', 'wildlog');
  const now = await saved(w, 'decision', 'wildlog uses SwiftData', 'wildlog');
  const k0 = graphCacheKey(w.db);
  const [row] = w.service.supersede([old], now, owner);
  const k1 = graphCacheKey(w.db);
  assert.notEqual(k1, k0);
  w.service.undoSupersession(row!.id, owner);
  const k2 = graphCacheKey(w.db);
  assert.notEqual(k2, k1);
  // The same count of current facts as before the replacement, yet the key still differs.
  assert.notEqual(k2, k0);
});
