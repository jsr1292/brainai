import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb, type DB } from '../db.js';
import type { Embedder } from '../memory/embedder.js';
import { E5_PROFILE, GEMMA_PROFILE, type EmbeddingProfile } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { stamp, storedModel } from '../memory/reembed.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { modelDirOf, type CatalogueModel, type ModelId } from './catalogue.js';
import { readChoice, writeChoice } from './choice.js';
import { writeKey } from './onlineKey.js';
import type { downloadModel, Progress } from './download.js';
import { ModelManager } from './manager.js';
import { SwitchableEmbedder, SwitchableReranker } from './switchable.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytesOf = (id: string) => Buffer.from(`made-up weights of ${id} `.repeat(40));

/** A catalogue of made-up models with tiny files: the manager checks them by hash, as it does the real ones. */
function fake(id: ModelId, kind: 'search' | 'rerank', more: Partial<CatalogueModel> = {}): CatalogueModel {
  const b = bytesOf(id);
  return { id, kind, label: 'Light', repo: `example-org/${id}-tiny`, files: { 'onnx/model.bin': sha(b) }, bytes: b.length, licence: 'MIT', measured: 'x', ...more };
}
const CATALOGUE: CatalogueModel[] = [
  fake('e5', 'search', { profile: 'e5' }),
  fake('gemma', 'search', { profile: 'gemma', notice: 'licenses/EXAMPLE-NOTICE.txt' }),
  fake('mminilm', 'rerank'),
];
const entry = (id: ModelId) => CATALOGUE.find((m) => m.id === id)!;

/** Puts a model's files where a finished download would (and its NOTICE, when it names one). */
function install(modelsDir: string, id: ModelId, o: { notice?: boolean } = {}): void {
  const m = entry(id);
  const path = join(modelDirOf(modelsDir, m), 'onnx/model.bin');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytesOf(id));
  if (m.notice && o.notice !== false) writeFileSync(join(modelDirOf(modelsDir, m), 'NOTICE'), 'Example notice');
}

/** A 768-long stand-in for Gemma; `held` makes every embed wait until release(). */
function fakeGemma(o: { held?: boolean } = {}) {
  const base = createFakeEmbedder();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  const e: Embedder & { release: () => void; waiting: Promise<void> } = {
    release, waiting,
    async embed(text, purpose) {
      if (o.held) { reached(); await gate; }
      const v = await base.embed(text, purpose);
      const out = new Float32Array(768); out.set(v, 0); out.set(v, 384);
      return out.map((x) => x / Math.SQRT2);
    },
  };
  return e;
}

function harness(o: { gemma?: Embedder; rerank?: boolean; gate?: Promise<void>; fail?: string; failOnly?: ModelId; fetch?: typeof fetch; rerankScore?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mgr-data-'));
  const modelsDir = mkdtempSync(join(tmpdir(), 'mgr-models-'));
  const db: DB = openDb(':memory:');
  const embedder = new SwitchableEmbedder(db, GEMMA_PROFILE);
  const reranker = new SwitchableReranker();
  const downloads: ModelId[] = [];
  const loads: string[] = [];
  const verified: (boolean | undefined)[] = [];
  let caughtUp = 0;
  const download: typeof downloadModel = async (m, dir, opts) => {
    downloads.push(m.id);
    opts.onProgress?.({ model: m.id, doneBytes: 0, totalBytes: m.bytes, state: 'waiting' });
    opts.onProgress?.({ model: m.id, doneBytes: 10, totalBytes: m.bytes, state: 'downloading' });
    // Like the real one, a stop ends it at once and leaves no file.
    if (o.gate) await Promise.race([o.gate, new Promise((_r, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('stopped'))))]);
    if (o.fail && (o.failOnly === undefined || o.failOnly === m.id)) {
      opts.onProgress?.({ model: m.id, doneBytes: 10, totalBytes: m.bytes, state: 'failed', error: o.fail });
      throw new Error(o.fail);
    }
    install(dir, m.id);
    opts.onProgress?.({ model: m.id, doneBytes: m.bytes, totalBytes: m.bytes, state: 'done' });
  };
  const manager = new ModelManager({
    dataDir, modelsDir, embedder, reranker, db, dbPath: ':memory:', download, catalogue: CATALOGUE,
    rerank: o.rerank, fetch: o.fetch,
    load: {
      embedder: async (_dir: string, p: EmbeddingProfile, lo?: { verified?: boolean }) => {
        loads.push(p.id); verified.push(lo?.verified);
        return p.id === 'gemma' ? (o.gemma ?? fakeGemma()) : createFakeEmbedder();
      },
      reranker: async (_dir: string, _m: CatalogueModel, lo?: { verified?: boolean }) => {
        loads.push('mminilm'); verified.push(lo?.verified);
        return { score: async (_q: string, texts: string[]) => texts.map((_t, i) => o.rerankScore ?? -i) };
      },
    },
    onSwitched: () => { caughtUp++; },
    log: () => {},
  });
  return { dataDir, modelsDir, db, embedder, reranker, downloads, loads, verified, manager, caughtUp: () => caughtUp };
}

