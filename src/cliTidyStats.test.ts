import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';
import { openDb } from './db.js';
import { createFakeEmbedder } from './memory/fakeEmbedder.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';

test('tidy-stats prints a project\'s facts, the brief size and what the brief shortens or leaves out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tidy-stats-'));
  const saved = process.env.DATA_DIR;
  t.after(() => { if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; rmSync(dir, { recursive: true, force: true }); });
  process.env.DATA_DIR = dir;
  const db = openDb(join(dir, 'memory.db'));
  const store = new MemoryStore(db, () => new Date());
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const owner = { type: 'owner' } as const;
  // 45 long decisions: more than the brief's 40, and far more text than its size limit.
  for (let i = 0; i < 45; i++) await service.remember({ kind: 'decision', content: `decision ${i} ${'word'.repeat(i + 1)} ${'padding text '.repeat(40)}`, project: 'busy', newProject: true }, owner);
  const s1 = (await service.remember({ kind: 'summary', content: 'first status of the busy project', project: 'busy' }, owner)) as any;
  const s2 = (await service.remember({ kind: 'summary', content: 'second status of the busy project', project: 'busy', separateWork: true }, owner)) as any;
  await service.remember({ kind: 'decision', content: 'something in another project', project: 'quiet', newProject: true }, owner);
  const old = (await service.remember({ kind: 'decision', content: 'replaced decision that stays as history', project: 'busy' }, owner)) as any;
  const newer = (await service.remember({ kind: 'decision', content: 'newer decision zebra', project: 'busy', supersedes: [old.memory.id] }, owner)) as any;
  assert.ok(s1.memory && s2.memory && newer.memory);
  db.close();

  const lines: string[] = [];
  t.mock.method(console, 'log', (m: string) => { lines.push(String(m)); });
  assert.equal(await main(['tidy-stats', 'busy']), 0);
  const out = lines.join('\n');
  assert.match(out, /^Project: busy/m);
  assert.match(out, /Facts: 48 current \(46 decisions, 2 statuses, 0 roadmap, 0 profile\), 1 replaced/);
  const chars = Number(/Brief: ([\d,]+) characters \(limit 16,000\)/.exec(out)![1]!.replace(/,/g, ''));
  assert.ok(chars > 10_000 && chars < 20_000, String(chars));
  const m = /Decisions: 46 in all; the brief shows (\d+) in full, shortens (\d+) to excerpts and leaves out (\d+)/.exec(out)!;
  assert.ok(m, out);
  const [full, excerpts, left] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.ok(full + excerpts + left === 46 && left >= 6 && excerpts + left > 0, `${full}/${excerpts}/${left}`);
  assert.match(out, /Statuses: 2 in all;/);
  assert.equal(await main(['tidy-stats']), 1, 'a project is needed');
  assert.equal(await main(['tidy-stats', 'nothing-here']), 1);
});

test('tidy-stats leaves the brain as it found it: no recall marks, no tool-call log', async () => {
  const { tidyStats } = await import('./memory/tidyStats.js');
  const db = openDb(':memory:');
  const store = new MemoryStore(db, () => new Date());
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  await service.remember({ kind: 'decision', content: 'one decision for the stats check', project: 'quiet', newProject: true }, { type: 'owner' });
  const before = { recalled: store.list({ project: 'quiet' }).map((m) => m.lastRecalledAt), calls: (db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }).n };
  const s = await tidyStats(db, 'quiet');
  assert.equal(s.facts.current, 1);
  assert.deepEqual(store.list({ project: 'quiet' }).map((m) => m.lastRecalledAt), before.recalled);
  assert.deepEqual(before.recalled, [null]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }).n, before.calls);
});
