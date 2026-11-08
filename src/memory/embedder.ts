import { env, pipeline } from '@huggingface/transformers';
import { modelSessionOptions } from './onnxOptions.js';

export const EMBEDDING_DIM = 384;

export interface Embedder {
  embed(text: string, purpose: 'query' | 'passage'): Promise<Float32Array>;
}

/** Dot product; equals cosine similarity because vectors are L2-normalized. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** How the embedding model loads: 8-bit, with the shared thread settings (onnxOptions.ts). */
export function embedderOptions(cores?: number): { dtype: 'q8'; session_options: ReturnType<typeof modelSessionOptions> } {
  return { dtype: 'q8', session_options: modelSessionOptions(cores) };
}

export async function createLocalEmbedder(opts: { modelDir: string; allowRemote: boolean }): Promise<Embedder> {
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
