import { join } from 'node:path';
import { E5_FILES, E5_MODEL, GEMMA_FILES, GEMMA_MODEL } from '../memory/embedder.js';
import { RERANK_FILES, RERANK_MODEL } from '../memory/reranker.js';

export type ModelId = 'e5' | 'gemma' | 'mminilm' | 'bge-m3-rerank';

export interface CatalogueModel {
  id: ModelId;
  kind: 'search' | 'rerank';
  label: 'Light' | 'Balanced' | 'Standard' | 'Strong';
  repo: string;
  /** path in the repo -> SHA-256 */
  files: Record<string, string>;
  /** the real sum of the files' sizes */
  bytes: number;
  licence: string;
  licenceUrl?: string;
  /** path of a notice file shipped with the app (Gemma's) */
  notice?: string;
  /** one plain sentence, from measurements */
  measured: string;
  profile?: 'e5' | 'gemma';
}

// Sizes measured from ./models (sum of the pinned files).
const E5_BYTES = 135_392_016;
const GEMMA_BYTES = 218_726_989;
const MMINILM_BYTES = 135_704_003;

export const CATALOGUE: CatalogueModel[] = [
  {
    id: 'e5', kind: 'search', label: 'Light', repo: E5_MODEL, files: E5_FILES, bytes: E5_BYTES,
    licence: 'MIT', measured: 'fastest; found 142 of 168 test questions first', profile: 'e5',
  },
  {
    id: 'gemma', kind: 'search', label: 'Balanced', repo: GEMMA_MODEL, files: GEMMA_FILES, bytes: GEMMA_BYTES,
    licence: 'Gemma Terms of Use', licenceUrl: 'https://ai.google.dev/gemma/terms', notice: 'licenses/GEMMA-NOTICE.txt',
    measured: 'about 10 ms more per search; found 150 of 168 first', profile: 'gemma',
  },
  {
    id: 'mminilm', kind: 'rerank', label: 'Standard', repo: RERANK_MODEL, files: RERANK_FILES, bytes: MMINILM_BYTES,
    licence: 'Apache-2.0', measured: 'about 0.3 s per search; puts the right one first far more often',
  },
];

/** Where the model lives under the models folder: the layout transformers.js reads, <dir>/<repo>. */
export function modelDirOf(modelsDir: string, m: CatalogueModel): string {
  return join(modelsDir, m.repo);
}

/** The online rerankers on OpenRouter (ids checked against its public model list, 2026-11-13). */
export interface OnlineModel { id: string; label: string; /** Said plainly next to the choice. */ policy: string; /** Only providers that keep nothing. */ zdr: boolean }
export const ONLINE_MODELS: OnlineModel[] = [
  { id: 'voyageai/rerank-2.5', label: 'Voyage rerank 2.5', policy: "doesn't train on what you send, but may keep it", zdr: false },
  { id: 'qwen/qwen3-reranker-8b', label: 'Qwen3 Reranker 8B', policy: 'keeps nothing (zero retention); a little slower', zdr: true },
];
