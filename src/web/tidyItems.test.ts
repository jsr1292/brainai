import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TidySummary } from '../memory/tidy.js';
import { makeService } from '../testing/helpers.js';
import { makeTidyItems, tidySentence, tidySummary } from './tidyItems.js';

const empty: TidySummary = { duplicates: 0, statuses: [], overlaps: 0, stale: 0, gone: 0 };

test('the Tidy sentence names what needs a look', () => {
  assert.equal(tidySentence({ ...empty, duplicates: 1, statuses: [{ project: 'wildlog', old: 3 }] }),
    '2 facts look like duplicates and wildlog has 3 old statuses');
  assert.equal(tidySentence({ ...empty, statuses: [{ project: 'wildlog', old: 1 }] }), 'wildlog has 1 old status');
  assert.equal(tidySentence(empty), null);
  assert.equal(tidySentence({ duplicates: 2, statuses: [{ project: 'a', old: 1 }, { project: 'b', old: 2 }], overlaps: 3, stale: 4, gone: 5 }),
    "2 pairs of facts look like duplicates, 2 projects have old statuses, 3 pairs of project names look alike, 4 facts haven't been touched in six months and 5 replaced facts lost their replacement");
});

test('the Tidy sentence uses the singular for one of each', () => {
  assert.equal(tidySentence({ ...empty, overlaps: 1 }), '2 project names look alike');
  assert.equal(tidySentence({ ...empty, stale: 1 }), "1 fact hasn't been touched in six months");
  assert.equal(tidySentence({ ...empty, gone: 1 }), '1 replaced fact lost its replacement');
});

test('Tidy items share the checks and summarize old statuses, pairs and missing replacements', (t) => {
  const now = () => new Date('2026-11-04T10:00:00Z');
  const w = makeService({ now });
  t.after(() => w.db.close());
  const save = (content: string, kind: 'summary' | 'decision' = 'decision') => w.store.insert({
    content, kind, project: 'wildlog', tags: [], embedding: new Float32Array([1, 0, 0, 0]), by: 'owner',
  });
  const old = save('first status', 'summary');
  save('second status', 'summary');
  save('third status', 'summary');
  const gone = save('old decision');
  const newer = save('new decision');
  w.store.supersessions.add(gone.id, newer.id, 'owner');
  w.store.softDelete(newer.id, 'owner');
  const checks = t.mock.method(w.service, 'duplicates');
  const items = makeTidyItems({ ...w, now });
  assert.equal(checks.mock.callCount(), 0, 'creating the helper is lazy');
  const first = items();
  assert.deepEqual(tidySummary(first), {
    duplicates: first.duplicates.length, statuses: [{ project: 'wildlog', old: 2 }], overlaps: 0, stale: 0, gone: 1,
  });
  assert.ok(first.duplicates.length > 0);
  assert.equal(checks.mock.callCount(), 1);
  items();
  assert.equal(checks.mock.callCount(), 1, 'unchanged memories reuse pair checks');
  save('fourth status', 'summary');
  assert.equal(tidySummary(items()).statuses[0]!.old, 3);
  assert.equal(checks.mock.callCount(), 2, 'a write invalidates pair checks');
  assert.equal(first.statuses[0]!.statuses.some((m) => m.id === old.id), true);
  assert.deepEqual(tidySummary({ duplicates: [], statuses: [], overlaps: [], stale: [] }), empty);
});
