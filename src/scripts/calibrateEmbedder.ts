/**
 * Calibrates a new search model's cut-offs against e5's on a stripped copy of a real brain (plan
 * 2026-11-11-embeddinggemma-swap, Task 4). Prints only numbers: never a fact, a name or a question.
 *
 *   node --import tsx src/scripts/calibrateEmbedder.ts <stripped-copy.db> <questions-dir> [--cutoffs-only]
 *
 * It copies the brain next to itself, re-embeds that copy with Gemma, then for each cut-off:
 * - duplicate, related, threadFloor: rank transfer. The share of pairs at or above e5's value under e5 is found, and
 *   Gemma's value is the similarity at that same share of Gemma pairs (midway between the two neighbours).
 * - confident: the best match of nonsense and off-topic questions against the real brain, plus 0.01 (as e5's was set).
 * - sameProject: halfway between Gemma's scores of the lowest project pair e5 accepts and the highest it rejects.
 * Then the owner's recall test (the three question files in <questions-dir>) on the Gemma copy for keyword weight
 * 0 / 0.25 / 0.5 × rank prior 0 / 1, and on the e5 copy as today.
 * Never point it at a live file: it writes a second database next to the one it is given.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../db.js';
import { cosine, createLocalEmbedder, type Embedder } from '../memory/embedder.js';
import { E5_PROFILE, GEMMA_PROFILE, type EmbeddingProfile } from '../memory/embeddingProfile.js';
import { ensureEmbeddings } from '../memory/reembed.js';
import { parseCases, runRecallTest } from '../memory/recallTest.js';
import { createLocalReranker } from '../memory/reranker.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { PageStore } from '../pages/store.js';

const [path, questions] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!path || !questions) {
  console.error('usage: node --import tsx src/scripts/calibrateEmbedder.ts <stripped-copy.db> <questions-dir>');
  process.exit(2);
}
const repo = fileURLToPath(new URL('../..', import.meta.url));
if (resolve(path) === resolve(process.env.DATA_DIR ?? 'data', 'memory.db') || resolve(path).startsWith(repo)) {
  console.error('refusing: copy the (stripped) database outside the repo first');
  process.exit(2);
}
const modelDir = process.env.MODEL_DIR ?? join(repo, 'models');
const now = () => new Date();

const gemmaPath = join(dirname(path), 'calibrate-gemma.db');
for (const f of [gemmaPath, `${gemmaPath}-wal`, `${gemmaPath}-shm`]) if (existsSync(f)) rmSync(f);
copyFileSync(path, gemmaPath);
const e5Db = openDb(path);
const gDb = openDb(gemmaPath);
const e5 = await createLocalEmbedder({ modelDir, allowRemote: false, model: E5_PROFILE });
const gemma = await createLocalEmbedder({ modelDir, allowRemote: false, model: GEMMA_PROFILE });
await ensureEmbeddings(e5Db, ':memory:', e5, E5_PROFILE, () => {});
await ensureEmbeddings(gDb, ':memory:', gemma, GEMMA_PROFILE, (l) => console.log(l));

const f3 = (x: number) => x.toFixed(3);

/** Pairs scored under both models, in the same order. */
function transfer(name: string, e5Value: number, e5s: number[], gs: number[]): number | null {
  const above = e5s.filter((s) => s >= e5Value).length;
  const share = above / Math.max(e5s.length, 1);
  const sorted = [...gs].sort((a, b) => b - a);
  if (above === 0) { console.log(`${name}: no e5 pair reaches ${e5Value} (of ${e5s.length}); cannot transfer`); return null; }
  const value = above >= sorted.length ? sorted.at(-1)! : (sorted[above - 1]! + sorted[above]!) / 2;
  // How many of the pairs e5 put above its cut-off Gemma also puts above the transferred one.
  const both = e5s.filter((s, i) => s >= e5Value && gs[i]! >= value).length;
  console.log(`${name}: e5 ${e5Value} → ${above}/${e5s.length} pairs (${(share * 100).toFixed(2)}%) → gemma ${f3(value)}; same pairs above both: ${both}/${above}`);
  return value;
}

type Vec = { id: string; embedding: Float32Array };
const byId = (xs: Vec[]) => new Map(xs.map((x) => [x.id, x.embedding]));

