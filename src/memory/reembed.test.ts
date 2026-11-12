import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../db.js';
import { GrowthStore } from '../growth/store.js';
import { MemoryStore } from './store.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import type { Embedder } from './embedder.js';
import { E5_PROFILE, GEMMA_PROFILE } from './embeddingProfile.js';
import { ensureEmbeddings, staleOverrides, storedModel } from './reembed.js';
import { makePages } from '../testing/helpers.js';
import { MemoryService } from './service.js';

const now = () => new Date('2026-11-11T12:00:00Z');

/** A 768-long stand-in for Gemma: the fake e5 vector twice, normalised; counts the texts it was asked for. */
function fakeGemma(failAt = Infinity): Embedder & { texts: string[] } {
  const e5 = createFakeEmbedder();
  const g = {
    texts: [] as string[],
    async embed(text: string, purpose: 'query' | 'passage') {
      g.texts.push(text);
      if (g.texts.length >= failAt) throw new Error('model crashed');
      const v = await e5.embed(text, purpose);
      const out = new Float32Array(768); out.set(v, 0); out.set(v, 384);
      return out.map((x) => x / Math.SQRT2);
    },
  };
  return g;
}

const dims = (db: DB, table: string) => [...new Set((db.prepare(`SELECT embedding FROM ${table}`).all() as { embedding: Buffer }[]).map((r) => r.embedding.byteLength / 4))];

/** A brain on disk with e5-sized vectors in facts (one deleted), two page sections, an observation and a meaning link. */
async function brain(t: { after(f: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'reembed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const db = openDb(path);
  const store = new MemoryStore(db, now);
  const e5 = createFakeEmbedder();
  for (const c of ['NAS is mounted at /mnt/nas', 'casa uses SQLite', 'an old fact']) {
    store.insert({ kind: 'decision', content: c, project: 'home', tags: [], embedding: await e5.embed(c, 'passage'), by: 'x' });
  }
  db.prepare("UPDATE memories SET deleted_at = '2026-11-10T00:00:00Z', deleted_by = 'x' WHERE content = 'an old fact'").run();
  const service = new MemoryService(store, e5, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  await makePages({ db, store, service }, now).create({ title: 'Home lab', project: 'home', body: '## Disks\nThe NAS.\n\n## Network\nThe router.' }, 'owner');
  new GrowthStore(db, now).insert({ kind: 'strength', area: 'testing', project: 'home', summary: 'Wrote the test first', practise: null, embedding: await e5.embed('Wrote the test first', 'passage'), by: 'x' });
  db.prepare("INSERT INTO meaning_links(a_kind, a_id, b_kind, b_id, similarity) VALUES ('m', 'a', 'm', 'b', 0.9)").run();
  db.prepare("INSERT INTO meaning_indexed(kind, id, fingerprint, indexed_at) VALUES ('m', 'a', 'f', '2026-11-10')").run();
  return { dir, path, db };
}

test('same model: nothing copied, nothing written', async (t) => {
  const b = await brain(t);
  assert.deepEqual(await ensureEmbeddings(b.db, b.path, createFakeEmbedder(), E5_PROFILE), { reembedded: false });
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 }, 'a brain with 384-long vectors and no stamp is e5');
  assert.equal(existsSync(join(b.dir, 'pre-migrate')), false);
  assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM meaning_links').get() as { n: number }).n, 1);
});

test('e5 → gemma: every vector rebuilt in one go, the meaning index emptied, the stamp moved, a copy kept', async (t) => {
  const b = await brain(t);
  const g = fakeGemma();
  const lines: string[] = [];
  const r = await ensureEmbeddings(b.db, b.path, g, GEMMA_PROFILE, (l) => lines.push(l));
  assert.equal(r.reembedded, true);
  assert.deepEqual(r.reembedded && [r.from, r.facts, r.sections, r.observations], ['e5', 3, 2, 1]);
  for (const table of ['memories', 'page_sections', 'observations']) assert.deepEqual(dims(b.db, table), [768], table);
  assert.ok(g.texts.includes('an old fact'), 'deleted facts too (undo and history read them)');
  assert.ok(g.texts.some((x) => x.startsWith('Home lab — Disks\n')), 'sections are embedded as the page service embeds them');
  assert.deepEqual(storedModel(b.db), { model: 'gemma', dim: 768 });
  assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM meaning_links').get() as { n: number }).n, 0);
  assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM meaning_indexed').get() as { n: number }).n, 0);
  const copies = readdirSync(join(b.dir, 'pre-migrate')).filter((f) => /^pre-reembed-e5-to-gemma-\d{8}-\d{6}\.db$/.test(f));
  assert.equal(copies.length, 1);
  const old = openDb(join(b.dir, 'pre-migrate', copies[0]!));
  assert.deepEqual(dims(old, 'memories'), [384], 'the copy is the brain before the change');
  old.close();
  assert.ok(lines.some((l) => /re-embedding 3 facts, 2 page sections and 1 observation/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /done in/.test(l)));
});

test('a model that fails partway leaves the brain entirely on the old model', async (t) => {
  const b = await brain(t);
  await assert.rejects(ensureEmbeddings(b.db, b.path, fakeGemma(3), GEMMA_PROFILE), /model crashed/);
  for (const table of ['memories', 'page_sections', 'observations']) assert.deepEqual(dims(b.db, table), [384], table);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 });
  assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM meaning_links').get() as { n: number }).n, 1);
  const again = await ensureEmbeddings(b.db, b.path, fakeGemma(), GEMMA_PROFILE);
  assert.equal(again.reembedded, true, 'the next start tries again');
});

