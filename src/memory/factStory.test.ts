import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { factStory } from './factStory.js';

const owner = { type: 'owner' } as const;

function world() {
  let t = Date.parse('2026-09-20T09:00:00Z');
  const given = makeService({ now: () => new Date(t) });
  const advance = (days: number) => { t += days * 86_400_000; };
  const save = async (content: string) => {
    const r = await given.service.remember({ kind: 'decision', content, project: 'wildlog' }, owner) as { memory: { id: string } };
    return r.memory.id;
  };
  return { ...given, advance, save };
}

test('the story of a fact in a three-step chain', async () => {
  const { store, service, advance, save } = world();
  const a = await save('Drinking windows come from the producer notes');
  advance(15);
  const b = await save('Drinking windows come from the Cellarium import');
  const [ab] = service.supersede([a], b, owner);
  advance(7);
  await service.update(b, { content: 'Drinking windows come from Cellarium' }, owner);
  advance(18);
  const c = await save('Drinking windows are set by hand per bottle');
  const [bc] = service.supersede([b], c, owner);
  let s = factStory(store, b);
  assert.equal(s.replacedBy!.endId, c);
  assert.equal(s.replacedBy!.row.id, bc!.id);
  assert.deepEqual(s.replaces.map((r) => [r.old.id, r.row.id]), [[a, ab!.id]]);
  assert.deepEqual(s.chain.map((x) => [x.memory.id, x.here, x.current]), [[a, false, false], [b, true, false], [c, false, true]]);
  assert.deepEqual(s.chain.map((x) => x.replacedAt), [ab!.createdAt, bc!.createdAt, null]);
  assert.deepEqual(s.events.map((e) => e.type), ['replaced', 'edit']);
  advance(1);
  service.undoSupersession(bc!.id, owner);
  advance(1);
  service.supersede([b], c, owner);
  s = factStory(store, b);
  assert.deepEqual(s.events.map((e) => e.type), ['replaced', 'brought-back', 'replaced', 'edit']);
  assert.deepEqual(factStory(store, c).chain.map((x) => x.memory.id), [a, b, c]);
});

test('a deleted step stays in the chain', async () => {
  const { store, service, advance, save } = world();
  const a = await save('Labels use Futura');
  advance(1);
  const b = await save('Labels use Avenir');
  advance(1);
  const c = await save('Labels use Gill Sans');
  service.supersede([a], b, owner);
  service.supersede([b], c, owner);
  service.forget(b, owner);
  const s = factStory(store, a);
  assert.deepEqual(s.chain.map((x) => [x.memory.id, x.memory.deletedAt !== null]), [[a, false], [b, true], [c, false]]);
  assert.equal(s.replacedBy!.end!.id, c);
  assert.deepEqual(factStory(store, c).replaces, []);
  const alone = factStory(store, (store.list({ project: 'wildlog' })[0])!.id);
  assert.ok(alone);
});

test('a fact that stands alone has an empty chain', async () => {
  const { store, save } = world();
  const a = await save('Bottles are grouped by rack and shelf');
  const s = factStory(store, a);
  assert.deepEqual([s.replacedBy, s.replaces, s.chain, s.events], [null, [], [], []]);
});
