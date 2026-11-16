/** Lists the model files to mirror on the GitHub release `models-v1`: node --import tsx src/scripts/modelAssets.ts */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, modelDirOf } from '../models/catalogue.js';
import { DEFAULT_SOURCES, EXTRA_TERMS, githubAssetName } from '../models/download.js';

export interface ModelAsset { name: string; url: string; sha256: string; bytes?: number }

const HERE = dirname(fileURLToPath(import.meta.url));

export function modelAssets(o: { repoRoot?: string; modelsDir?: string; sizeOf?: (path: string) => number | undefined } = {}): ModelAsset[] {
  const root = o.repoRoot ?? join(HERE, '..', '..');
  const modelsDir = o.modelsDir ?? join(root, 'models');
  const sizeOf = o.sizeOf ?? ((p: string) => (existsSync(p) ? statSync(p).size : undefined));
  const out: ModelAsset[] = [];
  for (const m of CATALOGUE) {
    if (m.kind !== 'search' && m.kind !== 'rerank') continue;
    for (const [file, sha256] of Object.entries(m.files)) {
      const bytes = sizeOf(join(modelDirOf(modelsDir, m), file));
      out.push({ name: githubAssetName(m, file), url: DEFAULT_SOURCES[0](m, file), sha256, ...(bytes === undefined ? {} : { bytes }) });
    }
    if (!m.notice) continue;
    for (const path of [m.notice, ...EXTRA_TERMS.map((n) => join(dirname(m.notice!), n))]) {
      const full = join(root, path);
      if (!existsSync(full)) { if (path === m.notice) throw new Error(`the licence notice is missing: ${path}`); continue; }
      const data = readFileSync(full);
      out.push({ name: path.replaceAll('/', '__'), url: `file:${path}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${JSON.stringify(modelAssets(), null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
}
