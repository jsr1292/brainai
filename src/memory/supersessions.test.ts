import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';
import { MAX_CHAIN, replaceableKind } from './supersessions.js';
import type { Kind } from './types.js';

const owner = { type: 'owner' } as const;

function world() {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const db = openDb(':memory:');
  const store = new MemoryStore(db, () => new Date(t));
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const advance = (days = 1) => { t += days * 86_400_000; };
  const save = async (content: string, project: string | null = 'wildlog', kind: Kind = 'decision') => {
    advance();
    const r = await service.remember({ kind, content, project: project ?? undefined }, owner);
    assert.equal(r.status, 'saved');
    return (r as { memory: { id: string } }).memory.id;
  };
  return { db, store, service, advance, save };
}

test('which facts can be replaced, and as what', () => {
  assert.equal(replaceableKind({ kind: 'decision', tags: [] }), 'decision');
  assert.equal(replaceableKind({ kind: 'decision', tags: ['status'] }), 'status');
  assert.equal(replaceableKind({ kind: 'summary', tags: [] }), 'status');
  assert.equal(replaceableKind({ kind: 'profile', tags: ['status'] }), null);
  assert.equal(replaceableKind({ kind: 'roadmap', tags: [] }), null);
});

test('a chain is walked to its end, through a deleted step, and listed oldest first', async () => {
  const { store, service, save } = world();
  const a = await save('Labels are printed on a Brother printer');
  const b = await save('Labels are printed on a Dymo printer now');
  const c = await save('Labels are handwritten for the small batches');
  store.supersessions.add(a, b, 'owner');
  store.supersessions.add(b, c, 'owner');
  assert.deepEqual(store.supersessions.chainEnd(a), { endId: c, steps: 2 });
  assert.deepEqual(store.supersessions.chainEnd(c), { endId: c, steps: 0 });
  assert.deepEqual(store.supersessions.chain(a), [a, b, c]);
  assert.deepEqual(store.supersessions.chain(c), [a, b, c]);
  service.forget(b, owner);
  assert.equal(store.supersessions.chainEnd(a).endId, c);
  service.forget(c, owner);
  assert.equal(store.supersessions.chainEnd(b).endId, c);
});

test('one fact replacing two: both are in its chain, oldest first', async () => {
  const { store, save } = world();
  const a = await save('Cellar temperature is read by a Ecobee sensor');
  const b = await save('Cellar humidity is read by a Hive sensor');
  const c = await save('Cellar climate is read by one Aqara sensor');
  store.supersessions.add(a, c, 'owner');
  store.supersessions.add(b, c, 'owner');
  assert.deepEqual(store.supersessions.chain(a), [a, b, c]);
  assert.deepEqual(store.supersessions.liveBy(c).map((r) => r.oldId), [a, b]);
});

test('an undone row leaves the chain and comes back in History', async () => {
  const { store, save } = world();
  const a = await save('Bottles are sorted by region');
  const b = await save('Bottles are sorted by drinking window');
  const row = store.supersessions.add(a, b, 'owner');
  store.supersessions.undo(row.id, 'owner');
  assert.equal(store.supersessions.liveFor(a), undefined);
  assert.equal(store.supersessions.chainEnd(a).steps, 0);
  const all = store.supersessions.allFor(a);
  assert.equal(all.length, 1);
  assert.ok(all[0]!.undoneAt);
  assert.equal(all[0]!.undoneBy, 'owner');
});

test('a looped chain made by hand stops after 50 steps', async () => {
  const { db, store, save } = world();
  const a = await save('First looped fact');
  const b = await save('Second looped fact');
  db.prepare("INSERT INTO supersessions(old_id, new_id, created_at, created_by) VALUES (?, ?, '2026-10-05', 'owner')").run(a, b);
  db.prepare("INSERT INTO supersessions(old_id, new_id, created_at, created_by) VALUES (?, ?, '2026-10-05', 'owner')").run(b, a);
  const end = store.supersessions.chainEnd(a);
  assert.ok(end.steps <= MAX_CHAIN);
  assert.ok(store.supersessions.chain(a).length <= MAX_CHAIN);
});

