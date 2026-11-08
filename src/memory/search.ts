import { cosine } from './embedder.js';
import { STOPWORDS } from './stopwords.js';
import type { MemoryStore } from './store.js';
import type { Kind, Memory } from './types.js';

const CANDIDATES = 50;
const RRF_K = 60;
/**
 * A keyword rank counts half as much as a vector rank: words shared with many memories (a project name, "owner")
 * otherwise lift keyword-only matches above the best match by meaning. Tuned with the recall test (2026-10-18).
 */
const KEYWORD_WEIGHT = 0.5;


/** Builds a safe FTS5 query: every non-filler token quoted, OR-joined. Null when nothing usable remains. */
export function toFtsQuery(text: string): string | null {
  const tokens = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const unique = [...new Set(tokens)];
  return unique.length ? unique.map((t) => `"${t}"`).join(' OR ') : null;
}

/**
 * Keyword and vector results fused by rank. A memory is returned only when it has a keyword hit or its similarity
 * reaches `minSimilarity` and, with a `window`, is within `window` of the best similarity for this query. Of those, only keyword hits and matches reaching `confidentSimilarity` are marked
 * recalled, so filler returned for a vague query never counts as the memory being used. `touch: false` marks
 * nothing (for test runs).
 *
 * Replaced facts (section 16) are left out. With `replaced: 'include'` the current hits are exactly the ones 'hide'
 * returns, and replaced hits follow, flagged `replaced`: they come from one joint ranking of current and replaced
 * candidates whose relative floor comes from the best current candidate only. `replacedCut` 'follow' (recall) returns
 * every qualifying replaced candidate in joint order, at most `replacedLimit` (default 5); 'joint-top' (the header
 * search and All facts) only those ranked within the joint top `limit`. Replaced facts are never marked recalled.
 *
 * `pool` (default `limit`): how many current results to return, for a caller that reorders them and keeps `limit`
 * itself (recall's reranker). Each current result says whether it is `sure` (a keyword hit or a match reaching
 * `confidentSimilarity`): the ones marking recalled would mark, for a caller that marks after reordering.
 */
export function hybridSearch(
  store: MemoryStore,
  q: {
    vector: Float32Array; text: string; kind?: Kind; project?: string; projects?: string[]; limit: number; pool?: number; minSimilarity: number; confidentSimilarity: number; window?: number; touch?: boolean;
    variants?: { vector: Float32Array; text: string }[];
    replaced?: 'hide' | 'include'; replacedLimit?: number; replacedCut?: 'follow' | 'joint-top';
  },
): SearchHit[] {
  const filter = { kind: q.kind, project: q.project, projects: q.projects };
  const ftsQuery = toFtsQuery(q.text);
  const live = store.activeEmbeddings(filter);
  // The question and each other phrasing (B4) are ranked on their own, each with its own keywords and floor; their
  // fused scores add up, and a fact is sure when any of them would call it sure.
  const current = merge([
    rank(live, ftsQuery ? store.ftsSearch(ftsQuery, filter, CANDIDATES) : [], q),
    ...(q.variants ?? []).map((v) => {
      const fts = toFtsQuery(v.text);
      return rank(live, fts ? store.ftsSearch(fts, filter, CANDIDATES) : [], { ...q, vector: v.vector });
    }),
  ]);
  const top = current.ranked.slice(0, Math.max(q.pool ?? q.limit, q.limit));
  const results: SearchHit[] = [];
  for (const [id, score] of top) {
    const memory = store.get(id);
    if (memory) results.push({ memory, score, sure: current.ftsIds.has(id) || (current.sims.get(id) ?? 0) >= q.confidentSimilarity });
  }
  if (q.touch !== false) store.markRecalled(results.filter((r) => r.sure).map((r) => r.memory.id));
  if (q.replaced !== 'include') return results;

  // One joint ranking of current and replaced candidates; the floor is the best current candidate's.
  const all = { ...filter, replaced: 'include' as const };
  const embeddings = store.activeEmbeddings(all);
  const replacedIds = new Set(embeddings.filter((e) => e.replaced).map((e) => e.id));
  const joint = rank(embeddings, ftsQuery ? store.ftsSearch(ftsQuery, all, CANDIDATES) : [], q, current.best);
  const pool = q.replacedCut === 'joint-top' ? joint.ranked.slice(0, q.limit) : joint.ranked;
  const max = q.replacedLimit ?? DEFAULT_REPLACED;
  for (const [id, score] of pool) {
    if (results.length - top.length >= max) break;
    if (!replacedIds.has(id)) continue;
    const memory = store.get(id);
    if (memory) results.push({ memory, score, sure: false, replaced: true });
  }
  return results;
}

