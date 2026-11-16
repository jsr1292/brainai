/** The Mac app's pages (D3), in local mode only: Settings › Tools on this Mac. */
import { Router, type RequestHandler } from 'express';
import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, disconnect, toolStates, type ToolEnv, type ToolId } from '../desktop/tools.js';
import { setupText } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { appKeyCheck, requireOwner } from './authRoutes.js';
import { html, page } from './html.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { isEmptyBrain, stageRestore } from '../saved/restore.js';
import { kindOfFile } from '../saved/backupFile.js';
import { firstLine, modelsLine, modelsProgress, toolsPage, welcomePage } from './desktopViews.js';
import { readHardware, suggest } from '../models/hardware.js';
import type { ModelChoice } from '../models/choice.js';
import { CATALOGUE, ONLINE_MODELS } from '../models/catalogue.js';
import { deleteKey, isKeyShaped, readKey, writeKey } from '../models/onlineKey.js';
import { saySearch } from './searchSaid.js';
import { thisComputer } from '../desktop/computer.js';
import { readUpdate, setLater, updateLine } from '../desktop/updateState.js';
import { runBackup } from '../backup.js';
import { BRAIN_VERSION } from '../version.js';

const OWNER = { type: 'owner' } as const;
const DONE_FILE = 'welcome-done';
/** The biggest saved file the welcome takes: a brain with many pictures is large, but not without end. */
const MAX_UPLOAD = 4 * 1024 ** 3;
const UPLOAD_FILE = 'restore-upload.tar.gz';
const UPLOAD_TYPES = ['application/gzip', 'application/octet-stream', 'application/vnd.sqlite3', 'application/x-sqlite3'];
const NOT_A_SAVED_FILE = 'That is not a saved BrainAI file or backup (a .tar.gz or a memory-….db).';
let doneInMemory = false;

function welcomeDone(d: AppDeps): boolean {
  return d.statusDir ? existsSync(join(d.statusDir, DONE_FILE)) : doneInMemory;
}

/** A new Mac install opens on the welcome: nothing saved, nothing suggested, nothing connected, and not dismissed. */
export function needsWelcome(d: AppDeps): boolean {
  return toolEnv(d) !== null && !welcomeDone(d) && d.store.countCurrent() === 0 && d.service.pendingSuggestions().length === 0
    && d.provider.listGrants().length === 0;
}

/**
 * The owner's own pair, from a form: the one validation of the welcome and of Settings › Search. Only known values pass.
 * Online ("online:<model>") is for Settings, once a key is saved; the welcome leaves it for later.
 */
function customChoice(body: Record<string, unknown>, o: { online: false } | { online: true; keySaved: boolean }): ModelChoice | null {
  if (body.search !== 'e5' && body.search !== 'gemma') return null;
  if (body.rerank === 'none') return { search: body.search, rerank: null };
  if (body.rerank === 'mminilm') return { search: body.search, rerank: 'mminilm' };
  if (o.online && o.keySaved && typeof body.rerank === 'string' && body.rerank.startsWith('online:')) {
    const model = ONLINE_MODELS.find((m) => `online:${m.id}` === body.rerank);
    if (model) return { search: body.search, rerank: 'online', online: { model: model.id } };
  }
  return null;
}

const IDS: readonly ToolId[] = ['claude-code', 'codex', 'opencode', 'cursor', 'claude-desktop'];
const isId = (s: string): s is ToolId => (IDS as readonly string[]).includes(s);

const windows = (env: ToolEnv) => (env.platform ?? process.platform) === 'win32';

export function toolEnv(d: AppDeps): ToolEnv | null {
  if (!d.localMode || !d.tools) return null;
  const mcpUrl = new URL('/mcp', d.publicUrl).href;
  const { bridgeCli, ...tools } = d.tools;
  const env: ToolEnv = { ...tools, mcpUrl, rules: (slug) => setupText(slug, mcpUrl, d.setupOverlay) };
  // Claude's desktop app runs this server's own Node and cli.js as a bridge; its key is a grant of its own (local mode only).
  if (d.statusDir) {
    env.bridge = {
      node: process.execPath, cli: bridgeCli ?? fileURLToPath(new URL('../cli.js', import.meta.url)),
      dataDir: d.statusDir, portFile: join(dirname(d.statusDir), 'brainai.json'),
    };
    env.issueKey = () => d.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
    env.revokeKey = (grantId) => d.provider.revokeGrant(grantId);
    env.keyLive = (grantId) => d.provider.isLocalGrantLive(grantId, mcpUrl);
  }
  return env;
}

