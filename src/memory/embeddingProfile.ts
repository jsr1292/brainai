/*
 * Every value that depends on which embedding model made the vectors. Cosine similarities differ a lot between
 * models (e5 puts almost everything above 0.7; EmbeddingGemma spreads them out), so each cut-off is set per model.
 * EMBED_MODEL picks one; the env overrides in config.ts still win for the four recall settings.
 */

export type EmbedModelId = 'e5' | 'gemma';

export interface EmbeddingProfile {
  id: EmbedModelId;
  /** Length of every vector this model makes. */
  dim: number;
  /** Two facts at or above this are the same fact (duplicate warning, held saves, observation merges). */
  duplicate: number;
  /** Recall: a by-meaning match is never returned below this. */
  minRecall: number;
  /** Recall: a by-meaning match must be within this of the query's best match; undefined = no window. */
  window: number | undefined;
  /** Recall: matches at or above this (and keyword hits) count as truly recalled. */
  confident: number;
  /** A save's close facts (same project and kind, below duplicate): fact-to-fact pairs at or above this. */
  closeFacts: number;
  /** Tidy: projects whose facts match this closely on average are offered as one project. */
  sameProject: number;
  /** A page's (and a fact's) related decisions from other projects. */
  related: number;
  /** The graph's meaning links (threads). */
  threadFloor: number;
  /** How much a keyword rank counts against a by-meaning rank in the fused search (facts and page sections). */
  keywordWeight: number;
  /** Reranking adds rerankPrior × log(1 / search rank), so the search order breaks near-ties; 0 = reranker alone. */
  rerankPrior: number;
}

/**
 * multilingual-e5-small q8. Its values, as measured when each was set:
 * - duplicate 0.93: lowest duplicate pair 0.9377 minus 0.01 (npm run test:model); NAS vs second SSD (0.9325) is a
 *   known false positive, accepted because it only costs a retry with allowDuplicate.
 * - minRecall 0.75, window 0.015: e5 query→passage cosines sit high and related and unrelated queries overlap, and a
 *   question in one language against a fact in another scores about 0.79 even for the right fact. Tuned on 52 real
 *   questions (found first 79% → 85%, top 8 94% → 100%) and confirmed on 20 held-out ones.
 * - confident 0.86: just above the highest unrelated query, so filler never keeps an outdated fact off the stale list.
 * - closeFacts 0.86: the same value, used for a save's close facts before it had its own setting.
 * - sameProject 0.88: on a real brain one project split in two scored 0.907, related but separate projects 0.897 and
 *   0.906 (accepted: one click on "Different projects"), all others 0.86 or less.
 * - related 0.88: a project's own decisions scored 0.89–0.93 against its page, unrelated projects' up to 0.863
 *   (2026-11-03).
 * - threadFloor 0.87: src/scripts/calibrateThreads.ts at 0.84 to 0.88; 0.87 with decisions only gave a median of 4
 *   threads per open project.
 * - keywordWeight 0.5: words shared with many facts (a project name, "owner") otherwise lift keyword-only matches
 *   above the best match by meaning (recall test, 2026-10-18).
 */
export const E5_PROFILE: EmbeddingProfile = {
  id: 'e5', dim: 384,
  duplicate: 0.93, minRecall: 0.75, window: 0.015, confident: 0.86, closeFacts: 0.86,
  sameProject: 0.88, related: 0.88, threadFloor: 0.87,
  keywordWeight: 0.5, rerankPrior: 0,
};

/**
 * EmbeddingGemma-300m q4. Calibrated 2026-11-11 against e5 on a stripped copy of the owner's brain (437 facts, 298 page
 * sections; src/scripts/calibrateEmbedder.ts) and the model tests (npm run test:model):
 * - minRecall 0.3, no window, keywordWeight 0, rerankPrior 1: the owner's recall test (168 questions) found 150 first
 *   (top 3 162, top 8 166) against e5's 142 (161, 166). Grid: keyword weight 0 / 0.25 / 0.5 with prior 1 found
 *   150 / 148 / 146 first, without the prior 144 / 143 / 142 (Mac; the grid used all three question files, the
 *   held-out one included). On the mini PC (x86) the chosen settings gave 149 / 162 / 165 against e5's 143 / 160 / 166
 *   on the same copy. Gemma's scores spread out (related questions 0.41 and
 *   up, unrelated ones 0.28 and below in the model tests), so no window is needed.
 * - duplicate 0.78: the share of fact pairs e5 put at 0.93 or above (22 of 47,905) falls at 0.782 under Gemma; the
 *   model tests' lowest duplicate pair scores 0.783, the highest different pair 0.711.
 * - confident 0.35: the best match of 18 off-topic questions against the real brain was 0.339 (e5's was 0.861, its
 *   cut-off 0.86).
 * - closeFacts 0.48: e5 used its confident level (0.86) here too, which put 54% of same-project, same-kind fact pairs
 *   in the close band; that share falls at 0.484 under Gemma (Gemma's 0.35 would have flagged nearly every pair).
 * - sameProject 0.54: the two models order project pairs a little differently, so this keeps e5's number of offers
 *   (17 of 703 pairs; 15 of them the same pairs).
 * - related 0.46: the share of page × decision pairs at e5's 0.88 (8.2%) falls at 0.460.
 * - threadFloor 0.52: rank transfer gave 0.515; calibrateThreads at 0.52 gives a median of 4 threads per open project,
 *   none without one, 83 threads (e5 at 0.87: 4, none, 85).
 */
export const GEMMA_PROFILE: EmbeddingProfile = {
  id: 'gemma', dim: 768,
  duplicate: 0.78, minRecall: 0.3, window: undefined, confident: 0.35, closeFacts: 0.48,
  sameProject: 0.54, related: 0.46, threadFloor: 0.52,
  keywordWeight: 0, rerankPrior: 1,
};

const PROFILES: Record<EmbedModelId, EmbeddingProfile> = { e5: E5_PROFILE, gemma: GEMMA_PROFILE };
export const DEFAULT_EMBED_MODEL: EmbedModelId = 'gemma';

/** The profile for an EMBED_MODEL value; undefined means the default. */
export function profileFor(id: string | undefined): EmbeddingProfile {
  const key = id ?? DEFAULT_EMBED_MODEL;
  if (key !== 'e5' && key !== 'gemma') throw new Error(`EMBED_MODEL must be e5 or gemma, got ${id}`);
  return PROFILES[key];
}
