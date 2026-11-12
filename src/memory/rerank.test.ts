import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import type { Reranker } from './reranker.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

const owner = { type: 'owner' } as const;

/** Scores 1 for a text containing `word`, 0 otherwise; counts its calls. */
function prefers(word: string): Reranker & { calls: number } {
  const r = { calls: 0, async score(_q: string, texts: string[]) { r.calls++; return texts.map((t) => (t.includes(word) ? 1 : 0)); } };
  return r;
}

/** Scores 0.5 for a text containing `word`, 0 otherwise: a small preference the search-order prior can outweigh. */
function leansTo(word: string): Reranker {
  return { async score(_q: string, texts: string[]) { return texts.map((t) => (t.includes(word) ? 0.5 : 0)); } };
}

function brain(reranker?: Reranker, rerankPrior?: number) {
  let t = Date.parse('2026-10-20T10:00:00Z');
  const store = new MemoryStore(openDb(':memory:'), () => new Date(t));
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2, reranker, rerankPrior });
  const save = async (content: string, project = 'garden', kind: 'decision' | 'summary' | 'roadmap' = 'decision') => {
    t += 86_400_000;
    const r = await service.remember({ kind, content, project }, owner) as any;
    assert.ok(r.status === 'saved' || r.status === 'roadmap_updated', r.status);
    return r.memory.id as string;
  };
  return { store, service, save };
}

/** 14 facts that share every query word, then one that shares only one: the search ranks that one last. */
async function fifteen(b: ReturnType<typeof brain>) {
  for (let i = 0; i < 14; i++) await b.save(`garden shed roof paint coat ${i} goes on in spring ${i}`);
  return b.save('the zebra note mentions the garden once');
}
const QUERY = 'garden shed roof paint';

test('recall returns the reranker\'s order: the fact the search ranked last comes first', async () => {
  const plain = brain();
  const last = await fifteen(plain);
  const before = (await plain.service.recall({ query: QUERY, limit: 20, touch: false })).map((r) => r.memory.id);
  assert.equal(before.at(-1), last, 'the search alone ranks the zebra note last');
  const b = brain(prefers('zebra'));
  const zebra = await fifteen(b);
  const got = await b.service.recall({ query: QUERY, limit: 3, touch: false });
  assert.equal(got.length, 3);
  assert.equal(got[0]!.memory.id, zebra, 'with a limit of 3 the reranker still reaches the 15th match');
});

test('recall marks as recalled only the facts it returns, never pool members it cut', async () => {
  const b = brain(prefers('zebra'));
  const zebra = await fifteen(b);
  const got = await b.service.recall({ query: QUERY, limit: 3 });
  const kept = new Set(got.map((r) => r.memory.id));
  assert.ok(kept.has(zebra));
  const marked = b.store.list({ project: 'garden', limit: 50 }).filter((m) => m.lastRecalledAt !== null).map((m) => m.id);
  assert.deepEqual(marked.sort(), [...kept].sort());
});

test('a reranker that fails leaves the search\'s own order, and recall still answers', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: string) => { errors.push(String(m)); });
  const plain = brain();
  await fifteen(plain);
  const want = (await plain.service.recall({ query: QUERY, limit: 8, touch: false })).map((r) => r.memory.content);
  const b = brain({ async score() { throw new Error('model gone'); } });
  await fifteen(b);
  const got = (await b.service.recall({ query: QUERY, limit: 8, touch: false })).map((r) => r.memory.content);
  assert.deepEqual(got, want);
  assert.ok(errors.some((e) => e.includes('reranker failed: model gone')), errors.join('|'));
});

test('rerank: false skips the reranker and keeps the search\'s order', async () => {
  const plain = brain();
  await fifteen(plain);
  const want = (await plain.service.recall({ query: QUERY, limit: 8, touch: false })).map((r) => r.memory.content);
  const r = prefers('zebra');
  const b = brain(r);
  await fifteen(b);
  const got = (await b.service.recall({ query: QUERY, limit: 8, touch: false, rerank: false })).map((x) => x.memory.content);
  assert.deepEqual(got, want);
  assert.equal(r.calls, 0);
});

test('the pinned roadmap and status stay first, and replaced facts still follow, after reranking', async () => {
  const b = brain(prefers('photos'));
  await b.save('Now: cellar import\nNext: labels', 'wildlog', 'roadmap');
  await b.save('wildlog status: the cellar import is half done', 'wildlog', 'summary');
  for (const w of ['csv', 'barcodes', 'photos', 'regions']) await b.save(`wildlog cellar import reads ${w} from the old spreadsheet`, 'wildlog');
  const old = await b.save('wildlog cellar import goes through Cellarium', 'wildlog');
  const now = await b.save('wildlog drinking windows are typed by hand', 'wildlog');
  b.service.supersede([old], now, owner);
  const r = await b.service.recall({ query: 'how is wildlog going?', limit: 3, touch: false, replaced: 'include' });
  const current = r.filter((x) => !x.replaced);
  assert.deepEqual(current.map((x) => x.memory.kind), ['roadmap', 'summary', 'decision']);
  assert.match(current[2]!.memory.content, /photos/);
  assert.deepEqual(r.filter((x) => x.replaced).map((x) => x.memory.id), [old]);
  assert.equal(r.at(-1)!.memory.id, old);
});