const states = (p: Progress[]) => p.map((x) => `${x.model}:${x.state}`);

test('start with the chosen models on disk loads them at once and downloads nothing', async () => {
  const h = harness();
  writeChoice(h.dataDir, { search: 'e5', rerank: 'mminilm' });
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'mminilm');
  await h.manager.start();
  assert.deepEqual(h.downloads, []);
  assert.equal(h.embedder.ready(), true);
  assert.equal(h.embedder.profile(), E5_PROFILE);
  assert.equal(h.reranker.ready(), true);
  assert.deepEqual(h.manager.status(), { choice: { search: 'e5', rerank: 'mminilm' }, progress: [], searchReady: true, checked: { ms: h.manager.status().checked!.ms } });
  assert.equal(Number.isInteger(h.manager.status().checked!.ms), true);
  assert.equal(h.caughtUp(), 1, 'the meaning graph catches up after the switch');
  assert.deepEqual(h.verified, [true, true], 'the files were just checked: the loaders do not hash them again');
});

test('start with the files missing downloads them in the background, serves on keywords meanwhile, then switches', async () => {
  let open!: () => void;
  const h = harness({ gate: new Promise<void>((r) => { open = r; }) });
  writeChoice(h.dataDir, { search: 'gemma', rerank: 'mminilm' });
  const started = h.manager.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.embedder.ready(), false, 'keywords only while it downloads');
  const during = h.manager.status();
  assert.equal(during.searchReady, false);
  assert.deepEqual(states(during.progress), ['gemma:downloading']);
  open();
  await started;
  assert.deepEqual(h.downloads, ['gemma', 'mminilm']);
  assert.equal(h.embedder.ready(), true);
  assert.equal(h.embedder.profile(), GEMMA_PROFILE);
  assert.equal(h.reranker.ready(), true);
  assert.deepEqual(states(h.manager.status().progress), ['gemma:done', 'mminilm:done']);
  assert.deepEqual(storedModel(h.db), { model: 'gemma', dim: 768 });
});

test('an install from before models.json (brain stamped gemma) keeps its model: the choice is written and downloaded, no question', async () => {
  let embedded = 0;
  const base = fakeGemma();
  const h = harness({ gemma: { embed: (t, p) => { if (p === 'passage') embedded++; return base.embed(t, p); } } });
  const store = new MemoryStore(h.db, () => new Date('2026-11-13T10:00:00Z'));
  for (const c of ['Alex grows vegetables in raised beds', 'The garden-club-site runs on SQLite']) {
    store.insert({ kind: 'decision', content: c, project: 'garden-club-site', tags: [], embedding: await base.embed(c, 'passage'), by: 'x' });
  }
  stamp(h.db, GEMMA_PROFILE);
  const stampRow = () => h.db.prepare('SELECT model, dim, embedded_at FROM embedding_model WHERE id = 1').get();
  const vectors = () => h.db.prepare('SELECT id, embedding FROM memories ORDER BY id').all();
  const [before, vectorsBefore] = [stampRow(), vectors()];
  await h.manager.start();
  assert.deepEqual(stampRow(), before, 'the same model arrived: the stamp (and its time) is unchanged');
  assert.deepEqual(vectors(), vectorsBefore);
  assert.equal(embedded, 0, 'nothing was re-embedded (the one test search is a query)');
  assert.deepEqual(readChoice(h.dataDir), { search: 'gemma', rerank: 'mminilm' });
  assert.deepEqual(h.manager.status().choice, { search: 'gemma', rerank: 'mminilm' }, 'a choice is there, so the welcome asks nothing');
  assert.deepEqual(h.downloads, ['gemma', 'mminilm']);
  assert.equal(h.embedder.profile(), GEMMA_PROFILE);
  assert.equal(h.embedder.ready(), true);
});

