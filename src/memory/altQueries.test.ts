import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import type { Embedder } from './embedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

const owner = { type: 'owner' } as const;

/** The fake embedder, recording every text it is asked to embed. */
function spy(): Embedder & { texts: string[] } {
  const inner = createFakeEmbedder();
  const e = { texts: [] as string[], async embed(text: string, purpose: 'query' | 'passage') { e.texts.push(text); return inner.embed(text, purpose); } };
  return e;
}

async function brain() {
  const embedder = spy();
  const store = new MemoryStore(openDb(':memory:'), () => new Date());
  const service = new MemoryService(store, embedder, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const save = async (content: string, project: string) => ((await service.remember({ kind: 'decision', content, project }, owner)) as any).memory.id as string;
  const nas = await save('The NAS is mounted at /mnt/storage on the small server', 'home');
  await save('Tomatoes go in the greenhouse in April', 'garden');
  embedder.texts.length = 0;
  return { service, embedder, nas };
}

const ids = (hits: { memory: { id: string } }[]) => hits.map((h) => h.memory.id);

test('a fact only the English phrasing matches is found for a Spanish question', async () => {
  const { service, nas } = await brain();
  const q = '¿dónde está montado el almacenamiento?';
  assert.ok(!ids(await service.recall({ query: q, touch: false })).includes(nas));
  assert.equal(ids(await service.recall({ query: q, alt: ['where is the NAS mounted?'], touch: false }))[0], nas);
});

test('blank phrasings, ones equal to the query and any beyond two are ignored; a long one is cut to 300 characters', async () => {
  const { service, embedder } = await brain();
  await service.recall({ query: 'garden plans', alt: ['', '   ', ' garden plans ', 'first', 'second', 'third'], touch: false });
  assert.deepEqual(embedder.texts, ['garden plans', 'first', 'second']);
  embedder.texts.length = 0;
  await service.recall({ query: 'garden plans', alt: ['x'.repeat(400)], touch: false });
  assert.equal(embedder.texts[1]!.length, 300);
});

test("a read-only grant still applies to what a phrasing finds", async () => {
  const { service, nas } = await brain();
  const hits = await service.recall({ query: '¿dónde?', alt: ['where is the NAS mounted?'], projects: ['garden'], touch: false });
  assert.ok(!ids(hits).includes(nas));
});

test('a fact found only through a phrasing is marked recalled like any sure hit', async () => {
  const { service, nas } = await brain();
  await service.recall({ query: '¿dónde está montado?', alt: ['where is the NAS mounted?'] });
  assert.notEqual(service.get(nas)!.lastRecalledAt, null);
});
