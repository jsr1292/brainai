/** Settings › Search (local mode only): the models, the online reranker and its key. Made-up files, fake fetch, temp folders. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { appSession, startTestApp } from '../testing/helpers.js';
import { fakeHome } from '../testing/fakeTools.js';
import { openDb } from '../db.js';
import { packArchive } from '../saved/archive.js';
import { stamp } from '../memory/reembed.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { E5_PROFILE, GEMMA_PROFILE } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import type { Embedder } from '../memory/embedder.js';
import { ModelManager } from '../models/manager.js';
import { SwitchableEmbedder, SwitchableReranker } from '../models/switchable.js';
import { modelDirOf, type CatalogueModel, type ModelId } from '../models/catalogue.js';
import { readKey } from '../models/onlineKey.js';
import { decodeEntities } from '../testing/entities.js';

const KEY = 'sk-or-made-up-key-7731';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytesOf = (id: string) => Buffer.from(`made-up weights of ${id} `.repeat(30));
const fake = (id: ModelId, kind: 'search' | 'rerank', label: CatalogueModel['label'], more: Partial<CatalogueModel> = {}): CatalogueModel =>
  ({ id, kind, label, repo: `example-org/${id}-tiny`, files: { 'onnx/model.bin': sha(bytesOf(id)) }, bytes: bytesOf(id).length, licence: 'MIT', measured: 'a made-up measurement', ...more });
const CAT = [fake('e5', 'search', 'Light', { profile: 'e5' }), fake('gemma', 'search', 'Balanced', { profile: 'gemma' }), fake('mminilm', 'rerank', 'Standard')];
const install = (modelsDir: string, id: ModelId) => {
  const p = join(modelDirOf(modelsDir, CAT.find((m) => m.id === id)!), 'onnx/model.bin');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytesOf(id));
};

function open(baseUrl: string, path: string, cookie = ''): Promise<{ status: number; body: string; cookie: string; location?: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method: 'GET', setHost: false, headers: { Host: `localhost:${u.port}`, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookie: cookie || (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; '), location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}
const post = (baseUrl: string, path: string, cookie: string, body: Record<string, string> = {}) =>
  fetch(baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

const held = (): Embedder & { release(): void; waiting: Promise<void> } => {
  const base = createFakeEmbedder();
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  return { release, waiting, async embed(t, p) { reached(); await gate; return base.embed(t, p); } };
};

async function setup(t: TestContext, o: { installed?: ModelId[]; fetch?: typeof fetch; local?: boolean; heldE5?: boolean; inUse?: 'gemma' | 'e5' } = {}) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-ssearch-data-'));
  const modelsDir = mkdtempSync(join(tmpdir(), 'brainai-ssearch-models-'));
  for (const id of o.installed ?? []) install(modelsDir, id);
  const db = openDb(':memory:');
  const embedder = new SwitchableEmbedder(db, GEMMA_PROFILE);
  const reranker = new SwitchableReranker();
  const e5 = held();
  const manager = new ModelManager({
    dataDir: statusDir, modelsDir, embedder, reranker, db, dbPath: ':memory:', catalogue: CAT, log: () => {}, fetch: o.fetch,
    load: {
      embedder: async (_d, p) => (p.id === 'e5' && o.heldE5 ? e5 : createFakeEmbedder()),
      reranker: async () => ({ score: async (_q: string, x: string[]) => x.map((_t, i) => -i) }),
    },
  });
  const local = o.local !== false;
  const app = await startTestApp({ localMode: local, noPassword: local, statusDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps }, models: local ? manager : undefined });
  t.after(() => app.close());
  const cookie = local ? await appSession(app) : (await open(app.baseUrl, '/settings')).cookie;
  return { app, cookie, statusDir, modelsDir, manager, reranker, embedder, db, e5 };
}

/** The brain was read with the Balanced model; Balanced + Standard is the choice in use. */
async function onBalanced(s: Awaited<ReturnType<typeof setup>>) {
  s.embedder.use(createFakeEmbedder(), GEMMA_PROFILE);
  stamp(s.db, GEMMA_PROFILE);
  const svc = new MemoryService(new MemoryStore(s.db, () => new Date('2026-11-13T10:00:00Z')), s.embedder, { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  await svc.remember({ kind: 'decision', content: 'Alex grows vegetables in raised beds', project: 'garden-club-site' }, { type: 'owner' });
  await s.manager.choose({ search: 'gemma', rerank: 'mminilm' });
}
const search = (body: string) => body.slice(body.indexOf('<section id="search"'), body.indexOf('</section>', body.indexOf('<section id="search"')));
const settings = async (s: { app: { baseUrl: string }; cookie: string }) => (await open(s.app.baseUrl, '/settings', s.cookie)).body;

test('Settings › Search exists in local mode only', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm'] });
  await onBalanced(s);
  const body = await settings(s);
  assert.match(body, /<section id="search"/);
  assert.match(body, /<a href="#search">Search<\/a>/);
  const sv = await setup(t, { local: false });
  assert.doesNotMatch(await settings(sv), /id="search"|Settings › Search/);
  assert.equal((await post(sv.app.baseUrl, '/settings/search/models', sv.cookie, { search: 'e5', rerank: 'none' })).status === 303, false);
});

test('the section shows the pair in use, the same list as step 2, Online with its data policy, and Remove only for a downloaded model not in use', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm', 'e5'] });
  await onBalanced(s);
  const sec = search(await settings(s));
  assert.match(sec, /Balanced[\s\S]*Standard/);
  assert.match(sec, /name="search" value="e5"/);
  assert.match(sec, /name="search" value="gemma"[^>]*checked/);
  assert.match(sec, /name="rerank" value="none"/);
  assert.match(sec, /name="rerank" value="mminilm"[^>]*checked/);
  assert.match(sec, /name="rerank" value="online:voyageai\/rerank-2\.5"/);
  assert.match(sec, /voyageai\/rerank-2\.5/);
  assert.match(decodeEntities(sec), /doesn't train on what you send, but may keep it/);
  assert.match(sec, /qwen\/qwen3-reranker-8b/);
  assert.match(sec, /keeps nothing \(zero retention\); a little slower/);
  const removes = [...sec.matchAll(/action="\/settings\/search\/remove"[\s\S]*?name="model" value="([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(removes, ['e5'], 'only the one not in use');
});

test('choosing Light while Balanced is in use starts a re-read and the section shows its progress', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm', 'e5'], heldE5: true });
  await onBalanced(s);
  const r = await post(s.app.baseUrl, '/settings/search/models', s.cookie, { search: 'e5', rerank: 'mminilm' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings#search');
  await s.e5.waiting;
  assert.equal(s.manager.status().rereading, true);
  const sec = search(await settings(s));
  assert.match(sec, /Re-reading your memories with the new search model/);
  assert.match(sec, /data-models-progress="\/models\/progress"/);
  s.e5.release();
});

test('the welcome and Settings share one validation: a bad choice is refused', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm'] });
  for (const body of [{ search: 'nope', rerank: 'none' }, { search: 'e5', rerank: 'bge-m3-rerank' }, { search: 'e5', rerank: 'online:example/other' }, {}] as Record<string, string>[]) {
    assert.equal((await post(s.app.baseUrl, '/settings/search/models', s.cookie, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(s.app.baseUrl, '/settings/search/models', s.cookie, { search: 'e5', rerank: 'none' }, )).status, 303);
});

test('removing the model in use is refused in plain words; an unused one is deleted', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm', 'e5'] });
  await onBalanced(s);
  assert.equal((await post(s.app.baseUrl, '/settings/search/remove', s.cookie, { model: 'gemma' })).status, 303);
  assert.ok(existsSync(modelDirOf(s.modelsDir, CAT[1]!)), 'still there');
  assert.match(await settings(s), /Balanced is in use: choose another first/);
  assert.equal((await post(s.app.baseUrl, '/settings/search/remove', s.cookie, { model: 'e5' })).status, 303);
  assert.equal(existsSync(modelDirOf(s.modelsDir, CAT[0]!)), false);
  assert.equal((await post(s.app.baseUrl, '/settings/search/remove', s.cookie, { model: 'example/x' })).status, 400);
});

test('the key is saved mode 600 and appears nowhere: not the page, /models/progress, the database or a saved copy', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm'] });
  await onBalanced(s);
  assert.match(search(await settings(s)), /type="password"[^>]*name="key"|name="key"[^>]*type="password"/);
  assert.equal((await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: KEY })).status, 303);
  assert.equal(readKey(s.statusDir), KEY);
  assert.equal(statSync(join(s.statusDir, 'openrouter-key')).mode & 0o777, 0o600);
  const sec = search(await settings(s));
  assert.match(sec, /a key is saved/i);
  assert.match(sec, /Replace/);
  assert.match(sec, /action="\/settings\/search\/key\/remove"/);
  assert.doesNotMatch(sec, /type="password"[^>]*value=/);
  for (const page of [await settings(s), (await open(s.app.baseUrl, '/welcome?step=3', s.cookie)).body, await (await fetch(s.app.baseUrl + '/models/progress', { headers: { Cookie: s.cookie } })).text()]) {
    assert.ok(!page.includes(KEY), 'no key in a page');
  }
  // The database and a saved copy of everything.
  const out = join(mkdtempSync(join(tmpdir(), 'brainai-ssearch-out-')), 'brainai-saved-test.tar.gz');
  await packArchive(s.app.deps.db!, s.statusDir, out, new Date('2026-11-13T10:00:00Z'));
  const x = mkdtempSync(join(tmpdir(), 'brainai-ssearch-x-'));
  execFileSync('tar', ['-xzf', out, '-C', x]);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(x)) assert.ok(!readFileSync(file).includes(KEY), `no key in ${file}`);
  assert.ok(!readFileSync(out).includes(KEY));
  assert.ok(!walk(x).some((f) => f.includes('openrouter-key')));
  // Remove forgets it.
  assert.equal((await post(s.app.baseUrl, '/settings/search/key/remove', s.cookie)).status, 303);
  assert.equal(readKey(s.statusDir), null);
});

