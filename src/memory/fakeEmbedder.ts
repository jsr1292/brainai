import { EMBEDDING_DIM, type Embedder } from './embedder.js';

function fnv1a(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic bag-of-words embedder for tests. Ignores `purpose`. */
export function createFakeEmbedder(): Embedder {
  return {
    async embed(text) {
      const vec = new Float32Array(EMBEDDING_DIM);
      const words = text
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      for (const w of words) vec[fnv1a(w) % EMBEDDING_DIM]! += 1;
      let norm = 0;
      for (const x of vec) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
      return vec;
    },
  };
}
