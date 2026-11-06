import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeService } from '../testing/helpers.js';
import { ReviewStore } from './store.js';
import { REVIEW_FORMAT, type ReviewBody } from './types.js';

function world() {
  let t = Date.parse('2026-10-20T10:00:00Z');
  const w = makeService({ now: () => new Date(t) });
  return { ...w, reviews: new ReviewStore(w.db), at(iso: string) { t = Date.parse(iso); } };
}
const emb = new Float32Array(4);
const body = (monday: string, n = 0): ReviewBody => ({
  format: 1, monday, projects: [], decisions: Array.from({ length: n }, (_, i) => `d${i}`), growth: null,
  digest: { totals: { saved: 0, changed: 0, deleted: 0 }, writers: [], lookupsSince: null }, safety: [], quietFromFactsOnly: false,
});

test('setTidy fills only a summary not worked out yet', () => {
  const { reviews } = world();
  const monday = '2026-10-26';
  const summary = { duplicates: 1, statuses: [{ project: 'wildlog', old: 2 }], overlaps: 0, stale: 0, gone: 0 };
  reviews.insert({ monday, body: { ...body(monday, 2), tidy: null }, builtAt: 'x', builtBy: 'owner' });
  reviews.markOpened(monday, 'opened');
  const before = reviews.get(monday)!;
  assert.equal(reviews.setTidy(monday, summary), true);
  const after = reviews.get(monday)!;
  assert.deepEqual(after, { ...before, body: { ...before.body, tidy: summary } });
  assert.equal(reviews.setTidy(monday, { ...summary, duplicates: 99 }), false);
  assert.deepEqual(reviews.get(monday), after);
  const older = '2026-10-19';
  reviews.insert({ monday: older, body: body(older), builtAt: 'x', builtBy: 'owner' });
  const legacy = reviews.get(older);
  assert.equal(reviews.setTidy(older, summary), false);
  assert.deepEqual(reviews.get(older), legacy);
  assert.equal(reviews.setTidy('2026-10-12', summary), false);
});

test('insert is once per Monday: a second insert keeps the first body and built_at', () => {
  const { reviews } = world();
  reviews.insert({ monday: '2026-10-26', body: body('2026-10-26', 1), builtAt: '2026-11-02T07:14:00.000Z', builtBy: 'owner' });
  reviews.insert({ monday: '2026-10-26', body: body('2026-10-26', 2), builtAt: '2026-11-02T09:00:00.000Z', builtBy: 'Claude' });
  const r = reviews.get('2026-10-26')!;
  assert.equal(r.format, REVIEW_FORMAT);
  assert.deepEqual(r.body.decisions, ['d0']);
  assert.equal(r.builtAt, '2026-11-02T07:14:00.000Z');
  assert.equal(r.builtBy, 'owner');
  assert.deepEqual([r.openedAt, r.dismissedAt], [null, null]);
  reviews.insert({ monday: '2026-10-19', body: body('2026-10-19'), builtAt: 'x', builtBy: 'owner' });
  assert.deepEqual(reviews.mondays(), ['2026-10-26', '2026-10-19']);
});