test('a key with spaces is refused without being echoed', async (t) => {
  const s = await setup(t, { installed: [] });
  const r = await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: 'two words here' });
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes('two words here'));
  assert.equal(readKey(s.statusDir), null);
});

test('Online needs a key; with one it is chosen, and the last online problem shows in plain words, never the key', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm'], fetch: (async () => new Response('{}', { status: 402 })) as never });
  await onBalanced(s);
  const online = { search: 'gemma', rerank: 'online:voyageai/rerank-2.5' };
  assert.equal((await post(s.app.baseUrl, '/settings/search/models', s.cookie, online)).status, 400, 'no key yet');
  await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: KEY });
  assert.equal((await post(s.app.baseUrl, '/settings/search/models', s.cookie, online)).status, 303);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await s.reranker.score('q', ['a', 'b']).then((x) => x.length), 2);
  const body = await settings(s);
  assert.match(search(body), /out of credit/);
  assert.ok(!body.includes(KEY));
  const j = await (await fetch(s.app.baseUrl + '/models/progress', { headers: { Cookie: s.cookie } })).text();
  assert.ok(!j.includes(KEY));
});

test('removing the key while Online is chosen switches Online off', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm'] });
  await onBalanced(s);
  await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: KEY });
  await post(s.app.baseUrl, '/settings/search/models', s.cookie, { search: 'gemma', rerank: 'online:qwen/qwen3-reranker-8b' });
  await new Promise((r) => setTimeout(r, 50));
  await post(s.app.baseUrl, '/settings/search/key/remove', s.cookie);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.manager.status().choice?.rerank, 'mminilm', 'Standard is installed: the fallback becomes the choice');
  assert.match(await settings(s), /Online reranking is off[^<]*Standard/);
  const bare = await setup(t, { installed: ['gemma'] });
  await post(bare.app.baseUrl, '/settings/search/key', bare.cookie, { key: KEY });
  await bare.manager.choose({ search: 'gemma', rerank: 'online', online: { model: 'qwen/qwen3-reranker-8b' } });
  await post(bare.app.baseUrl, '/settings/search/key/remove', bare.cookie);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bare.manager.status().choice?.rerank, null, 'no Standard on disk: none');
});

