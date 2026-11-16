import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../db.js';
import { cosine, type Embedder } from '../memory/embedder.js';
import { E5_PROFILE, GEMMA_PROFILE } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { storedModel } from '../memory/reembed.js';
import type { Reranker } from '../memory/reranker.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { ProjectStore } from '../projects/store.js';
import { MeaningIndex } from '../graph/threads.js';
import { activeCutOffs, memoryCutOffs } from './cutOffs.js';
import { rereadInBackground, SwitchableEmbedder, SwitchableReranker } from './switchable.js';

const owner = { type: 'owner' } as const;
const claude = { type: 'ai', name: 'Claude' } as const;

/**
 * The fake embedder with a small vocabulary of synonyms: "veggies" means "vegetables", so a question can match a fact
 * by meaning only, with no word in common for the keyword search.
 */
function vocabulary(): Embedder {
  const fake = createFakeEmbedder();
  const SAME: Record<string, string> = { veggies: 'vegetables', greens: 'vegetables', bike: 'bicycle' };
  return { embed: (text, purpose) => fake.embed(text.split(/\s+/).map((w) => SAME[w.toLowerCase()] ?? w).join(' '), purpose) };
}

/** A 768-long stand-in for Gemma on the same vocabulary; counts its texts; `gate` holds the embed after `at` texts. */
function fakeGemma(o: { at?: number } = {}) {
  const base = vocabulary();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  const g = {
    texts: [] as string[], release, waiting,
    async embed(text: string, purpose: 'query' | 'passage') {
      if (o.at !== undefined && g.texts.length === o.at) { reached(); await gate; }
      g.texts.push(text);
      const v = await base.embed(text, purpose);
      const out = new Float32Array(768); out.set(v, 0); out.set(v, 384);
      return out.map((x) => x / Math.SQRT2);
    },
  };
  return g;
}

const dims = (db: DB) => [...new Set((db.prepare('SELECT embedding FROM memories').all() as { embedding: Buffer }[]).map((r) => r.embedding.byteLength / 4))];
const pending = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM embedding_pending').get() as { n: number }).n;

function brain(o: { reranker?: Reranker; keywordWeight?: number } = {}) {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-13T10:00:00Z');
  const store = new MemoryStore(db, () => new Date(t += 60_000));
  const embedder = new SwitchableEmbedder(db, GEMMA_PROFILE);
  const service = new MemoryService(store, embedder, {
    duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2, keywordWeight: o.keywordWeight ?? 0, reranker: o.reranker,
  });
  const recall = async (query: string) => (await service.recall({ query, touch: false })).map((r) => r.memory.content);
  return { db, store, embedder, service, recall };
}

test('cosine of a zero vector with anything is 0, never NaN, even against a vector of another length', async () => {
  const v = await createFakeEmbedder().embed('Alex waters the tomatoes', 'passage');
  assert.equal(cosine(new Float32Array(384), v), 0);
  assert.equal(cosine(v, new Float32Array(384)), 0);
  assert.equal(cosine(new Float32Array(384), new Float32Array(384)), 0);
  assert.equal(cosine(new Float32Array(768), v), 0, 'a placeholder saved before a model change is never compared as a mistake');
  assert.throws(() => cosine(new Float32Array(768).fill(0.1), v), /different lengths/, 'two real vectors from two models still fail loudly');
});

test('not ready: a save is kept and found by its words, never by meaning, with no duplicate warning and no error', async () => {
  const b = brain();
  assert.equal(b.embedder.ready(), false);
  assert.equal(b.embedder.profile(), null);
  const first = await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, claude);
  assert.equal(first.status, 'saved');
  const again = await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, claude);
  assert.equal(again.status, 'saved', 'no meaning, so no duplicate check');
  assert.deepEqual(dims(b.db), [GEMMA_PROFILE.dim], 'an empty brain gets placeholders of the size the configured model makes');
  assert.equal(pending(b.db), 2, 'both are waiting for a model');
  assert.deepEqual(await b.recall('raised beds'), ['Alex grows vegetables in raised beds', 'Alex grows vegetables in raised beds'],
    'keywords answer even though the profile gives them no weight');
  assert.deepEqual(await b.recall('veggies'), [], 'nothing by meaning');
  const scores = (await b.service.recall({ query: 'raised beds', touch: false })).map((r) => r.score);
  assert.ok(scores.every((x) => x > 0), `a keyword rank counts fully while meaning is off (${scores.join(', ')})`);
});

