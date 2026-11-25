/*
 * Every similarity cut-off depends on the search model that made the vectors (src/memory/embeddingProfile.ts). The app
 * can switch models while it runs (src/models/switchable.ts), so the services read their cut-offs from the model in
 * use each time, never once at startup.
 */
import type { Config } from '../config.js';
import type { EmbeddingProfile } from '../memory/embeddingProfile.js';
import type { Reranker } from '../memory/reranker.js';
import type { MemoryService } from '../memory/service.js';

export type CutOffConfig = Pick<Config, 'embedModel' | 'duplicateThreshold' | 'minRecallSimilarity' | 'recallConfidentSimilarity' | 'recallWindow'>;

/**
 * The profile in force: the active model's (`active`, null before any model is ready: the configured one). The .env
 * overrides (DUPLICATE_THRESHOLD and the recall settings, already in `c`) apply only while that is the configured
 * model: they were tuned for it (as staleOverrides warns). Returns the same object until the model changes.
 */
export function activeCutOffs(c: CutOffConfig, active: () => EmbeddingProfile | null): () => EmbeddingProfile {
  const configured: EmbeddingProfile = {
    ...c.embedModel, duplicate: c.duplicateThreshold, minRecall: c.minRecallSimilarity, confident: c.recallConfidentSimilarity, window: c.recallWindow,
  };
  return () => {
    const p = active();
    return p === null || p.id === c.embedModel.id ? configured : p;
  };
}

type MemoryOptions = ConstructorParameters<typeof MemoryService>[2];

/** MemoryService's options with each cut-off read from `cut` whenever the service uses it. */
export function memoryCutOffs(cut: () => EmbeddingProfile, extra: { reranker?: Reranker }): MemoryOptions {
  return {
    ...extra,
    get duplicateThreshold() { return cut().duplicate; },
    get minRecallSimilarity() { return cut().minRecall; },
    get recallConfidentSimilarity() { return cut().confident; },
    get recallWindow() { return cut().window; },
    get keywordWeight() { return cut().keywordWeight; },
    get rerankPrior() { return cut().rerankPrior; },
    get closeFacts() { return cut().closeFacts; },
    get closeNudge() { return cut().closeNudge; },
    get deletedMargin() { return cut().deletedMargin; },
  };
}