test('an old install stamped e5 with RERANK=off keeps e5 and no reranker', async () => {
  const h = harness({ rerank: false });
  stamp(h.db, E5_PROFILE);
  await h.manager.start();
  assert.deepEqual(readChoice(h.dataDir), { search: 'e5', rerank: null });
  assert.deepEqual(h.downloads, ['e5']);
  assert.equal(h.reranker.ready(), false);
  assert.equal(h.embedder.profile(), E5_PROFILE);
});

test('a new, empty brain with no choice waits for the welcome: not ready, nothing downloaded, nothing written', async () => {
  const h = harness();
  await h.manager.start();
  assert.deepEqual(h.manager.status(), { choice: null, progress: [], searchReady: false });
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.loads, []);
  assert.equal(existsSync(join(h.dataDir, 'models.json')), false);
});

test('Gemma without its NOTICE is not installed: the download runs again (and puts the notice back)', async () => {
  const h = harness();
  writeChoice(h.dataDir, { search: 'gemma', rerank: null });
  install(h.modelsDir, 'gemma', { notice: false });
  await h.manager.start();
  assert.deepEqual(h.downloads, ['gemma']);
  assert.ok(existsSync(join(modelDirOf(h.modelsDir, entry('gemma')), 'NOTICE')));
  assert.equal(h.embedder.ready(), true);
});

test('a file with the wrong bytes is not installed either', async () => {
  const h = harness();
  writeChoice(h.dataDir, { search: 'e5', rerank: null });
  install(h.modelsDir, 'e5');
  writeFileSync(join(modelDirOf(h.modelsDir, entry('e5')), 'onnx/model.bin'), 'damaged');
  await h.manager.start();
  assert.deepEqual(h.downloads, ['e5']);
});

/** A brain with two facts by e5 (stamped e5), its embedder on e5. */
async function onE5(h: ReturnType<typeof harness>) {
  h.embedder.use(createFakeEmbedder(), E5_PROFILE);
  stamp(h.db, E5_PROFILE);
  const service = new MemoryService(new MemoryStore(h.db, () => new Date('2026-11-13T10:00:00Z')), h.embedder, { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  for (const c of ['Alex grows vegetables in raised beds', 'The garden-club-site runs on SQLite']) {
    await service.remember({ kind: 'decision', content: c, project: 'garden-club-site' }, { type: 'owner' });
  }
}

test('a start whose chosen model differs from the stored one re-reads in the background (keywords meanwhile)', async () => {
  const gemma = fakeGemma({ held: true });
  const h = harness({ gemma });
  await onE5(h);
  writeChoice(h.dataDir, { search: 'gemma', rerank: null });
  install(h.modelsDir, 'gemma');
  const started = h.manager.start();
  await gemma.waiting;
  assert.equal(h.embedder.ready(), false, 'meaning is off while it re-reads; the server is already serving');
  assert.deepEqual(storedModel(h.db), { model: 'e5', dim: 384 });
  gemma.release();
  await started;
  assert.deepEqual(storedModel(h.db), { model: 'gemma', dim: 768 });
  assert.equal(h.embedder.profile(), GEMMA_PROFILE);
  assert.equal(h.embedder.ready(), true);
});

test('a new choice stops and waits for the running re-read before it starts its own', async () => {
  const gemma = fakeGemma({ held: true });
  const h = harness({ gemma });
  await onE5(h);
  install(h.modelsDir, 'gemma');
  install(h.modelsDir, 'e5');
  const first = h.manager.choose({ search: 'gemma', rerank: null });
  await gemma.waiting;
  const second = h.manager.choose({ search: 'e5', rerank: null });
  gemma.release();
  await first; // superseded: it ends quietly, never "already running"
  await second;
  assert.deepEqual(readChoice(h.dataDir), { search: 'e5', rerank: null });
  assert.deepEqual(storedModel(h.db), { model: 'e5', dim: 384 }, 'the stopped re-read never switched the brain');
  assert.equal(h.embedder.profile(), E5_PROFILE);
  assert.equal(h.embedder.ready(), true);
});

test('choosing the online reranker loads it with the saved key, falling back to Standard when installed; none switches it off', async () => {
  const calls: { url: string; body: any }[] = [];
  const h = harness({ fetch: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.8 }] })); }) as never });
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'mminilm');
  writeKey(h.dataDir, 'sk-or-made-up-key');
  await h.manager.choose({ search: 'e5', rerank: 'mminilm' });
  assert.equal(h.reranker.ready(), true);
  await h.manager.choose({ search: 'e5', rerank: 'online', online: { model: 'qwen/qwen3-reranker-8b' } });
  assert.equal(h.reranker.ready(), true);
  assert.deepEqual(await h.reranker.score('q', ['a', 'b']), [0.2, 0.8], 'the online scores');
  assert.equal(calls[0]!.body.provider.zdr, true, 'zero retention for the Qwen choice');
  assert.equal(calls[0]!.body.provider.data_collection, 'deny');
  assert.deepEqual(readChoice(h.dataDir), { search: 'e5', rerank: 'online', online: { model: 'qwen/qwen3-reranker-8b' } });
  assert.equal(h.manager.status().onlineProblem, undefined);
  await h.manager.choose({ search: 'e5', rerank: null });
  assert.equal(h.reranker.ready(), false);
  assert.deepEqual(h.downloads, []);
  assert.equal(h.loads.filter((l) => l === 'e5').length, 1, 'the search model in use is not loaded again for a reranker change');
});