test('a question vector of another length than the stored ones searches by keywords instead of failing', async () => {
  const db = openDb(':memory:');
  const store = new MemoryStore(db, () => new Date('2026-11-13T10:00:00Z'));
  const gemma = fakeGemma();
  for (const c of ['The garden-club-site runs on SQLite', 'Alex grows vegetables in raised beds']) {
    store.insert({ kind: 'decision', content: c, project: 'garden-club-site', tags: [], embedding: await gemma.embed(c, 'passage'), by: 'x' });
  }
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  assert.deepEqual((await service.recall({ query: 'SQLite', touch: false })).map((r) => r.memory.content), ['The garden-club-site runs on SQLite']);
});

test('switching to a model: what was saved while not ready is found by meaning, and nothing is left waiting', async () => {
  const b = brain();
  await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, owner);
  const lines: string[] = [];
  const model = vocabulary();
  await rereadInBackground(b.db, ':memory:', model, E5_PROFILE, (l) => lines.push(l), { into: b.embedder });
  assert.equal(b.embedder.ready(), true);
  assert.equal(b.embedder.profile(), E5_PROFILE);
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 });
  assert.deepEqual(dims(b.db), [384]);
  assert.equal(pending(b.db), 0);
  assert.deepEqual(await b.recall('veggies'), ['Alex grows vegetables in raised beds']);
  const dup = await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, claude);
  assert.equal(dup.status, 'similar_exists', 'with a model the duplicate check is back');
});

test('a model change re-reads in the background: keywords answer meanwhile, an abort keeps the old model, a new run finishes', async () => {
  const b = brain();
  for (const c of ['Alex grows vegetables in raised beds', 'The garden-club-site runs on SQLite', 'Sam rides a bicycle to the allotment']) {
    await b.service.remember({ kind: 'decision', content: c, project: 'garden-club-site' }, owner);
  }
  await rereadInBackground(b.db, ':memory:', vocabulary(), E5_PROFILE, () => {}, { into: b.embedder });
  assert.equal(b.embedder.profile(), E5_PROFILE);

  // Gemma arrives: the re-read holds after two texts, so the server can be used meanwhile.
  const slow = fakeGemma({ at: 2 });
  const abort = new AbortController();
  const run = rereadInBackground(b.db, ':memory:', slow, GEMMA_PROFILE, () => {}, { signal: abort.signal, into: b.embedder });
  await slow.waiting;
  assert.equal(b.embedder.ready(), false, 'meaning is off while the re-read runs');
  assert.deepEqual(await b.recall('SQLite'), ['The garden-club-site runs on SQLite'], 'keywords still answer');
  assert.deepEqual(await b.recall('veggies'), [], 'no search by meaning, so never two models in one search');
  const saved = await b.service.remember({ kind: 'decision', content: 'The greenhouse needs new glass', project: 'garden-club-site' }, owner);
  assert.equal(saved.status, 'saved');
  abort.abort();
  slow.release();
  await assert.rejects(run, { name: 'AbortError' });
  assert.deepEqual(storedModel(b.db), { model: 'e5', dim: 384 }, 'the stamp moves only at the end');
  assert.deepEqual(dims(b.db), [384], 'nothing switched');
  assert.equal(b.embedder.ready(), true, 'back on the old model, which still matches every stored vector');
  assert.equal(pending(b.db), 1, 'the fact saved meanwhile waits for the next run');
  assert.equal(b.embedder.profile(), E5_PROFILE);
  assert.deepEqual(await b.recall('veggies'), ['Alex grows vegetables in raised beds']);

  const fast = fakeGemma();
  await rereadInBackground(b.db, ':memory:', fast, GEMMA_PROFILE, () => {}, { into: b.embedder });
  assert.equal(fast.texts.length, 1, 'the 3 facts embedded before the abort are kept: only the one saved meanwhile is embedded');
  assert.deepEqual(storedModel(b.db), { model: 'gemma', dim: 768 });
  assert.deepEqual(dims(b.db), [768]);
  assert.equal(pending(b.db), 0);
  assert.equal(b.embedder.profile(), GEMMA_PROFILE);
  assert.deepEqual(await b.recall('veggies'), ['Alex grows vegetables in raised beds']);
  assert.deepEqual(await b.recall('greenhouse glass'), ['The greenhouse needs new glass'], 'the fact saved during the re-read is on the new model too');
});