// --- duplicate: live facts of the same kind (not roadmaps), as duplicates() pairs them -------------------------------
const projectOfFact = new Map((e5Db.prepare('SELECT id, project FROM memories').all() as { id: string; project: string | null }[]).map((r) => [r.id, r.project]));
const e5Store = new MemoryStore(e5Db, now);
const gStore = new MemoryStore(gDb, now);
const dupE: number[] = []; const dupG: number[] = [];
// closeFacts compares a fact with the others of its own project and kind.
const closeE: number[] = []; const closeG: number[] = [];
for (const kind of ['decision', 'summary', 'profile'] as const) {
  const a = e5Store.activeEmbeddings({ kind }); const g = byId(gStore.activeEmbeddings({ kind }));
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    const se = cosine(a[i]!.embedding, a[j]!.embedding); const sg = cosine(g.get(a[i]!.id)!, g.get(a[j]!.id)!);
    dupE.push(se); dupG.push(sg);
    const pi = projectOfFact.get(a[i]!.id);
    if (pi !== null && pi !== undefined && pi === projectOfFact.get(a[j]!.id)) { closeE.push(se); closeG.push(sg); }
  }
}
const duplicate = transfer('duplicate', E5_PROFILE.duplicate, dupE, dupG);
const closeFacts = transfer('closeFacts', E5_PROFILE.closeFacts, closeE, closeG);

// --- related: a page's mean section vector against live decisions of other projects --------------------------------
function pageMeans(db: DB): Map<string, { project: string | null; v: Float32Array }> {
  const pages = new PageStore(db, now);
  const projectOf = new Map((db.prepare('SELECT id, project FROM pages WHERE deleted_at IS NULL').all() as { id: string; project: string | null }[]).map((r) => [r.id, r.project]));
  const by = new Map<string, Float32Array[]>();
  for (const s of pages.sectionEmbeddings()) by.set(s.pageId, [...(by.get(s.pageId) ?? []), s.embedding]);
  const out = new Map<string, { project: string | null; v: Float32Array }>();
  for (const [id, vs] of by) {
    const mean = new Float32Array(vs[0]!.length);
    for (const v of vs) v.forEach((x, i) => { mean[i]! += x; });
    const n = Math.hypot(...mean) || 1;
    out.set(id, { project: projectOf.get(id) ?? null, v: mean.map((x) => x / n) });
  }
  return out;
}
const pmE = pageMeans(e5Db); const pmG = pageMeans(gDb);
const decE = e5Store.activeEmbeddings({ kind: 'decision' }); const decG = byId(gStore.activeEmbeddings({ kind: 'decision' }));
const relE: number[] = []; const relG: number[] = [];
for (const [id, p] of pmE) for (const d of decE) {
  if (p.project !== null && projectOfFact.get(d.id) === p.project) continue;
  relE.push(cosine(p.v, d.embedding)); relG.push(cosine(pmG.get(id)!.v, decG.get(d.id)!));
}
const related = transfer('related', E5_PROFILE.related, relE, relG);

// --- threadFloor: decisions of different projects (the meaning index links across projects) -------------------------
const thE: number[] = []; const thG: number[] = [];
for (let i = 0; i < decE.length; i++) for (let j = i + 1; j < decE.length; j++) {
  const a = decE[i]!; const b = decE[j]!;
  if (projectOfFact.get(a.id) === projectOfFact.get(b.id)) continue;
  thE.push(cosine(a.embedding, b.embedding)); thG.push(cosine(decG.get(a.id)!, decG.get(b.id)!));
}
const threadFloor = transfer('threadFloor', E5_PROFILE.threadFloor, thE, thG);

// --- confident: the best match of questions about nothing in the brain ----------------------------------------------
const OFF_TOPIC = [
  'zxqv blorp', 'asdf qwer zxcv', 'lorem ipsum dolor sit amet', 'recipe for chocolate cake', 'who won the 1998 world cup',
  'best hiking trails in Patagonia', 'receta de tortilla de patatas', 'precio del bitcoin', 'quantum entanglement explained',
  'what is the capital of Australia', 'how to tune a guitar', 'how do penguins sleep', 'reglas del mus', 'mejor época para ver auroras',
  'translate good morning into Japanese', 'boiling point of water at altitude', 'who painted the Mona Lisa', 'cómo se hace el gazpacho',
];
async function bestOffTopic(embedder: Embedder, store: MemoryStore): Promise<number> {
  const live = store.activeEmbeddings({});
  let best = -1;
  for (const q of OFF_TOPIC) { const v = await embedder.embed(q, 'query'); for (const e of live) best = Math.max(best, cosine(v, e.embedding)); }
  return best;
}
const offE = await bestOffTopic(e5, e5Store); const offG = await bestOffTopic(gemma, gStore);
const confident = Math.max(offG + 0.01, GEMMA_PROFILE.minRecall);
console.log(`confident: best off-topic match e5 ${f3(offE)} (e5 uses ${E5_PROFILE.confident}), gemma ${f3(offG)} → gemma ${f3(confident)}`);