/** A search result; `sure` is false for replaced hits, which are never marked recalled. */
export interface SearchHit { memory: Memory; score: number; sure: boolean; replaced?: true }

/** Replaced hits that follow recall's current ones, at most. */
const DEFAULT_REPLACED = 5;

type Ranking = { ranked: [string, number][]; ftsIds: Set<string>; sims: Map<string, number>; best: number };

/** Several rankings as one: scores added, keyword hits joined, each fact's best similarity; `best` is the first's. */
function merge(parts: Ranking[]): Ranking {
  if (parts.length === 1) return parts[0]!;
  const scores = new Map<string, number>();
  const ftsIds = new Set<string>();
  const sims = new Map<string, number>();
  for (const p of parts) {
    for (const [id, score] of p.ranked) scores.set(id, (scores.get(id) ?? 0) + score);
    for (const id of p.ftsIds) ftsIds.add(id);
    for (const [id, sim] of p.sims) sims.set(id, Math.max(sims.get(id) ?? -Infinity, sim));
  }
  return { ranked: [...scores.entries()].sort((a, b) => b[1] - a[1]), ftsIds, sims, best: parts[0]!.best };
}

/**
 * Fuses vector and keyword ranks. `best` is the similarity the relative floor is measured from (default: the best
 * candidate here); returns every qualifying id with its score, best first.
 */
function rank(
  embeddings: { id: string; embedding: Float32Array }[],
  ftsRanked: string[],
  q: { vector: Float32Array; minSimilarity: number; window?: number },
  best?: number,
): Ranking {
  const vectorRanked = embeddings
    .map((e) => ({ id: e.id, sim: cosine(q.vector, e.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CANDIDATES);
  const ftsIds = new Set(ftsRanked);
  const sims = new Map(vectorRanked.map((v) => [v.id, v.sim]));
  const scores = new Map<string, number>();
  const add = (id: string, weight: number, r: number) => scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + r));
  ftsRanked.forEach((id, i) => add(id, KEYWORD_WEIGHT, i + 1));
  const from = best ?? vectorRanked[0]?.sim ?? 0;
  const floor = Math.max(q.minSimilarity, q.window === undefined ? -Infinity : from - q.window);
  vectorRanked.forEach((v, i) => {
    if (v.sim < floor && !ftsIds.has(v.id)) return;
    add(v.id, 1, i + 1);
  });
  return { ranked: [...scores.entries()].sort((a, b) => b[1] - a[1]), ftsIds, sims, best: vectorRanked[0]?.sim ?? 0 };
}

/**
 * With a `project`, memories of other projects are left out (those with no project are still compared). `exclude`:
 * ids never returned (the facts a save is replacing). Replaced facts are never compared.
 */
export function findSimilar(
  store: MemoryStore,
  vector: Float32Array,
  f: { kind?: Kind; project?: string | null; exclude?: ReadonlySet<string> },
  threshold: number,
): { memory: Memory; similarity: number }[] {
  const out: { memory: Memory; similarity: number }[] = [];
  for (const e of store.activeEmbeddings({ kind: f.kind })) {
    if (f.exclude?.has(e.id)) continue;
    const similarity = cosine(vector, e.embedding);
    if (similarity < threshold) continue;
    const memory = store.get(e.id);
    if (memory && (typeof f.project !== 'string' || memory.project === null || memory.project === f.project)) out.push({ memory, similarity });
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}
