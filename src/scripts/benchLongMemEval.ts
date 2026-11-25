/**
 * npm run bench:longmemeval [-- --cache <dir>] [--limit <n>] [--rerank on|off] [--sample <per category>] [--dated] [--only <id,...>]
 * — BrainAI's recall on LongMemEval_S (A3, docs/BENCHMARK.md). Downloads the pinned, cleaned longmemeval_s once into the
 * cache (bench-results/cache by default, git-ignored) and checks its SHA-256. For each question it saves every turn of
 * that question's ~50-session chat history in a fresh in-memory brain with the real local model and the server's own
 * recall settings (the reranker on unless --rerank off), asks the question for up to --limit (default 20) results, and
 * scores whether the answer sessions / answer turns are among them. --sample n takes n questions per category.
 * Passage embeddings are cached on disk per model (the cache folder), so a re-run (rerank on/off, other limit) skips
 * the slow part. Prints a table; writes bench-results/longmemeval-<date>-<sample|full>[-norerank][-dated].json.
 * Retrieval only: not comparable to end-to-end, model-judged LongMemEval scores.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ownerSaidWeight } from '../config.js';
import { profileFor } from '../memory/embeddingProfile.js';
import { openDb } from '../db.js';
import { createLocalEmbedder, type Embedder } from '../memory/embedder.js';
import { createLocalReranker, RERANK_MODEL, WEAK_SCORE } from '../memory/reranker.js';
import { benchQuestion, categoryOf, checkLmePinned, LME_CATEGORIES, LME_REVISION, LME_SHA256, LME_URL, parseLongMemEval, scoreLme, stratified, type LmeResult } from '../memory/longmemeval.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const cache = arg('--cache', 'bench-results/cache');
const out = arg('--out', 'bench-results');
const limit = Math.min(20, Math.max(1, Number(arg('--limit', '20')) || 20));
const rerankArg = arg('--rerank', 'on');
if (rerankArg !== 'on' && rerankArg !== 'off') throw new Error('--rerank must be on or off');
const rerank = rerankArg === 'on';
const sample = Math.max(0, Number(arg('--sample', '0')) || 0);
const only = arg('--only', '').split(',').filter(Boolean);
const dated = process.argv.includes('--dated');

const file = join(cache, 'longmemeval_s_cleaned.json');
if (!existsSync(file)) {
  mkdirSync(cache, { recursive: true });
  console.log(`Downloading LongMemEval_S (xiaowu0162/longmemeval-cleaned at ${LME_REVISION.slice(0, 7)}, MIT, 277 MB) ...`);
  const res = await fetch(LME_URL);
  if (!res.ok) throw new Error(`Could not download LongMemEval: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  checkLmePinned(bytes);
  writeFileSync(file, bytes);
}
const raw = readFileSync(file);
checkLmePinned(raw);
let questions = parseLongMemEval(raw.toString('utf8'));
if (only.length) questions = questions.filter((q) => only.includes(q.id));
else if (sample) questions = stratified(questions, sample);

const profile = profileFor(process.env.EMBED_MODEL);
const weight = ownerSaidWeight(process.env.OWNER_SAID_WEIGHT) ?? profile.ownerSaidWeight;
const inner = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false, model: profile });
// Passage embeddings kept on disk: records of a 16-byte text hash and the vector (float32), appended as made.
const embFile = join(cache, `lme-embeddings-${profile.id}.bin`);
const known = new Map<string, Float32Array>();
let dim = 0, hits = 0, misses = 0;
if (existsSync(embFile)) {
  const buf = readFileSync(embFile);
  dim = buf.readUInt32LE(0);
  for (let o = 4; o + 16 + dim * 4 <= buf.length; o += 16 + dim * 4) {
    known.set(buf.subarray(o, o + 16).toString('hex'), new Float32Array(buf.buffer.slice(buf.byteOffset + o + 16, buf.byteOffset + o + 16 + dim * 4)));
  }
}
const embedder: Embedder = {
  async embed(text, purpose) {
    if (purpose !== 'passage') return inner.embed(text, purpose);
    const key = createHash('sha256').update(text).digest().subarray(0, 16);
    const hex = key.toString('hex');
    const have = known.get(hex);
    if (have) { hits++; return have; }
    misses++;
    const v = await inner.embed(text, purpose);
    if (!existsSync(embFile)) { dim = v.length; const h = Buffer.alloc(4); h.writeUInt32LE(dim); writeFileSync(embFile, h); }
    appendFileSync(embFile, Buffer.concat([key, Buffer.from(v.buffer, v.byteOffset, v.byteLength)]));
    known.set(hex, v);
    return v;
  },
};
const reranker = rerank ? await createLocalReranker({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false }) : undefined;

const all: LmeResult[] = [];
let saved = 0, unsaved = 0;
const started = Date.now();
for (const [i, q] of questions.entries()) {
  let at: Date | null = null;
  const store = new MemoryStore(openDb(':memory:'), () => at ?? new Date());
  const service = new MemoryService(store, embedder, {
    duplicateThreshold: profile.duplicate, minRecallSimilarity: profile.minRecall,
    recallConfidentSimilarity: profile.confident, recallWindow: profile.window, reranker,
    ownerSaidWeight: weight, keywordWeight: profile.keywordWeight, rerankPrior: profile.rerankPrior, closeFacts: profile.closeFacts,
  });
  const r = await benchQuestion(q, service, { limit, weakBelow: WEAK_SCORE, dated: dated ? (d) => { at = d; } : undefined });
  all.push(r);
  saved += r.facts; unsaved += r.unsaved;
  if ((i + 1) % 10 === 0 || i + 1 === questions.length) console.log(`${i + 1}/${questions.length} questions, ${((Date.now() - started) / 1000).toFixed(0)} s, ${hits} cached / ${misses} new embeddings`);
}
const seconds = (Date.now() - started) / 1000;

const scores = scoreLme(all);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
const row = (name: string, s: ReturnType<typeof scoreLme>['overall']) =>
  `${name.padEnd(26)} ${String(s.questions).padStart(4)}  ${[s.hit1, s.hit8, s.hit20, s.all8, s.all20, s.turn1, s.turn8, s.turn20, s.weak, s.empty].map(pct).join('  ')}  ${s.mrr.toFixed(3)}`;
console.log(`\nLongMemEval_S recall, retrieval only, up to ${limit} results, reranker ${rerank ? 'on' : 'off'}${dated ? ', dated' : ''} (${saved} facts saved, ${seconds.toFixed(0)} s)`);
console.log(`${'category'.padEnd(26)} ${'qs'.padStart(4)}  ${['s@1', 's@8', 's@20', 'all@8', 'all@20', 't@1', 't@8', 't@20', 'weak', 'empty'].map((h) => h.padStart(6)).join('  ')}  MRR`);
for (const c of LME_CATEGORIES) if (scores.byCategory[c]) console.log(row(c, scores.byCategory[c]!));
console.log(row('all', scores.overall));
console.log(`s = an answer session is at that rank or better, all = every answer session is, t = an answer turn (has_answer) is; weak/empty = recall warned of a weak match / returned nothing. ${unsaved} facts not saved.`);

mkdirSync(out, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const variant = `${sample ? `sample${sample}` : only.length ? 'only' : 'full'}${rerank ? '' : '-norerank'}${dated ? '-dated' : ''}`;
writeFileSync(join(out, `longmemeval-${day}-${variant}.json`), JSON.stringify({
  date: day, data: { variant: 'longmemeval_s_cleaned', revision: LME_REVISION, sha256: LME_SHA256 }, model: profile.id, reranker: rerank ? RERANK_MODEL : null,
  settings: { ...profile, ownerSaidWeight: weight, limit, sample, dated }, seconds, facts: saved, unsaved, scores,
  perQuestion: all.map((r) => ({ ...r, type: questions.find((q) => q.id === r.id)?.type, abstention: categoryOf({ id: r.id, type: '' }) === 'abstention' })),
}, null, 2));