test('between returns rows created or undone in the week', async () => {
  const { store, save, advance } = world();
  const a = await save('Corks are bought from Portugal');
  const b = await save('Corks are bought from Italy');
  const c = await save('Screw caps for the whites');
  const d = await save('Glass corks for the reds');
  const early = store.supersessions.add(a, b, 'owner');
  const start = new Date(Date.parse('2026-10-01T10:00:00Z') + 10 * 86_400_000);
  advance(10);
  store.supersessions.undo(early.id, 'owner');
  const inside = store.supersessions.add(c, d, 'owner');
  const end = new Date(start.getTime() + 7 * 86_400_000);
  assert.deepEqual(store.supersessions.between(start, end).map((r) => r.id), [early.id, inside.id]);
});

test('the project list follows aliases and leaves deleted old facts out', async () => {
  const { store, service, save } = world();
  await save('Inflow is the player on the Apple TV', 'inflow');
  const a = await save('Coyote keeps the posters', 'coyote');
  const b = await save('Coyote keeps the posters and the subtitles', 'coyote');
  store.supersessions.add(a, b, 'owner');
  store.addAlias('coyote', 'inflow', 'owner');
  assert.deepEqual(store.supersessions.liveForProject('inflow').map((r) => r.oldId), [a]);
  service.forget(a, owner);
  assert.deepEqual(store.supersessions.liveForProject('inflow'), []);
});

test('gone lists only live rows whose newer fact is deleted', async () => {
  const { store, service, save } = world();
  const a = await save('Backups go to the NAS');
  const b = await save('Backups go to the NAS and the SSD');
  const c = await save('Tasting notes go in the app');
  const d = await save('Tasting notes go in the app and on paper');
  store.supersessions.add(a, b, 'owner');
  const cd = store.supersessions.add(c, d, 'owner');
  assert.deepEqual(store.supersessions.gone(), []);
  service.forget(b, owner);
  service.forget(d, owner);
  store.supersessions.undo(cd.id, 'owner');
  assert.deepEqual(store.supersessions.gone().map((r) => r.oldId), [a]);
  assert.deepEqual([...store.supersessions.liveCounts([b, d])], [[b, 1]]);
});

test('the version changes on an add and on an undo', async () => {
  const { store, save } = world();
  const a = await save('The label font is Futura');
  const b = await save('The label font is Avenir');
  const v0 = store.supersessions.version();
  const row = store.supersessions.add(a, b, 'owner');
  const v1 = store.supersessions.version();
  assert.notEqual(v1, v0);
  store.supersessions.undo(row.id, 'owner');
  assert.notEqual(store.supersessions.version(), v1);
});

test('the replaced list is newest replacement first, follows filters and aliases, and flags a replacement that was itself replaced', async () => {
  const { store, service, save, advance } = world();
  const a = await save('Drinking windows come from the producer notes');
  const b = await save('Drinking windows come from Cellarium');
  const c = await save('Drinking windows are set by hand');
  const s1 = await save('wildlog status: importing', 'wildlog', 'summary');
  const s2 = await save('wildlog status: imported', 'wildlog', 'summary');
  const x = await save('Coyote keeps the posters', 'coyote');
  const y = await save('Coyote keeps the posters and subtitles', 'coyote');
  store.supersessions.add(a, b, 'owner'); advance();
  store.supersessions.add(b, c, 'owner'); advance();
  store.supersessions.add(s1, s2, 'owner'); advance();
  store.supersessions.add(x, y, 'owner');
  // An alias added without moving the facts (as an old import did): they stay filed under coyote.
  store.addAlias('coyote', 'inflow', 'owner');
  const all = store.supersessions.replacedList({ limit: 50, offset: 0 });
  assert.deepEqual(all.map((r) => r.old.id), [x, s1, b, a]);
  assert.deepEqual(all.map((r) => r.nextReplaced), [false, false, false, true]);
  assert.equal(all[3]!.next.id, b);
  assert.deepEqual(store.supersessions.replacedList({ kind: 'decision', project: 'wildlog', limit: 50, offset: 0 }).map((r) => r.old.id), [b, a]);
  assert.deepEqual(store.supersessions.replacedList({ project: 'inflow', limit: 50, offset: 0 }).map((r) => r.old.id), [x]);
  assert.deepEqual(store.supersessions.replacedList({ limit: 2, offset: 1 }).map((r) => r.old.id), [s1, b]);
  assert.equal(store.supersessions.replacedCount({}), 4);
  assert.equal(store.supersessions.replacedCount({ kind: 'summary' }), 1);
  service.forget(a, owner);
  assert.equal(store.supersessions.replacedCount({}), 3);
});
