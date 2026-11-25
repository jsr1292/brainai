// MODEL_DIR=./models node --import tsx src/eval/sourceRank.ts
// EMBED_MODEL=e5|gemma (default gemma): the search profile. SOURCE_BY=assistant: the owner_said facts are claimed by an
// assistant (not set by the owner), so the service gives them half of w; the table's w is still the configured weight.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { createLocalEmbedder } from '../memory/embedder.js';
import { profileFor } from '../memory/embeddingProfile.js';
import { runRecallTest, type RecallCase, type Summary } from '../memory/recallTest.js';
import { createLocalReranker } from '../memory/reranker.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { removeTempDir } from '../testing/tempDir.js';
import { topics } from './sourceRankCases.js';

const profile = profileFor(process.env.EMBED_MODEL);
const assistantSets = process.env.SOURCE_BY === 'assistant';
console.log(`Profile ${profile.id}, owner_said set by ${assistantSets ? 'an assistant (half bonus)' : 'the owner'}\n`);
const models = { modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false };
const embedder = await createLocalEmbedder({ ...models, model: profile });
const reranker = await createLocalReranker(models);
const dir = mkdtempSync(join(tmpdir(), 'source-rank-eval-'));
const db = openDb(join(dir, 'fixture.db'));
try {
  const store = new MemoryStore(db, () => new Date('2026-01-01T12:00:00Z'));
  const options = {
    duplicateThreshold: profile.duplicate, minRecallSimilarity: profile.minRecall,
    recallConfidentSimilarity: profile.confident, recallWindow: profile.window,
    keywordWeight: profile.keywordWeight, rerankPrior: profile.rerankPrior, reranker,
  };
  const writer = new MemoryService(store, embedder, options);
  const cases: RecallCase[] = [];
  const competitors: string[] = [];
  for (const [index, { project, agree, conflict, inferred }] of topics.entries()) {
    const pairs = [['agree', agree], ['conflict', conflict], ['inferred', inferred[0]], ['inferred', inferred[1]]] as const;
    for (const [i, [tag, [q, owner, inference]]] of pairs.entries()) {
      const target = tag === 'inferred' ? 'inferred' : 'owner_said';
      const expect: string[] = [];
      const sources = ['owner_said', 'inferred'] as const;
      // Balance insertion order for each type of question across the ten topics.
      const order = (index + i) % 2 ? [...sources].reverse() : sources;
      for (const source of order) {
        const content = source === 'owner_said' ? owner : inference;
        const saved = await writer.remember({ kind: 'decision', project, content, meta: { source }, newProject: true, allowDuplicate: true }, { type: 'owner' });
        assert.equal(saved.status, 'saved');
        assert.equal(saved.memory.source, source);
        if (assistantSets && source === 'owner_said') db.prepare('UPDATE memories SET source_by = ? WHERE id = ?').run('Claude', saved.memory.id);
        if (source === target) expect.push(saved.memory.id);
        else competitors.push(saved.memory.id);
      }
      cases.push({ q, project, expect, tags: tag === 'inferred' ? [tag] : ['owner', tag] });
    }
  }

  const metrics = (s: Summary) => [s.first, s.top3, s.mrr.toFixed(4)].join(' / ');
  const baseline = new Map<string, number>();
  console.log('| w | All (40) | Owner (20) | Agree (10) | Conflict (10) | Inferred (20) | Inferred ranks worse than baseline |');
  console.log('|---:|---|---|---|---|---|---:|');
  for (const weight of [0, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.0, 1.2, 1.6, 2.0, 2.4, 3.2, 6.4, 12.8]) {
    const service = new MemoryService(store, embedder, { ...options, ownerSaidWeight: weight });
    const { summary, byTag, results, stale } = await runRecallTest(service, cases, 8);
    assert.equal(stale.length, 0);
    let losses = 0;
    for (const [i, r] of results.entries()) {
      assert.ok(r.rank && r.got.some((m) => m.id === competitors[i]), `Missing competitor or target for ${r.q}`);
      if (weight === 0) baseline.set(r.q, r.rank);
      if (r.tags.includes('inferred') && r.rank > baseline.get(r.q)!) losses++;
    }
    console.log('| ' + [weight, ...[summary, byTag.owner!, byTag.agree!, byTag.conflict!, byTag.inferred!].map(metrics), losses].join(' | ') + ' |');
  }
} finally {
  db.close();
  removeTempDir(dir);
}
