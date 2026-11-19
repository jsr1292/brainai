/**
 * Settings › Save a copy of everything. In the app (local mode, never through the public door) it makes the folder in
 * Documents or the home folder. On a server it asks for the authenticator code and streams the folder as a .tar.gz,
 * made in a temp folder that is deleted once the response is over.
 */
import { Router, type RequestHandler } from 'express';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { viaDoor } from '../desktop/publicDoor.js';
import { documentsFolder } from '../saved/documents.js';
import { checklist, serverTunnel, webAppNames } from '../saved/checklist.js';
import { makeSavedCopy, type SaveDeps } from '../saved/savedCopy.js';
import type { AppDeps } from './app.js';
import { codeLock, requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { t } from '../i18n/core.js';
import { rateLimitKey } from './clientIp.js';
import { revealCommand } from './moveRoutes.js';
import { savedCodePage, savedDone, savedPage } from './savedViews.js';

/** Test seam: runs before the server's copy is made (to hold it while a test aborts the request). */
export const savedHooks: { beforeCopy?: () => Promise<void> } = {};

/** Windows: the My Documents path (it may have moved, e.g. into OneDrive). A seam: tests replace `read`. */
export const myDocumentsProbe = {
  read(): string | undefined {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || undefined;
    } catch { return undefined; }
  },
};

export const homeOf = (d: AppDeps): string => d.tools?.home ?? homedir();
const platformOf = (d: AppDeps): NodeJS.Platform => d.tools?.platform ?? process.platform;

export function documentsOf(d: AppDeps) {
  const platform = platformOf(d);
  return documentsFolder({ home: homeOf(d), platform, env: { ...process.env, ...d.tools?.extraEnv }, myDocuments: platform === 'win32' ? myDocumentsProbe.read() : undefined });
}

/** The parent folder for a saved copy: the Documents folder, or the home folder. */
export function parentFor(where: 'home' | 'documents', d: AppDeps): string {
  return where === 'home' ? homeOf(d) : documentsOf(d).path;
}

/** The checklist for this brain: web apps from its grants, then what the caller adds (tunnel, tools left, notes). */
export function savedChecklist(
  d: AppDeps, install: 'app' | 'server',
  extra: { tunnel?: { hostname: string | null; deleted: boolean } | null; leftTools?: { name: string; reason: string }[]; kept?: string[] } = {},
): string[] {
  return checklist({ install, webApps: d.db ? webAppNames(d.db) : [], tunnel: extra.tunnel ?? null, leftTools: extra.leftTools ?? [], kept: extra.kept ?? [] });
}

export function saveDeps(d: AppDeps): SaveDeps {
  return { db: d.db!, dataDir: d.statusDir!, pages: d.pages, memoryStore: d.store, memories: d.service, skills: d.skills };
}

export function savedRoutes(d: AppDeps): Router {
  const router = Router();
  if (!d.db || !d.statusDir) return router;
  const owner = requireOwner(d.sessions);
  return d.localMode ? appRoutes(d, router, owner) : serverRoutes(d, router, owner);
}

function appRoutes(d: AppDeps, router: Router, owner: RequestHandler): Router {
  // Through the public door these pages do not exist.
  const here: RequestHandler = (req, _res, next) => (viaDoor(req) ? next('router') : next());
  const revealIn = platformOf(d) === 'win32' ? 'Explorer' as const : 'Finder' as const;
  let last: string | null = null;
  const chrome = { nav: true, tab: null, back: { href: '/settings', labelKey: 'shell.nav.settings' } } as const;

  router.get('/settings/save', here, owner, (_req, res) => {
    const docs = documentsOf(d);
    res.type('html').send(page(t('data.saved.title'), savedPage({ documents: docs.path, synced: docs.synced, home: homeOf(d), said: null }), chrome));
  });

  router.post('/settings/save', here, owner, async (req, res) => {
    const where = (req.body as Record<string, unknown> | undefined)?.where === 'home' ? 'home' : 'documents';
    try {
      const r = await makeSavedCopy(saveDeps(d), parentFor(where, d), d.now(), savedChecklist(d, 'app'));
      last = r.folder;
      res.type('html').send(page(t('data.done.title'), savedDone({ folder: r.folder, facts: r.facts, pages: r.pages, revealIn }), chrome));
    } catch (e) {
      console.error('saving a copy failed:', e);
      const docs = documentsOf(d);
      res.status(500).type('html').send(page(t('data.saved.title'), savedPage({ documents: docs.path, synced: docs.synced, home: homeOf(d), said: t('data.saved.failed', { reason: e instanceof Error ? e.message : String(e) }) }), chrome));
    }
  });

  router.post('/settings/save/show', here, owner, (_req, res) => {
    if (last) {
      if (d.reveal) d.reveal(last);
      else { const [cmd, args] = revealCommand(last, platformOf(d)); execFile(cmd, args, () => {}); }
    }
    res.redirect(303, '/settings/save');
  });
  return router;
}

