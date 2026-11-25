import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { removeTempDir } from '../testing/tempDir.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';
import { SOURCES } from './types.js';

test('only an owner statement gains the configured weight in the local reranker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'source-rank-'));
  const db = openDb(join(dir, 'test.db'));
  t.after(() => { db.close(); removeTempDir(dir); });
  const store = new MemoryStore(db, () => new Date('2026-01-01'));
  const embedder = createFakeEmbedder();
  const query = 'Which paper goes in the printer?';
  const sources = [...SOURCES, null];
  for (const [tray, source] of sources.entries()) {
    const content = `The printer takes matte paper (tray ${tray}).`;
    store.insert({ kind: 'decision', project: 'printing', tags: [], content, by: 'owner', embedding: await embedder.embed(content, 'passage'),
      meta: { source, sourceNote: null, sourceBy: source ? 'owner' : null, validUntil: null } });
  }
  // Give each source a different raw score. Only the owner statement (tray 0) can overtake another fact.
  const reranker = { async score(_q: string, texts: string[]) { return texts.map((s) => Number(s.match(/tray (\d)/)![1]) / 100); } };
  const ranked = async (weight?: string) => {
    const config = loadConfig({ PUBLIC_URL: 'http://localhost', OWNER_SAID_WEIGHT: weight });
    const service = new MemoryService(store, embedder, { ...config, reranker });
    const hits = await service.recall({ query, limit: 5, touch: false, report: (r) => assert.equal(r.bestScore, 0.04) });
    return hits.map((h) => h.memory.source);
  };
  assert.deepEqual(await ranked('0'), [null, 'from_file', 'imported', 'inferred', 'owner_said']);
  const preferred = [null, 'from_file', 'owner_said', 'imported', 'inferred'];
  assert.deepEqual(await ranked('0.025'), preferred);
  const ownerFirst = ['owner_said', null, 'from_file', 'imported', 'inferred'];
  assert.deepEqual(await ranked('1'), ownerFirst);
  // The default (1.6) lifts an owner statement over facts that match only a little better.
  assert.deepEqual(await ranked(), ownerFirst);
});

// Two facts about the same question with scores set by the test: the owner_said one is `ownerRaw`, the other `otherRaw`.
interface Pair { by?: string; validUntil?: string | null; ownerRaw: number; otherRaw: number; weight?: number; prior?: number; online?: boolean; ownerFirstInSearch?: boolean }
async function firstOfPair(t: { after(fn: () => void): void }, p: Pair): Promise<'owner_said' | 'other'> {
  const dir = mkdtempSync(join(tmpdir(), 'source-rank-pair-'));
  const db = openDb(join(dir, 'test.db'));
  t.after(() => { db.close(); removeTempDir(dir); });
  const store = new MemoryStore(db, () => new Date('2026-01-01'));
  const embedder = createFakeEmbedder();
  const facts = [
    { text: 'The printer takes matte paper (said).', source: 'owner_said' as const, by: p.by ?? 'owner', validUntil: p.validUntil ?? null },
    { text: 'The printer takes matte paper (other).', source: 'inferred' as const, by: 'Claude', validUntil: null },
  ];
  for (const f of facts) {
    store.insert({ kind: 'decision', project: 'printing', tags: [], content: f.text, by: 'owner', embedding: await embedder.embed(f.text, 'passage'),
      meta: { source: f.source, sourceNote: null, sourceBy: f.by, validUntil: f.validUntil } });
  }
  const scores = (texts: string[]) => texts.map((s) => (s.includes('(said)') ? p.ownerRaw : p.otherRaw));
  const reranker = {
    async score(_q: string, texts: string[]) { return scores(texts); },
    ...(p.online === undefined ? {} : { async scoreMany(qs: string[], texts: string[]) { return { scores: qs.map(() => scores(texts)), online: p.online! }; } }),
  };
  const service = new MemoryService(store, embedder, { ...loadConfig({ PUBLIC_URL: 'http://localhost' }), reranker, ownerSaidWeight: p.weight ?? 1.6, rerankPrior: p.prior ?? 0 });
  const hits = await service.recall({ query: 'Which paper goes in the printer?', limit: 5, touch: false });
  assert.equal(hits.length, 2);
  return hits[0]!.memory.source === 'owner_said' ? 'owner_said' : 'other';
}

test('a fact that scores 2.0 higher stays first at the default weight', async (t) => {
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 2.0 }), 'other');
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 1.5 }), 'owner_said');
});

test('an online reranker gives no bonus', async (t) => {
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.5, online: false }), 'owner_said');
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.5, online: true }), 'other');
});

test('the bonus and the rank prior add up', async (t) => {
  // With equal raw scores and no bonus the search's own order decides; find which fact it puts first.
  const searchFirst = await firstOfPair(t, { ownerRaw: 0, otherRaw: 0, weight: 0, prior: 1 });
  // The second fact in search order loses prior * log(2) = 0.693 against the first.
  if (searchFirst === 'other') {
    // Owner fact is second: it needs bonus > gap + 0.693. A gap of 1.0 is beaten by 1.6 alone, not once the prior counts.
    assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 1.0, prior: 0 }), 'owner_said');
    assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 1.0, prior: 1 }), 'other');
    assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.8, prior: 1 }), 'owner_said');
  } else {
    // Owner fact is first: the other one is held back by the prior, so a gap of 2.0 (more than 1.6) is still beaten.
    assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 2.0, prior: 0 }), 'other');
    assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 2.0, prior: 1 }), 'owner_said');
  }
});

test('an assistant that claims owner_said gets half the bonus', async (t) => {
  // A gap of 1.0 sits between 0.8 (half of 1.6) and 1.6.
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 1.0, by: 'owner' }), 'owner_said');
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 1.0, by: 'Claude' }), 'other');
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.7, by: 'Claude' }), 'owner_said');
});

test('an owner_said fact past its date gets no bonus', async (t) => {
  // "Today" is the owner's calendar day: pin the zone so the clock (midnight UTC) is 2026-01-01 on every machine.
  const zone = process.env.OWNER_TIMEZONE;
  process.env.OWNER_TIMEZONE = 'UTC';
  t.after(() => { if (zone === undefined) delete process.env.OWNER_TIMEZONE; else process.env.OWNER_TIMEZONE = zone; });
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.5, validUntil: '2026-01-01' }), 'owner_said'); // the last day is still valid
  assert.equal(await firstOfPair(t, { ownerRaw: 0, otherRaw: 0.5, validUntil: '2025-12-31' }), 'other');
});