test('with Online chosen, Standard is the fallback and is not offered for Remove', async (t) => {
  const s = await setup(t, { installed: ['gemma', 'mminilm', 'e5'] });
  await s.manager.choose({ search: 'gemma', rerank: 'mminilm' });
  await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: KEY });
  await post(s.app.baseUrl, '/settings/search/models', s.cookie, { search: 'gemma', rerank: 'online:voyageai/rerank-2.5' });
  await new Promise((r) => setTimeout(r, 80));
  const sec = search(await settings(s));
  assert.match(sec, /In use as the fallback/);
  const removes = [...sec.matchAll(/action="\/settings\/search\/remove"[\s\S]*?name="model" value="([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(removes, ['e5']);
});

test('the key routes answer 404 outside local mode, like the others', async (t) => {
  const sv = await setup(t, { local: false });
  for (const path of ['/settings/search/key', '/settings/search/key/remove']) assert.equal((await post(sv.app.baseUrl, path, sv.cookie, { key: KEY })).status, 404, path);
  assert.equal(readKey(sv.statusDir), null);
});

test('Replace and Load model files are openable details with the house chevron, and the warning names the question', async (t) => {
  const s = await setup(t, { installed: ['gemma'] });
  await post(s.app.baseUrl, '/settings/search/key', s.cookie, { key: KEY });
  const sec = search(await settings(s));
  assert.match(sec, /<summary>Replace<span class="chev"><\/span><\/summary>/);
  assert.match(sec, /<summary>Load model files from a folder<span class="chev"><\/span><\/summary>/);
  assert.match(sec, /sends your question and about 20 best matches to OpenRouter/);
  assert.doesNotMatch(sec, /sends your best matches/);
});