test('the online reranker with a refused key falls back to Standard, or to the search order, and says why in plain words', async () => {
  const refuse = (async () => new Response('{"error":"no"}', { status: 401 })) as never;
  const h = harness({ fetch: refuse });
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'mminilm');
  writeKey(h.dataDir, 'sk-or-made-up-key');
  await h.manager.choose({ search: 'e5', rerank: 'online', online: { model: 'voyageai/rerank-2.5' } });
  assert.deepEqual((await h.reranker.score('q', ['a', 'b'])).map((x) => x + 0), [0, -1], 'the local Standard order');
  assert.match(h.manager.status().onlineProblem!, /the OpenRouter key was refused/);
  assert.ok(!JSON.stringify(h.manager.status()).includes('sk-or-made-up-key'));
  const bare = harness({ fetch: refuse });
  install(bare.modelsDir, 'e5');
  writeKey(bare.dataDir, 'sk-or-made-up-key');
  await bare.manager.choose({ search: 'e5', rerank: 'online', online: { model: 'voyageai/rerank-2.5' } });
  assert.deepEqual(await bare.reranker.score('q', ['a', 'b']), [0, 0], 'no local reranker: the order is kept');
  assert.match(bare.manager.status().onlineProblem!, /key was refused/);
});

test('an online model BrainAI does not offer is refused', async () => {
  const h = harness();
  install(h.modelsDir, 'e5');
  await assert.rejects(h.manager.choose({ search: 'e5', rerank: 'online', online: { model: 'example/other' } }), /not one BrainAI offers/);
});

test('Load model files: the right files make the model ready; a wrong file refuses and copies nothing', async () => {
  const h = harness();
  const folder = mkdtempSync(join(tmpdir(), 'mgr-folder-'));
  mkdirSync(join(folder, 'onnx'), { recursive: true });
  writeFileSync(join(folder, 'onnx/model.bin'), Buffer.from('not the pinned bytes'));
  await assert.rejects(h.manager.loadFromFolder('mminilm', folder), /onnx\/model\.bin is not the file BrainAI expects.*nothing was copied/s);
  assert.equal(existsSync(modelDirOf(h.modelsDir, entry('mminilm'))), false, 'nothing copied');
  await assert.rejects(h.manager.loadFromFolder('mminilm', join(folder, 'missing')), /folder/);
  writeFileSync(join(folder, 'onnx/model.bin'), bytesOf('mminilm'));
  await h.manager.loadFromFolder('mminilm', folder);
  assert.deepEqual(await h.manager.installedIds(), ['mminilm']);
  rmSync(folder, { recursive: true });
});