test('a switchable embedder on a model that does not match the stored vectors stays off: never two models in one search', async () => {
  const b = brain();
  await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, owner);
  await rereadInBackground(b.db, ':memory:', vocabulary(), E5_PROFILE, () => {}, { into: b.embedder });
  b.embedder.use(fakeGemma(), GEMMA_PROFILE);
  assert.equal(b.embedder.ready(), false, 'the brain is stamped e5');
  assert.equal((await b.embedder.embed('anything', 'query')).length, 384, 'placeholders keep the stored size');
  assert.deepEqual(await b.recall('veggies'), []);
});

test('SwitchableReranker: null keeps the search order; a reranker reorders; switching back to null keeps it again', async () => {
  const reranker = new SwitchableReranker();
  const b = brain({ reranker, keywordWeight: 0.5 });
  await rereadInBackground(b.db, ':memory:', createFakeEmbedder(), E5_PROFILE, () => {}, { into: b.embedder });
  for (let i = 0; i < 5; i++) await b.service.remember({ kind: 'decision', content: `garden shed roof paint coat ${i} in spring ${i}`, project: 'garden-club-site' }, owner);
  await b.service.remember({ kind: 'decision', content: 'the zebra note mentions the garden once', project: 'garden-club-site' }, owner);
  const plain = await b.recall('garden shed roof paint');
  assert.equal(plain.at(-1), 'the zebra note mentions the garden once');
  const reports: (number | null)[] = [];
  await b.service.recall({ query: 'garden shed roof paint', touch: false, report: (r) => reports.push(r.bestScore) });
  assert.deepEqual(reports, [null], 'no reranker ran');
  reranker.use({ async score(_q, texts) { return texts.map((t) => (t.includes('zebra') ? 1 : 0)); } });
  assert.equal((await b.recall('garden shed roof paint'))[0], 'the zebra note mentions the garden once');
  reranker.use(null);
  assert.deepEqual(await b.recall('garden shed roof paint'), plain);
});

test('pages: sections saved while not ready are found by their words, and a later save embeds them instead of keeping the placeholder', async () => {
  const b = brain();
  const now = () => new Date('2026-11-13T10:00:00Z');
  const pages = new PageService(new PageStore(b.db, now), b.embedder, b.service, new ProjectStore(b.db, now), b.store, now, { keywordWeight: 0 });
  const body = '## Beds\nAlex grows vegetables in raised beds.\n\n## Shed\nThe shed holds the tools.';
  const page = await pages.create({ title: 'Garden club', area: 'home', body }, 'owner');
  const sectionsWaiting = () => (b.db.prepare("SELECT COUNT(*) AS n FROM embedding_pending WHERE tbl = 's'").get() as { n: number }).n;
  assert.equal(sectionsWaiting(), 2);
  const search = async (text: string) => pages.search(text, await pages.embedQuery(text), 5, 0.2).map((h) => h.anchor);
  assert.deepEqual(await search('raised beds'), ['beds'], 'by keywords, though the profile gives them no weight');
  assert.deepEqual(await search('veggies'), []);
  // A model matching the placeholders' size, switched to without a re-read: a save embeds the unchanged sections.
  b.embedder.use(fakeGemma(), GEMMA_PROFILE);
  assert.equal(b.embedder.ready(), true);
  await pages.save(page.id, { base: page.version, title: 'Garden club', body: `${body}\n\n## Gate\nThe gate code is on the board.` }, 'owner');
  assert.equal(sectionsWaiting(), 0);
  assert.deepEqual(await search('veggies'), ['beds']);
});

/**
 * A stand-in for e5 on the same vocabulary: e5 puts almost every pair high (unrelated texts about 0.72 here, related
 * ones 0.8 and up), so Gemma's cut-offs would call everything similar.
 */
function fakeE5(): Embedder {
  const base = vocabulary();
  const shared = Math.sqrt(2.57);
  return {
    async embed(text, purpose) {
      const v = await base.embed(text, purpose);
      const out = new Float32Array(384);
      out[0] = shared; out.set(v.subarray(0, 383), 1);
      const norm = Math.hypot(...out);
      return out.map((x) => x / norm);
    },
  };
}

