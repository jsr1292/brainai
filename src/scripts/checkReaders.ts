/**
 * Records what recall, project briefs and what's left return on a copy of a real database, so a later change can be
 * shown to leave them the same. Prints only counts, hashes and milliseconds: never a name or any text.
 *
 *   node --import tsx src/scripts/checkReaders.ts <copy.db> --out <file.json>
 *   node --import tsx src/scripts/checkReaders.ts <copy.db> --compare <file.json> [--round-trip]
 *
 * --round-trip (section 16) replaces one real decision with another on the copy, checks that every reader leaves it
 * out (and that include_replaced finds it without changing the current results), undoes it, and checks every reader
 * is back to the baseline.
 *
 * Opening the copy runs the migrations on it, so never point this at the live file. Recall is run with the copy's own
 * stored vectors (and a seeded, noisy copy of each), so the vector ranking and its relative floor decide the results.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DEFAULT_RECALL_WINDOW } from '../config.js';
import { openDb } from '../db.js';
import { cosine } from '../memory/embedder.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';

const args = process.argv.slice(2);
const path = args[0];
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outPath = flag('--out');
const comparePath = flag('--compare');
if (!path || (!outPath && !comparePath)) {
  console.error('usage: node --import tsx src/scripts/checkReaders.ts <copy.db> (--out <file.json> | --compare <file.json>)');
  process.exit(2);
}

const MIN_SIMILARITY = 0.2;
const db = openDb(path);
const schema = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
const newest = (db.prepare('SELECT max(created_at) AS at FROM memories').get() as { at: string | null }).at;
if (newest === null) throw new Error('the copy has no memories');
const now = () => new Date(newest);
const store = new MemoryStore(db, now);
const service = new MemoryService(store, createFakeEmbedder(), {
  duplicateThreshold: 0.9, minRecallSimilarity: MIN_SIMILARITY, recallConfidentSimilarity: 0.2, recallWindow: DEFAULT_RECALL_WINDOW,
});

const sha = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const short = (h: string) => h.slice(0, 12);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** A small seeded PRNG (mulberry32): the same noise on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noisy(v: Float32Array, seed: number): Float32Array {
  const rand = prng(seed);
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) { out[i] = v[i]! + (rand() * 2 - 1) * 0.02; norm += out[i]! * out[i]!; }
  norm = Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

// Every current fact is a row with no deletion and, once replaced facts exist, no live replacement.
const hasSupersessions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supersessions'").get() !== undefined;
const currentSql = `deleted_at IS NULL${hasSupersessions ? ' AND NOT EXISTS (SELECT 1 FROM supersessions s WHERE s.old_id = memories.id AND s.undone_at IS NULL)' : ''}`;
const facts = db.prepare(`SELECT rowid, id, content, project, embedding FROM memories WHERE ${currentSql} ORDER BY rowid LIMIT 40`)
  .all() as { rowid: number; id: string; content: string; project: string | null; embedding: Buffer }[];
const stored = new Map((db.prepare('SELECT id, embedding FROM memories').all() as { id: string; embedding: Buffer }[]).map((r) => [r.id, fromBlob(r.embedding)]));

interface Query { query: string; vector: Float32Array; project?: string }
const queries: Query[] = facts.flatMap((f) => {
  const query = f.content.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const exact = fromBlob(f.embedding);
  const near = noisy(exact, f.rowid);
  const project = f.project ?? undefined;
  return [{ query, vector: exact }, { query, vector: exact, project }, { query, vector: near }, { query, vector: near, project }];
});

async function runRecall(extra: Record<string, unknown> = {}): Promise<{ memory: { id: string }; score: number; replaced?: true }[][]> {
  const out: { memory: { id: string }; score: number; replaced?: true }[][] = [];
  for (const q of queries) out.push(await service.recall({ query: q.query, vector: q.vector, project: q.project, limit: 8, touch: false, ...extra }));
  return out;
}
const recallKey = (rs: { memory: { id: string }; score: number }[][]) => rs.map((r) => r.map((x) => [x.memory.id, Number(x.score.toFixed(6))]));

async function runBriefs() {
  const out: unknown[] = [];
  for (const p of service.listProjects()) {
    const b = await service.brief(p.project);
    out.push(b.found ? [p.project, b.brief.roadmap?.id ?? null, b.brief.statuses.map((m) => m.id), b.brief.decisions.map((m) => m.id), b.brief.omitted] : [p.project, null]);
  }
  return out;
}
const runWhatsLeft = () => {
  const w = service.whatsLeft(now());
  return [w.projects.map((p) => [p.project, p.roadmap.id]), w.waiting.map((x) => sha(x.text))];
};

async function time(fn: () => unknown): Promise<{ median: number; max: number }> {
  for (let i = 0; i < 3; i++) await fn();
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    await fn();
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  return { median: ms[10]!, max: ms[19]! };
}
const f1 = (n: number) => n.toFixed(1);

interface ReaderResult { hash: string; median: number; max: number; [k: string]: unknown }
const results: Record<string, ReaderResult> = {};

console.log(`schema version: ${schema}`);
if (hasSupersessions) console.log(`supersessions rows: ${(db.prepare('SELECT COUNT(*) AS n FROM supersessions').get() as { n: number }).n}`);

const recalled = await runRecall();
const resultCount = recalled.reduce((a, r) => a + r.length, 0);
let fromVectors = 0;
// A result came from vectors when its similarity reaches the relative floor recall used (best current candidate minus
// the window), not only from a keyword hit.
recalled.forEach((r, i) => {
  const q = queries[i]!;
  const best = Math.max(...store.activeEmbeddings({ project: q.project ? service.projectNamed(q.project) : undefined }).map((e) => cosine(q.vector, e.embedding)));
  const floor = Math.max(MIN_SIMILARITY, best - (DEFAULT_RECALL_WINDOW ?? Infinity));
  for (const x of r) if (cosine(q.vector, stored.get(x.memory.id)!) >= floor) fromVectors++;
});
const recallTime = await time(() => runRecall());
results.recall = { hash: sha(recallKey(recalled)), ...recallTime, queries: queries.length, results: resultCount, fromVectors };
console.log(`recall: ${queries.length} queries, ${resultCount} results, ${fromVectors} from vectors, hash ${short(results.recall.hash)}, median ${f1(recallTime.median)} ms, max ${f1(recallTime.max)} ms`);

const briefs = await runBriefs();
const briefTime = await time(() => runBriefs());
results.project_brief = { hash: sha(briefs), ...briefTime, projects: briefs.length };
console.log(`project_brief: ${briefs.length} projects, hash ${short(results.project_brief.hash)}, median ${f1(briefTime.median)} ms, max ${f1(briefTime.max)} ms`);

const left = runWhatsLeft();
const leftTime = await time(runWhatsLeft);
results.whats_left = { hash: sha(left), ...leftTime, projects: (left[0] as unknown[]).length, waiting: (left[1] as unknown[]).length };
console.log(`whats_left: ${(left[0] as unknown[]).length} projects, ${(left[1] as unknown[]).length} waiting, hash ${short(results.whats_left.hash)}, median ${f1(leftTime.median)} ms, max ${f1(leftTime.max)} ms`);

let failed = false;
if (outPath) writeFileSync(outPath, JSON.stringify({ schema, results }, null, 2));
if (comparePath) {
  const base = JSON.parse(readFileSync(comparePath, 'utf8')) as { schema: number; results: Record<string, ReaderResult> };
  for (const [name, r] of Object.entries(results)) {
    const b = base.results[name]!;
    const same = b.hash === r.hash;
    // Each median may be at most 1.25 times its baseline plus half a millisecond.
    const within = r.median <= 1.25 * b.median + 0.5;
    if (!same || !within) failed = true;
    console.log(`${name}: ${same ? 'same' : 'DIFFERENT'}, median ${f1(b.median)} → ${f1(r.median)} ms (×${(r.median / b.median).toFixed(2)}, ${within ? 'within' : 'OVER'})`);
  }
}
if (args.includes('--round-trip')) {
  if (!hasSupersessions) throw new Error('--round-trip needs migration 22');
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT m.* FROM memories m WHERE 1=1 AND m.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM supersessions s WHERE s.old_id = m.id AND s.undone_at IS NULL)
    ORDER BY m.updated_at DESC, m.rowid DESC LIMIT -1 OFFSET 0`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
  console.log(`uses supersessions_live: ${plan.includes('supersessions_live') ? 'yes' : 'no'}`);
  // The first project (by rowid) with two current decisions; the older is replaced by the newer.
  const decisions = db.prepare(`SELECT rowid, id, project, created_at FROM memories WHERE ${currentSql} AND kind = 'decision'
    AND NOT EXISTS (SELECT 1 FROM json_each(memories.tags) t WHERE t.value = 'status') AND project IS NOT NULL ORDER BY rowid`)
    .all() as { rowid: number; id: string; project: string; created_at: string }[];
  const byProject = new Map<string, typeof decisions>();
  for (const d of decisions) byProject.set(d.project, [...(byProject.get(d.project) ?? []), d]);
  const pair = [...byProject.values()].find((ds) => ds.length >= 2)!.slice(0, 2).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const [older, newer] = [pair[0]!, pair[1]!];
  const project = service.projectNamed(older.project);
  const briefOf = async () => { const b = await service.brief(project); if (!b.found) throw new Error('no brief'); return b.brief; };
  const before = await briefOf();
  const [row] = service.supersede([older.id], newer.id, { type: 'owner' });
  const after = await runRecall();
  const hidden = after.filter((r) => !r.some((x) => x.memory.id === older.id)).length;
  const included = await runRecall({ replaced: 'include' });
  const currentSame = sha(recallKey(included.map((r) => r.filter((x) => !x.replaced)))) === sha(recallKey(after));
  const own = stored.get(older.id)!;
  const ownText = (db.prepare('SELECT content FROM memories WHERE id = ?').get(older.id) as { content: string }).content.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const foundIt = (await service.recall({ query: ownText, vector: own, limit: 8, touch: false, replaced: 'include' })).some((x) => x.replaced && x.memory.id === older.id);
  const briefAfter = await briefOf();
  const leftOut = !briefAfter.decisions.some((m) => m.id === older.id);
  const omittedSame = briefAfter.omitted === before.omitted;
  const leftSame = sha(runWhatsLeft()) === results.whats_left!.hash;
  service.undoSupersession(row!.id, { type: 'owner' });
  const back = sha(recallKey(await runRecall())) === results.recall!.hash && sha(await runBriefs()) === results.project_brief!.hash && sha(runWhatsLeft()) === results.whats_left!.hash;
  const ok = hidden === queries.length && currentSame && foundIt && leftOut && omittedSame && leftSame && back;
  if (!ok) failed = true;
  console.log(`round trip: replaced fact hidden in ${hidden} of ${queries.length} recalls, include_replaced current parts ${currentSame ? 'same' : 'DIFFERENT'} and ${foundIt ? 'found it' : 'did NOT find it'}, brief ${leftOut ? 'left it out' : 'KEPT it'}, omitted ${omittedSame ? 'unchanged' : 'CHANGED'}, whats_left ${leftSame ? 'same' : 'DIFFERENT'}; after undo ${back ? 'all same' : 'NOT all same'}`);
}
db.close();
process.exit(failed ? 1 : 0);
