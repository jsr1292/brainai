/**
 * Settings › Move to a server (D5), on a desktop install only and never through the public door: the moving file is
 * every memory in clear, so it is made, shown and deleted only from this computer.
 */
import { Router, type RequestHandler } from 'express';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { missingPictures } from '../backup.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { deleteMoveFile, makeMoveFile, movedTo, moveFile, serverAddress, setMoved } from '../desktop/move.js';
import { reachOff } from './reachRoutes.js';
import { disconnect, toolStates } from '../desktop/tools.js';
import { toolEnv } from './desktopRoutes.js';
import { html } from './html.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { movePage } from './moveViews.js';
import { thisComputer } from '../desktop/computer.js';

/** The command that shows a file selected in Finder (the Mac) or Explorer (Windows). */
export function revealCommand(path: string, platform: NodeJS.Platform): [string, string[]] {
  return platform === 'win32' ? ['explorer.exe', [`/select,${path}`]] : ['open', ['-R', path]];
}

export function moveRoutes(d: AppDeps): Router {
  const router = Router();
  if (!d.localMode || !d.statusDir || !d.db) return router;
  const dataDir = d.statusDir;
  const db = d.db;
  const owner = requireOwner(d.sessions);
  // Through the public door these pages do not exist.
  const here: RequestHandler = (req, _res, next) => (viaDoor(req) ? next('router') : next());
  let said: string | null = null;
  const back = (res: Parameters<RequestHandler>[1], text: string | null) => { said = text; res.redirect(303, '/settings/move'); };

  router.get('/settings/move', here, owner, (_req, res) => {
    const path = moveFile(dataDir);
    const st = path ? statSync(path) : null;
    const view = {
      said,
      file: path && st ? { name: basename(path), mb: (st.size / 1_048_576).toFixed(1), made: st.mtime.toISOString().slice(0, 16).replace('T', ' ') } : null,
      missingPictures: missingPictures(db, dataDir) ?? 0,
      movedTo: movedTo(dataDir),
      revealIn: (d.tools?.platform ?? process.platform) === 'win32' ? 'Explorer' as const : 'Finder' as const,
    };
    said = null;
    res.type('html').send(page('Move to a server', movePage(view), { nav: true, tab: null, back: { href: '/settings', label: 'Settings' } }));
  });

  router.post('/settings/move/file', here, owner, async (_req, res) => {
    try {
      await makeMoveFile(db, dataDir, d.now());
      back(res, 'The moving file is ready.');
    } catch (e) {
      console.error('making the moving file failed:', e);
      back(res, `The moving file could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  router.post('/settings/move/show', here, owner, (_req, res) => {
    const path = moveFile(dataDir);
    if (path) {
      if (d.reveal) d.reveal(path);
      else { const [cmd, args] = revealCommand(path, d.tools?.platform ?? process.platform); execFile(cmd, args, () => {}); }
    }
    back(res, path ? null : 'There is no moving file yet.');
  });

  router.post('/settings/move/file/delete', here, owner, (_req, res) => {
    deleteMoveFile(dataDir);
    back(res, 'The moving file is deleted.');
  });
  router.post('/settings/move/done', here, owner, async (req, res) => {
    const to = serverAddress(String((req.body as Record<string, unknown> | undefined)?.address ?? ''));
    if (!to) return back(res, "That is not a server address: it starts with https:// (for example https://brain.example.com).");
    setMoved(dataDir, to);
    // Nothing should reach the Mac copy from the internet any more.
    if (d.reach?.saved()) await reachOff(d);
    back(res, null);
  });

  // After a move: the tools pointed at this Mac are disconnected (a tool on another BrainAI is left alone), then the
  // window goes to the goodbye page, where the app stops starting at login and quits. The data folder stays.
  router.post('/settings/move/remove', here, owner, async (_req, res, next) => {
    if (!movedTo(dataDir)) return next();
    const env = toolEnv(d);
    if (env) {
      for (const tool of await toolStates(env)) {
        if (tool.state !== 'connected') continue;
        const r = await disconnect(tool.id, env);
        if (!r.ok) console.error(`disconnecting ${tool.name} failed: ${r.reason}`);
      }
    }
    res.redirect(303, '/app/goodbye');
  });

  router.get('/app/goodbye', here, (_req, res, next) => {
    const to = movedTo(dataDir);
    if (!to) return next();
    res.type('html').send(page('BrainAI is moving out', html`<div class="narrow">
<h1>BrainAI is moving out of ${thisComputer()}</h1>
<p>Your brain lives at <a href="${to.origin}">${to.origin}</a> now. The tools on ${thisComputer()} were disconnected from this copy: connect them to the server from its Settings.</p>
<p>The app asks whether to stop and stop starting at login. Then drag BrainAI from Applications to the Trash. The data folder stays, in case you need it.</p>
</div>`, { tab: null }));
  });

  router.post('/settings/move/undo', here, owner, (_req, res) => {
    setMoved(dataDir, null);
    back(res, `Not moved: ${thisComputer()} answers its apps again.`);
  });
  return router;
}
