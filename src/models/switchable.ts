/*
 * Keywords first, models when ready. The app starts and serves before any search model is on disk: the switchable
 * embedder stands in until one is, and the server switches to it later without a restart, re-reading the memories in
 * the background with the crash-safe re-embed (src/memory/reembed.ts).
 *
 * While it is not ready, embed() returns a zero vector of the stored size. That placeholder is the whole signal:
 * a save keeps it (migration 37's triggers list the row in embedding_pending until a model embeds it), the search
 * treats a zero question vector as "keywords only" (src/memory/search.ts), and every check by meaning (duplicates,
 * related facts, the graph's threads) finds nothing, since cosine() is 0 against a zero vector.
 */
import type { DB } from '../db.js';
import type { Embedder } from '../memory/embedder.js';
import type { EmbeddingProfile } from '../memory/embeddingProfile.js';
import { embedPending, ensureEmbeddings, modelOf, type ReembedResult } from '../memory/reembed.js';
import type { Reranker } from '../memory/reranker.js';

/** Switchable embedders whose re-read is running: off (keywords only) until it ends. */
const rereading = new WeakSet<SwitchableEmbedder>();
/** One re-read at a time per brain. */
const running = new WeakSet<DB>();

export class SwitchableEmbedder implements Embedder {
  #model: Embedder | null = null;
  #profile: EmbeddingProfile | null = null;

  /** `target`: the configured model, whose size a placeholder takes in a brain with no vectors and no stamp yet. */
  constructor(private readonly db: DB, private readonly target: EmbeddingProfile) {}

  /**
   * True when a model is in use, no re-read is running, and the model is the one that made the stored vectors. A model
   * that does not match them (one switched to without a re-read) stays off: never two models in one search.
   */
  ready(): boolean {
    if (this.#model === null || this.#profile === null || rereading.has(this)) return false;
    const stored = modelOf(this.db);
    return stored === null || stored.model === this.#profile.id;
  }

  /** Whether the brain is being re-read with a new model right now. */
  rereading(): boolean {
    return rereading.has(this);
  }

  /** The model in use (also during its re-read), or null before the first one. */
  profile(): EmbeddingProfile | null {
    return this.#profile;
  }

  /** Switches to `e`, the model `p` describes. rereadInBackground calls this itself once the brain is on `p`. */
  use(e: Embedder, p: EmbeddingProfile): void {
    this.#model = e;
    this.#profile = p;
  }

  async embed(text: string, purpose: 'query' | 'passage'): Promise<Float32Array> {
    const model = this.#model;
    if (model !== null && this.ready()) {
      const v = await model.embed(text, purpose);
      // A switch while this computed: the vector is the old model's, so a placeholder goes in its place.
      if (this.#model === model && this.ready()) return v;
    }
    return new Float32Array(modelOf(this.db)?.dim ?? this.target.dim);
  }
}

/** The reranker in use, or none: with null, recall keeps the search's own order. */
export class SwitchableReranker implements Reranker {
  #reranker: Reranker | null;

  constructor(r: Reranker | null = null) {
    this.#reranker = r;
  }

  use(r: Reranker | null): void {
    this.#reranker = r;
  }

  /** Whether a reranker is in use (recall skips reranking without one). */
  ready(): boolean {
    return this.#reranker !== null;
  }

  /** With none in use, every text scores the same, which keeps the order it was given. */
  async score(query: string, texts: string[]): Promise<number[]> {
    const r = this.#reranker;
    return r === null ? texts.map(() => 0) : r.score(query, texts);
  }

  async scoreMany(queries: string[], texts: string[]): Promise<{ scores: number[][]; online: boolean }> {
    const r = this.#reranker;
    if (r?.scoreMany) return r.scoreMany(queries, texts);
    const scores: number[][] = [];
    for (const q of queries) scores.push(await this.score(q, texts));
    return { scores, online: false };
  }
}

/**
 * Puts the brain on `embedder` (the model `profile` describes) while the server keeps serving: the re-embed runs if the
 * stored vectors are another model's (ensureEmbeddings: staged, resumable, switched in one transaction at the end),
 * then the rows saved while no model was ready are embedded. With `into`, that switchable embedder is off (keywords
 * only, meaning off) for the whole run and is switched to the new model in the same turn as the last check, so a
 * search never mixes two models. An abort or an error leaves the stored model as it was, and `into` back on its old
 * model if that still matches the stored vectors (otherwise off): the next run carries on from what was staged. Once
 * the stored vectors have switched, the abort is too late and is ignored: the run finishes and `into` switches too.
 * `onSwitched` runs after the switch (the meaning index's catch-up: the re-embed emptied the graph's links, and the rows
 * embedded from placeholders have new vectors); its failure is logged, never the run's.
 */
export async function rereadInBackground(
  db: DB, dbPath: string, embedder: Embedder, profile: EmbeddingProfile, log: (line: string) => void = console.log,
  o: { signal?: AbortSignal; into?: SwitchableEmbedder; onSwitched?: () => unknown } = {},
): Promise<ReembedResult & { pending: number }> {
  if (running.has(db)) throw new Error('a re-read of this brain is already running');
  running.add(db);
  const into = o.into;
  if (into) rereading.add(into);
  try {
    const result = await ensureEmbeddings(db, dbPath, embedder, profile, log, { signal: o.signal });
    const pending = await embedPending(db, embedder, profile, {
      // After a switch of the stored vectors, stopping would leave the brain on keywords: the rest is finished.
      signal: result.reembedded ? undefined : o.signal, log,
      done: () => {
        if (!into) return;
        into.use(embedder, profile);
        rereading.delete(into);
      },
    });
    try {
      await o.onSwitched?.();
    } catch (e) {
      log(`after the switch to ${profile.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ...result, pending };
  } finally {
    if (into) rereading.delete(into);
    running.delete(db);
  }
}
