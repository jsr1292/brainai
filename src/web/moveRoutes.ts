/**
 * Settings › Move to a server (D5), on a desktop install only and never through the public door: the moving file is
 * every memory in clear, so it is made, shown and deleted only from this computer.
 */
import { Router, type RequestHandler } from 'express';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { missingPictures } from '../backup.js';
import { localRouteOnly } from '../desktop/publicDoor.js';
import { deleteMoveFile, makeMoveFile, movedTo, moveFile, serverAddress, setMoved } from '../desktop/move.js';
import { reachOff } from './reachRoutes.js';
import { html } from './html.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { movePage } from './moveViews.js';
import { currentLanguage, t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';

/** The command that shows a file selected in Finder (the Mac) or Explorer (Windows). */
export function revealCommand(path: string, platform: NodeJS.Platform): [string, string[]] {
  return platform === 'win32' ? ['explorer.exe', [`/select,${path}`]] : ['open', ['-R', path]];
}

/** Megabytes with one decimal, the decimal comma in Spanish. */
const mbText = (bytes: number): string => { const mb = (bytes / 1_048_576).toFixed(1); return currentLanguage() === 'es' ? mb.replace('.', ',') : mb; };

export function moveRoutes(d: AppDeps): Router {
  const router = Router();
  if (!d.localMode || !d.statusDir || !d.db) return router;
  const dataDir = d.statusDir;
  const db = d.db;
  const owner = requireOwner(d.sessions);
  // Through the public door these pages do not exist.
  let said: string | null = null;
  const back = (res: Parameters<RequestHandler>[1], text: string | null) => { said = text; res.redirect(303, '/settings/move'); };

  router.get('/settings/move', localRouteOnly, owner, (_req, res) => {
    const path = moveFile(dataDir);
    const st = path ? statSync(path) : null;
    const view = {
      said,
      file: path && st ? { name: basename(path), mb: mbText(st.size), made: st.mtime.toISOString().slice(0, 16).replace('T', ' ') } : null,
      missingPictures: missingPictures(db, dataDir) ?? 0,
      movedTo: movedTo(dataDir),
      revealIn: (d.tools?.platform ?? process.platform) === 'win32' ? 'Explorer' as const : 'Finder' as const,
    };
    said = null;
    res.type('html').send(page(t('data.move.title'), movePage(view), { nav: true, tab: null, back: { href: '/settings', labelKey: 'shell.nav.settings' } }));
  });

  router.post('/settings/move/file', localRouteOnly, owner, async (_req, res) => {
    try {
      await makeMoveFile(db, dataDir, d.now());
      back(res, t('data.move.msgReady'));
    } catch (e) {
      console.error('making the moving file failed:', e);
      back(res, t('data.move.msgFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  });

  router.post('/settings/move/show', localRouteOnly, owner, (_req, res) => {
    const path = moveFile(dataDir);
    if (path) {
      if (d.reveal) d.reveal(path);
      else { const [cmd, args] = revealCommand(path, d.tools?.platform ?? process.platform); execFile(cmd, args, () => {}); }
    }
    back(res, path ? null : t('data.move.msgNone'));
  });

  router.post('/settings/move/file/delete', localRouteOnly, owner, (_req, res) => {
    deleteMoveFile(dataDir);
    back(res, t('data.move.msgDeleted'));
  });
  router.post('/settings/move/done', localRouteOnly, owner, async (req, res) => {
    const to = serverAddress(String((req.body as Record<string, unknown> | undefined)?.address ?? ''));
    if (!to) return back(res, t('data.move.msgAddress'));
    setMoved(dataDir, to);
    // Nothing should reach the Mac copy from the internet any more.
    if (d.reach?.saved()) await reachOff(d);
    back(res, null);
  });

  // After a move, Remove BrainAI does the whole removal (the saved copy, the tools, the leftovers). The old button, and
  // /app/goodbye below for windows that already show it, keep working.
  router.post('/settings/move/remove', localRouteOnly, owner, (_req, res, next) => {
    if (!movedTo(dataDir)) return next();
    res.redirect(303, '/settings/remove');
  });

  router.get('/app/goodbye', localRouteOnly, (_req, res, next) => {
    const to = movedTo(dataDir);
    if (!to) return next();
    res.type('html').send(page(t('data.move.goodbyeTitle'), html`<div class="narrow">
<h1>${t('data.move.goodbyeHead', { computer: computerName() })}</h1>
<p>${tHtml('data.move.goodbye1', { link: html`<a href="${to.origin}">${to.origin}</a>`, computer: computerName() })}</p>
<p>${t('data.move.goodbye2')}</p>
</div>`, { tab: null }));
  });

  router.post('/settings/move/undo', localRouteOnly, owner, (_req, res) => {
    setMoved(dataDir, null);
    back(res, t('data.move.msgUndo', { computer: computerName() }));
  });
  return router;
}
