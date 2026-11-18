import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClusters, MAX_CLUSTER, type ClusterFact, type ClusterOptions } from './tidyClusters.js';
import type { Memory } from './types.js';

/** A unit vector at `deg` degrees: two vectors are as close as cos(difference). */
const vec = (deg: number): Float32Array => new Float32Array([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]);
let n = 0;
function fact(over: Partial<Memory> & { deg: number }): ClusterFact {
  n++;
  const day = over.createdAt ?? `2026-0${(n % 9) + 1}-01T10:00:00.000Z`;
  const { deg, ...rest } = over;
  return {
    embedding: vec(deg),
    memory: { id: `f${String(n).padStart(3, '0')}`, kind: 'decision', content: `fact ${n}`, project: 'p', tags: [], keys: '', createdAt: day, createdBy: 'o', updatedAt: day, updatedBy: 'o', lastRecalledAt: null, deletedAt: null, ...rest },
  };
}
const opts = (o: Partial<ClusterOptions> = {}): ClusterOptions => ({ project: 'p', related: 0.9, duplicate: 0.99, excluded: () => false, looked: () => false, dismissed: () => false, ...o });

test('close facts form a group; far ones and other kinds stay out; the result is deterministic', () => {
  n = 0;
  const a = fact({ deg: 0, createdAt: '2026-01-01T00:00:00.000Z' });
  const b = fact({ deg: 10, createdAt: '2026-02-01T00:00:00.000Z' });
  const far = fact({ deg: 90 });
  const road = fact({ deg: 5, kind: 'roadmap' });
  const prof = fact({ deg: 6, kind: 'profile' });
  const r1 = buildClusters([far, b, road, a, prof], opts());
  const r2 = buildClusters([a, prof, far, road, b], opts());
  assert.deepEqual(r1, r2);
  assert.equal(r1.clusters.length, 1);
  assert.deepEqual(r1.clusters[0]!.ids, [a.memory.id, b.memory.id], 'oldest first');
  assert.equal(r1.clusters[0]!.why, 'conflict', 'close but below the duplicate cut-off, saved on different days');
  assert.match(r1.clusters[0]!.id, /^c[0-9a-f]{10}$/);
});

test('same day and close is related; at the duplicate cut-off it is a duplicate; a decision never groups with a status', () => {
  n = 0;
  const d1 = fact({ deg: 0, createdAt: '2026-03-01T08:00:00.000Z' });
  const d2 = fact({ deg: 10, createdAt: '2026-03-01T18:00:00.000Z' });
  const s1 = fact({ deg: 1, kind: 'summary', createdAt: '2026-03-01T09:00:00.000Z' });
  assert.equal(buildClusters([d1, d2, s1], opts()).clusters[0]!.why, 'related');
  const same = fact({ deg: 0.5, createdAt: '2026-04-01T00:00:00.000Z' });
  const dup = buildClusters([d1, same], opts({ duplicate: 0.999 })).clusters[0]!;
  assert.equal(dup.why, 'duplicates');
  assert.ok(!dup.ids.includes(s1.memory.id));
});

test('old statuses: everything but the newest, with the newest as the keeper, and a status tagged decision counts', () => {
  n = 0;
  const s1 = fact({ deg: 0, kind: 'summary', updatedAt: '2026-01-01T00:00:00.000Z' });
  const s2 = fact({ deg: 90, kind: 'decision', tags: ['status'], updatedAt: '2026-02-01T00:00:00.000Z' });
  const s3 = fact({ deg: 180, kind: 'summary', updatedAt: '2026-03-01T00:00:00.000Z' });
  const r = buildClusters([s2, s3, s1], opts());
  assert.equal(r.clusters.length, 1);
  const c = r.clusters[0]!;
  assert.equal(c.why, 'old_statuses');
  assert.equal(c.newestStatusId, s3.memory.id);
  assert.deepEqual(c.ids, [s3.memory.id, s1.memory.id, s2.memory.id], 'newest first, then the oldest');
  // The owner said they are all current: nothing to tidy.
  assert.equal(buildClusters([s2, s3, s1], opts({ dismissed: () => true })).clusters.length, 0);
  // A lone status is never an old one.
  assert.equal(buildClusters([s3], opts()).clusters.length, 0);
});

