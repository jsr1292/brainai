/*
 * The app's models (local mode only): the owner's choice (models.json), what is on disk under the models folder, and
 * what the server uses. Downloads run in the background while the server serves on keywords; a new search model is
 * switched to with the background re-read (src/models/switchable.ts), never before the server listens.
 *
 * Existing installs (spec 2026-11-13-app-install-update-onboarding-design, goal 6): an app from before models.json
 * kept its models inside itself. Its brain is stamped with the model that made its vectors, so on the first start of
 * this version that model becomes the choice and is downloaded: nothing to ask, keyword search meanwhile.
 */
import { createHash } from 'node:crypto';
import { busy } from '../busyMarker.js';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DB } from '../db.js';
import { createLocalEmbedder, isZeroVector, type Embedder } from '../memory/embedder.js';
import { profileFor, type EmbeddingProfile } from '../memory/embeddingProfile.js';
import { storedModel } from '../memory/reembed.js';
import { createLocalReranker, type Reranker } from '../memory/reranker.js';
import { createOpenRouterReranker, withFallback } from '../memory/remoteReranker.js';
import { CATALOGUE, modelDirOf, ONLINE_MODELS, type CatalogueModel, type ModelId } from './catalogue.js';
import { readChoice, writeChoice, type ModelChoice } from './choice.js';
import { copyNotice, DEFAULT_SOURCES, downloadModel, type Progress, type Source } from './download.js';
import { readKey } from './onlineKey.js';
import { rereadInBackground, type SwitchableEmbedder, type SwitchableReranker } from './switchable.js';

export interface ModelStatus { choice: ModelChoice | null; progress: Progress[]; searchReady: boolean; problem?: string;
  /** With `problem`: whether the search model or the reranker could not be set up (the search may be working without the reranker). */
  problemWith?: 'search' | 'rerank' | 'check';
  /** Only present while the brain is being re-read with a new search model. */ rereading?: boolean;
  /** The last time the online reranker could not be used, in plain words (no key, no memory text); the search kept its local order. */
  onlineProblem?: string;
  /** Set once the models are loaded and a test search on this computer worked: how long it took. */
  checked?: { ms: number } }