test('Load model files accepts the files flat in the folder', async () => {
  const h = harness();
  const folder = mkdtempSync(join(tmpdir(), 'mgr-folder-'));
  writeFileSync(join(folder, 'model.bin'), bytesOf('e5'));
  await h.manager.loadFromFolder('e5', folder);
  assert.deepEqual(await h.manager.installedIds(), ['e5']);
  rmSync(folder, { recursive: true });
});

test('a failed download says why in the status and leaves the brain on keywords', async () => {
  const h = harness({ fail: 'could not reach Hugging Face or GitHub' });
  writeChoice(h.dataDir, { search: 'gemma', rerank: 'mminilm' });
  await assert.rejects(h.manager.start(), /could not reach/);
  const s = h.manager.status();
  assert.equal(s.searchReady, false);
  assert.equal(s.problem, 'could not reach Hugging Face or GitHub');
  assert.deepEqual(states(s.progress), ['gemma:failed']);
  assert.equal(h.embedder.ready(), false);
});

test('retry runs the current choice again after a failure, and does nothing with no choice', async () => {
  const h = harness({ fail: 'could not reach Hugging Face or GitHub' });
  await h.manager.retry();
  assert.deepEqual(h.manager.status().progress, [], 'no choice: nothing started');
  writeChoice(h.dataDir, { search: 'gemma', rerank: 'mminilm' });
  await assert.rejects(h.manager.start(), /could not reach/);
  assert.equal(h.manager.status().problem, 'could not reach Hugging Face or GitHub');
  await assert.rejects(h.manager.retry(), /could not reach/);
  assert.deepEqual(states(h.manager.status().progress), ['gemma:failed']);
  assert.deepEqual(readChoice(h.dataDir), { search: 'gemma', rerank: 'mminilm' });
});

/** A brain with two facts by the made-up Gemma (stamped gemma), its files installed, and e5 chosen but not downloaded. */
async function onGemmaChoosingE5(h: ReturnType<typeof harness>) {
  const base = fakeGemma();
  const store = new MemoryStore(h.db, () => new Date('2026-11-13T10:00:00Z'));
  for (const c of ['Alex grows vegetables in raised beds', 'The garden-club-site runs on SQLite']) {
    store.insert({ kind: 'decision', content: c, project: 'garden-club-site', tags: [], embedding: await base.embed(c, 'passage'), by: 'x' });
  }
  stamp(h.db, GEMMA_PROFILE);
  install(h.modelsDir, 'gemma');
  writeChoice(h.dataDir, { search: 'e5', rerank: null });
}

test('a chosen search model that cannot download leaves the brain on its own installed model: search by meaning stays on', async () => {
  const h = harness({ fail: 'could not reach Hugging Face or GitHub' });
  await onGemmaChoosingE5(h);
  await assert.rejects(h.manager.start(), /could not reach/);
  assert.equal(h.embedder.profile()?.id, 'gemma');
  assert.equal(h.embedder.ready(), true, 'the stamp matches the model in use');
  const s = h.manager.status();
  assert.equal(s.searchReady, true);
  assert.equal(s.problem, 'could not reach Hugging Face or GitHub', 'the failure is still reported');
  assert.deepEqual(states(s.progress), ['e5:failed']);
  assert.deepEqual(storedModel(h.db), { model: 'gemma', dim: 768 }, 'nothing was re-read');
  assert.equal((await h.embedder.embed('raised beds', 'query')).length, 768);
  assert.deepEqual(h.downloads, ['e5'], 'the brain\'s own model was not downloaded again');
});

test('the brain\'s own model serves while the chosen one downloads, then the brain is re-read with the chosen one', async () => {
  let open!: () => void;
  const h = harness({ gate: new Promise<void>((r) => { open = r; }) });
  await onGemmaChoosingE5(h);
  const started = h.manager.start();
  while (!h.downloads.includes('e5')) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.embedder.profile()?.id, 'gemma');
  assert.equal(h.manager.status().searchReady, true, 'meaning is on during the download');
  open();
  await started;
  assert.deepEqual(storedModel(h.db), { model: 'e5', dim: 384 });
  assert.equal(h.embedder.profile(), E5_PROFILE);
  assert.equal(h.embedder.ready(), true);
});

