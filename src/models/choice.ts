/*
 * The owner's choice of models, kept by the app in <data>/models.json (local mode only: a server keeps EMBED_MODEL and
 * RERANK in its .env). No file means nothing was chosen yet; a damaged file reads the same, so the app asks again
 * rather than fail to start.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelChoice {
  search: 'e5' | 'gemma';
  rerank: 'mminilm' | 'bge-m3-rerank' | 'online' | null;
  /** The OpenRouter model, when `rerank` is 'online'. */
  online?: { model: string };
}

const FILE = 'models.json';
const SEARCH = ['e5', 'gemma'];
const RERANK = ['mminilm', 'bge-m3-rerank', 'online', null];

/** The choice in `v`, or null when it is not one (only the known fields are kept). */
function asChoice(v: unknown): ModelChoice | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!SEARCH.includes(o.search as string) || !('rerank' in o) || !RERANK.includes(o.rerank as string | null)) return null;
  const c: ModelChoice = { search: o.search as ModelChoice['search'], rerank: o.rerank as ModelChoice['rerank'] };
  if (o.online !== undefined) {
    const online = o.online as Record<string, unknown> | null;
    if (typeof online !== 'object' || online === null || typeof online.model !== 'string' || online.model.trim() === '') return null;
    c.online = { model: online.model };
  }
  return c;
}

export function readChoice(dataDir: string): ModelChoice | null {
  try {
    return asChoice(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')));
  } catch {
    return null;
  }
}

/** Writes the choice whole or not at all: a temp file, flushed, then a rename over models.json. */
export function writeChoice(dataDir: string, c: ModelChoice): void {
  const clean = asChoice(c);
  if (clean === null) throw new Error(`not a model choice: ${JSON.stringify(c)}`);
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${FILE}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, `${JSON.stringify(clean, null, 2)}\n`);
      fsyncSync(fd); // on disk before the rename, so a power cut never leaves an empty models.json
    } finally { closeSync(fd); }
    renameSync(tmp, join(dataDir, FILE));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