export function desktopRoutes(d: AppDeps): Router {
  const router = Router();
  const env = toolEnv(d);
  if (!env) return router;
  const owner = requireOwner(d.sessions);
  // The last result for each tool, shown once on the page it returns to. Kept here, never taken from the URL, so a
  // link from another site cannot make the page say anything (D3 review).
  const results = new Map<ToolId, { text: string; at: number }>();
  const resultFor = (q: unknown): string | null => {
    if (typeof q !== 'string' || !isId(q)) return null;
    const r = results.get(q);
    results.delete(q);
    return r && Date.now() - r.at < 120_000 ? r.text : null;
  };

  router.get('/settings/tools', owner, async (req, res) => {
    const said = resultFor(req.query.tool);
    res.type('html').send(page(`Tools on ${thisComputer()}`, toolsPage({ tools: await toolStates(env), windows: windows(env), said, cursorRules: env.rules('claude-code') }),
      { nav: true, tab: null, back: { href: '/settings#connections', label: 'Settings' } }));
  });

  for (const what of ['connect', 'disconnect'] as const) {
    router.post(`/settings/tools/:id/${what}`, owner, async (req, res, next) => {
      const id = req.params.id as string;
      if (!isId(id)) return next();
      const replace = (req.body as Record<string, unknown> | undefined)?.replace === '1';
      const r = what === 'connect' ? await connect(id, env, { replace }) : await disconnect(id, env);
      if (r.ok) await d.refreshAskCommands?.().catch(() => {});
      const said = r.ok ? (what === 'connect' ? `Connected. Next: ${r.signIn}` : 'Disconnected.') : r.reason;
      results.set(id, { text: said, at: Date.now() });
      const back = (req.body as Record<string, unknown> | undefined)?.back === 'welcome' ? '/welcome?step=3&tool=' : '/settings/tools?tool=';
      res.redirect(303, back + id);
    });
  }
  // The restore pages exist only on this computer, never through the public door.
  const here: RequestHandler = (req, _res, next) => (viaDoor(req) ? next('router') : next());
  const dataDir = d.statusDir;
  const emptyBrain = () => !!dataDir && isEmptyBrain(join(dataDir, 'memory.db'));
  // An import replaces the whole database, so an app connected here would lose its connection without being told.
  const appConnected = () => d.provider.listGrants().some((g) => !g.revokedAt);
  const canRestore = () => emptyBrain() && !appConnected();
  /** What the restart wrote about the restore, read once and removed so it is said once. */
  const takeRestored = (): { facts: number; pages: number; pictures_missing: number } | { refused: string } | null => {
    if (!dataDir) return null;
    const file = join(dataDir, 'restored.json');
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as { facts?: unknown; pages?: unknown; pictures_missing?: unknown; refused?: unknown };
      rmSync(file, { force: true });
      if (typeof r.refused === 'string') return { refused: r.refused };
      return typeof r.facts === 'number' && typeof r.pages === 'number'
        ? { facts: r.facts, pages: r.pages, pictures_missing: typeof r.pictures_missing === 'number' ? r.pictures_missing : 0 } : null;
    } catch { return null; }
  };

  router.get('/welcome', here, owner, async (req, res) => {
    const step = req.query.step === '2' ? 2 : req.query.step === '3' ? 3 : req.query.step === '4' ? 4 : 1;
    const said = resultFor(req.query.tool);
    const restore = step === 1 && canRestore() ? (req.query.restore === '1' ? 'choose' as const : 'offer' as const) : null;
    const restored = step === 3 ? takeRestored() : null;
    res.type('html').send(page('Welcome to BrainAI', welcomePage({
      step, tools: step === 3 ? await toolStates(env) : [], windows: windows(env), said, cursorRules: env.rules('claude-code'), restore, restored,
      models: step === 2 && d.models ? { hardware: await (d.hardware ?? (() => readHardware(dataDir ?? process.cwd())))(), installed: await d.models.installedIds() } : undefined,
      modelsLine: step >= 3 && d.models ? modelsLine(d.models.status(), { dataDir }) : undefined,
    }),
      { nav: false, tab: null, shell: 'setup' }));
  });

  /**
   * The saved file arrives as the raw request body, streamed to disk with a size limit (no buffering, no multipart),
   * checked and staged by stageRestore; the app then restarts the server, which swaps it in. The upload is always deleted.
   */
  router.post('/welcome/restore', here, owner, async (req, res) => {
    if (!dataDir) return res.status(404).end();
    const type = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!UPLOAD_TYPES.includes(type)) return res.status(415).json({ error: NOT_A_SAVED_FILE });
    if (!emptyBrain()) return res.status(409).json({ error: 'This brain already has memories, so a saved copy cannot be brought in.' });
    if (appConnected()) return res.status(409).json({ error: 'An app is already connected to this brain, so a saved copy cannot be brought in: it would lose its connection.' });
    const file = join(dataDir, UPLOAD_FILE);
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > MAX_UPLOAD ? new Error('That file is too big to be a saved BrainAI folder.') : null, chunk);
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(file));
      // The bytes decide, not the name or the type: an archive starts with gzip's mark, a backup with SQLite's.
      if (!kindOfFile(file)) return res.status(415).json({ error: NOT_A_SAVED_FILE });
      await stageRestore(file, dataDir);
      res.json({ next: '/app/restart' });
    } catch (e) {
      res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(file, { force: true });
    }
  });

  /** Shown if the desktop app did not intercept the navigation (it normally restarts the server and moves on). */
  router.get('/app/restart', here, (_req, res) => {
    res.type('html').send(page('BrainAI is restarting', html`<div class="narrow"><h1>BrainAI is restarting…</h1>
<p>Your saved brain is being brought back. This window opens again by itself in a moment.</p></div>`, { tab: null }));
  });

  router.post('/welcome/name', owner, async (req, res) => {
    const raw = (req.body as Record<string, unknown> | undefined)?.name;
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (name !== '') await d.service.remember({ kind: 'profile', content: `The owner is called ${name}.` }, OWNER);
    res.redirect(303, '/welcome?step=2');
  });

  /** The search models' state for the progress line: no data folder path, and nothing of any key. */
  router.get('/models/progress', owner, (_req, res) => {
    if (!d.models) return res.status(404).end();
    const s = d.models.status();
    const line = modelsProgress(s, dataDir);
    const clean = (t: string) => (dataDir ? t.replaceAll(dataDir, 'the data folder') : t);
    res.set('Cache-Control', 'no-store').json({
      choice: s.choice === null ? null : { search: s.choice.search, rerank: s.choice.rerank },
      progress: s.progress.map((p) => ({ model: p.model, doneBytes: p.doneBytes, totalBytes: p.totalBytes, state: p.state, ...(p.error !== undefined ? { error: clean(p.error) } : {}) })),
      searchReady: s.searchReady,
      ...(s.problem !== undefined ? { problem: clean(s.problem) } : {}),
      line: line.text, busy: line.busy, failed: line.failed, bar: line.bar, ready: line.ready,
    });
  });

  const clean = (t: string) => [dataDir, d.backupDir].reduce<string>((s, p) => (p ? s.replaceAll(p, 'the data folder') : s), t);

  /** The shell's call before it installs an update: a backup now. Only the app's key passes; anything else is the unknown page. */
  const fromApp = appKeyCheck(d);
  router.post('/app/backup-now', here, async (req, res, next) => {
    if (!fromApp(req)) return next('router');
    res.set('Cache-Control', 'no-store');
    if (!dataDir || !d.backupDir) return res.status(500).json({ error: 'No backup folder is set up, so no backup was made.' });
    const run = await runBackup(d.db!, d.backupDir, d.backupKeep ?? 14, d.now(), dataDir, d.backupCopy);
    if (run.ok) return res.json({ ok: true });
    res.status(500).json({ error: clean(run.error ?? 'The backup did not finish.') });
  });

  /** Shown if the desktop app did not intercept the navigation (for example in a normal browser tab). */
  router.get('/app/update', here, (_req, res) => {
    res.type('html').send(page('Update BrainAI', html`<div class="narrow"><h1>Update BrainAI</h1>
<p>To update, use Update and restart in BrainAI's own window (open it from the menu bar or the tray).</p></div>`, { tab: null }));
  });

  router.post('/app/update/later', here, owner, (_req, res) => {
    const u = dataDir ? readUpdate(dataDir, BRAIN_VERSION) : null;
    if (dataDir && u) setLater(dataDir, u.version);
    res.redirect(303, '/');
  });

  router.get('/app/update/state', here, owner, (_req, res) => {
    const u = dataDir ? readUpdate(dataDir, BRAIN_VERSION) : null;
    if (!u) return res.status(404).end();
    const l = updateLine(u);
    res.set('Cache-Control', 'no-store').json({ title: l.title, text: clean(l.text), busy: l.busy, failed: l.failed });
  });

  /** "Choose for me" or the owner's own pair; Online is set up later in Settings › Search, so it is refused here. */
  router.post('/welcome/models', here, owner, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let choice: ModelChoice | null = null;
    if (body.mode === 'suggested') {
      const p = suggest(await (d.hardware ?? (() => readHardware(dataDir ?? process.cwd())))());
      choice = { search: p.search, rerank: p.rerank };
    } else if (body.mode === 'custom') {
      choice = customChoice(body, { online: false });
    }
    if (!choice) return res.status(400).type('html').send(page('Welcome to BrainAI', html`<div class="narrow"><h1>Choose again</h1><p>That choice is not one BrainAI offers here. <a href="/welcome?step=2">Back to the search step</a></p></div>`, { nav: false, tab: null }));
    // Downloads run in the background while the welcome goes on; a failure shows in the progress line.
    d.models?.choose(choice).catch(() => {});
    res.redirect(303, '/welcome?step=3');
  });

  // ---- Settings › Search (the section itself is drawn with Settings) ----
  const back = (res: import('express').Response) => res.redirect(303, '/settings#search');
  const refuseSearch = (res: import('express').Response, why: string) =>
    res.status(400).type('html').send(page('Settings › Search', html`<div class="narrow"><h1>Not changed</h1><p>${why}</p><p><a href="/settings#search">Back to Settings › Search</a></p></div>`, { nav: true, tab: null, back: { href: '/settings#search', label: 'Settings' } }));
  const labelOf = (id: string) => CATALOGUE.find((m) => m.id === id)?.label ?? id;
  const modelId = (v: unknown) => (typeof v === 'string' ? CATALOGUE.find((m) => m.id === v)?.id : undefined);
  const keySaved = () => !!dataDir && readKey(dataDir) !== null;

  router.post('/settings/search/models', here, owner, (req, res) => {
    if (!d.models) return res.status(404).end();
    const choice = customChoice((req.body ?? {}) as Record<string, unknown>, { online: true, keySaved: keySaved() });
    if (!choice) return refuseSearch(res, 'That choice is not one BrainAI offers. Online needs an OpenRouter key: save it first.');
    // Downloads and a re-read run in the background; the section shows how far they are.
    d.models.choose(choice).catch(() => {});
    back(res);
  });

  router.post('/settings/search/key', here, owner, (req, res) => {
    if (!d.models) return res.status(404).end();
    const key = (req.body as Record<string, unknown> | undefined)?.key;
    if (!dataDir || typeof key !== 'string' || !isKeyShaped(key.trim())) return refuseSearch(res, 'That does not look like an OpenRouter key: it is one word, without spaces.');
    try {
      writeKey(dataDir, key);
      saySearch('The key is saved.');
    } catch (e) {
      return refuseSearch(res, e instanceof Error ? e.message : 'The key could not be saved.');
    }
    back(res);
  });

  router.post('/settings/search/key/remove', here, owner, async (_req, res) => {
    if (!dataDir || !d.models) return res.status(404).end();
    deleteKey(dataDir);
    const c = d.models.status().choice;
    if (c?.rerank === 'online') {
      const standard = (await d.models.installedIds()).includes('mminilm');
      d.models.choose({ search: c.search, rerank: standard ? 'mminilm' : null }).catch(() => {});
      saySearch(`The key is removed, so Online reranking is off: ${standard ? 'Standard is used' : 'no reranker is used'}.`);
    } else saySearch('The key is removed.');
    back(res);
  });

  router.post('/settings/search/remove', here, owner, (req, res) => {
    const id = modelId((req.body as Record<string, unknown> | undefined)?.model);
    if (!d.models || !id) return refuseSearch(res, 'That is not a model BrainAI has.');
    try {
      d.models.remove(id);
      saySearch(`${labelOf(id)} is removed.`);
    } catch (e) {
      saySearch(/in use/.test(e instanceof Error ? e.message : '') ? `${labelOf(id)} is in use: choose another first.` : `${labelOf(id)} could not be removed.`);
    }
    back(res);
  });

  router.post('/settings/search/load', here, owner, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = modelId(body.model);
    if (!d.models || !id || typeof body.folder !== 'string') return refuseSearch(res, 'Choose a model and the folder that holds its files.');
    try {
      await d.models.loadFromFolder(id, body.folder.trim());
      saySearch(`${labelOf(id)} is ready: its files were checked and copied.`);
    } catch (e) {
      const why = e instanceof Error ? e.message.replaceAll(dataDir ?? '\0', 'the data folder') : 'the files could not be loaded';
      saySearch(`${labelOf(id)} was not loaded: ${why}.`.replace(/\.\.$/, '.'));
    }
    back(res);
  });

  router.get('/welcome/first', owner, (_req, res) => {
    const mine = d.store.list({ limit: 50 }).filter((m) => m.createdBy !== 'owner').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const held = d.service.pendingSuggestions().filter((s) => s.content !== null)[0];
    res.set('Cache-Control', 'no-store').type('html').send(firstLine({
      memory: mine ? { by: mine.createdBy, content: mine.content } : null,
      suggestion: held ? { by: held.suggestedBy, content: held.content! } : null,
    }).value);
  });

  router.post('/welcome/done', owner, (_req, res) => {
    if (d.statusDir) writeFileSync(join(d.statusDir, DONE_FILE), '');
    doneInMemory = true;
    res.redirect(303, '/');
  });
  return router;
}
