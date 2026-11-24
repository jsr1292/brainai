import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256Of } from '../memory/reranker.js';
import { modelDirOf, type CatalogueModel, type ModelId } from './catalogue.js';

export interface Progress { model: ModelId; doneBytes: number; totalBytes: number; state: 'waiting' | 'downloading' | 'checking' | 'done' | 'failed'; error?: string }

export type Source = (m: CatalogueModel, file: string) => string;

/** The name a model file has as an asset on the models-v1 GitHub release (shared by the downloader and the upload). */
export function githubAssetName(m: CatalogueModel, file: string): string {
  return `${m.repo.replaceAll('/', '__')}__${file.replaceAll('/', '__')}`;
}

export const DEFAULT_SOURCES: Source[] = [
  (m, file) => `https://huggingface.co/${m.repo}/resolve/main/${file}`,
  (m, file) => `https://github.com/jsr1292/brainai/releases/download/models-v1/${githubAssetName(m, file)}`,
];

export interface DownloadOptions {
  sources: Source[];
  /**
   * Proxies are environmental: Node's built-in support reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY when
   * NODE_USE_ENV_PROXY=1 (set by the desktop shell), so the global fetch needs no proxy code here.
   */
  fetch?: typeof fetch;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
  /** free bytes where the models folder lives (tests replace it) */
  freeBytes?: () => Promise<number>;
  /** opens the partial file for writing (tests replace it) */
  createWriter?: (path: string, append?: boolean) => Writable;
  /** no bytes for this long fails the file (default 60 s; tests shorten it) */
  stallMs?: number;
  /** folder holding licenses/ (default: the folder with package.json) */
  licensesRoot?: string;
}

class Mismatch extends Error {}
class DiskFull extends Error {}

async function freeBytesAt(path: string): Promise<number> {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const fs = await statfs(p);
  return Number(fs.bavail) * Number(fs.bsize);
}

function hasGood(path: string, sha: string): boolean {
  return existsSync(path) && sha256Of(path) === sha;
}

/** No bytes for this long: the file fails (the connection is dropped), so "Downloading… 63%" never hangs for good. */
export const STALL_MS = 60_000;

class Stalled extends Error {}

/** SHA-256 of what is already in a partial file, to carry on hashing from there. */
async function hashOfFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/**
 * Streams one file from one source to <path>.partial, checks its SHA-256, renames it. A partial left by an earlier try
 * (a stall, a cut connection) is carried on with an HTTP Range request when the server honours it; if it does not, or the
 * finished file's size or checksum is wrong, the file is fetched again whole. The checksum is always of the whole file
 * and never relaxed. A stall, a cut or an HTTP error keeps the partial for the next try; a wrong checksum, a full disk
 * or a stop removes it.
 */
async function fetchOne(url: string, path: string, sha: string, f: typeof fetch, signal: AbortSignal | undefined, createWriter: (path: string, append?: boolean) => Writable, onBytes: (n: number) => void, onChecking: () => void, stallMs: number): Promise<void> {
  const partial = `${path}.partial`;
  mkdirSync(dirname(path), { recursive: true });
  let reported = 0;
  const count = (n: number) => { reported += n; onBytes(n); };
  const attempt = async (resume: boolean): Promise<void> => {
    const have = resume && existsSync(partial) ? statSync(partial).size : 0;
    const ac = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort(); }, stallMs); };
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      arm();
      const res = await f(url, { signal: ac.signal, headers: { 'accept-encoding': 'identity', ...(have > 0 ? { range: `bytes=${have}-` } : {}) } });
      let append = false;
      let expected: number | undefined;
      if (have > 0 && res.status === 206 && new RegExp(`^bytes ${have}-\\d+/(\\d+|\\*)$`).test(res.headers.get('content-range') ?? '')) {
        append = true;
        const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        expected = m ? Number(m[1]) : undefined;
      } else if (have > 0 && (res.status === 416 || res.status === 206)) {
        // No usable range (or a slice that does not start where the partial ends): the file is fetched whole.
        await res.body?.cancel().catch(() => undefined);
        await rm(partial, { force: true });
        return attempt(false);
      } else if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash('sha256');
      // Hashing what is already there can take a while on a slow disk: not a stall.
      if (append) { clearTimeout(timer); await hashOfFile(partial, hash); count(have); arm(); }
      const tap = new Transform({ transform(chunk: Buffer, _e, cb) { arm(); hash.update(chunk); count(chunk.length); cb(null, chunk); } });
      await pipeline(Readable.fromWeb(res.body as any), tap, createWriter(partial, append), { signal: ac.signal });
      clearTimeout(timer);
      onChecking();
      // The checksum is the real check. The size is only compared for a resumed file, to decide on a whole refetch (a
      // whole response's Content-Length can describe an encoded body).
      const wrongSize = append && expected !== undefined && statSync(partial).size !== expected;
      if (wrongSize || hash.digest('hex') !== sha) {
        await rm(partial, { force: true });
        if (append) { onBytes(-reported); reported = 0; return attempt(false); }
        throw new Mismatch('the file did not match');
      }
      await rename(partial, path);
    } catch (e) {
      if (stalled && !signal?.aborted) throw new Stalled('no data for a while');
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  try {
    await attempt(true);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    const keep = e instanceof Stalled || (!(e instanceof Mismatch) && !signal?.aborted && code !== 'ENOSPC' && code !== 'EDQUOT');
    if (!keep) await rm(partial, { force: true });
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new DiskFull('disk full');
    throw e;
  }
}