test("with another phrasing, the reranker scores each phrasing and a fact keeps its best score", async () => {
  const seen: string[] = [];
  const reranker: Reranker = { async score(q, texts) { seen.push(q); return texts.map((t) => (q.includes('zebra') && t.includes('zebra') ? 1 : 0)); } };
  const b = brain(reranker);
  const last = await fifteen(b);
  const hits = await b.service.recall({ query: QUERY, alt: ['the zebra note'], limit: 8, touch: false });
  assert.equal(hits[0]!.memory.id, last);
  assert.deepEqual(seen, [QUERY, 'the zebra note']);
});

test('a reranker that fails with another phrasing still gives the search order', async (t) => {
  t.mock.method(console, 'error', () => {});
  const failing: Reranker = { async score() { throw new Error('model gone'); } };
  const plain = brain();
  await fifteen(plain);
  const expected = (await plain.service.recall({ query: QUERY, alt: ['the zebra note'], limit: 8, touch: false })).map((r) => r.memory.content);
  const b = brain(failing);
  await fifteen(b);
  assert.deepEqual((await b.service.recall({ query: QUERY, alt: ['the zebra note'], limit: 8, touch: false })).map((r) => r.memory.content), expected);
});

test("recall reports the reranker's best score over all phrasings, or null when it did not run", async (t) => {
  const scoring: Reranker = { async score(q, texts) { return texts.map((_, i) => (q.includes('zebra') ? 3 : -5) - i); } };
  const b = brain(scoring);
  await fifteen(b);
  const seen: (number | null)[] = [];
  await b.service.recall({ query: QUERY, touch: false, report: (r) => seen.push(r.bestScore) });
  await b.service.recall({ query: QUERY, alt: ['the zebra note'], touch: false, report: (r) => seen.push(r.bestScore) });
  await b.service.recall({ query: QUERY, rerank: false, touch: false, report: (r) => seen.push(r.bestScore) });
  t.mock.method(console, 'error', () => {});
  const failing = brain({ async score() { throw new Error('gone'); } });
  await fifteen(failing);
  await failing.service.recall({ query: QUERY, touch: false, report: (r) => seen.push(r.bestScore) });
  assert.deepEqual(seen, [-5, 3, null, null]);
});

test('a recall with a single match still asks the reranker for its score, so a weak one is known', async () => {
  const seen: (number | null)[] = [];
  const b = brain({ async score(_q, t) { return t.map(() => -5); } });
  await b.save('the zebra note mentions the garden once');
  await b.save('tomatoes go in the greenhouse in april');
  const hits = await b.service.recall({ query: 'zebra note', touch: false, report: (r) => seen.push(r.bestScore) });
  assert.equal(hits.length, 1);
  assert.deepEqual(seen, [-5]);
});

test('a status question answered by the pinned status reports no reranker score, so it never gets the weak note', async () => {
  const seen: (number | null)[] = [];
  const b = brain({ async score(_q, t) { return t.map(() => -5); } });
  await b.save('Now: cellar import\nNext: labels', 'wildlog', 'roadmap');
  await b.save('wildlog status: the cellar import is half done', 'wildlog', 'summary');
  for (const w of ['csv', 'barcodes']) await b.save(`wildlog cellar import reads ${w} from the old spreadsheet`, 'wildlog');
  const r = await b.service.recall({ query: 'how is wildlog going?', touch: false, report: (x) => seen.push(x.bestScore) });
  assert.equal(r[0]!.memory.kind, 'roadmap');
  assert.deepEqual(seen, [null]);
});

test('isWholeProjectQuestion: only the project and how-is-it-going words make a whole-project question', async () => {
  const { isWholeProjectQuestion } = await import('./service.js');
  for (const q of ['how is wildlog going?', "what's the next step for wildlog?", '¿cómo va el proyecto wildlog?', 'wildlog status', 'what is left to do in the wildlog app?']) {
    assert.equal(isWholeProjectQuestion(q, ['wildlog']), true, q);
  }
  for (const q of ["what's the latest on wildlog's label printer?", '¿en qué punto está wildlog, qué trae la 0.2.2?', 'wildlog status of the barcode import']) {
    assert.equal(isWholeProjectQuestion(q, ['wildlog']), false, q);
  }
});

async function wildlog(b: ReturnType<typeof brain>) {
  const roadmap = await b.save('Now: cellar import\nNext: labels', 'wildlog', 'roadmap');
  const status = await b.save('wildlog status: the cellar import is half done', 'wildlog', 'summary');
  const printer = await b.save('wildlog label printer prints two sizes of bottle labels', 'wildlog');
  for (const w of ['csv', 'barcodes']) await b.save(`wildlog cellar import reads ${w} from the old spreadsheet`, 'wildlog');
  return { roadmap, status, printer };
}