function serverRoutes(d: AppDeps, router: Router, owner: RequestHandler): Router {
  const chrome = { nav: true, tab: null, back: { href: '/settings', labelKey: 'shell.nav.settings' } } as const;
  const ask = (res: Parameters<RequestHandler>[1], status: number, error: string | null) =>
    res.status(status).type('html').send(page(t('data.saved.title'), savedCodePage({ error }), chrome));

  router.get('/settings/save', owner, (_req, res) => ask(res, 200, null));

  router.post('/settings/save', owner, async (req, res) => {
    const ip = rateLimitKey(req);
    const code = String((req.body as Record<string, unknown> | undefined)?.code ?? '').trim();
    // Check, verify and fail run one at a time (the login's own lock), or a parallel burst would all pass the check.
    const outcome = await codeLock(d.limiter).run(async () => {
      const gate = await d.limiter.check(ip, { knownDevice: true });
      if (!gate.allowed) return { kind: 'blocked' as const, retryAfterSec: gate.retryAfterSec };
      if (!d.owner.verifyTotp(code)) { await d.limiter.fail(ip); return { kind: 'failed' as const }; }
      await d.limiter.succeed(ip);
      return { kind: 'ok' as const };
    });
    if (outcome.kind === 'blocked') {
      res.set('Retry-After', String(outcome.retryAfterSec));
      return ask(res, 429, t('data.saved.tooMany', { count: Math.max(1, Math.ceil(outcome.retryAfterSec / 60)) }));
    }
    if (outcome.kind === 'failed') return ask(res, 200, t('data.saved.badCode'));
    // Outside the data folder (makeSavedCopy refuses a folder inside it); the folder is private to this process.
    const tmp = mkdtempSync(join(tmpdir(), 'brainai-saved-tmp-'));
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    let tar: ChildProcess | null = null;
    // Registered before the copy starts: a client that gives up at any point stops tar and deletes the folder.
    res.on('close', () => { tar?.kill(); cleanup(); });
    try {
      await savedHooks.beforeCopy?.();
      const r = await makeSavedCopy(saveDeps(d), tmp, d.now(), savedChecklist(d, 'server', { tunnel: serverTunnel(d.publicUrl) }));
      if (res.destroyed || res.writableEnded) return cleanup();
      const name = basename(r.folder);
      res.status(200).set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}.tar.gz"`, 'Cache-Control': 'no-store' });
      const child = tar = spawn('tar', ['-czf', '-', '-C', tmp, name], { stdio: ['ignore', 'pipe', 'ignore'] });
      // The response is ended only once tar has exited cleanly (below), never by the pipe: a failed tar must not look whole.
      child.stdout!.pipe(res, { end: false });
      // A failed tar must not end as a clean, truncated 200: cut the connection so the browser shows a failed download.
      child.on('error', () => { cleanup(); res.destroy(); });
      child.on('close', (code, signal) => {
        cleanup();
        if (code === 0) res.end(); else if (signal === null) res.destroy();
      });
    } catch (e) {
      cleanup();
      console.error('saving a copy failed:', e);
      if (!res.destroyed) ask(res, 500, t('data.saved.failed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  });
  return router;
}
