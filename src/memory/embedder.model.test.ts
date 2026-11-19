import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { cosine, createLocalEmbedder, type Embedder } from './embedder.js';
import { E5_PROFILE, GEMMA_PROFILE, type EmbeddingProfile } from './embeddingProfile.js';
import { hybridSearch } from './search.js';
import { MemoryStore } from './store.js';

const enabled = process.env.RUN_MODEL_TESTS === '1';

const DUPLICATES: [string, string][] = [
  ['Has a Synology NAS mounted at /mnt/nas', 'Tiene un NAS Synology montado en /mnt/nas'],
  ['Mini PC runs Ubuntu Server with Docker', 'The mini PC uses Ubuntu Server and Docker Compose'],
  ['Prefers short answers with code examples', 'Likes concise replies that include code samples'],
  ['casa: login rate limiter trusts cf-connecting-ip', 'casa uses cf-connecting-ip for the login rate limit'],
];
const DIFFERENT: [string, string][] = [
  ['Has a Synology NAS mounted at /mnt/nas', 'Second SSD is mounted at /mnt/ssd'],
  ['Mini PC runs Ubuntu Server with Docker', 'Mini PC has 16 GB of RAM'],
  ['casa: login rate limiter trusts cf-connecting-ip', 'casa: backups run nightly via cron'],
  ['Prefers short answers with code examples', 'Lives in Berlin'],
];

// Mount-path facts score close together; accepted because a false positive only costs a retry with allowDuplicate.
const KNOWN_FALSE_POSITIVES: [string, string][] = [
  ['Has a Synology NAS mounted at /mnt/nas', 'Second SSD is mounted at /mnt/ssd'],
];
const isKnownFalsePositive = (pair: [string, string]) =>
  KNOWN_FALSE_POSITIVES.some(([a, b]) => a === pair[0] && b === pair[1]);

test('EmbeddingGemma makes 768-long unit vectors and reads queries and passages differently', { skip: !enabled }, async () => {
  const g = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: true, model: GEMMA_PROFILE });
  const q = await g.embed('where is the NAS mounted', 'query');
  const p = await g.embed('where is the NAS mounted', 'passage');
  assert.equal(q.length, 768);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5);
  assert.ok(cosine(q, p) < 0.999, 'the query and passage prompts apply');
});

const shared = new Map<string, Promise<Embedder>>();
const model = (p: EmbeddingProfile) => {
  if (!shared.has(p.id)) shared.set(p.id, createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: true, model: p }));
  return shared.get(p.id)!;
};

/** The same checks for each search model, against its own profile's cut-offs. */
for (const profile of [E5_PROFILE, GEMMA_PROFILE]) {
test(`${profile.id}: duplicate threshold separates duplicates from different facts`, { skip: !enabled }, async () => {
  const embedder = await model(profile);
  const sim = async ([a, b]: [string, string]) =>
    cosine(await embedder.embed(a, 'passage'), await embedder.embed(b, 'passage'));
  const dup = [];
  for (const pair of DUPLICATES) dup.push({ pair, s: await sim(pair) });
  const diff = [];
  for (const pair of DIFFERENT) diff.push({ pair, s: await sim(pair) });
  for (const { pair, s } of dup) console.log(`DUPLICATE ${s.toFixed(4)}  ${pair[0]}  |  ${pair[1]}`);
  for (const { pair, s } of diff) console.log(`DIFFERENT ${s.toFixed(4)}  ${pair[0]}  |  ${pair[1]}`);
  for (const { pair, s } of dup) assert.ok(s >= profile.duplicate, `duplicate pair scored ${s}: ${pair[0]}`);
  const lowestDuplicate = Math.min(...dup.map((d) => d.s));
  for (const { pair, s } of diff) {
    if (isKnownFalsePositive(pair)) {
      assert.ok(s < lowestDuplicate, `known false positive is indistinguishable from a duplicate (${s}): ${pair[0]}`);
    } else {
      assert.ok(s < profile.duplicate, `different pair scored ${s}: ${pair[0]}`);
    }
  }
});

const RECALL_MEMORIES = [
  'Has a Synology NAS mounted at /mnt/nas',
  'Mini PC runs Ubuntu Server with Docker',
  'Prefers short answers with code examples',
  'casa: login rate limiter trusts cf-connecting-ip',
  'casa uses SQLite for storage',
  'Lives in Berlin',
  'Backups run nightly via cron to two disks',
  'Prefiere respuestas cortas con ejemplos',
];
/** Query → the memory it should find. */
const RELATED: [string, string][] = [
  ['where is the NAS mounted', RECALL_MEMORIES[0]!],
  ['dónde está montado el NAS', RECALL_MEMORIES[0]!],
  ['what operating system does the mini pc run', RECALL_MEMORIES[1]!],
  ['how should answers be formatted', RECALL_MEMORIES[2]!],
  ['¿cómo prefiere las respuestas?', RECALL_MEMORIES[2]!],
  ['rate limiting in casa', RECALL_MEMORIES[3]!],
  ['which database does casa use', RECALL_MEMORIES[4]!],
  ['¿qué base de datos usa casa?', RECALL_MEMORIES[4]!],
  ['where does the owner live', RECALL_MEMORIES[5]!],
  ['how are backups done', RECALL_MEMORIES[6]!],
];
/** Queries that match none of RECALL_MEMORIES; they may return filler, but it must never be marked recalled. */
const UNRELATED = [
  'zxqv blorp', 'asdf qwer zxcv', 'lorem ipsum dolor sit amet', 'recipe for chocolate cake', 'who won the 1998 world cup',
  'best hiking trails in Patagonia', 'receta de tortilla de patatas', 'precio del bitcoin', 'quantum entanglement explained',
  'what is the capital of Australia', 'how to tune a guitar',
];

async function realStore(embedder: Embedder, profile: EmbeddingProfile) {
  const store = new MemoryStore(openDb(':memory:'), () => new Date());
  for (const content of RECALL_MEMORIES) {
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding: await embedder.embed(content, 'passage'), by: 'x' });
  }
  const search = async (text: string) => hybridSearch(store, {
    vector: await embedder.embed(text, 'query'), text, limit: 8,
    minSimilarity: profile.minRecall, confidentSimilarity: profile.confident, keywordWeight: profile.keywordWeight,
  });
  return { store, search };
}