// --- sameProject: tidy's overlap score for every project pair -------------------------------------------------------
function overlapScores(store: MemoryStore): Map<string, number> {
  const vectors = new Map<string, Float32Array[]>();
  for (const e of store.activeEmbeddings({})) { const p = projectOfFact.get(e.id); if (p) vectors.set(p, [...(vectors.get(p) ?? []), e.embedding]); }
  const names = [...vectors.keys()].sort();
  const out = new Map<string, number>();
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [x, y] = [names[i]!, names[j]!];
    const [small, large] = vectors.get(x)!.length <= vectors.get(y)!.length ? [x, y] : [y, x];
    const mine = vectors.get(small)!; const others = vectors.get(large)!;
    out.set(`${x}\u0000${y}`, mine.reduce((s, v) => s + Math.max(...others.map((o) => cosine(v, o))), 0) / mine.length);
  }
  return out;
}
const spE = overlapScores(e5Store); const spG = overlapScores(gStore);
const accepted = [...spE].filter(([, s]) => s >= E5_PROFILE.sameProject).map(([k]) => spG.get(k)!);
const rejected = [...spE].filter(([, s]) => s < E5_PROFILE.sameProject).map(([k]) => spG.get(k)!);
const lowAcc = accepted.length ? Math.min(...accepted) : NaN; const highRej = Math.max(...rejected);
const sameProject = accepted.length === 0 ? null : lowAcc > highRej ? (lowAcc + highRej) / 2 : null;
console.log(`sameProject: ${accepted.length} of ${spE.size} pairs accepted by e5; gemma lowest accepted ${f3(lowAcc)}, highest rejected ${f3(highRej)} → ${sameProject === null ? 'orders disagree or none accepted' : f3(sameProject)}`);
if (sameProject === null && accepted.length > 0) {
  const sorted = [...spG.values()].sort((a, b) => b - a);
  const value = (sorted[accepted.length - 1]! + sorted[accepted.length]!) / 2;
  const same = accepted.filter((s) => s >= value).length;
  console.log(`sameProject (rank transfer instead): gemma ${f3(value)} accepts ${sorted.filter((s) => s >= value).length} pairs, ${same} of them e5's`);
}

if (process.argv.includes('--cutoffs-only')) {
  console.log(`summary: duplicate ${duplicate} closeFacts ${closeFacts} related ${related} threadFloor ${threadFloor} confident ${f3(confident)} sameProject ${sameProject}`);
  e5Db.close(); gDb.close();
  process.exit(0);
}
// --- the owner's recall test -----------------------------------------------------------------------------------------
const files = ['recall-test.json', 'recall-holdout.json', 'recall-more.json'].map((f) => join(questions, f));
const cases = files.map((f) => parseCases(readFileSync(f, 'utf8')));
const reranker = await createLocalReranker({ modelDir, allowRemote: false });
async function score(db: DB, embedder: Embedder, p: EmbeddingProfile, label: string): Promise<void> {
  const service = new MemoryService(new MemoryStore(db, now), embedder, {
    duplicateThreshold: p.duplicate, minRecallSimilarity: p.minRecall, recallConfidentSimilarity: p.confident, recallWindow: p.window,
    keywordWeight: p.keywordWeight, rerankPrior: p.rerankPrior, reranker,
  });
  const totals = { n: 0, first: 0, top3: 0, top8: 0 };
  for (const c of cases) {
    const r = await runRecallTest(service, c, 8);
    for (const x of r.results) { totals.n++; if (x.rank === 1) totals.first++; if (x.rank !== null && x.rank <= 3) totals.top3++; if (x.rank !== null && x.rank <= 8) totals.top8++; }
  }
  console.log(`recall ${label}: ${totals.n} questions, first ${totals.first}, top 3 ${totals.top3}, top 8 ${totals.top8}`);
}
await score(e5Db, e5, E5_PROFILE, 'e5 today');
const base: EmbeddingProfile = { ...GEMMA_PROFILE, duplicate: duplicate ?? GEMMA_PROFILE.duplicate, confident };
for (const keywordWeight of [0, 0.25, 0.5]) for (const rerankPrior of [0, 1]) {
  await score(gDb, gemma, { ...base, keywordWeight, rerankPrior }, `gemma kw=${keywordWeight} prior=${rerankPrior}`);
}
console.log(`summary: duplicate ${duplicate === null ? '-' : f3(duplicate)} related ${related === null ? '-' : f3(related)} threadFloor ${threadFloor === null ? '-' : f3(threadFloor)} confident ${f3(confident)} sameProject ${sameProject === null ? '-' : f3(sameProject)}`);
e5Db.close(); gDb.close();
