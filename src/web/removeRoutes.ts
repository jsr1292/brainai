/**
 * Settings › Remove BrainAI from this computer, on a desktop install only and never through the public door. One POST
 * does it all, in this order: the saved copy first (nothing else runs if it fails), then Reach off, the Cloudflare
 * tunnel, the tools, Claude Code's hooks, the folder report, and last the tools' original settings into the saved folder
 * with the final checklist written into its README. The app then finishes (stops, no login start) at /app/removed.
 */
import { Router, type RequestHandler } from 'express';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupFiles, claudeCodeHasBrainEntry, disconnect, dropLeftoverKey, dropSettingsBackup, tracesOfThisBrain, toolStates } from '../desktop/tools.js';
import { deleteTunnel } from '../desktop/cloudflared.js';
import { removeToolHooks } from '../desktop/hooksInstall.js';
import { removeFolderReport, removeHooks, type Launchctl } from '../desktop/leftovers.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { makeSavedCopy, moveIntoSaved, writeReadme } from '../saved/savedCopy.js';
import type { AppDeps } from './app.js';
import { appKeyCheck, requireOwner } from './authRoutes.js';
import { toolEnv } from './desktopRoutes.js';
import { html, page } from './html.js';
import { revealCommand } from './moveRoutes.js';
import { cloudflaredEnv, reachOff } from './reachRoutes.js';
import { removeDone, removePage, type ToolOutcome } from './removeViews.js';
import { parentFor, savedChecklist, documentsOf, homeOf, saveDeps } from './savedRoutes.js';

/** Test seam: the command that stops the Mac's folder-report job (tests never reach the real launchctl). */
export const removeSeams: { launchctl?: Launchctl; moveIntoSaved?: typeof moveIntoSaved } = {};

interface Result { folder: string; facts: number; pages: number; tools: ToolOutcome[]; checklist: string[]; kept: string[] }

