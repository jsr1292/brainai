import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AutoModel, AutoTokenizer, env, pipeline } from '@huggingface/transformers';
import { profileFor, type EmbeddingProfile } from './embeddingProfile.js';
import { modelSessionOptions } from './onnxOptions.js';
import { sha256Of } from './reranker.js';

export const EMBEDDING_DIM = 384;

export interface Embedder {
  embed(text: string, purpose: 'query' | 'passage'): Promise<Float32Array>;
}

/** Dot product; equals cosine similarity because vectors are L2-normalized. */
export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors from two models never compare: fail loudly rather than rank by NaN.
  if (a.length !== b.length) throw new Error(`vectors of different lengths (${a.length} and ${b.length}): were they made by different models?`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** How the embedding model loads: 8-bit, with the shared thread settings (onnxOptions.ts). */
export function embedderOptions(cores?: number): { dtype: 'q8'; session_options: ReturnType<typeof modelSessionOptions> } {
  return { dtype: 'q8', session_options: modelSessionOptions(cores) };
}

/** EmbeddingGemma-300m as ONNX (Gemma Terms of Use: licenses/GEMMA-NOTICE.txt), 4-bit. */
export const GEMMA_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
/**
 * The bytes of every file it loads, as of revision 5090578d9565bb06545b4552f76e6bc2c93e4a66 (2025-09-04). Pinned by
 * hash, not by revision, for the reason the reranker's are (reranker.ts): a pinned revision never loads offline.
 */
export const GEMMA_FILES: Record<string, string> = {
  'config.json': '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
  'tokenizer.json': '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
  'tokenizer_config.json': '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
  'onnx/model_q4.onnx': 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
  'onnx/model_q4.onnx_data': '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02',
};
/** EmbeddingGemma's own prompts for retrieval (its model card). */
const GEMMA_PROMPT = { query: 'task: search result | query: ', passage: 'title: none | text: ' } as const;
const GEMMA_MAX_TOKENS = 512;

/** Gemma's folder inside the model folder. */
export function gemmaDir(modelDir: string): string {
  return join(modelDir, GEMMA_MODEL);
}

/** Throws unless every pinned Gemma file is there with exactly the pinned bytes. */
export function checkEmbedderFiles(modelDir: string, expected = GEMMA_FILES): void {
  for (const [file, sha] of Object.entries(expected)) {
    const path = join(gemmaDir(modelDir), file);
    if (!existsSync(path)) throw new Error(`The search model is missing (${path}): run  npm run model  first.`);
    const got = sha256Of(path);
    if (got !== sha) throw new Error(`The search model's ${file} does not match the pinned version (SHA-256 ${got}, expected ${sha}): delete ${gemmaDir(modelDir)} and run  npm run model  again.`);
  }
}

async function createGemmaEmbedder(opts: { modelDir: string; allowRemote: boolean }): Promise<Embedder> {
  if (!opts.allowRemote) checkEmbedderFiles(opts.modelDir);
  env.cacheDir = opts.modelDir;
  env.allowRemoteModels = opts.allowRemote;
  const tokenizer = await AutoTokenizer.from_pretrained(GEMMA_MODEL);
  const model = await AutoModel.from_pretrained(GEMMA_MODEL, { dtype: 'q4', session_options: modelSessionOptions() } as never);
  return {
    async embed(text, purpose) {
      const inputs = tokenizer([GEMMA_PROMPT[purpose] + text], { padding: true, truncation: true, max_length: GEMMA_MAX_TOKENS });
      const { sentence_embedding } = await (model as unknown as (x: unknown) => Promise<{ sentence_embedding: { data: Float32Array } }>)(inputs);
      const v = Float32Array.from(sentence_embedding.data);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    },
  };
}

/** The search model `model` names (default: the default profile's), from `modelDir`; offline unless `allowRemote`. */
export async function createLocalEmbedder(opts: { modelDir: string; allowRemote: boolean; model?: EmbeddingProfile }): Promise<Embedder> {
  const model = opts.model ?? profileFor(undefined);
  if (model.id === 'gemma') return createGemmaEmbedder(opts);
  if (model.id !== 'e5') throw new Error(`unknown embedding model ${model.id as string}`);
  env.cacheDir = opts.modelDir;
  env.allowRemoteModels = opts.allowRemote;
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', embedderOptions() as never);
  return {
    async embed(text, purpose) {
      const output = await extractor(`${purpose}: ${text}`, { pooling: 'mean', normalize: true });
      return Float32Array.from(output.data as Float32Array);
    },
  };
}