test('a stored model whose files are missing or damaged is not loaded: the brain stays on keywords', async () => {
  const h = harness({ fail: 'could not reach Hugging Face or GitHub' });
  await onGemmaChoosingE5(h);
  writeFileSync(join(modelDirOf(h.modelsDir, entry('gemma')), 'onnx/model.bin'), 'damaged');
  await assert.rejects(h.manager.start(), /could not reach/);
  assert.equal(h.embedder.profile(), null);
  assert.equal(h.manager.status().searchReady, false);
  assert.deepEqual(h.loads, []);
});

test('the status says which model failed: the reranker alone, with search by meaning on, or the search model', async () => {
  const h = harness({ fail: 'could not reach Hugging Face or GitHub', failOnly: 'mminilm' });
  writeChoice(h.dataDir, { search: 'e5', rerank: 'mminilm' });
  await assert.rejects(h.manager.start(), /could not reach/);
  const s = h.manager.status();
  assert.equal(s.searchReady, true);
  assert.equal(s.problem, 'could not reach Hugging Face or GitHub');
  assert.equal(s.problemWith, 'rerank');
  const both = harness({ fail: 'could not reach Hugging Face or GitHub' });
  writeChoice(both.dataDir, { search: 'e5', rerank: 'mminilm' });
  await assert.rejects(both.manager.start(), /could not reach/);
  assert.equal(both.manager.status().problemWith, 'search');
  install(h.modelsDir, 'mminilm');
  await h.manager.choose({ search: 'e5', rerank: null });
  assert.equal(h.manager.status().problemWith, undefined, 'cleared with the problem');
});

test('remove deletes a model that is not in use and refuses one that is', async () => {
  const h = harness();
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'gemma');
  await h.manager.choose({ search: 'e5', rerank: null });
  assert.throws(() => h.manager.remove('e5'), /in use/);
  h.manager.remove('gemma');
  assert.equal(existsSync(modelDirOf(h.modelsDir, entry('gemma'))), false);
  assert.ok(existsSync(modelDirOf(h.modelsDir, entry('e5'))));
  rmSync(h.modelsDir, { recursive: true, force: true });
});

test('choosing again what is already being set up changes nothing: the download goes on, never restarted', async () => {
  let open!: () => void;
  const h = harness({ gate: new Promise<void>((r) => { open = r; }) });
  const first = h.manager.choose({ search: 'gemma', rerank: null });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.downloads, ['gemma']);
  const again = h.manager.choose({ search: 'gemma', rerank: null });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(states(h.manager.status().progress), ['gemma:downloading'], 'not stopped');
  open();
  await Promise.all([first, again]);
  assert.deepEqual(h.downloads, ['gemma'], 'downloaded once');
  assert.equal(h.embedder.profile(), GEMMA_PROFILE);
  assert.equal(h.embedder.ready(), true);
});

