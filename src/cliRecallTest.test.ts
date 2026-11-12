import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';
import { openDb } from './db.js';
import { createFakeEmbedder } from './memory/fakeEmbedder.js';
import type { Reranker } from './memory/reranker.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';

test('recall-test scores recall with the reranker the server would use', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL, EMBED_MODEL: process.env.EMBED_MODEL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
  // The fake embedder makes e5-sized vectors, so the brain is an e5 brain.
  process.env.EMBED_MODEL = 'e5';
  const embedder = createFakeEmbedder();
  const db = openDb(join(dir, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), embedder, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  for (let i = 0; i < 6; i++) await service.remember({ kind: 'decision', content: `garden shed roof paint coat ${i}`, project: 'garden' }, { type: 'owner' });
  const r = await service.remember({ kind: 'decision', content: 'the zebra note mentions the garden once', project: 'garden' }, { type: 'owner' }) as any;
  db.close();
  const questions = join(dir, 'q.json');
  writeFileSync(questions, JSON.stringify([{ q: 'garden shed roof paint', expect: [r.memory.id] }]));
  const lines: string[] = [];
  t.mock.method(console, 'log', (m: string) => { lines.push(String(m)); });
  const zebra: Reranker = { async score(_q, texts) { return texts.map((x) => (x.includes('zebra') ? 1 : 0)); } };
  assert.equal(await main(['recall-test', questions], { embedder, reranker: zebra }), 0);
  assert.match(lines.join('\n'), /Found first: +1 \(100%\)/);
});

test('recall-test --json writes each question with its rank, and --against lists what was gained and lost', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL, EMBED_MODEL: process.env.EMBED_MODEL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
  // The fake embedder makes e5-sized vectors, so the brain is an e5 brain.
  process.env.EMBED_MODEL = 'e5';
  const embedder = createFakeEmbedder();
  const db = openDb(join(dir, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), embedder, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const r = await service.remember({ kind: 'decision', content: 'garden shed roof paint', project: 'garden' }, { type: 'owner' }) as any;
  db.close();
  const questions = join(dir, 'q.json');
  writeFileSync(questions, JSON.stringify([{ q: 'garden shed roof paint', expect: [r.memory.id], tags: ['home'] }]));
  const earlier = join(dir, 'before.json');
  writeFileSync(earlier, JSON.stringify({ perQuestion: [{ id: 'garden shed roof paint', rank: null }] }));
  const out = join(dir, 'after.json');
  const lines: string[] = [];
  t.mock.method(console, 'log', (m: string) => { lines.push(String(m)); });
  assert.equal(await main(['recall-test', questions, '--json', out, '--against', earlier], { embedder, reranker: { async score(_q, texts) { return texts.map(() => 0); } } }), 0);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(written.perQuestion, [{ id: 'garden shed roof paint', rank: 1 }]);
  assert.equal(written.byTag.home.first, 1);
  assert.match(lines.join('\n'), /Gained within 8: 1\n +"garden shed roof paint"/);
  assert.match(lines.join('\n'), /Lost within 1: 0/);
});

test('recall-test --limit 12 scores within 12 results (what assistants get since B9)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL, EMBED_MODEL: process.env.EMBED_MODEL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
  // The fake embedder makes e5-sized vectors, so the brain is an e5 brain.
  process.env.EMBED_MODEL = 'e5';
  const embedder = createFakeEmbedder();
  const db = openDb(join(dir, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), embedder, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const r = await service.remember({ kind: 'decision', content: 'garden shed roof paint', project: 'garden' }, { type: 'owner' }) as any;
  db.close();
  const questions = join(dir, 'q.json');
  writeFileSync(questions, JSON.stringify([{ q: 'garden shed roof paint', expect: [r.memory.id] }]));
  const lines: string[] = [];
  t.mock.method(console, 'log', (m: string) => { lines.push(String(m)); });
  assert.equal(await main(['recall-test', questions, '--limit', '12'], { embedder, reranker: { async score(_q, texts) { return texts.map(() => 0); } } }), 0);
  assert.match(lines.join('\n'), /top 12 results each/);
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: unknown) => { errors.push(String(m)); });
  assert.notEqual(await main(['recall-test', questions, '--limit', '30'], { embedder }), 0);
  assert.match(errors.join('\n'), /--limit must be a whole number from 1 to 20; got 30/);
});

test('recall-test refuses a brain made by another search model unless --reembed, and changes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL, EMBED_MODEL: process.env.EMBED_MODEL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
  const e5 = createFakeEmbedder();
  const db = openDb(join(dir, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), e5, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const r = await service.remember({ kind: 'decision', content: 'garden shed roof paint', project: 'garden' }, { type: 'owner' }) as any;
  db.close();
  const questions = join(dir, 'q.json');
  writeFileSync(questions, JSON.stringify([{ q: 'garden shed roof paint', expect: [r.memory.id] }]));
  // A 768-long stand-in for Gemma.
  const gemma = { async embed(text: string, p: 'query' | 'passage') { const v = await e5.embed(text, p); const o = new Float32Array(768); o.set(v); return o; } };
  const none = { async score(_q: string, texts: string[]) { return texts.map(() => 0); } };
  process.env.EMBED_MODEL = 'gemma';
  const errors: string[] = [];
  t.mock.method(console, 'error', (m: string) => { errors.push(String(m)); });
  t.mock.method(console, 'log', () => {});
  assert.equal(await main(['recall-test', questions], { embedder: gemma, reranker: none }), 1);
  assert.match(errors.join('\n'), /this brain's vectors were made by e5.*--reembed.*EMBED_MODEL=e5/s);
  const after = openDb(join(dir, 'memory.db'));
  assert.equal((after.prepare('SELECT length(embedding) AS n FROM memories').get() as { n: number }).n, 384 * 4, 'nothing was re-embedded');
  after.close();
  assert.equal(await main(['recall-test', questions, '--reembed'], { embedder: gemma, reranker: none }), 0, 'on a copy, --reembed switches it first');
});