/** Configured for Gemma (the default), every cut-off read from the model in use. */
function liveBrain() {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-13T10:00:00Z');
  const now = () => new Date(t += 60_000);
  const store = new MemoryStore(db, now);
  const embedder = new SwitchableEmbedder(db, GEMMA_PROFILE);
  const cut = activeCutOffs({ embedModel: GEMMA_PROFILE, duplicateThreshold: GEMMA_PROFILE.duplicate, minRecallSimilarity: GEMMA_PROFILE.minRecall,
    recallConfidentSimilarity: GEMMA_PROFILE.confident, recallWindow: GEMMA_PROFILE.window }, () => embedder.profile());
  const service = new MemoryService(store, embedder, memoryCutOffs(cut, {}));
  const meaning = new MeaningIndex(db, { floor: () => cut().threadFloor, kinds: ['decision'], now });
  service.setMeaningHook(meaning);
  const recall = async (query: string) => (await service.recall({ query, touch: false })).map((r) => r.memory.content);
  return { db, store, embedder, service, meaning, recall };
}

test('switching models at runtime: every cut-off follows the model in use (gemma → e5 → gemma)', async () => {
  const b = liveBrain();
  await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, owner);
  // The welcome picks the Light model on a small computer.
  await rereadInBackground(b.db, ':memory:', fakeE5(), E5_PROFILE, () => {}, { into: b.embedder });
  assert.equal(b.embedder.profile(), E5_PROFILE);
  const other = await b.service.remember({ kind: 'decision', content: 'Alex paints the shed in spring', project: 'garden-club-site' }, claude);
  assert.equal(other.status, 'saved', 'a clearly different fact is not "similar" under e5\'s cut-off');
  assert.deepEqual(await b.recall('tax return deadline'), [], 'nothing unrelated passes e5\'s floor');
  assert.deepEqual(await b.recall('veggies'), ['Alex grows vegetables in raised beds']);
  // And back to the Balanced model.
  await rereadInBackground(b.db, ':memory:', fakeGemma(), GEMMA_PROFILE, () => {}, { into: b.embedder });
  assert.equal(b.embedder.profile(), GEMMA_PROFILE);
  assert.deepEqual(await b.recall('veggies'), ['Alex grows vegetables in raised beds'], 'found by meaning under Gemma\'s floor');
});

test('after a switch the graph\'s threads are rebuilt with the new vectors', async () => {
  const b = liveBrain();
  await b.service.remember({ kind: 'decision', content: 'raised beds hold vegetables for Alex', project: 'garden-club-site' }, owner);
  await b.service.remember({ kind: 'decision', content: 'raised beds hold vegetables for Sam', project: 'allotment-rota' }, owner);
  const links = () => (b.db.prepare('SELECT COUNT(*) AS n FROM meaning_links').get() as { n: number }).n;
  assert.equal(links(), 0, 'placeholders link nothing');
  await rereadInBackground(b.db, ':memory:', fakeE5(), E5_PROFILE, () => {}, { into: b.embedder, onSwitched: () => b.meaning.catchUp() });
  assert.equal(links(), 1);
  await rereadInBackground(b.db, ':memory:', fakeGemma(), GEMMA_PROFILE, () => {}, { into: b.embedder, onSwitched: () => b.meaning.catchUp() });
  assert.equal(links(), 1, 'emptied by the re-embed, rebuilt after the switch');
  assert.equal((await b.meaning.catchUp()).indexed, 0, 'every item already indexed with the new vectors');
});

test('an abort that comes once the vectors have switched is too late: the run finishes and the embedder switches', async () => {
  const b = brain();
  await b.service.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, owner);
  await rereadInBackground(b.db, ':memory:', vocabulary(), E5_PROFILE, () => {}, { into: b.embedder });
  // A save that lands right after the switch (a placeholder of the new size), when the abort has just come.
  b.db.exec(`CREATE TEMP TRIGGER save_after_switch AFTER INSERT ON embedding_model WHEN NEW.model = 'gemma' BEGIN
    INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
      VALUES ('late', 'decision', 'The greenhouse needs new glass', 'garden-club-site', '[]', zeroblob(768 * 4), 'x', 'owner', 'x', 'owner');
  END`);
  const abort = new AbortController();
  const g = fakeGemma();
  const aborting = { embed: async (text: string, purpose: 'query' | 'passage') => { const v = await g.embed(text, purpose); if (text.startsWith('Alex')) abort.abort(); return v; } };
  const r = await rereadInBackground(b.db, ':memory:', aborting, GEMMA_PROFILE, () => {}, { signal: abort.signal, into: b.embedder });
  assert.equal(r.pending, 1);
  assert.equal(b.embedder.ready(), true);
  assert.equal(b.embedder.profile(), GEMMA_PROFILE);
  assert.equal(pending(b.db), 0);
});