test('a current-state question about one part of a project gets that part first; the pinned facts compete', async () => {
  const b = brain(prefers('printer'));
  const { roadmap, status, printer } = await wildlog(b);
  const ids = (await b.service.recall({ query: "what's the latest on wildlog's label printer?", touch: false })).map((h) => h.memory.id);
  assert.equal(ids[0], printer);
  assert.ok(ids.includes(roadmap) && ids.includes(status));
  assert.equal(new Set(ids).size, ids.length);
});

test('a whole-project question keeps the roadmap and the newest status on top', async () => {
  const b = brain(prefers('printer'));
  const { roadmap, status } = await wildlog(b);
  const ids = (await b.service.recall({ query: 'how is wildlog going?', touch: false })).map((h) => h.memory.id);
  assert.deepEqual(ids.slice(0, 2), [roadmap, status]);
});

test('without a reranker, a current-state question about one part still pins as before', async () => {
  const b = brain();
  const { roadmap, status } = await wildlog(b);
  const ids = (await b.service.recall({ query: "what's the latest on wildlog's label printer?", touch: false })).map((h) => h.memory.id);
  assert.deepEqual(ids.slice(0, 2), [roadmap, status]);
});

test('isWholeProjectQuestion: everyday whole-project questions in both languages, and one part named inside how-is-it-going', async () => {
  const { isWholeProjectQuestion } = await import('./service.js');
  for (const q of ['¿qué queda por hacer en wildlog?', '¿cuál es el estado actual de wildlog?', '¿cómo va todo con wildlog?', '¿cómo va wildlog ahora?',
    '¿cómo va wildlog esta semana?', 'dame el estado de wildlog', '¿qué tal el avance de wildlog?', "what's the current status of wildlog?",
    'give me an update on wildlog', "what's the overall progress on wildlog?", 'show me the wildlog roadmap', 'how is wildlog going so far?']) {
    assert.equal(isWholeProjectQuestion(q, ['wildlog']), true, q);
  }
  for (const q of ["how is wildlog's export going?", 'how are the wildlog labels going?']) assert.equal(isWholeProjectQuestion(q, ['wildlog']), false, q);
  assert.equal(isWholeProjectQuestion('latest on the cove podcast', ['cove', 'cove podcast']), true);
  assert.equal(isWholeProjectQuestion("what's the latest on the roadmap tool?", ['roadmap-tool']), true);
});

/** Twenty facts that outrank the roadmap and status in the search, so those two reach the reranker only by being added. */
async function crowded(b: ReturnType<typeof brain>) {
  const ids = await wildlog(b);
  for (let i = 0; i < 20; i++) await b.save(`wildlog label printer label printer note ${i} about labels and the printer`, 'wildlog');
  return ids;
}

test('pinned facts the search did not find are added to the pool once each; only kept ones are marked recalled; the score is reported', async () => {
  const scoreOf = (t: string) => (t.startsWith('wildlog status') ? 9 : t.startsWith('Now:') ? -9 : 0);
  const seen: (number | null)[] = [];
  const b = brain({ async score(_q, texts) { return texts.map(scoreOf); } });
  const { roadmap, status } = await crowded(b);
  const hits = await b.service.recall({ query: "what's the latest on wildlog's label printer?", limit: 3, report: (r) => seen.push(r.bestScore) });
  const ids = hits.map((h) => h.memory.id);
  assert.equal(ids[0], status);
  assert.ok(!ids.includes(roadmap));
  assert.deepEqual(seen, [9]);
  assert.notEqual(b.store.get(status)!.lastRecalledAt, null);
  assert.equal(b.store.get(roadmap)!.lastRecalledAt, null);
  const all = (await b.service.recall({ query: "what's the latest on wildlog's label printer?", limit: 20, touch: false })).map((h) => h.memory.id);
  assert.equal(all.filter((id) => id === status).length, 1);
});

test('when the reranker fails on a question about one part, the roadmap and status are pinned on top as before', async (t) => {
  t.mock.method(console, 'error', () => {});
  const b = brain({ async score() { throw new Error('gone'); } });
  const { roadmap, status } = await crowded(b);
  const ids = (await b.service.recall({ query: "what's the latest on wildlog's label printer?", touch: false })).map((h) => h.memory.id);
  assert.deepEqual(ids.slice(0, 2), [roadmap, status]);
});

test('the rank prior (Gemma profile) keeps the search order unless the reranker clearly disagrees', async () => {
  const plain = brain(leansTo('zebra'));
  const z0 = await fifteen(plain);
  assert.equal((await plain.service.recall({ query: QUERY, limit: 3, touch: false }))[0]!.memory.id, z0, 'no prior: the reranker alone decides');
  const withPrior = brain(leansTo('zebra'), 1);
  const z1 = await fifteen(withPrior);
  const got = await withPrior.service.recall({ query: QUERY, limit: 20, touch: false });
  assert.notEqual(got[0]!.memory.id, z1, 'a 0.5 preference does not lift the 15th search match over the first');
});
