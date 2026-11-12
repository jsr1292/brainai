/**
 * npm run bench:locomo [-- --cache <dir>] [--limit <n>] [--rerank on|off] [--evidence audited|original] [--against <earlier json>]
 * — BrainAI's recall on LoCoMo (B1, docs/BENCHMARK.md). Downloads the pinned locomo10.json and, unless --evidence
 * original, the LoCoMo audit's error list once into the cache (bench-results/cache by default, git-ignored), checks
 * their SHA-256s, applies the audit's corrected evidence, then for each
 * of the 10 conversations saves every turn in a fresh in-memory brain with the real local model and the server's own
 * recall settings (the reranker on unless --rerank off), and asks each answerable question. Prints a table; writes
 * bench-results/locomo-<date>-top<limit>[-norerank][-original].json with each question's rank; --against an earlier
 * such file lists the questions gained and lost within 1 and within 8.
 * Retrieval only: not comparable to end-to-end, model-judged LoCoMo scores.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileFor } from '../memory/embeddingProfile.js';
import { openDb } from '../db.js';
import { createLocalEmbedder } from '../memory/embedder.js';
import { createLocalReranker, RERANK_MODEL } from '../memory/reranker.js';
import { applyAudit, benchConversation, CATEGORY_NAMES, checkPinned, LOCOMO_AUDIT_COMMIT, LOCOMO_AUDIT_SHA256, LOCOMO_AUDIT_URL, LOCOMO_COMMIT, LOCOMO_SHA256, LOCOMO_URL, parseLocomo, scoreRecall, type Score } from '../memory/locomo.js';
import { comparePaired } from '../memory/recallTest.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const cache = arg('--cache', 'bench-results/cache');
const out = arg('--out', 'bench-results');
/** How many results each question asks recall for: 10 by default, at most 20 (recall's own limit). */
const limit = Math.min(20, Math.max(1, Number(arg('--limit', '10')) || 10));
const rerankArg = arg('--rerank', 'on');
if (rerankArg !== 'on' && rerankArg !== 'off') throw new Error('--rerank must be on or off');
const rerank = rerankArg === 'on';
const evidence = arg('--evidence', 'audited');
if (evidence !== 'audited' && evidence !== 'original') throw new Error('--evidence must be audited or original');
const againstFile = arg('--against', '');
/** --pack <chars> saves runs of turns of one session as long facts, up to that many characters (0: one turn per fact). */
const pack = Math.max(0, Math.min(1000, Number(arg('--pack', '0')) || 0));
/** --dated (B10): each turn saved on its session's day, the questions asked the day after the last session. */
const dated = process.argv.includes('--dated');

