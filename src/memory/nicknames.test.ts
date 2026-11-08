import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { ProjectStore } from '../projects/store.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

const owner = { type: 'owner' } as const;

/**
 * Fifteen facts of other projects share two of the question's words; the one vino-db fact shares only "labels", and
 * names its project as facts do ("<project>: ...").
 */
async function setup() {
  const ctx = makeService();
  const registry = new ProjectStore(ctx.db, () => new Date());
  const save = async (content: string, project: string) =>
    ((await ctx.service.remember({ kind: 'decision', content, project, allowDuplicate: true, newProject: true }, owner)) as { memory: { id: string } }).memory.id;
  for (let i = 0; i < 15; i++) await save(`the shop prints price labels and receipts for counter ${i}`, i % 2 ? 'shop' : 'till');
  const target = await save('vino-db: bottle labels come out in two sizes now', 'vino-db');
  return { ...ctx, registry, target, save };
}

const rankOf = (hits: { memory: { id: string } }[], id: string) => { const i = hits.findIndex((h) => h.memory.id === id); return i < 0 ? null : i + 1; };

test("a question naming a project by its nickname finds the facts that use the project's real name", async () => {
  const { service, registry, target } = await setup();
  const q = 'is the cellar app finished printing labels?';
  const before = rankOf(await service.recall({ query: q, limit: 20, touch: false, rerank: false }), target);
  assert.ok(before === null || before > 8, `without a nickname it ranks ${before}`);
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  const after = rankOf(await service.recall({ query: q, limit: 20, touch: false, rerank: false }), target);
  // Into recall's default 8 by the search alone; the reranker then scores the real-name phrasing too (see below).
  assert.ok(after !== null && after <= 8, `with the nickname it ranks ${after}`);
});

test('namedProjects finds names, aliases and nicknames as whole words, longest first, at most two', async () => {
  const { service, registry, db } = await setup();
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  db.prepare("INSERT INTO project_aliases(alias, project, added_at, added_by) VALUES ('counter-app', 'till', 'x', 'owner')").run();
  assert.deepEqual(service.namedProjects('Is the Cellar App done?'), ['vino-db']);
  assert.deepEqual(service.namedProjects('the cellar apples'), []);
  assert.deepEqual(service.namedProjects('vino db and the counter app and the shop'), ['till', 'vino-db']);
  assert.deepEqual(service.namedProjects('the cellar app', ['shop']), []);
});

test('a project named with a common word does not drag its facts into an unrelated question', async () => {
  const { service, save } = await setup();
  const backup = await save('the nightly backup copies the database to the NAS at three', 'backups');
  for (let i = 0; i < 6; i++) await save(`work meeting notes number ${i} about the quarterly plan`, 'work');
  const hits = await service.recall({ query: 'how does the nightly backup work?', limit: 8, touch: false, rerank: false });
  assert.equal(hits[0]!.memory.id, backup);
});

test('a read-only search never reaches a project outside its grant through a nickname', async () => {
  const { service, registry, target } = await setup();
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  const hits = await service.recall({ query: 'is the cellar app finished printing labels?', projects: ['shop'], limit: 20, touch: false, rerank: false });
  assert.equal(rankOf(hits, target), null);
  assert.ok(hits.every((h) => h.memory.project === 'shop'));
});

test('a project filter turns the lane off: the filter already chose the project', async () => {
  const { service, registry } = await setup();
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  const hits = await service.recall({ query: 'is the cellar app finished printing labels?', project: 'shop', limit: 20, touch: false, rerank: false });
  assert.ok(hits.length > 0 && hits.every((h) => h.memory.project === 'shop'));
});

test("only aliases and nicknames open the lane: a project's own name already matches through keywords", async () => {
  const { service, registry } = await setup();
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  assert.deepEqual(service.namedProjects('the shop and the cellar app', undefined, false), ['vino-db']);
});

test('a nickname in the question adds the question with the project\'s real name as a phrasing, also for the reranker', async () => {
  const { db, registry } = await setup();
  const queries: string[] = [];
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  const service = new MemoryService(new MemoryStore(db, () => new Date()), createFakeEmbedder(), {
    duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2,
    reranker: { async score(q, t) { queries.push(q); return t.map(() => 0); } },
  });
  await service.recall({ query: 'is the cellar app finished printing labels?', touch: false });
  assert.deepEqual(queries, ['is the cellar app finished printing labels?', 'is the cellar app finished printing labels? (vino-db)']);
});

test('the real-name phrasing is skipped when a given phrasing already names the project, and counts toward the two', async () => {
  const { db, registry } = await setup();
  registry.setInfo('vino-db', { nicknames: ['cellar app'] }, 'owner');
  const queries: string[] = [];
  const service = new MemoryService(new MemoryStore(db, () => new Date()), createFakeEmbedder(), {
    duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2,
    reranker: { async score(q, t) { queries.push(q); return t.map(() => 0); } },
  });
  const q = 'is the cellar app finished printing labels?';
  await service.recall({ query: q, alt: ['is vino-db finished printing labels?'], touch: false });
  assert.deepEqual(queries, [q, 'is vino-db finished printing labels?']);
  queries.length = 0;
  await service.recall({ query: q, alt: ['first other phrasing about labels', 'second other phrasing about labels'], touch: false });
  assert.deepEqual(queries, [q, `${q} (vino-db)`, 'first other phrasing about labels']);
});

test("merging a project into another keeps the merged project's nicknames", async () => {
  const { service, registry } = await setup();
  registry.setInfo('till', { nicknames: ['the counter'] }, 'owner');
  registry.setInfo('shop', { nicknames: ['the store'] }, 'owner');
  service.addAlias('till', 'shop', { type: 'owner' });
  assert.deepEqual(registry.get('shop')!.nicknames, ['the store', 'the counter']);
});
