/**
 * npm run bench:locomo [-- --cache <dir>] — BrainAI's recall on LoCoMo (B1, docs/BENCHMARK.md). Downloads the pinned
 * locomo10.json once into the cache (bench-results/cache by default, git-ignored), checks its SHA-256, then for each
 * of the 10 conversations saves every turn in a fresh in-memory brain with the real local model and the server's own
 * recall settings, and asks each answerable question. Prints a table; writes bench-results/locomo-<date>.json.
 * Retrieval only: not comparable to end-to-end, model-judged LoCoMo scores.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DUPLICATE_THRESHOLD, DEFAULT_MIN_RECALL_SIMILARITY, DEFAULT_RECALL_CONFIDENT_SIMILARITY, DEFAULT_RECALL_WINDOW } from '../config.js';
import { openDb } from '../db.js';
import { createLocalEmbedder } from '../memory/embedder.js';
import { benchConversation, CATEGORY_NAMES, checkPinned, LOCOMO_COMMIT, LOCOMO_SHA256, LOCOMO_URL, parseLocomo, scoreRecall, type Score } from '../memory/locomo.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const cache = arg('--cache', 'bench-results/cache');
const out = arg('--out', 'bench-results');
const file = join(cache, 'locomo10.json');

if (!existsSync(file)) {
  mkdirSync(cache, { recursive: true });
  console.log(`Downloading LoCoMo (snap-research/locomo at ${LOCOMO_COMMIT.slice(0, 7)}, CC BY-NC 4.0) ...`);
  const res = await fetch(LOCOMO_URL);
  if (!res.ok) throw new Error(`Could not download LoCoMo: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  checkPinned(bytes);
  writeFileSync(file, bytes);
}
const bytes = readFileSync(file);
checkPinned(bytes);
const conversations = parseLocomo(bytes.toString('utf8'));

const embedder = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false });
const all: { category: number; rank: number | null }[] = [];
const skipped = { adversarial: 0, noEvidence: 0, unsaved: 0 };
let turns = 0;
const started = Date.now();
for (const c of conversations) {
  const store = new MemoryStore(openDb(':memory:'), () => new Date());
  const service = new MemoryService(store, embedder, {
    duplicateThreshold: DEFAULT_DUPLICATE_THRESHOLD, minRecallSimilarity: DEFAULT_MIN_RECALL_SIMILARITY,
    recallConfidentSimilarity: DEFAULT_RECALL_CONFIDENT_SIMILARITY, recallWindow: DEFAULT_RECALL_WINDOW,
  });
  const r = await benchConversation(c, service);
  all.push(...r.results);
  turns += r.saved;
  for (const k of ['adversarial', 'noEvidence', 'unsaved'] as const) skipped[k] += r.skipped[k];
  console.log(`${c.id}: ${r.saved} turns, ${r.results.length} questions`);
}

const scores = scoreRecall(all);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const row = (name: string, s: Score) => `${name.padEnd(12)} ${String(s.questions).padStart(5)}  ${pct(s.hit1).padStart(6)}  ${pct(s.hit5).padStart(6)}  ${pct(s.hit10).padStart(6)}  ${s.mrr.toFixed(3)}`;
console.log(`\nLoCoMo recall, retrieval only (${turns} turns saved, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
console.log(`${'category'.padEnd(12)} ${'qs'.padStart(5)}  ${'@1'.padStart(6)}  ${'@5'.padStart(6)}  ${'@10'.padStart(6)}  MRR`);
for (const [c, s] of Object.entries(scores.byCategory)) console.log(row(CATEGORY_NAMES[Number(c)] ?? c, s));
console.log(row('all', scores.overall));
console.log(`Skipped: ${skipped.adversarial} adversarial (no answer exists), ${skipped.noEvidence} without evidence, ${skipped.unsaved} turns not saved.`);

mkdirSync(out, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
writeFileSync(join(out, `locomo-${day}.json`), JSON.stringify({
  date: day, data: { commit: LOCOMO_COMMIT, sha256: LOCOMO_SHA256 }, model: 'Xenova/multilingual-e5-small (q8)',
  settings: { duplicateThreshold: DEFAULT_DUPLICATE_THRESHOLD, minRecallSimilarity: DEFAULT_MIN_RECALL_SIMILARITY, recallConfidentSimilarity: DEFAULT_RECALL_CONFIDENT_SIMILARITY, recallWindow: DEFAULT_RECALL_WINDOW, limit: 10 },
  turns, skipped, scores,
}, null, 2));