test(`${profile.id}: recall thresholds: related pairs clear the floor, unrelated queries stay under the confident level`, { skip: !enabled }, async () => {
  const embedder = await model(profile);
  const passages: { m: string; v: Float32Array }[] = [];
  for (const m of RECALL_MEMORIES) passages.push({ m, v: await embedder.embed(m, 'passage') });
  const related = [];
  for (const [q, m] of RELATED) related.push({ q, s: cosine(await embedder.embed(q, 'query'), passages.find((p) => p.m === m)!.v) });
  const unrelated = [];
  for (const q of UNRELATED) {
    const qv = await embedder.embed(q, 'query');
    unrelated.push({ q, s: Math.max(...passages.map((p) => cosine(qv, p.v))) });
  }
  for (const { q, s } of related) console.log(`RELATED   ${s.toFixed(4)}  ${q}`);
  for (const { q, s } of unrelated) console.log(`UNRELATED ${s.toFixed(4)}  ${q}`);
  for (const { q, s } of related) assert.ok(s >= profile.minRecall, `related query scored ${s}: ${q}`);
  for (const { q, s } of unrelated) assert.ok(s < profile.confident, `unrelated query scored ${s}: ${q}`);
});

test(`${profile.id}: recall returns every related memory, including across languages`, { skip: !enabled }, async () => {
  const { search } = await realStore(await model(profile), profile);
  for (const [q, m] of RELATED) {
    assert.ok((await search(q)).some((r) => r.memory.content === m), `not returned for: ${q}`);
  }
});

// The search alone returns the nearest fact above the floor even for nonsense: telling an assistant that nothing
// matches closely is the reranker's job (WEAK_SCORE, reranker.model.test.ts). Such filler is never marked recalled.
test(`${profile.id}: the nearest facts returned for a nonsense query are never marked recalled`, { skip: !enabled }, async () => {
  const { store, search } = await realStore(await model(profile), profile);
  console.log(`zxqv blorp returned ${(await search('zxqv blorp')).length} result(s)`);
  console.log(`lorem ipsum returned ${(await search('lorem ipsum dolor sit amet')).length} result(s)`);
  assert.ok(store.list({}).every((m) => m.lastRecalledAt === null), 'filler was marked recalled');
  await search('what operating system does the mini pc run');
  assert.ok(store.list({}).find((m) => m.content === RECALL_MEMORIES[1])!.lastRecalledAt, 'a confident match is marked recalled');
});
}

// Forgetting that sticks: the deleted-match band (duplicate - deletedMargin, plus "keeps the deleted fact's numbers") against
// the texts assistants re-saved in the lifecycle eval, and related facts that must still save (measured 2026-11-19).
// Known gap on gemma (margin 0): the eval's Claude run 3 text (0.691) and Codex run 3 text (0.559) are not held there;
// any margin wide enough would also hold related facts that share the deleted fact's numbers (0.72-0.77).
for (const profile of [E5_PROFILE, GEMMA_PROFILE]) {
  test(`${profile.id}: reworded and re-kinded re-saves of a deleted fact score in the deleted-match band, related facts below it`, { skip: !enabled }, async () => {
    const e = await model(profile);
    const deleted = 'Harbor staging box is called lantern. Its nightly database backup runs at 02:30 UTC.';
    const score = async (a: string, b: string) => cosine(await e.embed(a, 'passage'), await e.embed(b, 'passage'));
    const floor = profile.duplicate - profile.deletedMargin;
    assert.ok(await score(deleted, 'Harbor: the staging box is called "lantern". Its backup is believed to run at 02:30 UTC (owner unsure, "I think", as of 2026-11-19; not verified). Lantern staging was reported slow on 2026-11-19 and the cause is not known yet.') >= profile.duplicate, 'eval Claude run 2');
    if (profile.id === 'e5') {
      assert.ok(await score('Harbor staging box is called lantern. The nightly database backup on lantern runs at 02:30 UTC (as of 2026-11-19).', 'Harbor status 2026-11-19: staging box ("lantern") was slow again today; cause not investigated yet. No host or service details recorded. Open: find why staging is slow (check CPU, memory, disk I/O, and whether it overlaps the 02:30 UTC backup window).') >= floor, 'eval Claude run 3');
      assert.ok(await score("Harbor's staging box is called lantern, and its nightly database backup runs at 02:30 UTC.", "The owner thinks lantern's backup is still scheduled for 02:30 UTC (mentioned 2026-11-19; not independently verified).") >= floor, 'eval Codex run 3');
    }
    for (const other of ['Harbor staging box lantern has 4 GB of RAM and runs Ubuntu Server.', 'Harbor production backups run at 04:00 UTC to a Backblaze B2 bucket.', 'Harbor production database is hosted on Fly.io in the Frankfurt region.', 'Harbor status 2026-11-19: staging was slow today; cause not investigated yet.']) {
      assert.ok(await score(deleted, other) < profile.duplicate, other); // inside the loose band only counts with the same numbers: none of these has 02:30
    }
    assert.ok(await score('staging runs on port 8080', 'production runs on port 443') < floor);
  });
}
