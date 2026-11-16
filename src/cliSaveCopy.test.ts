import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';
import { openDb } from './db.js';
import { createFakeEmbedder } from './memory/fakeEmbedder.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';

test('cli save-copy prints the folder on its last line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'save-copy-data-'));
  const parent = mkdtempSync(join(tmpdir(), 'save-copy-out-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, PUBLIC_URL: process.env.PUBLIC_URL };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
  process.env.DATA_DIR = dir;
  process.env.PUBLIC_URL = 'https://brain.example.test';
  const db = openDb(join(dir, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), createFakeEmbedder(), { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  await service.remember({ kind: 'decision', content: 'Larder shelves are oak', project: 'larder' }, { type: 'owner' });
  db.close();
  const lines: string[] = [];
  t.mock.method(console, 'log', (m: string) => { lines.push(String(m)); });
  assert.equal(await main(['save-copy', parent]), 0);
  assert.equal(lines.at(-2), 'save-copy: 1 fact, 0 pages');
  const folder = lines.at(-1)!;
  assert.ok(folder.startsWith(join(parent, 'BrainAI saved ')));
  assert.ok(existsSync(join(folder, 'README.txt')));
  // And it comes back into an empty brain with the counts in words.
  const fresh = mkdtempSync(join(tmpdir(), 'save-copy-back-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  process.env.DATA_DIR = fresh;
  const archive = join(folder, readdirSync(folder).find((n) => n.endsWith('.tar.gz'))!);
  assert.equal(await main(['restore', archive]), 0);
  assert.equal(lines.at(-1), 'Restored 1 fact and 0 pages. Now set the password and authenticator.');
});
