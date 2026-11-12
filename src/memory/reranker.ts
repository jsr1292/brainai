/**
 * The reranker (B3): a small local multilingual model that reads a question next to each candidate fact and scores how
 * well the fact answers it. Recall's search finds the candidates; this only reorders them. Measured on 2026-11-08 (the
 * owner's recall test: right fact first 59% → 75%; LoCoMo @1 36% → 53%) at about 0.4 s a search on an M4 Mac.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import { modelSessionOptions } from './onnxOptions.js';

export interface Reranker {
  /** One score per text, higher = answers the query better. */
  score(query: string, texts: string[]): Promise<number[]>;
}

/** cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (Apache-2.0), int8. */
export const RERANK_MODEL = 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
/** The repo's int8 file; its arm64, avx512 and avx512_vnni names hold the same bytes. */
export const RERANK_FILE = 'model_qint8_arm64';
/**
 * The bytes of every file it loads, as of revision 1427fd652930e4ba29e8149678df786c240d8825 (2025-04-15). Pinned by
 * hash, not by revision: transformers.js 4.3.1 looks for a pinned revision's tokenizer under the default revision, so
 * a pinned model never loads offline. npm run model refuses any other bytes.
 */
export const RERANK_FILES: Record<string, string> = {
  'config.json': 'cc2cfe51aa3fd759d21d21acf5dfd6994aa67a3c9210636d22e143699d336c77',
  'tokenizer.json': '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',
  'tokenizer_config.json': 'e7fbfbfa6347b4e414c1cee50d142e2c2f9a895dad68b068ae83a8b564c3837e',
  [`onnx/${RERANK_FILE}.onnx`]: '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
};
/** How many of the search's first matches recall reorders (it keeps its limit of them). */
export const RERANK_POOL = 20;
/**
 * Facts scored per model run. Memory grows with the batch (20 facts at the token cap took the server past its 1 GB
 * container limit on the mini PC, 2026-11-08); 5 at a time keeps it bounded at the same total time.
 */
export const RERANK_BATCH = 5;
/** Question plus fact, cut to this many tokens: 512 scored the same on both tests and took longer. */
export const RERANK_MAX_TOKENS = 256;
/**
 * Below this best score no fact matches the question closely (B6). Measured 2026-11-08: the owner's 72 test questions
 * scored at least -5.43 (5th lowest -3.22, median 2.19), 32 unrelated questions at most -0.57 (median -4.89). No
 * threshold separates them, so recall never hides results on it: below WEAK_SCORE it only says so (3 of the 72, 23 of
 * the 32).
 */
export const WEAK_SCORE = -4;

/** The reranker's folder inside the model folder. */
export function rerankerDir(modelDir: string): string {
  return join(modelDir, RERANK_MODEL);
}

/** A file's SHA-256, read 1 MB at a time: the 119 MB model is never held in memory twice. */
export function sha256Of(path: string): string {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(path, 'r');
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

/** Throws unless every pinned file is there with exactly the pinned bytes. */
export function checkRerankerFiles(modelDir: string, expected = RERANK_FILES): void {
  for (const [file, sha] of Object.entries(expected)) {
    const path = join(rerankerDir(modelDir), file);
    if (!existsSync(path)) throw new Error(`The reranker model is missing (${path}): run  npm run model  first.`);
    const got = sha256Of(path);
    if (got !== sha) throw new Error(`The reranker's ${file} does not match the pinned version (SHA-256 ${got}, expected ${sha}): delete ${rerankerDir(modelDir)} and run  npm run model  again.`);
  }
}

/**
 * The server's reranker for its config: none when RERANK=off, and none (said once) when the model can't be loaded,
 * so a model folder without it (an old install, a dev checkout) still starts. `load` replaces the model (tests).
 */
export async function startReranker(c: { rerank: boolean; modelDir: string }, load = createLocalReranker): Promise<Reranker | undefined> {
  if (!c.rerank) return undefined;
  try {
    return await load({ modelDir: c.modelDir, allowRemote: false });
  } catch (e) {
    console.error(`reranker unavailable (${e instanceof Error ? e.message : String(e)}): recall keeps its plain order`);
    return undefined;
  }
}

/**
 * The reranker's ONNX session options: the shared thread settings (onnxOptions.ts), and without ONNX Runtime's arena,
 * so memory used by one run goes back after it instead of staying reserved.
 */
export function rerankerSessionOptions(cores?: number): ReturnType<typeof modelSessionOptions> & { enableCpuMemArena: false } {
  return { ...modelSessionOptions(cores), enableCpuMemArena: false };
}

export async function createLocalReranker(opts: { modelDir: string; allowRemote: boolean }): Promise<Reranker> {
  // Offline (the server), only the pinned bytes load, and a missing model says so plainly.
  if (!opts.allowRemote) checkRerankerFiles(opts.modelDir);
  env.cacheDir = opts.modelDir;
  env.allowRemoteModels = opts.allowRemote;
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
    dtype: 'fp32', model_file_name: RERANK_FILE, session_options: rerankerSessionOptions(),
  } as never);
  return oneAtATime({
    async score(query, texts) {
      const inputs = tokenizer(new Array(texts.length).fill(query), { text_pair: texts, padding: true, truncation: true, max_length: RERANK_MAX_TOKENS });
      const { logits } = await model(inputs);
      return Array.from(logits.data as Float32Array);
    },
  }, RERANK_BATCH);
}

/**
 * The reranker run one batch of at most `size` texts at a time, across every caller: recalls that arrive together
 * wait their turn instead of each holding a batch's memory at once. A failed batch fails only its own call.
 */
export function oneAtATime(inner: Reranker, size: number): Reranker {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    async score(query, texts) {
      const out: number[] = [];
      for (let i = 0; i < texts.length; i += size) out.push(...await run(() => inner.score(query, texts.slice(i, i + size))));
      return out;
    },
  };
}