export async function downloadModel(m: CatalogueModel, modelsDir: string, o: DownloadOptions): Promise<void> {
  const f = o.fetch ?? fetch;
  const dir = modelDirOf(modelsDir, m);
  const total = m.bytes;
  let done = 0;
  const report = (state: Progress['state'], error?: string) => o.onProgress?.({ model: m.id, doneBytes: done, totalBytes: total, state, ...(error ? { error } : {}) });
  const fail = (msg: string): never => { report('failed', msg); throw new Error(msg); };

  report('waiting');
  const root = resolve(dir);
  for (const file of Object.keys(m.files)) {
    if (!resolve(root, file).startsWith(root + sep)) fail(`a file path is outside the models folder: ${file}`);
  }
  const mb = (b: number) => Math.ceil(b / 1_000_000);
  let neededBytes = 0;
  const pending = Object.entries(m.files).filter(([file, sha]) => !hasGood(join(dir, file), sha));

  // Bytes already in place count as done; the rest must fit on disk with 10 % to spare.
  const pendingNames = new Set(pending.map(([file]) => file));
  const havePart = Object.keys(m.files).filter((file) => !pendingNames.has(file)).reduce((n, file) => n + statSync(join(dir, file)).size, 0);
  done = havePart;
  if (pending.length > 0) {
    const needed = neededBytes = Math.ceil(Math.max(0, total - havePart) * 1.1);
    const free = await (o.freeBytes ?? (() => freeBytesAt(modelsDir)))();
    if (free < needed) fail(`not enough disk space: ${mb(needed)} MB needed`);
  }

  for (const [file, sha] of pending) {
    const path = join(dir, file);
    let sawMismatch = false;
    let sawStall = false;
    let ok = false;
    for (const source of o.sources) {
      const before = done;
      try {
        await fetchOne(source(m, file), path, sha, f, o.signal, o.createWriter ?? ((p, append) => createWriteStream(p, { flags: append ? 'a' : 'w' })),
          (n) => { done += n; report('downloading'); }, () => report('checking'), o.stallMs ?? STALL_MS);
        ok = true;
        break;
      } catch (e) {
        done = before;
        if (o.signal?.aborted) fail('stopped');
        if (e instanceof DiskFull) fail(`not enough disk space: ${mb(neededBytes || total)} MB needed`);
        if (e instanceof Mismatch) sawMismatch = true;
        if (e instanceof Stalled) sawStall = true;
      }
    }
    if (!ok) fail(sawMismatch ? 'the file did not match' : sawStall ? 'the download stalled: no data for a while' : 'could not reach Hugging Face or GitHub');
  }
  try { copyNotice(m, modelsDir, { licensesRoot: o.licensesRoot }); } catch (e) { fail((e as Error).message); }
  done = total;
  report('done');
}

/** Default licences folder: the folder that holds package.json (the repo or app root). */
function appRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, 'package.json')) && dirname(d) !== d) d = dirname(d);
  return d;
}

export const EXTRA_TERMS = ['GEMMA-TERMS.md', 'GEMMA-PROHIBITED-USE-POLICY.md'];

/** Writes the model's notice (as NOTICE) and terms files next to it, when the catalogue names a notice (Gemma). */
export function copyNotice(m: CatalogueModel, modelsDir: string, o: { licensesRoot?: string } = {}): void {
  if (!m.notice) return;
  const root = o.licensesRoot ?? appRoot();
  const target = modelDirOf(modelsDir, m);
  mkdirSync(target, { recursive: true });
  const notice = join(root, m.notice);
  if (!existsSync(notice)) throw new Error(`the licence notice is missing: ${m.notice}`);
  copyFileSync(notice, join(target, 'NOTICE'));
  for (const name of EXTRA_TERMS) {
    const p = join(root, dirname(m.notice), name);
    if (existsSync(p)) copyFileSync(p, join(target, name));
  }
}
