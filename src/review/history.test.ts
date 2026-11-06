import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryEntry, Memory } from '../memory/types.js';
import { liveDuring, versionAt, versionsOf } from './history.js';

const mem = (o: Partial<Memory> = {}): Memory => ({
  id: 'm', kind: 'roadmap', content: 'now', project: 'p', tags: [], createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'c',
  updatedAt: 'x', updatedBy: 'c', lastRecalledAt: null, deletedAt: null, ...o,
});
let n = 0;
const h = (action: HistoryEntry['action'], content: string, changedAt: string, project = 'p'): HistoryEntry =>
  ({ id: ++n, memoryId: 'm', action, content, project, tags: [], changedAt, changedBy: 'c' });

test('no history is one live version from created_at', () => {
  assert.deepEqual(versionsOf(mem(), []), [{ content: 'now', project: 'p', live: true, from: '2026-10-01T00:00:00.000Z', to: null }]);
});

test('each update closes a version at its changed_at', () => {
  const vs = versionsOf(mem({ content: 'v3', project: 'q' }), [h('update', 'v1', '2026-10-05T00:00:00.000Z'), h('update', 'v2', '2026-10-07T00:00:00.000Z')]);
  assert.deepEqual(vs, [
    { content: 'v1', project: 'p', live: true, from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' },
    { content: 'v2', project: 'p', live: true, from: '2026-10-05T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z' },
    { content: 'v3', project: 'q', live: true, from: '2026-10-07T00:00:00.000Z', to: null },
  ]);
});

test('a delete then restore leaves a version that is not live', () => {
  const vs = versionsOf(mem({ content: 'v1' }), [h('delete', 'v1', '2026-10-05T00:00:00.000Z'), h('restore', 'v1', '2026-10-07T00:00:00.000Z')]);
  assert.deepEqual(vs.map((v) => v.live), [true, false, true]);
  const gone = versionsOf(mem({ content: 'v1', deletedAt: '2026-10-05T00:00:00.000Z' }), [h('delete', 'v1', '2026-10-05T00:00:00.000Z')]);
  assert.deepEqual(gone.map((v) => v.live), [true, false]);
});

test('versionAt picks from <= at < to', () => {
  const vs = versionsOf(mem({ content: 'v2' }), [h('update', 'v1', '2026-10-05T00:00:00.000Z')]);
  assert.equal(versionAt(vs, '2026-09-30T00:00:00.000Z'), undefined);
  assert.equal(versionAt(vs, '2026-10-01T00:00:00.000Z')!.content, 'v1');
  assert.equal(versionAt(vs, '2026-10-04T23:59:59.999Z')!.content, 'v1');
  assert.equal(versionAt(vs, '2026-10-05T00:00:00.000Z')!.content, 'v2');
  const deleted = versionsOf(mem({ content: 'v1', deletedAt: 'x' }), [h('delete', 'v1', '2026-10-05T00:00:00.000Z')]);
  assert.equal(versionAt(deleted, '2026-10-06T00:00:00.000Z'), undefined);
  assert.deepEqual(liveDuring(vs, '2026-10-04T00:00:00.000Z', '2026-10-06T00:00:00.000Z').map((v) => v.content), ['v1', 'v2']);
  assert.deepEqual(liveDuring(vs, '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z').map((v) => v.content), ['v2']);
});
