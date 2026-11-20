/** The Mac app's pages (D3), in local mode only: Settings › Tools on this Mac. */
import { Router, type RequestHandler } from 'express';
import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedNotSignedIn, withSignIn } from './toolSignIn.js';
import { addReminders, connect, disconnect, foundToolIds, toolStates, type ToolEnv, type ToolId } from '../desktop/tools.js';
import { setupText } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { appKeyCheck, requireOwner } from './authRoutes.js';
import { html, page, type SafeHtml } from './html.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { isEmptyBrain, stageRestore } from '../saved/restore.js';
import { kindOfFile } from '../saved/backupFile.js';
import { addedToolsLine } from './dashboardViews.js';
import type { AppsStep } from './desktopViews.js';
import { nextStepCard } from './yourAppsViews.js';
import { movedTo } from '../desktop/move.js';
import { firstLine, modelLabelPlain, noteItems, modelsLine, modelsProgress, toolsPage, welcomePage } from './desktopViews.js';
import { readHardware, suggest } from '../models/hardware.js';
import type { ModelChoice } from '../models/choice.js';
import { CATALOGUE, ONLINE_MODELS } from '../models/catalogue.js';
import { deleteKey, isKeyShaped, readKey, writeKey } from '../models/onlineKey.js';
import { saySearch } from './searchSaid.js';
import { currentLanguage, t } from '../i18n/core.js';
import { computerName } from '../desktop/computer.js';
import { clearJustUpdated, readUpdate, setLater, setOffsiteLater, updateLine } from '../desktop/updateState.js';
import { runBackup } from '../backup.js';
import { BRAIN_VERSION } from '../version.js';
import { INTERNET_APPS, LOCAL_APPS, dismissNext, isInternetApp, isWay, nextCard, outcome, readAnswer, saveAnswer, type AppId } from '../desktop/yourApps.js';

const OWNER = { type: 'owner' } as const;
const DONE_FILE = 'welcome-done';
/** The biggest saved file the welcome takes: a brain with many pictures is large, but not without end. */
const MAX_UPLOAD = 4 * 1024 ** 3;
const UPLOAD_FILE = 'restore-upload.tar.gz';
const UPLOAD_TYPES = ['application/gzip', 'application/octet-stream', 'application/vnd.sqlite3', 'application/x-sqlite3'];
const notASavedFile = () => t('setup.err.notSaved');
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

const IDS: readonly ToolId[] = ['claude-code', 'codex', 'opencode', 'cursor', 'gemini', 'claude-desktop'];
const isId = (s: string): s is ToolId => (IDS as readonly string[]).includes(s);

/** Home and the welcome's last screen: the one next step for the ticked internet apps, or nothing. */
export function nextCardFor(d: AppDeps, inWelcome = false): SafeHtml | undefined {
  if (!d.localMode) return undefined;
  const a = readAnswer(d.store);
  const internet = a ? a.apps.filter(isInternetApp) : [];
  if (!a || internet.length === 0) return undefined;
  const env = toolEnv(d);
  // Reach is not offered on Windows, so an answer of 'reach' never makes a card there.
  const card = nextCard(a.way === 'reach' && env && windows(env) ? { ...a, way: null } : a, { reachOn: (d.reach?.url() ?? null) !== null, moved: !!d.statusDir && movedTo(d.statusDir) !== null });
  return card ? nextStepCard(card, internet, inWelcome) : undefined;
}

const windows = (env: ToolEnv) => (env.platform ?? process.platform) === 'win32';