export interface ModelManagerOptions {
  dataDir: string;
  modelsDir: string;
  embedder: SwitchableEmbedder;
  reranker: SwitchableReranker;
  db: DB;
  dbPath: string;
  download?: typeof downloadModel;
  /** Where downloads come from (default: Hugging Face, then the GitHub mirror). */
  sources?: Source[];
  /** The models there are (tests give made-up ones). */
  catalogue?: CatalogueModel[];
  /** How a model on disk is loaded (tests give stand-ins). */
  load?: {
    /** `verified`: the manager has just checked the files, so the loader need not hash them again. */
    embedder?: (modelsDir: string, p: EmbeddingProfile, o: { verified: boolean }) => Promise<Embedder>;
    reranker?: (modelsDir: string, m: CatalogueModel, o: { verified: boolean }) => Promise<Reranker>;
  };
  /** False with RERANK=off: an old install keeps no reranker. */
  rerank?: boolean;
  /** After a switch of the search model (the meaning index's catch-up). */
  onSwitched?: () => unknown;
  /** The network, for the online reranker (tests give a fake: the real OpenRouter is never called from a test). */
  fetch?: typeof fetch;
  /** How long the online reranker may take before the local order is used. */
  onlineTimeoutMs?: number;
  log?: (line: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sameChoice = (a: ModelChoice, b: ModelChoice) =>
  a.search === b.search && a.rerank === b.rerank && (a.online?.model ?? null) === (b.online?.model ?? null);

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whether the model is ready to load: every pinned file there with exactly its bytes, and its NOTICE when the
 * catalogue names one (Gemma: a copy without it is not distributed as its terms ask). Hashed without blocking the
 * server, which is serving meanwhile.
 */
export async function isInstalled(m: CatalogueModel, modelsDir: string): Promise<boolean> {
  const dir = modelDirOf(modelsDir, m);
  if (m.notice && !existsSync(join(dir, 'NOTICE'))) return false;
  for (const [file, sha] of Object.entries(m.files)) {
    const path = join(dir, file);
    if (!existsSync(path) || (await sha256File(path)) !== sha) return false;
  }
  return true;
}

export class ModelManager {
  #choice: ModelChoice | null = null;
  #progress = new Map<ModelId, Progress>();
  #problem: string | undefined;
  /** Set while the current run's search model is ready: a failure from then on is the reranker's. */
  #rerankFailed = false;
  #onlineProblem: string | undefined;
  #checked: { ms: number } | undefined;
  /** The search model is in use but its test search failed (not a model that could not be set up). */
  #checkFailed = false;
  /** The work for the latest choice: a newer one stops it and waits for it before starting its own. */
  #job: { choice: ModelChoice; ctrl: AbortController; outcome: Promise<void> } | null = null;
  /** The local reranker in use (by id), so a choice that keeps it does not load it again. */
  #rerankerId: ModelId | null = null;
  readonly #catalogue: CatalogueModel[];
  readonly #log: (line: string) => void;

  constructor(private readonly o: ModelManagerOptions) {
    this.#catalogue = o.catalogue ?? CATALOGUE;
    this.#log = o.log ?? console.log;
  }

  status(): ModelStatus {
    const c = this.#choice;
    return {
      choice: c === null ? null : { ...c, ...(c.online ? { online: { ...c.online } } : {}) },
      progress: [...this.#progress.values()].map((p) => ({ ...p })),
      searchReady: this.o.embedder.ready(),
      ...(this.#problem !== undefined ? { problem: this.#problem, problemWith: this.#rerankFailed ? 'rerank' as const : this.#checkFailed ? 'check' as const : 'search' as const } : {}),
      ...(this.#onlineProblem !== undefined ? { onlineProblem: this.#onlineProblem } : {}),
      ...(this.o.embedder.rereading() ? { rereading: true } : {}),
      ...(this.#checked !== undefined ? { checked: { ...this.#checked } } : {}),
    };
  }

  /** Writes the choice, downloads what is missing, loads it, and re-reads the brain if the search model changed. */
  async choose(c: ModelChoice): Promise<void> {
    writeChoice(this.o.dataDir, c);
    this.#choice = readChoice(this.o.dataDir) ?? c;
    await this.#run(this.#choice);
  }

  /** "Try again" after a failure: runs the current choice again (a stalled or cut download carries on from its partial file). */
  async retry(): Promise<void> {
    if (this.#choice) await this.#run(this.#choice);
  }

  /**
   * Which of the catalogue's models have their files on disk, for the welcome's button label only: presence, not a
   * hash (hundreds of MB on every page load). The real check is isInstalled, run before any model is loaded.
   */
  async installedIds(): Promise<ModelId[]> {
    return this.#catalogue.filter((m) => {
      const dir = modelDirOf(this.o.modelsDir, m);
      return (!m.notice || existsSync(join(dir, 'NOTICE'))) && Object.keys(m.files).every((f) => existsSync(join(dir, f)));
    }).map((m) => m.id);
  }

  /** Deletes a model's files. One the choice names, or the search model still in use, is refused. */
  remove(id: ModelId): void {
    const c = this.#choice;
    if (c?.search === id || c?.rerank === id || this.o.embedder.profile()?.id === id || this.#rerankerId === id) {
      throw new Error(`the ${id} model is in use: choose another first`);
    }
    const m = this.#entry(id);
    rmSync(modelDirOf(this.o.modelsDir, m), { recursive: true, force: true });
    this.#progress.delete(id);
  }

  /**
   * At server start, after it listens: the choice on disk is loaded (downloaded first when missing); an install from
   * before models.json gets its brain's own model as the choice; a new brain with no choice waits for the welcome.
   */
  async start(): Promise<void> {
    let c = readChoice(this.o.dataDir);
    if (c === null) {
      const stored = storedModel(this.o.db)?.model;
      if (stored === 'e5' || stored === 'gemma') {
        c = { search: stored, rerank: this.o.rerank === false ? null : 'mminilm' };
        try {
          writeChoice(this.o.dataDir, c);
        } catch (e) {
          this.#log(`models: could not save the choice (${message(e)}): it is kept for this run`);
        }
        this.#log(`models: this brain uses ${stored}; keeping it (searching by keywords until it is downloaded)`);
      }
    }
    this.#choice = c;
    if (c !== null) await this.#run(c);
  }

  #entry(id: ModelId): CatalogueModel {
    const m = this.#catalogue.find((x) => x.id === id);
    if (!m) throw new Error(`the ${id} model is not available`);
    return m;
  }

  #run(c: ModelChoice): Promise<void> {
    const prev = this.#job;
    // The same choice again (a second click, the welcome sent twice): the work under way goes on, never restarted.
    if (prev && !prev.ctrl.signal.aborted && sameChoice(prev.choice, c)) return prev.outcome;
    prev?.ctrl.abort();
    const ctrl = new AbortController();
    const done = (async () => {
      // Never two re-reads of one brain: the stopped one ends (keeping what it staged) before this one starts.
      if (prev) await prev.outcome.catch(() => {});
      ctrl.signal.throwIfAborted();
      await this.#apply(c, ctrl.signal);
      ctrl.signal.throwIfAborted();
      await this.#selfCheck(c);
      ctrl.signal.throwIfAborted();
    })();
    const job = { choice: c, ctrl, outcome: Promise.resolve() };
    job.outcome = (async () => {
      try {
        await done;
      } catch (e) {
        if (ctrl.signal.aborted) return; // a newer choice took over
        this.#problem = message(e);
        this.#log(`models: ${this.#problem}`);
        throw e;
      } finally {
        if (this.#job === job) this.#job = null;
      }
    })();
    this.#job = job;
    return job.outcome;
  }

  /** Half-downloaded files (kept to carry on from) of models the owner no longer wants are removed, so they never sit on the disk for ever. */
  #dropStalePartials(c: ModelChoice): void {
    const keep = new Set<string>([c.search, ...(c.rerank ? [c.rerank] : [])]);
    const walk = (dir: string): void => {
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.partial')) { try { rmSync(p, { force: true }); } catch { /* left for next time */ } }
      }
    };
    for (const m of this.#catalogue) if (!keep.has(m.id)) walk(modelDirOf(this.o.modelsDir, m));
  }

  async #apply(c: ModelChoice, signal: AbortSignal): Promise<void> {
    this.#progress.clear();
    this.#problem = undefined;
    this.#rerankFailed = false;
    this.#onlineProblem = undefined;
    this.#checked = undefined;
    this.#checkFailed = false;
    this.#dropStalePartials(c);
    const e = this.o.embedder;
    let reread: Promise<unknown> = Promise.resolve();
    if (!(e.ready() && e.profile()?.id === c.search)) {
      const m = this.#entry(c.search);
      // While the chosen model is missing (chosen before a restart, or offline), the brain's own model keeps search by
      // meaning on when its files are here: only when no model is serving, so one that works is never swapped.
      await this.#ensure(m, signal, () => (e.ready() ? Promise.resolve() : this.#useStored(signal)));
      const profile = profileFor(m.profile ?? c.search);
      // #ensure has just checked every file (or downloaded and checked it): not hashed a second time, blocking.
      const model = await (this.o.load?.embedder ?? defaultEmbedder)(this.o.modelsDir, profile, { verified: true });
      signal.throwIfAborted();
      reread = rereadInBackground(this.o.db, this.o.dbPath, model, profile, this.#log, { signal, into: e, onSwitched: this.o.onSwitched });
    }
    const [searched, reranked] = await Promise.allSettled([reread, this.#useReranker(c, signal)]);
    if (searched.status === 'rejected') throw searched.reason;
    if (reranked.status === 'rejected') {
      this.#rerankFailed = true;
      throw reranked.reason;
    }
  }

  /**
   * After the models are in use: one real test search, so "ready" means it works on this computer. The search model
   * must give a finite, non-zero vector (a model that is not really serving gives the all-zero placeholder), and a
   * local reranker one finite score. Online reranking (the network) and no reranker are not tried.
   */
  async #selfCheck(c: ModelChoice): Promise<void> {
    const started = performance.now();
    const query = 'How do I bake bread?';
    const failed = (e: unknown) => new Error(`the search model loaded but a test search on this computer failed: ${message(e)}`);
    try {
      const v = await this.o.embedder.embed(query, 'query');
      if (!(v instanceof Float32Array) || v.length === 0) throw new Error('it gave no result');
      if (!v.every(Number.isFinite)) throw new Error('it gave a result that is not numbers');
      if (isZeroVector(v)) throw new Error('it gave an empty result');
    } catch (e) {
      this.#checkFailed = true;
      throw failed(e);
    }
    if (this.#rerankerId !== null && c.rerank !== 'online' && this.o.reranker.ready()) {
      try {
        const scores = await this.o.reranker.score(query, ['Bread: flour, water, salt and yeast.']);
        if (scores.length !== 1 || !Number.isFinite(scores[0])) throw new Error('the reranker gave a result that is not a number');
      } catch (e) {
        this.#rerankFailed = true;
        throw failed(e);
      }
    }
    this.#checked = { ms: Math.round(performance.now() - started) };
  }

  async #useReranker(c: ModelChoice, signal: AbortSignal): Promise<void> {
    const r = this.o.reranker;
    if (c.rerank === 'online') return this.#useOnline(c, signal);
    if (c.rerank === null) {
      r.use(null);
      this.#rerankerId = null;
      return;
    }
    if (this.#rerankerId === c.rerank && r.ready()) return;
    const m = this.#entry(c.rerank);
    await this.#ensure(m, signal);
    const loaded = await (this.o.load?.reranker ?? defaultReranker)(this.o.modelsDir, m, { verified: true });
    signal.throwIfAborted();
    r.use(loaded);
    this.#rerankerId = m.id;
  }

  /**
   * The online reranker: OpenRouter's, falling back to Standard when that is installed (never downloaded for this),
   * else to the search's own order. A key that is missing, refused or out of credit is said in status().onlineProblem.
   */
  async #useOnline(c: ModelChoice, signal: AbortSignal): Promise<void> {
    const model = ONLINE_MODELS.find((m) => m.id === c.online?.model);
    if (!model) throw new Error('that online model is not one BrainAI offers');
    const standard = this.#catalogue.find((m) => m.id === 'mminilm');
    let backup: Reranker = { score: async (_q, texts) => texts.map(() => 0) };
    this.#rerankerId = null;
    if (standard && await isInstalled(standard, this.o.modelsDir)) {
      backup = await (this.o.load?.reranker ?? defaultReranker)(this.o.modelsDir, standard, { verified: true });
      this.#rerankerId = standard.id;
    }
    signal.throwIfAborted();
    const online = createOpenRouterReranker({
      apiKey: () => readKey(this.o.dataDir), model: model.id, zdr: model.zdr, fetch: this.o.fetch, timeoutMs: this.o.onlineTimeoutMs,
      onProblem: (plain) => { this.#onlineProblem = plain; },
      onOk: () => { this.#onlineProblem = undefined; },
    });
    this.o.reranker.use(withFallback(online, backup));
  }

  /**
   * Load model files, for when neither download source works: `folder` holds the model's files (laid out as in its
   * repo, or all in the folder itself). Every file is checked against its pin first and copied only if all match, so
   * a wrong file copies nothing.
   */
  async loadFromFolder(id: ModelId, folder: string): Promise<void> {
    const m = this.#entry(id);
    if (await isInstalled(m, this.o.modelsDir)) throw new Error(`${m.label} is already on this computer: nothing was copied`);
    const job = this.#job;
    if (job && !job.ctrl.signal.aborted && (job.choice.search === id || job.choice.rerank === id)) throw new Error(`${m.label} is being set up right now: nothing was copied`);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('that folder does not exist');
    const found: [string, string][] = [];
    for (const [file, sha] of Object.entries(m.files)) {
      const path = [join(folder, file), join(folder, basename(file))].find((p) => existsSync(p) && statSync(p).isFile());
      if (!path) throw new Error(`that folder does not hold ${file}: nothing was copied`);
      if ((await sha256File(path)) !== sha) throw new Error(`${file} is not the file BrainAI expects for ${m.label}: nothing was copied`);
      found.push([file, path]);
    }
    const target = modelDirOf(this.o.modelsDir, m);
    try {
      busy('copying model files', () => {
        for (const [file, from] of found) {
          const to = join(target, file);
          mkdirSync(join(to, '..'), { recursive: true });
          copyFileSync(from, `${to}.partial`);
          renameSync(`${to}.partial`, to);
        }
      });
      copyNotice(m, this.o.modelsDir);
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`the files could not be copied (${(e as NodeJS.ErrnoException).code ?? 'write failed'}): nothing was kept`);
    }
    this.#progress.delete(id);
    // A choice that was waiting for these files (the download had failed) goes on with them.
    if (this.#choice && (this.#choice.search === id || this.#choice.rerank === id) && this.#job === null) void this.#run(this.#choice).catch(() => {});
  }

  /**
   * The model that made the stored vectors, loaded into the switchable embedder when its files are here and check out.
   * Its vectors are the brain's, so nothing is re-read: the run only embeds the rows saved on keywords, and the embedder
   * switches to it in the same turn as its last check, its stamp check (SwitchableEmbedder.ready) holding as for any
   * other model. A failure here is logged and the chosen model's download goes on.
   */
  async #useStored(signal: AbortSignal): Promise<void> {
    const stored = storedModel(this.o.db)?.model;
    const m = this.#catalogue.find((x) => x.kind === 'search' && x.profile !== undefined && x.profile === stored);
    if (!m) return;
    try {
      if (!(await isInstalled(m, this.o.modelsDir))) return;
      signal.throwIfAborted();
      const profile = profileFor(m.profile);
      const model = await (this.o.load?.embedder ?? defaultEmbedder)(this.o.modelsDir, profile, { verified: true });
      signal.throwIfAborted();
      await rereadInBackground(this.o.db, this.o.dbPath, model, profile, this.#log, { signal, into: this.o.embedder, onSwitched: this.o.onSwitched });
      this.#log(`models: searching with ${m.id}, the model this brain's vectors are from, until the chosen one is ready`);
    } catch (e) {
      if (signal.aborted) throw e;
      this.#log(`models: could not load ${m.id} meanwhile (${message(e)})`);
    }
  }

  /**
   * Downloads `m` unless it is installed; its progress shows in status() while this choice is the current one.
   * `missing` runs first when it is not installed.
   */
  async #ensure(m: CatalogueModel, signal: AbortSignal, missing?: () => Promise<void>): Promise<void> {
    if (await isInstalled(m, this.o.modelsDir)) return;
    signal.throwIfAborted();
    if (missing) {
      await missing();
      signal.throwIfAborted();
    }
    await (this.o.download ?? downloadModel)(m, this.o.modelsDir, {
      sources: this.o.sources ?? DEFAULT_SOURCES, signal,
      onProgress: (p) => { if (!signal.aborted) this.#progress.set(p.model, p); },
    });
    signal.throwIfAborted();
  }
}

function defaultEmbedder(modelsDir: string, p: EmbeddingProfile, o: { verified: boolean }): Promise<Embedder> {
  return createLocalEmbedder({ modelDir: modelsDir, allowRemote: false, model: p, verified: o.verified });
}

async function defaultReranker(modelsDir: string, m: CatalogueModel, o: { verified: boolean }): Promise<Reranker> {
  if (m.id !== 'mminilm') throw new Error(`the ${m.id} reranker is not available yet`);
  return createLocalReranker({ modelDir: modelsDir, allowRemote: false, verified: o.verified });
}
