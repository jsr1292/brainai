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
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
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
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'http://localhost:3000';
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
