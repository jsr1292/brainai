/** B10: facts from the time a question asks about rank higher (a soft time lane); explicit dates narrow, with a fall-back. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { hybridSearch } from './search.js';

const owner = { type: 'owner' } as const;

/** A service whose clock can be set, with two facts about backups: one saved in September, one last week. */
async function world() {
  let t = Date.parse('2026-09-15T10:00:00Z');
  const ctx = makeService({ now: () => new Date(t) });
  const save = async (content: string) => ((await ctx.service.remember({ kind: 'decision', content, project: 'homelab', allowDuplicate: true, newProject: true }, owner)) as { memory: { id: string } }).memory.id;
  // Without time words the September fact is the closer one ("about" is in it and in the question).
  const september = await save('We decided about backups run weekly to the NAS');
  t = Date.parse('2026-11-04T10:00:00Z');
  const november = await save('We decided backups run nightly to the NAS');
  t = Date.parse('2026-11-10T10:00:00Z');
  return { ...ctx, september, november, save, at: (iso: string) => { t = Date.parse(iso); } };
}
const ids = (hits: { memory: { id: string } }[]) => hits.map((h) => h.memory.id);

test('a question about last week ranks last week\'s fact first; the same question without the time keeps the old order', async () => {
  const { service, september, november } = await world();
  const plain = ids(await service.recall({ query: 'what did we decide about backups', rerank: false, touch: false, readTime: true }));
  assert.equal(plain[0], september);
  const timed = await service.recall({ query: 'what did we decide last week about backups', rerank: false, touch: false, readTime: true });
  assert.equal(ids(timed)[0], november);
  assert.equal(timed.find((h) => h.memory.id === november)?.inRange, true);
  assert.equal(timed.find((h) => h.memory.id === september)?.inRange, undefined);
});

test('a fact saved later but dated inside the range in its text counts as in range', async () => {
  const { service, save } = await world();
  const later = await save('The NAS disk was swapped (2026-11-03)');
  const hits = await service.recall({ query: 'what happened to the NAS last week', rerank: false, touch: false, readTime: true });
  assert.equal(hits.find((h) => h.memory.id === later)?.inRange, true);
});

test('explicit dates narrow the search to facts of that time, and fall back when fewer than three match', async () => {
  const { service, september, november, save, at } = await world();
  let report: { fellBack?: boolean; timeRange?: { from: string; to: string; source: string } } = {};
  const narrow = await service.recall({ query: 'backups', range: { from: '2026-11-01', to: '2026-11-10', strict: true }, rerank: false, touch: false, readTime: true, report: (r) => { report = r; } });
  // Only one fact is in range: too few, so the nearest overall come back, and the report says so.
  assert.equal(report.fellBack, true);
  assert.deepEqual(report.timeRange, { from: '2026-11-01', to: '2026-11-10', source: 'given' });
  assert.ok(ids(narrow).includes(september));
  at('2026-11-05T10:00:00Z');
  await save('Backups are checked every Monday on the NAS');
  await save('Backups older than a year are pruned from the NAS');
  at('2026-11-10T10:00:00Z');
  const strict = await service.recall({ query: 'backups', range: { from: '2026-11-01', to: '2026-11-10', strict: true }, rerank: false, touch: false, readTime: true, report: (r) => { report = r; } });
  assert.equal(report.fellBack, false);
  assert.ok(!ids(strict).includes(september), 'the September fact is left out');
  assert.ok(ids(strict).includes(november));
  assert.ok(strict.every((h) => h.inRange === true));
});

test('a question with no time words returns exactly what the search alone returns, in the same order', async () => {
  const { service, store } = await world();
  for (const q of ['what did we decide about backups', 'NAS nightly', 'weekly backups decided']) {
    const vector = await (await import('./fakeEmbedder.js')).createFakeEmbedder().embed(q, 'query');
    const direct = hybridSearch(store, { vector, text: q, limit: 8, minSimilarity: 0.2, confidentSimilarity: 0.2, touch: false });
    const viaRecall = await service.recall({ query: q, rerank: false, touch: false, readTime: true });
    assert.deepEqual(ids(viaRecall), ids(direct), q);
  }
});

test('the time a question was read as is reported', async () => {
  const { service } = await world();
  let report: { timeRange?: { from: string; to: string; source: string } } = {};
  await service.recall({ query: 'what did we decide last week', rerank: false, touch: false, readTime: true, report: (r) => { report = r; } });
  assert.deepEqual(report.timeRange, { from: '2026-11-02', to: '2026-11-08', source: 'question' });
  await service.recall({ query: 'what did we decide', rerank: false, touch: false, readTime: true, report: (r) => { report = r; } });
  assert.equal(report.timeRange, undefined);
});

test('a range that holds most facts tells nothing apart, so it changes nothing (a young brain asked about "this week")', async () => {
  let t = Date.parse('2026-11-09T10:00:00Z');
  const { service, store } = makeService({ now: () => new Date(t) });
  for (const c of ['backups run nightly to the NAS', 'the NAS has two disks', 'restic keeps seven daily snapshots', 'the router forwards no ports', 'docker compose runs every service']) {
    await service.remember({ kind: 'decision', content: c, project: 'homelab', allowDuplicate: true, newProject: true }, owner);
  }
  t = Date.parse('2026-11-10T10:00:00Z');
  const plain = ids(await service.recall({ query: 'NAS backups snapshots', rerank: false, touch: false, readTime: true }));
  const timed = await service.recall({ query: 'NAS backups snapshots this week', rerank: false, touch: false, readTime: true });
  const vector = await (await import('./fakeEmbedder.js')).createFakeEmbedder().embed('NAS backups snapshots this week', 'query');
  const direct = hybridSearch(store, { vector, text: 'NAS backups snapshots this week', limit: 8, minSimilarity: 0.2, confidentSimilarity: 0.2, touch: false });
  assert.deepEqual(ids(timed), ids(direct));
  assert.ok(plain.length > 0);
});

test('time words are read only when the caller asks (assistants do; the dashboard search does not)', async () => {
  const { service, september } = await world();
  const hits = await service.recall({ query: 'what did we decide last week about backups', rerank: false, touch: false });
  assert.equal(hits[0]?.memory.id, september, 'no time lane without readTime');
  assert.ok(hits.every((h) => h.inRange === undefined));
});

test('the time lane never brings in a fact the search would not have found at all', async () => {
  const { service, save } = await world();
  const tap = await save('the kitchen tap was replaced by the plumber');
  const plain = ids(await service.recall({ query: 'restic retention policy', rerank: false, touch: false, readTime: true }));
  const timed = ids(await service.recall({ query: 'restic retention policy this week', rerank: false, touch: false, readTime: true }));
  assert.ok(!plain.includes(tap));
  assert.ok(!timed.includes(tap), 'an unrelated fact of this week is not a match');
});

test('the dated-fact lookup reads only facts that can be in range: saved near it, or with a date written in them', async () => {
  const { store, save, at } = await world();
  at('2025-01-10T10:00:00Z');
  const old = await save('the old router was a TP-Link');
  const dated = await save('the NAS disk was swapped (2026-11-03)');
  at('2026-11-10T10:00:00Z');
  const got = store.datedCandidates({ from: '2026-11-02', to: '2026-11-08' }).map((m) => m.id);
  assert.ok(!got.includes(old));
  assert.ok(got.includes(dated));
});