test('the welcome offers no online reranker of its own and points to Settings › Search for it', async (t) => {
  const s = await setup(t, { installed: [] });
  const body = (await open(s.app.baseUrl, '/welcome?step=2', s.cookie)).body;
  assert.doesNotMatch(body, /your best matches are sent|sends your best matches|best matches are sent to this service/);
  assert.match(body, /Prefer an online reranker\? Set it up later in Settings › Search\./);
});

test('Load model files: a folder with the right files makes the model ready; a wrong file is refused and copies nothing', async (t) => {
  const s = await setup(t, { installed: [] });
  const folder = mkdtempSync(join(tmpdir(), 'brainai-ssearch-folder-'));
  mkdirSync(join(folder, 'onnx'), { recursive: true });
  writeFileSync(join(folder, 'onnx/model.bin'), 'not what is pinned');
  assert.equal((await post(s.app.baseUrl, '/settings/search/load', s.cookie, { model: 'mminilm', folder })).status, 303);
  assert.match(await settings(s), /is not the file BrainAI expects/);
  assert.equal(existsSync(modelDirOf(s.modelsDir, CAT[2]!)), false, 'nothing copied');
  writeFileSync(join(folder, 'onnx/model.bin'), bytesOf('mminilm'));
  assert.equal((await post(s.app.baseUrl, '/settings/search/load', s.cookie, { model: 'mminilm', folder })).status, 303);
  assert.deepEqual(await s.manager.installedIds(), ['mminilm']);
  assert.match(await settings(s), /Standard is ready/);
  assert.equal((await post(s.app.baseUrl, '/settings/search/load', s.cookie, { model: 'example/x', folder })).status, 400);
});

test('other sites cannot post to Settings › Search', async (t) => {
  const s = await setup(t, { installed: [] });
  const r = await fetch(s.app.baseUrl + '/settings/search/key', { method: 'POST', redirect: 'manual', headers: { Cookie: s.cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: KEY }) });
  assert.equal(r.status, 403);
  assert.equal(readKey(s.statusDir), null);
});