test('markOpened and markDismissed keep the first time and answer false for a Monday not stored', () => {
  const { reviews } = world();
  reviews.insert({ monday: '2026-10-26', body: body('2026-10-26'), builtAt: 'x', builtBy: 'owner' });
  assert.equal(reviews.markOpened('2026-10-26', '2026-11-02T08:00:00.000Z'), true);
  assert.equal(reviews.markOpened('2026-10-26', '2026-11-02T09:00:00.000Z'), true);
  assert.equal(reviews.markDismissed('2026-10-26', '2026-11-02T10:00:00.000Z'), true);
  assert.equal(reviews.markDismissed('2026-10-26', '2026-11-02T11:00:00.000Z'), true);
  const r = reviews.get('2026-10-26')!;
  assert.equal(r.openedAt, '2026-11-02T08:00:00.000Z');
  assert.equal(r.dismissedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(reviews.markOpened('2026-09-28', 'x'), false);
  assert.equal(reviews.markDismissed('2026-09-28', 'x'), false);
});

test('get refuses a format it has never known', () => {
  const { db, reviews } = world();
  db.prepare("INSERT INTO weekly_reviews(monday, format, body, built_at, built_by) VALUES ('2026-10-26', 99, '{}', 'x', 'owner')").run();
  assert.throws(() => reviews.get('2026-10-26'), /format 99/);
});

test('lastTouched counts creations under the project the memory started in and history rows filed under it, up to the moment', () => {
  const { store, reviews, at } = world();
  at('2026-10-20T10:00:00.000Z');
  const m = store.insert({ kind: 'decision', content: 'x', project: 'a', tags: [], embedding: emb, by: 'Claude' });
  at('2026-10-22T10:00:00.000Z');
  store.relabel(m.id, { project: 'b', tags: [], by: 'owner' });
  const t1 = reviews.lastTouched('2026-10-20T10:00:00.000Z');
  assert.equal(t1.get('a'), '2026-10-20T10:00:00.000Z');
  assert.equal(t1.has('b'), false);
  const t2 = reviews.lastTouched('2026-10-22T10:00:00.000Z');
  assert.equal(t2.get('a'), '2026-10-22T10:00:00.000Z');
  assert.equal(t2.has('b'), false);
  assert.equal(reviews.lastTouched('2026-10-19T00:00:00.000Z').size, 0);
  const first = reviews.firstTouched('2026-10-21T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
  assert.equal(first.get('a'), '2026-10-22T10:00:00.000Z');
  assert.equal(reviews.earliestMemory(), '2026-10-20T10:00:00.000Z');
});

test('roadmapsBetween includes a roadmap deleted during the week and leaves out one deleted before it', () => {
  const { store, reviews, at } = world();
  at('2026-10-01T10:00:00.000Z');
  const during = store.insert({ kind: 'roadmap', content: 'Now: a', project: 'a', tags: [], embedding: emb, by: 'Claude' });
  const before = store.insert({ kind: 'roadmap', content: 'Now: b', project: 'b', tags: [], embedding: emb, by: 'Claude' });
  const later = store.insert({ kind: 'roadmap', content: 'Now: c', project: 'c', tags: [], embedding: emb, by: 'Claude' });
  at('2026-10-20T10:00:00.000Z');
  store.softDelete(before.id, 'owner');
  at('2026-10-28T10:00:00.000Z');
  store.update(during.id, { content: 'Now: a2', project: 'a', tags: [], embedding: emb, by: 'Claude' });
  at('2026-10-29T10:00:00.000Z');
  store.softDelete(during.id, 'owner');
  at('2026-11-05T10:00:00.000Z');
  store.insert({ kind: 'roadmap', content: 'Now: d', project: 'd', tags: [], embedding: emb, by: 'Claude' });
  const got = reviews.roadmapsBetween('2026-10-25T23:00:00.000Z', '2026-11-01T23:00:00.000Z');
  assert.deepEqual(got.map((r) => r.memory.id).sort(), [during.id, later.id].sort());
  const h = got.find((r) => r.memory.id === during.id)!.history;
  assert.deepEqual(h.map((x) => x.action), ['update', 'delete'], 'history oldest first');
});

test('the week queries use the new indexes', () => {
  const { db } = world();
  const plan = (sql: string) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b'));
  assert.match(plan('SELECT * FROM memory_history WHERE changed_at >= ? AND changed_at < ?'), /memory_history_changed/);
  assert.match(plan('SELECT * FROM memories WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid'), /memories_created/);
});

test('pages saved, evidence added and discussion voices for a week', () => {
  const { db, reviews } = world();
  db.prepare(`INSERT INTO pages(id, title, title_key, project, body, version, created_at, created_by, updated_at, updated_by)
    VALUES ('p1', 'T', 't', 'wildlog', 'b', 2, 'x', 'c', 'x', 'c')`).run();
  const v = db.prepare('INSERT INTO page_versions(page_id, version, title, project, body, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  v.run('p1', 1, 'T', 'wildlog', 'b', '2026-10-27T10:00:00.000Z', 'c');
  v.run('p1', 2, 'T', 'wildlog', 'b', '2026-10-28T10:00:00.000Z', 'c');
  assert.deepEqual(reviews.pagesSaved('2026-10-25T23:00:00.000Z', '2026-11-01T23:00:00.000Z'), [{ pageId: 'p1', project: 'wildlog' }]);

  db.prepare(`INSERT INTO observations(id, kind, area, summary, embedding, created_at, created_by, last_evidence_at)
    VALUES ('o1', 'strength', 'reviewing', 's', x'00', 'x', 'c', 'x')`).run();
  const e = db.prepare("INSERT INTO observation_evidence(observation_id, what, added_by, added_at) VALUES ('o1', 'w', 'c', ?)");
  e.run('2026-10-27T10:00:00.000Z'); e.run('2026-10-29T10:00:00.000Z'); e.run('2026-11-03T10:00:00.000Z');
  assert.deepEqual(reviews.evidenceAdded('2026-10-25T23:00:00.000Z', '2026-11-01T23:00:00.000Z'),
    [{ observationId: 'o1', kind: 'strength', count: 2, latest: '2026-10-29T10:00:00.000Z' }]);

  db.prepare(`INSERT INTO discussions(id, title, question, opened_by, opened_model, opened_at, decision_memory_id)
    VALUES ('d1', 't', 'q', 'owner', 'm', 'x', 'mem1')`).run();
  const post = db.prepare("INSERT INTO discussion_posts(discussion_id, round, kind, author, model, voice_key, text, created_at) VALUES ('d1', ?, ?, ?, 'm', ?, 't', 'x')");
  post.run(1, 'question', 'owner', 'owner');
  post.run(1, 'reply', 'ChatGPT', 'gpt');
  post.run(1, 'reply', 'Claude', 'claude');
  post.run(2, 'reply', 'ChatGPT', 'gpt');
  assert.deepEqual(reviews.discussionVoices('mem1'), ['ChatGPT', 'Claude']);
  assert.equal(reviews.discussionVoices('nope'), undefined);
});