export function toolEnv(d: AppDeps): ToolEnv | null {
  if (!d.localMode || !d.tools) return null;
  const mcpUrl = new URL('/mcp', d.publicUrl).href;
  const { bridgeCli, ...tools } = d.tools;
  const env: ToolEnv = { hooksDir: fileURLToPath(new URL('../hooks/', import.meta.url)), ...tools, mcpUrl, // Connect writes the rules in the language the owner has when they press it (their Language setting, else the system's; English outside a request). A tool connected in English keeps English rules until it is reconnected.
    rules: (slug) => setupText(slug, mcpUrl, d.setupOverlay, currentLanguage()) };
  // Disconnect ends a tool's sign-in too, through the same revoke as Settings › Connections (the rows stay, marked revoked).
  env.endSignIns = (toolName) => {
    const live = d.provider.listGrants().filter((g) => !g.revokedAt && g.clientName.toLowerCase().startsWith(toolName.toLowerCase()));
    for (const g of live) d.provider.revokeGrant(g.id);
    return live.length;
  };
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

/** The tools' looks start their CLIs (up to 30 s each): the answer is kept for a short while and shared by Settings › Tools and the Settings line. */
const STATES_MS = 30_000;
const stateCache = new WeakMap<AppDeps, { at: number; grants: string; states: Promise<Awaited<ReturnType<typeof toolStates>>> }>();
export function cachedToolStates(d: AppDeps, env: ToolEnv): Promise<Awaited<ReturnType<typeof toolStates>>> {
  // A sign-in granted or revoked elsewhere (Settings › Connections) changes what a look says, so it ends the kept answer too.
  const grants = d.provider.listGrants().map((g) => `${g.id}:${g.revokedAt ?? ''}`).join(',');
  const hit = stateCache.get(d);
  if (hit && hit.grants === grants && d.now().getTime() - hit.at < STATES_MS) return hit.states;
  const states = toolStates(env);
  stateCache.set(d, { at: d.now().getTime(), grants, states });
  states.catch(() => { if (stateCache.get(d)?.states === states) stateCache.delete(d); });
  return states;
}
/** Forgets the kept looks: a connect, disconnect or replace changed what they would say. */
export const forgetToolStates = (d: AppDeps) => { stateCache.delete(d); };

/** Local mode: the names of the tools BrainAI added that have not signed in yet (for Settings › Connections). */
export async function addedToolNames(d: AppDeps): Promise<string[]> {
  const env = toolEnv(d);
  if (!env) return [];
  try { return addedNotSignedIn(withSignIn(await cachedToolStates(d, env), d.provider.listGrants())).map((t) => t.name); } catch { return []; }
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

  // The "added, not signed in yet" line of Settings, off the page's own request (the tools' CLIs can take seconds). Only on
  // this computer: never through the public door, and only for the owner.
  const sameComputer: RequestHandler = (req, _res, next) => (viaDoor(req) ? next('router') : next());
  router.get('/settings/tools/added', sameComputer, owner, async (_req, res) => {
    const names = await addedToolNames(d);
    res.set('Cache-Control', 'no-store').type('html').send(addedToolsLine(names).value);
  });

  router.get('/settings/tools', owner, async (req, res) => {
    const said = resultFor(req.query.tool);
    res.type('html').send(page(t('setup.toolsOn', { computer: computerName() }), toolsPage({ tools: withSignIn(await cachedToolStates(d, env), d.provider.listGrants()), windows: windows(env), said, cursorRules: env.rules('claude-code') }),
      { nav: true, tab: null, back: { href: '/settings#connections', labelKey: 'shell.nav.settings' } }));
  });

  for (const what of ['connect', 'disconnect'] as const) {
    router.post(`/settings/tools/:id/${what}`, owner, async (req, res, next) => {
      const id = req.params.id as string;
      if (!isId(id)) return next();
      const replace = (req.body as Record<string, unknown> | undefined)?.replace === '1';
      const r = what === 'connect' ? await connect(id, env, { replace }) : await disconnect(id, env);
      forgetToolStates(d);
      if (r.ok) await d.refreshAskCommands?.().catch(() => {});
      const hooks = r.ok && r.hooksNote ? ` ${r.hooksNote}` : '';
      const said = r.ok ? ((what === 'connect' ? t('setup.said.added', { signIn: r.signIn }) : (id === 'claude-desktop' ? t('setup.said.disKey') : r.ended ? t('setup.said.disEnded') : t('setup.said.disRevoke'))) + hooks) : r.reason;
      results.set(id, { text: said, at: Date.now() });
      const back = (req.body as Record<string, unknown> | undefined)?.back === 'welcome' ? '/welcome?step=4&tool=' : '/settings/tools?tool=';
      res.redirect(303, back + id);
    });
  }
  router.post('/settings/tools/:id/reminders', owner, async (req, res, next) => {
    const id = req.params.id as string;
    if (!isId(id)) return next();
    const r = await addReminders(id, env);
    forgetToolStates(d);
    results.set(id, { text: r.ok ? `${t('setup.said.reminders')}${r.hooksNote ? ` ${r.hooksNote}` : ''}` : r.reason, at: Date.now() });
    res.redirect(303, `/settings/tools?tool=${id}`);
  });
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
    const step = (['2', '3', '4', '5'] as const).map(Number).find((n) => String(n) === req.query.step) as 2 | 3 | 4 | 5 | undefined ?? 1;
    const said = resultFor(req.query.tool);
    const restore = step === 1 && canRestore() ? (req.query.restore === '1' ? 'choose' as const : 'offer' as const) : null;
    const restored = step === 4 ? takeRestored() : null;
    const answer = readAnswer(d.store);
    const reachOn = (d.reach?.url() ?? null) !== null;
    const found = new Set<ToolId>(foundToolIds(env));
    const apps: AppsStep | undefined = step !== 2 ? undefined
      : req.query.see === '1' && answer && answer.apps.length > 0
        ? { screen: 'result', ticked: answer.apps, outcome: outcome(answer.apps, { found, reachOn, windows: windows(env) }), way: answer.way, windows: windows(env) }
        : { screen: 'pick', ticked: answer ? answer.apps : LOCAL_APPS.filter((id) => found.has(id)), found };
    res.type('html').send(page(t('setup.welcome.title'), welcomePage({
      step, apps, chosen: step === 5 ? answer?.apps : undefined, yours: step === 4 ? { answer, found, reachOn } : undefined,
      nextCard: step === 5 ? nextCardFor(d, true) : undefined,
      tools: step >= 4 ? withSignIn(await cachedToolStates(d, env), d.provider.listGrants()) : [], windows: windows(env), said, cursorRules: env.rules('claude-code'), restore, restored,
      models: step === 3 && d.models ? { hardware: await (d.hardware ?? (() => readHardware(dataDir ?? process.cwd())))(), installed: await d.models.installedIds() } : undefined,
      modelsLine: step >= 4 && d.models ? modelsLine(d.models.status(), { dataDir }) : undefined,
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
    if (!UPLOAD_TYPES.includes(type)) return res.status(415).json({ error: notASavedFile() });
    if (!emptyBrain()) return res.status(409).json({ error: t('setup.err.notEmpty') });
    if (appConnected()) return res.status(409).json({ error: t('setup.err.connected') });
    const file = join(dataDir, UPLOAD_FILE);
    let bytes = 0;
    const tooBig = t('setup.err.tooBig');
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > MAX_UPLOAD ? new Error(tooBig) : null, chunk);
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(file));
      // The bytes decide, not the name or the type: an archive starts with gzip's mark, a backup with SQLite's.
      if (!kindOfFile(file)) return res.status(415).json({ error: notASavedFile() });
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
    res.type('html').send(page(t('setup.restart.title'), html`<div class="narrow"><h1>${t('setup.restart.head')}</h1>
<p>${t('setup.restart.text')}</p></div>`, { tab: null }));
  });

  router.post('/welcome/name', owner, async (req, res) => {
    const raw = (req.body as Record<string, unknown> | undefined)?.name;
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (name !== '') await d.service.remember({ kind: 'profile', content: `The owner is called ${name}.` }, OWNER);
    res.redirect(303, '/welcome?step=2');
  });

  /** Your apps, screen 1: the ticks are stored (replacing any earlier answer). No tick, or Skip, is an empty answer and carries on to Search. */
  router.post('/welcome/apps', here, owner, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const given = body.skip === '1' ? [] : ([] as unknown[]).concat(body.app ?? []);
    const known = [...LOCAL_APPS, ...INTERNET_APPS] as readonly AppId[];
    const apps = known.filter((id) => given.includes(id));
    saveAnswer(d.store, apps, null);
    res.redirect(303, apps.length === 0 ? '/welcome?step=3' : '/welcome?step=2&see=1');
  });

  /** Dismisses the Home card for the internet apps: for good, until the answer is given again. */
  router.post('/welcome/next/dismiss', here, owner, (req, res) => {
    dismissNext(d.store);
    // From the welcome's last screen the person stays in the welcome.
    res.redirect(303, (req.body as Record<string, unknown> | undefined)?.back === 'welcome' ? '/welcome?step=5' : '/');
  });

  /** Your apps, screen 2: how the internet apps will reach BrainAI. Stored with the ticks; setup carries on to Search either way. */
  router.post('/welcome/apps/way', here, owner, (req, res) => {
    const answer = readAnswer(d.store);
    const way = (req.body as Record<string, unknown> | undefined)?.way;
    // Only a way this computer offers counts; with a choice shown, anything else is "not now".
    const offered = answer ? outcome(answer.apps, { found: new Set(), reachOn: (d.reach?.url() ?? null) !== null, windows: windows(env) }).ways : [];
    if (answer) saveAnswer(d.store, answer.apps, isWay(way) && offered.includes(way) ? way : offered.length > 0 ? 'later' : null);
    res.redirect(303, '/welcome?step=3');
  });

  /** The search models' state for the progress line: no data folder path, and nothing of any key. */
  router.get('/models/progress', owner, (_req, res) => {
    if (!d.models) return res.status(404).end();
    const s = d.models.status();
    const line = modelsProgress(s, dataDir);
    const clean = (text: string) => (dataDir ? text.replaceAll(dataDir, t('setup.dataFolder')) : text);
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
    res.type('html').send(page(t('setup.update.title'), html`<div class="narrow"><h1>${t('setup.update.title')}</h1>
<p>${t('setup.update.text')}</p></div>`, { tab: null }));
  });

  router.post('/app/update/later', here, owner, (_req, res) => {
    const u = dataDir ? readUpdate(dataDir, BRAIN_VERSION) : null;
    if (dataDir && u) setLater(dataDir, u.version);
    res.redirect(303, '/');
  });

  /** Dismisses the "Updated to x" line on Home: its file goes. */
  router.post('/app/update/dismiss', here, owner, (_req, res) => {
    if (dataDir) clearJustUpdated(dataDir);
    res.redirect(303, '/');
  });

  router.post('/app/offsite/later', here, owner, (_req, res) => {
    if (dataDir) setOffsiteLater(dataDir, d.now());
    res.redirect(303, '/');
  });

  router.get('/app/update/state', here, owner, (_req, res) => {
    const u = dataDir ? readUpdate(dataDir, BRAIN_VERSION) : null;
    if (!u) return res.status(404).end();
    const l = updateLine(u);
    res.set('Cache-Control', 'no-store').json({ title: l.title, text: clean(l.text), busy: l.busy, failed: l.failed, items: noteItems(u.notes), state: u.state, ...(u.percent !== undefined ? { percent: u.percent } : {}), version: u.version });
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
    if (!choice) return res.status(400).type('html').send(page(t('setup.welcome.title'), html`<div class="narrow"><h1>${t('setup.again.title')}</h1><p>${t('setup.again.text')} <a href="/welcome?step=3">${t('setup.again.back')}</a></p></div>`, { nav: false, tab: null }));
    // Downloads run in the background while the welcome goes on; a failure shows in the progress line.
    d.models?.choose(choice).catch(() => {});
    res.redirect(303, '/welcome?step=4');
  });

  // ---- Settings › Search (the section itself is drawn with Settings) ----
  const back = (res: import('express').Response) => res.redirect(303, '/settings#search');
  const refuseSearch = (res: import('express').Response, why: string) =>
    res.status(400).type('html').send(page(t('setup.search.pageTitle'), html`<div class="narrow"><h1>${t('setup.search.notChanged')}</h1><p>${why}</p><p><a href="/settings#search">${t('setup.search.backTo')}</a></p></div>`, { nav: true, tab: null, back: { href: '/settings#search', labelKey: 'shell.nav.settings' } }));
  const labelOf = (id: string) => { const m = CATALOGUE.find((x) => x.id === id); return m ? modelLabelPlain(m) : id; };
  const modelId = (v: unknown) => (typeof v === 'string' ? CATALOGUE.find((m) => m.id === v)?.id : undefined);
  const keySaved = () => !!dataDir && readKey(dataDir) !== null;

  router.post('/settings/search/models', here, owner, (req, res) => {
    if (!d.models) return res.status(404).end();
    const choice = customChoice((req.body ?? {}) as Record<string, unknown>, { online: true, keySaved: keySaved() });
    if (!choice) return refuseSearch(res, t('setup.err.choice'));
    // Downloads and a re-read run in the background; the section shows how far they are.
    d.models.choose(choice).catch(() => {});
    back(res);
  });

  router.post('/settings/search/key', here, owner, (req, res) => {
    if (!d.models) return res.status(404).end();
    const key = (req.body as Record<string, unknown> | undefined)?.key;
    if (!dataDir || typeof key !== 'string' || !isKeyShaped(key.trim())) return refuseSearch(res, t('setup.err.keyShape'));
    try {
      writeKey(dataDir, key);
      saySearch(t('setup.said.keySaved'));
    } catch (e) {
      return refuseSearch(res, e instanceof Error ? e.message : t('setup.err.keyNotSaved'));
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
      saySearch(standard ? t('setup.said.keyRemovedStandard') : t('setup.said.keyRemovedNone'));
    } else saySearch(t('setup.said.keyRemoved'));
    back(res);
  });

  router.post('/settings/search/remove', here, owner, (req, res) => {
    const id = modelId((req.body as Record<string, unknown> | undefined)?.model);
    if (!d.models || !id) return refuseSearch(res, t('setup.err.notModel'));
    try {
      d.models.remove(id);
      saySearch(t('setup.said.modelRemoved', { label: labelOf(id) }));
    } catch (e) {
      saySearch(/in use/.test(e instanceof Error ? e.message : '') ? t('setup.said.modelInUse', { label: labelOf(id) }) : t('setup.said.modelNotRemoved', { label: labelOf(id) }));
    }
    back(res);
  });

  router.post('/settings/search/load', here, owner, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = modelId(body.model);
    if (!d.models || !id || typeof body.folder !== 'string') return refuseSearch(res, t('setup.err.chooseFolder'));
    try {
      await d.models.loadFromFolder(id, body.folder.trim());
      saySearch(t('setup.said.modelReady', { label: labelOf(id) }));
    } catch (e) {
      const why = e instanceof Error ? e.message.replaceAll(dataDir ?? '\0', t('setup.dataFolder')) : t('setup.err.filesFailed');
      saySearch(t('setup.said.modelNotLoaded', { label: labelOf(id), why }).replace(/\.\.$/, '.'));
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