test('a vector of the wrong length from the model stops the change before anything is written', async (t) => {
  const b = await brain(t);
  await assert.rejects(ensureEmbeddings(b.db, b.path, createFakeEmbedder(), GEMMA_PROFILE), /384.*768|768.*384/);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 });
});

test('gemma → e5 (rollback) rebuilds back to e5', async (t) => {
  const b = await brain(t);
  await ensureEmbeddings(b.db, b.path, fakeGemma(), GEMMA_PROFILE);
  const r = await ensureEmbeddings(b.db, b.path, createFakeEmbedder(), E5_PROFILE);
  assert.equal(r.reembedded && r.from, 'gemma');
  for (const table of ['memories', 'page_sections', 'observations']) assert.deepEqual(dims(b.db, table), [384], table);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 });
});

test('a new, empty brain takes the configured model without re-embedding', async () => {
  const db = openDb(':memory:');
  assert.equal(storedModel(db), null);
  const g = fakeGemma();
  assert.deepEqual(await ensureEmbeddings(db, ':memory:', g, GEMMA_PROFILE), { reembedded: false });
  assert.deepEqual(storedModel(db), { model: 'gemma', dim: 768 });
  assert.equal(g.texts.length, 0);
});

test('an existing brain is stamped e5 by the migration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reembed-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const old = openDb(path, { upTo: 32 });
  new MemoryStore(old, now).insert({ kind: 'decision', content: 'x', project: null, tags: [], embedding: new Float32Array(384), by: 'x' });
  old.close();
  const db = openDb(path);
  assert.deepEqual(storedModel(db), { model: 'e5', dim: 384 });
  db.close();
});

test('settings tuned for the old model are named when the model changed', () => {
  assert.deepEqual(staleOverrides({ MIN_RECALL_SIMILARITY: '0.75', RECALL_WINDOW: '0.015', PORT: '3000' }, 'e5'), [
    'warning: MIN_RECALL_SIMILARITY is set and was tuned for e5; check it',
    'warning: RECALL_WINDOW is set and was tuned for e5; check it',
  ]);
  assert.deepEqual(staleOverrides({ PORT: '3000' }, 'e5'), []);
});

test('a rebuild cut short keeps its progress: the next start embeds only what is left', async (t) => {
  const b = await brain(t);
  // 6 texts: 3 facts, 2 sections, 1 observation. Batches of 2, the 5th text fails (a kill, a crash).
  await assert.rejects(ensureEmbeddings(b.db, b.path, fakeGemma(5), GEMMA_PROFILE, () => {}, { batch: 2 }), /model crashed/);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 }, 'nothing switched yet');
  for (const table of ['memories', 'page_sections', 'observations']) assert.deepEqual(dims(b.db, table), [384], table);
  const second = fakeGemma();
  const r = await ensureEmbeddings(b.db, b.path, second, GEMMA_PROFILE, () => {}, { batch: 2 });
  assert.equal(r.reembedded, true);
  assert.equal(second.texts.length, 2, 'the 4 texts done before the stop are not embedded again');
  for (const table of ['memories', 'page_sections', 'observations']) assert.deepEqual(dims(b.db, table), [768], table);
  assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM embedding_staging').get() as { n: number }).n, 0, 'the staged vectors are cleared');
});

test('a fact edited between two attempts is embedded again with its new text', async (t) => {
  const b = await brain(t);
  await assert.rejects(ensureEmbeddings(b.db, b.path, fakeGemma(5), GEMMA_PROFILE, () => {}, { batch: 2 }), /model crashed/);
  b.db.prepare("UPDATE memories SET content = 'NAS is mounted at /mnt/storage' WHERE content = 'NAS is mounted at /mnt/nas'").run();
  const second = fakeGemma();
  await ensureEmbeddings(b.db, b.path, second, GEMMA_PROFILE, () => {}, { batch: 2 });
  assert.ok(second.texts.includes('NAS is mounted at /mnt/storage'));
});

test('a vector of the old size written during the rebuild makes the switch roll back, never mixes sizes', async (t) => {
  const b = await brain(t);
  const g = fakeGemma();
  const sneaky = {
    async embed(text: string, purpose: 'query' | 'passage') {
      const v = await g.embed(text, purpose);
      // Another process (a CLI, an older server) saves a fact with e5 while the rebuild computes.
      if (g.texts.length === 6) new MemoryStore(b.db, now).insert({ kind: 'decision', content: 'saved meanwhile', project: null, tags: [], embedding: new Float32Array(384), by: 'x' });
      return v;
    },
  };
  await assert.rejects(ensureEmbeddings(b.db, b.path, sneaky, GEMMA_PROFILE, () => {}), /changed while/);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 });
  assert.deepEqual(dims(b.db, 'memories'), [384]);
  const r = await ensureEmbeddings(b.db, b.path, fakeGemma(), GEMMA_PROFILE, () => {});
  assert.equal(r.reembedded && r.facts, 4, 'the next start finishes, the new fact included');
  assert.deepEqual(dims(b.db, 'memories'), [768]);
});

test('progress is logged as the rebuild goes', async (t) => {
  const b = await brain(t);
  const lines: string[] = [];
  await ensureEmbeddings(b.db, b.path, fakeGemma(), GEMMA_PROFILE, (l) => lines.push(l), { batch: 2, progressEvery: 2 });
  for (const n of [2, 4, 6]) assert.ok(lines.some((l) => l === `re-embedding: ${n} of 6`), lines.join('\n'));
});
