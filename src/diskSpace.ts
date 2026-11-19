import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep, win32, posix } from 'node:path';
import { CATALOGUE, modelDirOf } from './models/catalogue.js';
import { currentLanguage, pseudoWrap, t } from './i18n/core.js';

/** "1.2 GB", "340 MB", "12 KB": 1000-based units, one decimal below 10 and none above. */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, Math.round(bytes));
  if (b === 0) return pseudoWrap('0 KB');
  if (b < 1000) return t('settings.space.lessThan');
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1000;
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) { v /= 1000; i++; }
  let text = v < 9.95 && i > 0 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  // Spanish writes the decimal comma; nothing else about the output changes.
  if (currentLanguage() === 'es') text = text.replace('.', ',');
  return pseudoWrap(`${text} ${units[i]}`);
}

/** How many lstat/readdir calls a walk has in flight at once, however deep the tree (libuv's thread pool is shared with the database and the models). */
const IN_FLIGHT = 8;

/** Runs the tasks it is given at most `max` at a time. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await task(); } finally { active--; waiting.shift()?.(); }
  };
}
/** The one limiter every walk in this process shares. */
const shared = limiter(IN_FLIGHT);

export interface WalkFs { lstat: typeof lstat; readdir: (p: string) => Promise<string[]> }
const realFs: WalkFs = { lstat, readdir: (p) => readdir(p) };

/** The sum of the real sizes of the files under `path` (a file counts its own size). Symlinks are not followed or counted; unreadable entries are skipped. `skip` are absolute paths left out. `io`: the file calls and their limit (tests). */
export async function folderBytes(path: string, skip: ReadonlySet<string> = new Set(), io: { fs?: WalkFs; limit?: number } = {}): Promise<number> {
  const fs = io.fs ?? realFs;
  const gate = io.limit === undefined ? shared : limiter(io.limit);
  const walk = async (raw: string): Promise<number> => {
    const p = resolve(raw);
    if (skip.has(p)) return 0;
    let st;
    try { st = await gate(() => fs.lstat(p)); } catch { return 0; }
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let names: string[];
    try { names = await gate(() => fs.readdir(p)); } catch { return 0; }
    const sizes = await Promise.all(names.map((n) => walk(join(p, n))));
    return sizes.reduce((n, x) => n + x, 0);
  };
  return walk(path);
}

/** The installed bundle: on macOS the nearest `.app` above the program, on Windows the install folder; otherwise (or not found) null. */
export function appBundlePath(execPath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return win32.dirname(execPath);
  if (platform !== 'darwin') return null;
  let cur = execPath;
  for (;;) {
    const up = posix.dirname(cur);
    if (up === cur) return null;
    cur = up;
    if (posix.basename(cur).toLowerCase().endsWith('.app')) return cur;
  }
}

export interface SpacePart { label: string; bytes: number }
export interface SpaceBreakdown {
  total: number;
  /** The installed bundle; null when it is not known (dev runs). */
  app: number | null;
  models: { bytes: number; parts: SpacePart[] };
  memories: number;
  backups: number;
  other: number;
}

export interface SpaceInput {
  dataDir: string;
  modelDir: string;
  backupDir?: string | null;
  /** The second (copy) folder: never counted. */
  copyFolder?: string | null;
  /** Where the running program is (default process.execPath) and the platform, for the app's own size. */
  execPath?: string;
  platform?: NodeJS.Platform;
  /** The desktop app keeps its logs in `logs` beside the data folder (not inside it): set to count that folder into "Other". */
  localMode?: boolean;
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Works out how much disk space BrainAI uses here. Never throws. */
export async function computeSpace(i: SpaceInput): Promise<SpaceBreakdown> {
  const data = resolve(i.dataDir);
  const modelDir = resolve(i.modelDir);
  const backupDir = i.backupDir ? resolve(i.backupDir) : null;
  const preMigrate = join(data, 'pre-migrate');
  const images = join(data, 'images');
  const dbFiles = ['memory.db', 'memory.db-wal', 'memory.db-shm'].map((f) => join(data, f));
  const copy = i.copyFolder ? resolve(i.copyFolder) : null;

  const backupRoots = [backupDir, preMigrate].filter((p): p is string => p !== null && !(copy !== null && inside(p, copy)));
  // A backup folder inside another counted folder is counted once, by the outer one.
  const backupTops = backupRoots.filter((p, n) => !backupRoots.some((q, m) => m !== n && (inside(p, q) && (p !== q || m < n))));
  const known = new Set<string>([...dbFiles, images, preMigrate, modelDir, ...(backupDir ? [backupDir] : []), ...(copy ? [copy] : [])]);

  const [app, memFiles, pics, backupSizes, modelParts, otherData, shellLogs] = await Promise.all([
    (async () => {
      const p = appBundlePath(i.execPath ?? process.execPath, i.platform);
      return p === null ? null : folderBytes(p);
    })(),
    Promise.all(dbFiles.map((f) => folderBytes(f))),
    folderBytes(images),
    Promise.all(backupTops.map((p) => folderBytes(p))),
    (async () => {
      const dirs = CATALOGUE.map((m) => ({ m, dir: resolve(modelDirOf(modelDir, m)) }));
      const skip = new Set(dirs.map((d) => d.dir));
      const parts: SpacePart[] = [];
      for (const { m, dir } of dirs) {
        const bytes = await folderBytes(dir);
        if (bytes > 0) parts.push({ label: m.kind === 'rerank' ? `${m.label} reranker` : `${m.label} search model`, bytes });
      }
      const rest = await folderBytes(modelDir, skip);
      return { parts, rest };
    })(),
    folderBytes(data, known),
    // The desktop shell writes its logs to <app_data>/logs, beside the data folder (<app_data>/data): only that folder.
    i.localMode ? folderBytes(join(dirname(data), 'logs'), known) : 0,
  ]);

  const parts = [...modelParts.parts];
  if (modelParts.rest > 0) parts.push({ label: 'Other model files', bytes: modelParts.rest });
  const models = { bytes: parts.reduce((n, p) => n + p.bytes, 0), parts };
  const memories = memFiles.reduce((n, s) => n + s, 0) + pics;
  const backups = backupSizes.reduce((n, s) => n + s, 0);
  const other = otherData + shellLogs;
  const total = (app ?? 0) + models.bytes + memories + backups + other;
  return { total, app, models, memories, backups, other };
}

/** Keeps the last answer for `ttlMs` and works one out at a time. */
export class SpaceCache {
  #value: SpaceBreakdown | null = null;
  #at = 0;
  #running: Promise<SpaceBreakdown | null> | null = null;
  constructor(private readonly work: () => Promise<SpaceBreakdown>, private readonly now: () => number = Date.now, private readonly ttlMs = 10 * 60_000) {}

  /** The cached answer if it is fresh, else null (and a walk is started). */
  peek(): SpaceBreakdown | null {
    if (this.#value && this.now() - this.#at < this.ttlMs) return this.#value;
    this.start();
    return null;
  }

  start(): Promise<SpaceBreakdown | null> {
    if (!this.#running) {
      this.#running = this.work().then((v) => { this.#value = v; this.#at = this.now(); return v; }, () => null).finally(() => { this.#running = null; });
    }
    return this.#running;
  }

  /** The fresh answer, or what a walk finds within `waitMs`; null when it takes longer. */
  async get(waitMs: number): Promise<SpaceBreakdown | null> {
    const fresh = this.peek();
    if (fresh) return fresh;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); });
    try { return await Promise.race([this.start(), late]); } finally { clearTimeout(timer); }
  }
}