export function removeRoutes(d: AppDeps): Router {
  const router = Router();
  if (!d.localMode || !d.statusDir || !d.db) return router;
  const dataDir = d.statusDir;
  const owner = requireOwner(d.sessions);
  const here: RequestHandler = (req, _res, next) => (viaDoor(req) ? next('router') : next());
  const platform = d.tools?.platform ?? process.platform;
  const revealIn = platform === 'win32' ? 'Explorer' as const : 'Finder' as const;
  const chrome = { nav: true, tab: null, back: { href: '/settings', label: 'Settings' } } as const;
  let result: Result | null = null;

  const ask = (res: Parameters<RequestHandler>[1], status: number, said: string | null) => {
    const docs = documentsOf(d);
    res.status(status).type('html').send(page('Remove BrainAI', removePage({ documents: docs.path, synced: docs.synced, home: homeOf(d), said, mac: platform === 'darwin' }), chrome));
  };

  router.get('/settings/remove', here, owner, (_req, res) => ask(res, 200, null));

  /** The whole removal. Returns why nothing was removed (the save failed), or null once the result is set. */
  async function removeAll(where: 'home' | 'documents'): Promise<string | null> {
    const now = d.now();
    // 1. The saved copy. If it cannot be made, nothing else runs.
    let saved;
    try {
      saved = await makeSavedCopy(saveDeps(d), parentFor(where, d), now, savedChecklist(d, 'app'));
    } catch (e) {
      console.error('saving the copy before removing failed:', e);
      return `Nothing was removed: ${e instanceof Error ? e.message : String(e)}`;
    }
    const env = toolEnv(d);
    const kept: string[] = [];
    const tools: ToolOutcome[] = [];
    const leftTools: { name: string; reason: string }[] = [];
    let tunnel: { hostname: string | null; deleted: boolean; reason?: string } | null = null;
    let originals: string[] = [];
    const handled: string[] = [];
    // Every step after the save is on its own: one that throws becomes a line in the result, and the rest still run.
    const step = async (what: string, fn: () => Promise<void> | void) => {
      try { await fn(); } catch (e) {
        console.error(`removing: ${what} failed:`, e);
        kept.push(`Failed: ${what}, ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // This app's own addresses, read before Reach is turned off (it forgets its address then).
    const ours = [d.publicUrl.origin, ...(d.reach?.saved() ? [d.reach.saved()!.origin] : [])];
    // 2. Reach off, then 3. the Cloudflare tunnel (stopped by now) if Reach ever used Cloudflare.
    await step('turning Reach off', async () => { await reachOff(d); });
    await step('deleting the Cloudflare tunnel', async () => {
      if (!existsSync(join(dataDir, 'cloudflared', 'tunnel.json'))) return;
      tunnel = await deleteTunnel(cloudflaredEnv(d), dataDir);
      if (tunnel.deleted && tunnel.hostname) kept.push(`Cloudflare: the name ${tunnel.hostname} still exists in your DNS; delete it there.`);
    });
    if (env) {
      // 4. Every tool that is connected to this brain or holds a piece of it.
      const host = new URL(env.mcpUrl).host;
      await step('disconnecting the tools', async () => {
        for (const tool of await toolStates(env)) {
          if (!tool.installed) continue;
          if (tool.state === 'other-brainai') {
            dropLeftoverKey(tool.id, env); // our own key stays ours to revoke; the other entry is not touched
            tools.push({ name: tool.name, what: 'left alone', detail: tool.detail }); continue;
          }
          const traces = tool.state === 'connected' ? 'yes' : await tracesOfThisBrain(tool.id, env);
          if (traces === 'no') {
            // Not connected here, but the save reminders BrainAI added to Codex or Cursor may still be (Connect added them, the connection went).
            if (tool.id !== 'claude-code') {
              const note = removeToolHooks(tool.id, env, false);
              if (note) kept.push(note);
            }
            continue;
          }
          if (traces === 'unreadable') {
            const reason = `BrainAI couldn't read its settings; if it has a brainai entry for ${host}, remove it by hand.`;
            tools.push({ name: tool.name, what: 'unreadable', detail: reason });
            leftTools.push({ name: tool.name, reason });
            continue;
          }
          const r = await disconnect(tool.id, env);
          if (r.ok) tools.push({ name: tool.name, what: 'disconnected' });
          else { tools.push({ name: tool.name, what: 'failed', detail: r.reason }); leftTools.push({ name: tool.name, reason: r.reason }); }
        }
      });
      // 5. Claude Code's hooks, unless a brain may still use them; 6. the folder report.
      await step("Claude Code's hooks", async () => {
        const hooks = removeHooks(env, await claudeCodeHasBrainEntry(env));
        if (hooks.kept) kept.push(hooks.kept);
        else { const gone = dropSettingsBackup(env); if (gone) handled.push(gone); }
      });
      await step('the folder report', () => {
        const report = removeFolderReport({ home: env.home, platform }, ours, removeSeams.launchctl);
        if (report.kept) kept.push(report.kept);
      });
      // 7. The tools' originals go into the saved folder.
      await step("the tools' original settings", () => { originals = (removeSeams.moveIntoSaved ?? moveIntoSaved)(saved.folder, backupFiles(env), env.home); });
    }
    // The README is written again with the final checklist, whatever happened above.
    const checklist = savedChecklist(d, 'app', { tunnel, leftTools, kept });
    try {
      writeReadme(saved.folder, { day: saved.day, facts: saved.facts, pages: saved.pages, checklist, originals, handled });
    } catch (e) {
      console.error('writing the final README failed:', e);
      kept.push(`Failed: the README in the saved folder, ${e instanceof Error ? e.message : String(e)}`);
      checklist.push(kept[kept.length - 1]!);
    }
    result = { folder: saved.folder, facts: saved.facts, pages: saved.pages, tools, checklist, kept };
    return null;
  }

  // One removal at a time: a second submit while one runs waits for it and shows its result, never a second saved copy.
  let running: Promise<string | null> | null = null;
  router.post('/settings/remove', here, owner, async (req, res) => {
    const where = (req.body as Record<string, unknown> | undefined)?.where === 'home' ? 'home' : 'documents';
    const mine = running === null;
    if (mine) running = removeAll(where);
    let said: string | null;
    try { said = await running!; } finally { if (mine) running = null; }
    if (said !== null) return ask(res, 500, said);
    res.redirect(303, '/settings/remove/done');
  });

  router.get('/settings/remove/done', here, owner, (_req, res) => {
    if (!result) return res.redirect(303, '/settings/remove');
    res.type('html').send(page('BrainAI is ready to be removed', removeDone({ ...result, revealIn }), chrome));
  });

  router.post('/settings/remove/show', here, owner, (_req, res) => {
    if (result) {
      if (d.reveal) d.reveal(result.folder);
      else { const [cmd, args] = revealCommand(result.folder, platform); execFile(cmd, args, () => {}); }
    }
    res.redirect(303, '/settings/remove/done');
  });

  /**
   * The app's check before it deletes its data folder and itself (it intercepts /app/removed, which any link can
   * reach): only the app's own client, with its key, learns whether a removal finished in this server and where its
   * saved folder is. Anything else is the unknown-page answer; no finished removal (or its folder gone) is 409.
   */
  const fromApp = appKeyCheck(d);
  router.get('/app/removed/ready', here, (req, res, next) => {
    if (!fromApp(req)) return next('router');
    res.set('Cache-Control', 'no-store');
    if (!result || !existsSync(result.folder)) return res.status(409).json({ error: 'No saved copy was made for a removal.' });
    res.json({ folder: result.folder });
  });

  // The address the app intercepts to stop and quit; a browser that reaches it anyway sees this.
  router.get('/app/removed', here, (_req, res) => {
    res.type('html').send(page('BrainAI is finishing', html`<div class="narrow"><h1>BrainAI is finishing…</h1><p>BrainAI is finishing: it is stopping, deleting its data folder and removing itself. Your saved copy is where the last page said.</p></div>`, { tab: null }));
  });
  return router;
}