test('caps: a group has at most 8 facts, an old-status group 8 with the newest, and a call at most 20 groups', () => {
  n = 0;
  const crowd = Array.from({ length: 20 }, (_, i) => fact({ deg: i * 0.5 }));
  const r = buildClusters(crowd, opts());
  assert.ok(r.clusters.length >= 2);
  for (const c of r.clusters) assert.ok(c.ids.length <= MAX_CLUSTER);
  assert.equal(new Set(r.clusters.flatMap((c) => c.ids)).size, r.clusters.flatMap((c) => c.ids).length, 'no fact in two groups');
  n = 0;
  const statuses = Array.from({ length: 20 }, (_, i) => fact({ deg: i * 30, kind: 'summary', updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
  const st = buildClusters(statuses, opts());
  assert.deepEqual(st.clusters.map((c) => c.ids.length), [8, 8, 6]);
  // 25 well-separated pairs make 25 groups: all of them stay reachable, and the total says 25.
  n = 0;
  const pairs = Array.from({ length: 25 }, (_, i) => [fact({ deg: i * 14.4 }), fact({ deg: i * 14.4 + 1 })]).flat();
  const many = buildClusters(pairs, opts({ related: 0.999 }));
  assert.equal(many.clusters.length, 25);
  assert.equal(many.total, 25);
});

test('waiting facts are left out and a group of only looked-at facts is not offered', () => {
  n = 0;
  const a = fact({ deg: 0 });
  const b = fact({ deg: 5 });
  const c = fact({ deg: 8 });
  assert.deepEqual(buildClusters([a, b, c], opts({ excluded: (m) => m.id === c.memory.id })).clusters[0]!.ids.sort(), [a.memory.id, b.memory.id].sort());
  assert.equal(buildClusters([a, b], opts({ looked: () => true })).clusters.length, 0);
  assert.equal(buildClusters([a, b], opts({ looked: (m) => m.id === a.memory.id })).clusters.length, 1, 'one changed fact brings the group back');
});

test('wording: related groups say "look related"; only a duplicates group says "nearly the same"', () => {
  n = 0;
  const related = buildClusters([fact({ deg: 0, createdAt: '2026-01-01T10:00:00.000Z' }), fact({ deg: 20, createdAt: '2026-01-01T11:00:00.000Z' })], opts({ related: 0.9, duplicate: 0.99 }));
  assert.equal(related.clusters[0]!.why, 'related');
  assert.equal(related.clusters[0]!.because, '2 decisions look related.');
  n = 0;
  const conflict = buildClusters([fact({ deg: 0, createdAt: '2026-01-01T10:00:00.000Z' }), fact({ deg: 20, createdAt: '2026-01-05T10:00:00.000Z' })], opts({ related: 0.9, duplicate: 0.99 }));
  assert.match(conflict.clusters[0]!.because, /^2 decisions look related, and were saved on different days/);
  n = 0;
  const dupes = buildClusters([fact({ deg: 0 }), fact({ deg: 1 })], opts({ related: 0.9, duplicate: 0.99 }));
  assert.match(dupes.clusters[0]!.because, /say nearly the same thing/);
});

test('wording: a duplicate pair chained with a looser neighbour says "look related (two of them ...)"; all-duplicates and a bare pair say "nearly the same"', () => {
  n = 0;
  const mixed = buildClusters([fact({ deg: 0 }), fact({ deg: 1 }), fact({ deg: 15 })], opts({ related: 0.9, duplicate: 0.99 }));
  assert.equal(mixed.clusters.length, 1);
  assert.match(mixed.clusters[0]!.because, /^3 decisions look related \(two of them say nearly the same thing/);
  assert.doesNotMatch(mixed.clusters[0]!.because, /^3 decisions say nearly/);
  n = 0;
  const all = buildClusters([fact({ deg: 0 }), fact({ deg: 1 }), fact({ deg: 2 })], opts({ related: 0.9, duplicate: 0.99 }));
  assert.match(all.clusters[0]!.because, /^3 decisions say nearly the same thing/);
});