/** The cached copy of a pinned download, fetched once and checked every time. */
async function pinned(name: string, url: string, sha256: string, what: string): Promise<Buffer> {
  const file = join(cache, name);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    console.log(`Downloading ${what} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${what}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    checkPinned(bytes, sha256);
    writeFileSync(file, bytes);
  }
  const bytes = readFileSync(file);
  checkPinned(bytes, sha256);
  return bytes;
}

const conversations = parseLocomo((await pinned('locomo10.json', LOCOMO_URL, LOCOMO_SHA256, `LoCoMo (snap-research/locomo at ${LOCOMO_COMMIT.slice(0, 7)}, CC BY-NC 4.0)`)).toString('utf8'));
const audit = evidence === 'audited'
  ? applyAudit(conversations, (await pinned('locomo-audit-errors.json', LOCOMO_AUDIT_URL, LOCOMO_AUDIT_SHA256, `the LoCoMo audit (dial481/locomo-audit at ${LOCOMO_AUDIT_COMMIT.slice(0, 7)}, CC BY-NC 4.0)`)).toString('utf8'))
  : null;

// EMBED_MODEL picks the model and every cut-off tuned for it, as the server does.
const profile = profileFor(process.env.EMBED_MODEL);
const embedder = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false, model: profile });
const reranker = rerank ? await createLocalReranker({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false }) : undefined;
const all: { id: string; category: number; rank: number | null }[] = [];
const skipped = { adversarial: 0, noEvidence: 0, unsaved: 0 };
let turns = 0;
const started = Date.now();
for (const c of conversations) {
  let at: Date | null = null;
  const store = new MemoryStore(openDb(':memory:'), () => at ?? new Date());
  const service = new MemoryService(store, embedder, {
    duplicateThreshold: profile.duplicate, minRecallSimilarity: profile.minRecall,
    recallConfidentSimilarity: profile.confident, recallWindow: profile.window, reranker,
    keywordWeight: profile.keywordWeight, rerankPrior: profile.rerankPrior, closeFacts: profile.closeFacts,
  });
  const r = await benchConversation(c, service, { limit, pack, dated: dated ? (d) => { at = d; } : undefined });
  all.push(...r.results);
  turns += r.saved;
  for (const k of ['adversarial', 'noEvidence', 'unsaved'] as const) skipped[k] += r.skipped[k];
  console.log(`${c.id}: ${r.saved} ${pack ? 'facts' : 'turns'}, ${r.results.length} questions`);
}

const scores = scoreRecall(all);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const row = (name: string, s: Score) => `${name.padEnd(12)} ${String(s.questions).padStart(5)}  ${[s.hit1, s.hit5, s.hit8, s.hit10, ...(limit > 10 ? [s.hit20] : [])].map((x) => pct(x).padStart(6)).join('  ')}  ${s.mrr.toFixed(3)}`;
console.log(`\nLoCoMo recall, retrieval only, up to ${limit} results, reranker ${rerank ? 'on' : 'off'}, ${audit ? `audited evidence (${audit.fixed} questions corrected)` : 'original evidence'} (${turns} turns saved, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
console.log(`${'category'.padEnd(12)} ${'qs'.padStart(5)}  ${['@1', '@5', '@8', '@10', ...(limit > 10 ? ['@20'] : [])].map((h) => h.padStart(6)).join('  ')}  MRR`);
for (const [c, s] of Object.entries(scores.byCategory)) console.log(row(CATEGORY_NAMES[Number(c)] ?? c, s));
console.log(row('all', scores.overall));
console.log(`Skipped: ${skipped.adversarial} adversarial (no answer exists), ${skipped.noEvidence} without evidence, ${skipped.unsaved} turns not saved.`);

mkdirSync(out, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const perQuestion = all.map(({ id, category, rank }) => ({ id, category, rank }));
if (againstFile) {
  const before = (JSON.parse(readFileSync(againstFile, 'utf8')) as { perQuestion?: { id: string; rank: number | null }[] }).perQuestion;
  if (!before) throw new Error(`${againstFile} has no per-question ranks (it was written before they were recorded)`);
  for (const k of [1, 8]) {
    const { gained, lost } = comparePaired(before, perQuestion, k);
    console.log(`Against ${againstFile}, within ${k}: ${gained.length} gained, ${lost.length} lost (net ${gained.length - lost.length >= 0 ? '+' : ''}${gained.length - lost.length})`);
  }
}
const variant = `${rerank ? '' : '-norerank'}${audit ? '' : '-original'}${pack ? `-pack${pack}` : ''}${dated ? '-dated' : ''}`;
writeFileSync(join(out, `locomo-${day}-top${limit}${variant}.json`), JSON.stringify({
  date: day, data: { commit: LOCOMO_COMMIT, sha256: LOCOMO_SHA256 }, evidence: audit ? { audit: LOCOMO_AUDIT_COMMIT, sha256: LOCOMO_AUDIT_SHA256, corrected: audit.fixed } : 'original', model: profile.id, reranker: rerank ? RERANK_MODEL : null,
  settings: { ...profile, limit, pack },
  turns, skipped, scores, perQuestion,
}, null, 2));