test('Load model files refuses a model that is already installed, and one being downloaded, and deletes nothing', async () => {
  const h = harness();
  install(h.modelsDir, 'e5');
  const folder = mkdtempSync(join(tmpdir(), 'mgr-folder-'));
  writeFileSync(join(folder, 'model.bin'), bytesOf('e5'));
  await assert.rejects(h.manager.loadFromFolder('e5', folder), /already on this computer/);
  assert.deepEqual(await h.manager.installedIds(), ['e5']);
  let open!: () => void;
  const busy = harness({ gate: new Promise<void>((r) => { open = r; }) });
  writeFileSync(join(folder, 'model.bin'), bytesOf('mminilm'));
  const run = busy.manager.choose({ search: 'e5', rerank: 'mminilm' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(busy.manager.loadFromFolder('mminilm', folder), /being set up/);
  open();
  await run;
  rmSync(folder, { recursive: true });
});

test('removing the key while Online is chosen switches to Standard when installed, else none (the route decides; the manager keeps Standard as the fallback)', async () => {
  const h = harness();
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'mminilm');
  writeKey(h.dataDir, 'sk-or-made-up-key');
  await h.manager.choose({ search: 'e5', rerank: 'online', online: { model: 'voyageai/rerank-2.5' } });
  assert.throws(() => h.manager.remove('mminilm'), /in use/, 'Standard is the fallback while Online is chosen');
});

test('after the models load, a test search runs on both and the time it took is kept in status().checked', async () => {
  const h = harness();
  writeChoice(h.dataDir, { search: 'e5', rerank: 'mminilm' });
  install(h.modelsDir, 'e5');
  install(h.modelsDir, 'mminilm');
  assert.equal(h.manager.status().checked, undefined, 'nothing checked before a run');
  await h.manager.start();
  const s = h.manager.status();
  assert.equal(s.problem, undefined);
  assert.equal(s.searchReady, true);
  assert.equal(Number.isInteger(s.checked?.ms), true);
  assert.ok(s.checked!.ms >= 0);
});

test('a search model whose test search gives only zeros is a problem, not ready', async () => {
  const h = harness({ gemma: { embed: async () => new Float32Array(768) } });
  await h.manager.choose({ search: 'gemma', rerank: null }).catch(() => {});
  const s = h.manager.status();
  assert.match(s.problem ?? '', /^the search model loaded but a test search on this computer failed: /);
  assert.equal(s.problemWith, 'check', 'the model is in use; it is its test search that failed');
  assert.equal(s.checked, undefined);
});

test('a search model whose test search gives NaN is a problem, not ready', async () => {
  const h = harness({ gemma: { embed: async () => new Float32Array(768).fill(Number.NaN) } });
  await h.manager.choose({ search: 'gemma', rerank: null }).catch(() => {});
  const s = h.manager.status();
  assert.match(s.problem ?? '', /test search on this computer failed/);
  assert.equal(s.problemWith, 'check');
  assert.equal(s.checked, undefined);
});

test('a search model whose test search throws is a problem with its reason', async () => {
  const h = harness({ gemma: { embed: async () => { throw new Error('session crashed'); } } });
  await h.manager.choose({ search: 'gemma', rerank: null }).catch(() => {});
  assert.match(h.manager.status().problem ?? '', /test search on this computer failed: .*session crashed/);
});

test('a reranker whose test search gives NaN is a rerank problem and search by meaning stays on', async () => {
  const h = harness({ rerankScore: Number.NaN });
  await h.manager.choose({ search: 'e5', rerank: 'mminilm' }).catch(() => {});
  const s = h.manager.status();
  assert.match(s.problem ?? '', /^the search model loaded but a test search on this computer failed: /);
  assert.equal(s.problemWith, 'rerank');
  assert.equal(s.searchReady, true);
  assert.equal(s.checked, undefined);
});

test('with no reranker the test search checks only the search model', async () => {
  const h = harness({ rerankScore: Number.NaN });
  await h.manager.choose({ search: 'e5', rerank: null });
  const s = h.manager.status();
  assert.equal(s.problem, undefined);
  assert.equal(typeof s.checked?.ms, 'number');
});

test('a new run clears the earlier check until its own passes', async () => {
  let open!: () => void;
  const h = harness();
  await h.manager.choose({ search: 'e5', rerank: null });
  assert.notEqual(h.manager.status().checked, undefined);
  const gated = harness({ gate: new Promise<void>((r) => { open = r; }) });
  const run = gated.manager.choose({ search: 'e5', rerank: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(gated.manager.status().checked, undefined);
  open();
  await run;
  assert.notEqual(gated.manager.status().checked, undefined);
});

test('choosing models removes half-downloaded files of models that are not chosen, and keeps the chosen ones', async () => {
  const h = harness();
  const partial = (id: ModelId) => join(modelDirOf(h.modelsDir, entry(id)), 'onnx/model.bin.partial');
  for (const id of ['e5', 'gemma'] as ModelId[]) { mkdirSync(dirname(partial(id)), { recursive: true }); writeFileSync(partial(id), 'half'); }
  install(h.modelsDir, 'e5');
  await h.manager.choose({ search: 'e5', rerank: null }).catch(() => {});
  assert.equal(existsSync(partial('gemma')), false);
  assert.equal(existsSync(partial('e5')), true);
});
