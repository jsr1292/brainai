import { WEEK_NOTICE_SWITCH, weekNoticeOn } from './weekNote.js';
import { COACHING_SWITCH, coachingOn } from '../learning/coaching.js';
import { t } from '../i18n/core.js';
import { errorField, errorText, type FactField } from './errorText.js';
import { isUiLanguage, storedChoice, UI_LANGUAGE_SWITCH, writeUiLanguageFile } from '../i18n/uiLanguage.js';
import { DEFAULT_BACKUP_KEEP } from '../config.js';
import { runBackup } from '../backup.js';
import { healthOf, profileHealth, quietAppsOf } from './healthData.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { BRIDGE_KEY_FILE } from '../desktop/claudeBridge.js';
import { syncedCloud } from '../saved/documents.js';
import { Router, type Request, type Response } from 'express';
import { localRouteOnly, viaDoor } from '../desktop/publicDoor.js';
import { InvalidNameError } from '../auth/clientsStore.js';
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import { readUpdate, readUpdateCheck, updateCheckProblem } from '../desktop/updateState.js';
import { checkLatestRelease, type ReleaseResult } from '../desktop/releaseCheck.js';
import { CHECK_GAP_S, lastAttempt, type VersionPanelInput } from './versionViews.js';
import { connStatuses } from './connStatus.js';
import { BRAIN_VERSION } from '../version.js';
import { weekContaining, weekOf } from '../memory/digest.js';
import { makeTidyItems, tidySentence, tidySummary } from './tidyItems.js';
import { keepStatuses } from '../memory/tidy.js';
import { MemoryError } from '../memory/service.js';
import { SkillError } from '../skills/service.js';
import { factStory } from '../memory/factStory.js';
import { replaceableKind } from '../memory/supersessions.js';
import { KINDS, type Kind, type Memory } from '../memory/types.js';
import type { AppDeps } from './app.js';
import { pickedProjects, readCookie, requireOwner, SESSION_COOKIE, sessionCookieOptions } from './authRoutes.js';
import {
  detailView, groupFacts, listView, newView, NO_PROJECT, PAGE_SIZE, valuesOf,
  type FactsShow, type MemoryFormValues, type ReplacedItem,
} from './dashboardViews.js';
import { deviceLabel } from './deviceLabel.js';
import { FACT_RESULTS } from './searchRoutes.js';
import { takeSearchSaid } from './searchSaid.js';
import { saySettings, takeSettingsSaid } from './settingsSaid.js';
import { timeOfDay } from '../timezone.js';
import { readKey } from '../models/onlineKey.js';
import { computeSpace, SpaceCache } from '../diskSpace.js';
import { spaceBlock, spaceTotalText } from './spaceViews.js';
import { settingsView } from './settingsViews.js';
import { currentTheme, isThemeChoice, THEME_COOKIE, THEME_COOKIE_MAX_AGE } from './theme.js';
import { html, page, type SafeHtml } from './html.js';
import { backFrom, factBackDefault, nextHref, suggestionBack, withFrom, type Back, type BackTarget } from './back.js';
import { backLookups } from './backLookups.js';
import { alreadyAnswered } from './approvalsViews.js';
import { makeInbox } from './inboxPage.js';
import { TidyError } from '../memory/tidyService.js';
import { invalidateSideStatus } from './sideStatus.js';
import { noteDecision, takeStatusLine, undoable } from './inboxUndo.js';
import { deskSideView, nearIt } from './deskSide.js';

const OWNER = { type: 'owner' } as const;
// The same number as the header search's facts, so its "Also N replaced facts" and this page's list agree.
const SEARCH_LIMIT = FACT_RESULTS;

const str = (req: Request, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};
const query = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
/** A field the form did not send at all (an older form): undefined, so the save keeps what is stored. */
const optStr = (req: Request, name: string): string | undefined => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : undefined;
};
const formValues = (req: Request, kind: string): MemoryFormValues =>
  ({ kind, content: str(req, 'content'), project: str(req, 'project').trim(), tags: str(req, 'tags'), keys: optStr(req, 'keys'), base: str(req, 'base') || undefined,
    validUntil: optStr(req, 'valid_until'), source: optStr(req, 'source'), sourceNote: optStr(req, 'source_note'),
    origValidUntil: optStr(req, 'orig_valid_until'), origSource: optStr(req, 'orig_source'), origSourceNote: optStr(req, 'orig_source_note') });
/** The New fact form's date and source (owner-set; the service checks them like any other write). Empty fields send nothing. */
const newMeta = (v: MemoryFormValues): { validUntil?: string; source?: string; sourceNote?: string } => {
  const validUntil = v.validUntil?.trim(), source = v.source?.trim(), sourceNote = v.sourceNote?.trim();
  return { ...(validUntil ? { validUntil } : {}), ...(source ? { source, ...(sourceNote ? { sourceNote } : {}) } : {}) };
};
const tagList = (raw: string): string[] => raw.split(/[\s,]+/).filter((t) => t !== '');

/** Settings waits this long for the sizes of the data folder; slower than that, the page says it is working them out. */
const SPACE_WAIT_MS = 200;

export function dashboardRoutes(d: AppDeps): Router {
  const router = Router();
  // Guard per route, not router.use: unknown paths must still fall through to the 404 page.
  const owner = requireOwner(d.sessions);

  /** What a page is, chosen by the caller (never from its title, which is translated): decides the lit tab, the back link and the crumb. */
  type PageKind = 'settings' | 'facts' | 'fact' | 'newFact' | 'notFound' | 'badRequest';
  const send = (res: Response, status: number, kind: PageKind, title: string, body: SafeHtml, back?: Back) => {
    const tab = kind === 'settings' ? 'settings' : kind === 'notFound' || kind === 'badRequest' ? null : 'facts';
    const fixed: BackTarget | undefined = kind === 'newFact' ? { href: '/facts', labelKey: 'shell.nav.facts' } : kind === 'settings' ? { href: '/', labelKey: 'shell.nav.projects' } : undefined;
    res.status(status).type('html').send(page(title, body, { nav: true, tab: back?.tab ?? tab, ...(kind === 'fact' && back?.tab !== 'inbox' ? { sideTab: 'facts' as const } : {}), back: back ?? fixed, crumb: kind === 'settings' ? false : undefined }));
  };
  const notFound = (res: Response) => send(res, 404, 'notFound', t('common.notFound'), html`<h1>${t('common.notFound')}</h1>`);
  const badRequest = (res: Response) => send(res, 400, 'badRequest', t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1>`);
  const activeMemory = (id: string): Memory | undefined => {
    const m = d.store.get(id);
    return m && !m.deletedAt ? m : undefined;
  };

  /** Runs an owner action. A MemoryError becomes `onError(error)`; a missing memory becomes a 404. */
  const attempt = async (res: Response, action: () => unknown, onError: (message: string, field?: FactField) => void): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      if (e.code === 'not_found') notFound(res);
      else onError(errorText(e), errorField(e));
      return false;
    }
  };

  const tidyItems = makeTidyItems(d);
  const inbox = makeInbox(d);
  const tidy = (res: Response, status = 200, error?: string) => inbox.tidy(res, status, error);
  const look = backLookups(d);
  /** After a tidy answer: a "Done." line on the next screen, then back to Tidy up, or to the Inbox when the card sat in its pane. */
  const tidyDone = (req: Request, res: Response, message = t('inbox.said.done')): void => {
    noteDecision(d.service, { id: 'tidy', at: d.now().getTime(), message });
    res.redirect(303, str(req, 'back') === 'inbox' ? '/approvals' : '/facts/tidy');
  };
  /** The origin a fact was opened from (its link's `from`, or the same field on its forms), kept only when `backFrom` accepts it. */
  const origin = (req: Request): { raw?: string; back?: Back } => {
    const v = req.method === 'GET' ? req.query.from : str(req, 'from');
    const raw = typeof v === 'string' && v !== '' ? v : undefined;
    const back = raw === undefined ? undefined : backFrom(raw, look);
    return back === undefined ? {} : { raw, back };
  };

  // ---- Home ----

  /** The Inbox (its own place): everything that waits, in one grouped list, with the first item (or the one asked for) beside it. */
  const approvals = (res: Response, status = 200, error?: string, notice?: string) => inbox.approvals(res, status, error, notice);

  // Settings › Version. The app: what update-check.json and update.json say (the shell writes them). A server: only
  // what the owner's last press of Check for updates answered, kept in memory.
  let serverCheck: { at: string; result: ReleaseResult } | null = null;
  const versionInput = (tooSoon = false): VersionPanelInput => {
    const base = { brain: BRAIN_VERSION, database: d.store.schemaVersion(), now: d.now() };
    if (!d.localMode) return { ...base, server: serverCheck, ...(tooSoon ? { tooSoon } : {}) };
    const check = d.statusDir ? readUpdateCheck(d.statusDir) : null;
    return { ...base, desktop: { check, problem: updateCheckProblem(check, d.now()), update: d.statusDir ? readUpdate(d.statusDir, BRAIN_VERSION) : null } };
  };

  // Settings › This computer: the space BrainAI uses here (the app only). Walked in the background, kept ten minutes.
  const spaceCache = new SpaceCache(() => computeSpace({
    dataDir: d.statusDir!, modelDir: d.space?.modelDir ?? join(d.statusDir!, 'models'), backupDir: d.backupDir, copyFolder: d.backupCopy?.folder() ?? null,
    execPath: d.space?.execPath, platform: d.space?.platform, localMode: true,
  }));
  const spaceOn = () => !!d.localMode && !!d.statusDir;

  /** Settings: the owner's device, connections, devices, backups and health, and their login. */
  const settings = async (req: Request, res: Response, status = 200, error?: string, created?: { name: string; token: string }, ask?: { folder: string; cloud: string }, tooSoon = false) => {
    const installedNow = d.localMode && d.models ? await d.models.installedIds() : [];
    const space = spaceOn() && !viaDoor(req) ? await spaceCache.get(SPACE_WAIT_MS) : undefined;
    const token = readCookie(req, SESSION_COOKIE);
    send(res, status, 'settings', t('shell.nav.settings'), settingsView({
      space,
      error,
      grants: d.provider.listGrants(),
      connStatus: connStatuses(d, d.provider.listGrants()),
      sessions: d.sessions.list(),
      currentSessionId: token ? d.sessions.idFor(token) : undefined,
      localMode: d.localMode,
      search: d.localMode && d.models ? { status: d.models.status(), installed: installedNow, keySaved: !!d.statusDir && readKey(d.statusDir) !== null, said: takeSearchSaid(), dataDir: d.statusDir } : undefined,
      projects: d.service.listProjects().map((p) => p.project),
      savesPausedSince: d.service.savesPausedSince(),
      version: { brain: BRAIN_VERSION, database: d.store.schemaVersion() },
      versionPanel: versionInput(tooSoon),
      brainUrl: d.publicUrl.origin,
      counts: { facts: KINDS.reduce((n, kind) => n + d.store.list({ kind }).length, 0), projects: d.registry.list().length, pages: d.pages.count() },
      pictures: d.images.totals(),
      devices: d.devices.list(),
      now: d.now(),
      device: deviceLabel(req.get('user-agent') ?? null),
      created,
      health: healthOf(d, d.now()),
      profile: profileHealth(d),
      quiet: { apps: quietAppsOf(d, d.now()), local: !!d.localMode },
      language: { choice: storedChoice(d.store.switchValue(UI_LANGUAGE_SWITCH)) },
      appearance: { choice: currentTheme() ?? 'auto' },
      coaching: { on: coachingOn(d.store) },
      weekNotice: d.localMode ? { on: weekNoticeOn(d.store) } : undefined,
      said: { backupNow: takeSettingsSaid('backup-now'), copy: takeSettingsSaid('backup-copy') },
      copy: d.localMode && d.backupCopy ? { keep: d.backupKeep ?? DEFAULT_BACKUP_KEEP, folder: d.backupCopy.folder(), last: d.backupCopy.lastResult(), ask, ...(pickedFolder(req) ? { picked: pickedFolder(req)! } : {}) } : undefined,
      reach: d.localMode ? { on: d.reach?.url() != null } : undefined,
      backupNow: d.localMode && !!d.db && !!d.backupDir && !!d.statusDir,
      backups: d.statusDir === undefined ? undefined : (() => {
        const status = readBackupStatus(d.statusDir);
        // The app makes only the daily backup (and the second folder's copy): the off-site, git and Markdown jobs are a
        // server's, so the app neither shows nor judges them.
        const server = !d.localMode;
        return { status, health: backupHealth(status, d.now(), { offsite: server, jobs: server }), offsite: server, jobs: server };
      })(),
    }));
  };


  /** A UNC or network share (\\server\share, //server/share): never a backup copy's folder (slow, and the checks below cannot vouch for it). */
  const isNetworkPath = (p: string): boolean => p.startsWith('\\\\') || p.startsWith('//');
  /** The folder the shell's picker just chose, from /settings?folder=…: only to fill the box (nothing is saved until Save). */
  const pickedFolder = (req: Request): string | undefined => {
    const f = d.localMode ? query(req, 'folder') : undefined;
    return f !== undefined && f.length <= 1000 && isAbsolute(f) && !isNetworkPath(f) && !/[\u0000-\u001f]/.test(f) ? f : undefined;
  };
  // Settings › Backups (the app): the second folder for the daily backups.
  // Through the public door this page does not exist.
  router.post('/settings/backup-copy', localRouteOnly, owner, (req, res, next) => {
    const copy = d.backupCopy;
    if (!d.localMode || !copy) return next();
    if (str(req, 'action') === 'off') { copy.set(null); saySettings('backup-copy', t('inbox.settings.copyOff')); return res.redirect(303, '/settings#backup-copy'); }
    const folder = str(req, 'folder').trim();
    const refuse = (why: string) => settings(req, res, 400, why);
    if (isNetworkPath(folder)) return refuse(t('inbox.settings.copyNetwork'));
    if (!isAbsolute(folder)) return refuse(t('inbox.settings.copyFull'));
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return refuse(t('inbox.settings.copyMissing', { folder }));
    const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    const inside = (child: string, parent: string) => { const r = relative(real(parent), real(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
    if (d.statusDir && inside(folder, d.statusDir)) return refuse(t('inbox.settings.copyInside'));
    const cloud = syncedCloud(folder, { home: d.tools?.home ?? homedir(), platform: d.tools?.platform ?? process.platform, env: { ...process.env, ...d.tools?.extraEnv } });
    if (cloud !== null && str(req, 'confirm') !== '1') return settings(req, res, 200, undefined, undefined, { folder, cloud });
    copy.set(folder);
    saySettings('backup-copy', t('inbox.settings.copySaved', { folder }));
    res.redirect(303, '/settings#backup-copy');
  });

  // Back up now (the app): the same backup the nightly run and the update make. The owner's session and the same-origin
  // check on every POST guard it; never through the public door; it only writes into the app's own backup folder.
  router.post('/settings/backup-now', localRouteOnly, owner, async (req, res, next) => {
    if (!d.localMode || !d.db || !d.backupDir || !d.statusDir) return next();
    const run = await runBackup(d.db, d.backupDir, d.backupKeep ?? DEFAULT_BACKUP_KEEP, d.now(), d.statusDir, d.backupCopy);
    if (run.ok) {
      saySettings('backup-now', t('inbox.settings.backedUp', { time: timeOfDay(d.now().toISOString()) }));
      return res.redirect(303, '/settings#health');
    }
    const clean = [d.statusDir, d.backupDir].reduce<string>((text, p) => text.replaceAll(p, t('inbox.settings.dataFolder')), run.error ?? t('inbox.settings.backupNoFinish'));
    return settings(req, res, 500, t('inbox.settings.backupFailed', { why: clean }));
  });
  // Check for updates. The app: the link /app/check-updates is taken by the shell (see below), which runs its normal check
  // and writes update-check.json; the page asks this route whether a newer check is in. A server: one request to GitHub,
  // only on this press (owner session and the same-origin check on every POST), at most one per CHECK_GAP_S.
  router.get('/settings/space', localRouteOnly, owner, (_req, res, next) => {
    if (!spaceOn()) return next();
    const s = spaceCache.peek();
    res.set('Cache-Control', 'no-store').json(s ? { ready: true, total: spaceTotalText(s), html: spaceBlock(s).value } : { ready: false });
  });
  router.get('/settings/version/state', localRouteOnly, owner, (_req, res, next) => {
    if (!d.localMode || !d.statusDir) return next();
    res.set('Cache-Control', 'no-store').json({ at: lastAttempt(readUpdateCheck(d.statusDir)) });
  });
  let lastServerCheckMs = 0;
  router.post('/settings/version/check', localRouteOnly, owner, async (req, res, next) => {
    if (d.localMode) return next();
    const nowMs = d.now().getTime();
    if (nowMs - lastServerCheckMs < CHECK_GAP_S * 1000) return settings(req, res, 429, undefined, undefined, undefined, true);
    lastServerCheckMs = nowMs;
    serverCheck = { at: d.now().toISOString(), result: await checkLatestRelease(BRAIN_VERSION, { url: d.releaseApiUrl, fetch: d.releaseFetch }) };
    res.redirect(303, '/settings#version');
  });
  // The shell (BrainAI's own window) takes these two links itself: the native folder picker and Show in Finder. In an
  // ordinary browser tab they land here instead, so the link never dead-ends.
  for (const path of ['/app/choose-folder', '/app/reveal-backups', '/app/check-updates']) {
    router.get(path, localRouteOnly, owner, (_req, res, next) => {
      if (!d.localMode) return next();
      res.type('html').send(page(t('inbox.settings.windowOnlyTitle'), html`<div class="narrow"><h1>${t('inbox.settings.windowOnlyH1')}</h1><p>${path === '/app/choose-folder' ? t('inbox.settings.windowFolder') : path === '/app/check-updates' ? t('inbox.settings.windowUpdates') : t('inbox.settings.windowReveal')}</p><p><a href="/settings#health">${t('inbox.settings.backToSettings')}</a></p></div>`, { nav: true, tab: null, back: { href: '/settings#health', labelKey: 'shell.nav.settings' } }));
    });
  }

  // A new device's token, kept until the page after the redirect shows it (once), so a reload never mints another.
  const justAdded = new Map<string, { name: string; token: string; at: number }>();
  const ADDED_MS = 10 * 60_000;
  router.get('/settings', owner, (req, res) => {
    const key = query(req, 'added');
    const added = key === undefined ? undefined : justAdded.get(key);
    if (key !== undefined) justAdded.delete(key);
    return settings(req, res, 200, undefined, added && Date.now() - added.at < ADDED_MS ? { name: added.name, token: added.token } : undefined);
  });
  // Settings › Devices: adding redirects to Settings, which shows the new token once.
  router.post('/settings/devices', owner, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    try {
      const { device, token } = d.devices.create(name);
      for (const [k, v] of justAdded) if (Date.now() - v.at >= ADDED_MS) justAdded.delete(k);
      const key = randomBytes(16).toString('base64url');
      justAdded.set(key, { name: device.name, token, at: Date.now() });
      res.redirect(303, `/settings?added=${key}#devices`);
    } catch (e) {
      return settings(req, res, 400, e instanceof Error ? e.message : t('inbox.settings.couldNotAddDevice'));
    }
  });
  router.post('/settings/devices/:id/revoke', owner, (req, res) => {
    d.devices.revoke(req.params.id as string);
    res.redirect(303, '/settings#devices');
  });
  // The old home page: its memory map is the Graph tab now, everything else is in Settings.
  router.get('/overview', owner, (req, res) => {
    const view = req.query.view;
    res.redirect(301, view === 'map' || view === 'globe' ? '/graph' : '/settings');
  });

  router.get('/approvals', owner, (req, res) => {
    inbox.approvalsPage(req, res);
  });

  router.post('/suggestions/:id/approve', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    // Answered on another device since this page was made: say so here, never a bare 404, and change nothing.
    if (!d.service.pendingSuggestions().some((s) => s.id === id)) return approvals(res, 400, alreadyAnswered());
    const content = str(req, 'content');
    const back = suggestionBack(str(req, 'back'));
    let skipped: { id: string; why: string }[] = [];
    const held = d.store.getSuggestion(id)!;
    let made: Memory | null = null;
    if (await attempt(res, async () => {
      const r = await d.service.approveSuggestionReport(id, content !== '' ? content : undefined);
      skipped = r.notReplaced;
      made = r.memory;
    }, (m) => approvals(res, 400, m))) {
      invalidateSideStatus();
      // Only a plain addition can be taken back cleanly (the fact it made goes again); a change, a deletion, a roadmap or
      // a replacement alters facts that were already there, so those are confirmed without Undo.
      const profile = held.kind === 'profile';
      const added = held.action === 'add' && held.kind !== 'roadmap' && held.supersedes.length === 0 && made !== null;
      const message = held.action === 'delete' ? (profile ? t('inbox.said.removedProfile') : t('inbox.said.removedMemory'))
        : held.action === 'update' ? (profile ? t('inbox.said.updatedProfile') : t('inbox.said.updatedMemory'))
        : profile ? t('inbox.said.addedProfile') : t('inbox.said.savedMemory');
      noteDecision(d.service, { id, at: d.now().getTime(), message, undo: added ? { kind: 'approve-add', memoryId: (made as unknown as Memory).id } : undefined });
      // Facts it could no longer replace are named on the page that loads; otherwise the approval is its own confirmation.
      const after = back === '/approvals' ? nextHref(str(req, 'next')) ?? back : back;
      if (skipped.length === 0) return res.redirect(303, after);
      const lead = t('inbox.said.skipped', { count: skipped.length });
      approvals(res, 200, undefined, `${lead} ${skipped.map((x) => x.why).join('; ')}`);
    }
  });

  router.post('/suggestions/:id/reject', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    if (!d.service.pendingSuggestions().some((s) => s.id === id)) return approvals(res, 400, alreadyAnswered());
    if (await attempt(res, () => d.service.rejectSuggestion(id), (m) => approvals(res, 400, m))) {
      invalidateSideStatus();
      noteDecision(d.service, { id, at: d.now().getTime(), message: t('inbox.said.rejected'), undo: { kind: 'reject-suggestion' } });
      const back = suggestionBack(str(req, 'back'));
      res.redirect(303, back === '/approvals' ? nextHref(str(req, 'next')) ?? back : back);
    }
  });

  // B1: Approve all / Reject all for one harvest (every item still waiting in it). Items already answered are skipped.
  for (const answer of ['approve', 'reject'] as const) {
    router.post(`/harvest/:batch/${answer}`, owner, async (req: Request, res) => {
      const batch = req.params.batch as string;
      if (d.service.harvestBatch(batch).length === 0) return approvals(res, 400, alreadyAnswered());
      const r = await d.service.answerHarvest(batch, answer);
      invalidateSideStatus();
      const flagged = r.flagged === 0 ? '' : ` ${t('inbox.harvest.flagged', { count: r.flagged })}`;
      const said = answer === 'approve' && r.flagged > 0 ? `${t('inbox.harvest.savedFlagged', { done: r.done })}${flagged}` : answer === 'approve' ? t('inbox.harvest.savedN', { count: r.done }) : t('inbox.harvest.rejectedN', { count: r.done });
      if (r.left.length > 0) return approvals(res, 200, undefined, t(answer === 'approve' ? 'inbox.harvest.leftSaved' : 'inbox.harvest.leftRejected', { said: said, count: r.left.length, why: [...new Set(r.left.map((x) => x.why))].join('; ') }));
      noteDecision(d.service, { id: batch, at: d.now().getTime(), message: said });
      // Flagged items still wait: stay on this harvest, where they are.
      res.redirect(303, r.flagged > 0 ? `/approvals?batch=${encodeURIComponent(batch)}` : '/approvals');
    });
  }

  // Undo for the answer just given in the Inbox: the same owner and same-origin protections as Approve (every browser POST),
  // only for the item just decided and only for UNDO_WINDOW_MS.
  router.post('/inbox/undo', owner, (req: Request, res) => {
    const id = str(req, 'id');
    const dec = undoable(d.service, id, d.now().getTime());
    if (!dec?.undo) return approvals(res, 400, t('inbox.said.cannotUndo'));
    try {
      if (dec.undo.kind === 'reject-suggestion') d.service.undoRejectSuggestion(id);
      else if (dec.undo.kind === 'approve-add') d.service.undoApprovedAdd(id, dec.undo.memoryId);
      else if (dec.undo.kind === 'tidy-approved') d.tidy.undoApproved(id);
      else if (dec.undo.kind === 'tidy-rejected') d.tidy.reopenRejected(id);
      else d.skills.reopenRejected(id);
    } catch (e) {
      if (!(e instanceof MemoryError || e instanceof SkillError || e instanceof TidyError)) throw e;
      return approvals(res, 400, errorText(e));
    }
    invalidateSideStatus();
    noteDecision(d.service, { id, at: d.now().getTime(), message: t('inbox.said.undone') });
    res.redirect(303, '/approvals');
  });

  // ---- Browse, search, create ----

  router.get('/memories', owner, (req, res) => {
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    res.redirect(301, `/facts${qs ? `?${qs}` : ''}`);
  });
  router.get('/facts', owner, async (req, res) => {
    const kindParam = query(req, 'kind');
    const kind = KINDS.find((k) => k === kindParam) as Kind | undefined;
    const project = query(req, 'project');
    const q = query(req, 'q');
    const pageNo = Math.max(1, Math.trunc(Number(query(req, 'page'))) || 1);
    const showParam = query(req, 'show');
    const show: FactsShow = showParam === 'replaced' || showParam === 'everything' ? showParam : 'current';
    // The facts with no project: the leftover group of the grouped view has no project of its own.
    const noneProject = project === NO_PROJECT && d.service.projectNamed(NO_PROJECT) === undefined;
    const filter = { kind, project: noneProject ? NO_PROJECT : project, q };
    // The grouped view is the plain page: a filter at all (an empty one is no filter) asks for the flat list.
    const grouped = q === undefined && kind === undefined && project === undefined && show === 'current' && pageNo === 1;
    const factsBack: Back | undefined = project && !noneProject ? { href: `/?project=${encodeURIComponent(d.service.projectNamed(project))}#panel`, label: d.service.projectNamed(project), tab: 'facts' } : kind || q || show !== 'current' || pageNo > 1 || noneProject ? { href: '/facts', labelKey: 'shell.nav.facts', tab: 'facts' } : undefined;
    const factsSend = (body: SafeHtml) => send(res, 200, 'facts', t('shell.nav.facts'), body, factsBack);
    const now = d.now();
    const counts = { all: d.store.countCurrent(), profile: d.store.countCurrent({ kind: 'profile' }), replaced: d.store.supersessions.replacedCount({}) };
    const common = { counts, tidy: tidySentence(tidySummary(tidyItems())), from: req.originalUrl };
    /** A replaced search hit as a card: the fact, the one that replaced it, and whether that one was replaced too. */
    const asItem = (m: Memory): ReplacedItem | undefined => {
      const rep = d.service.replacement(m.id);
      const next = rep ? d.store.get(rep.row.newId) : undefined;
      return rep && next ? { row: rep.row, old: m, next, nextReplaced: d.store.supersessions.liveFor(next.id) !== undefined } : undefined;
    };
    if (q !== undefined) {
      if (show === 'current') {
        const found = await d.service.recall({ query: q, kind, project, limit: SEARCH_LIMIT });
        return factsSend(listView({ items: found.map((f) => f.memory), filter, page: 1, hasNext: false, show, now, ...common }));
      }
      // The header search's rule: replaced hits that rank within the joint top of the results. Replaced only marks
      // nothing as recalled, because no current fact is shown.
      const found = await d.service.recall({ query: q, kind, project, limit: SEARCH_LIMIT, replaced: 'include', replacedCut: 'joint-top', replacedLimit: SEARCH_LIMIT, touch: show === 'everything' });
      const replaced = found.filter((f) => f.replaced).map((f) => asItem(f.memory)).filter((x): x is ReplacedItem => x !== undefined);
      const items = show === 'everything' ? found.filter((f) => !f.replaced).map((f) => f.memory) : [];
      return factsSend(listView({ items, replaced, filter, page: 1, hasNext: false, show, now, ...common }));
    }
    if (grouped) {
      // The plain page: every current fact, grouped by project, each group showing its newest few.
      const groups = groupFacts(d.store.list({ limit: -1 }), 5);
      return factsSend(listView({ items: [], groups, projects: d.service.listProjects().map((p) => p.project), filter, page: 1, hasNext: false, show, now, ...common }));
    }
    if (show === 'replaced') {
      const replaced = d.store.supersessions.replacedList({ kind, project, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
      const total = d.store.supersessions.replacedCount({ kind, project });
      return factsSend(listView({ items: [], replaced, replacedTotal: total, filter, page: pageNo, hasNext: pageNo * PAGE_SIZE < total, show, now, ...common }));
    }
    const rows = noneProject
      ? d.store.list({ kind, limit: -1, replaced: show === 'everything' ? 'include' : 'hide' }).filter((m) => m.project === null).slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE + 1)
      : d.store.list({ kind, project, limit: PAGE_SIZE + 1, offset: (pageNo - 1) * PAGE_SIZE, replaced: show === 'everything' ? 'include' : 'hide' });
    const items = rows.slice(0, PAGE_SIZE);
    const replacedIds = show === 'everything' ? new Set(items.filter((m) => d.store.supersessions.liveFor(m.id)).map((m) => m.id)) : undefined;
    factsSend(listView({ items, filter, page: pageNo, hasNext: rows.length > PAGE_SIZE, show, replacedIds, now, ...common }));
  });

  router.get('/memories/new', owner, (req, res) =>
    send(res, 200, 'newFact', t('inbox.facts.newFact'), newView({ kind: 'decision', content: '', project: query(req, 'project') ?? '', tags: '' })));

  router.post('/memories', owner, async (req: Request, res) => {
    const values = formValues(req, str(req, 'kind'));
    let id = '';
    const ok = await attempt(res, async () => {
      const r = await d.service.remember({
        kind: values.kind as Kind, content: values.content, project: values.project || undefined, tags: tagList(values.tags), keys: values.keys,
        meta: newMeta(values),
      }, OWNER);
      if (r.status === 'saved' || r.status === 'roadmap_updated') id = r.memory.id;
    }, (m, field) => send(res, 400, 'newFact', t('inbox.facts.newFact'), newView({ ...values, errorField: field }, m)));
    if (ok) res.redirect(303, `/memories/${id}`);
  });

  // ---- One memory ----

  /** A fact's page, with what section 16 adds: its replacements and, on a current fact, the owner's picker. `from` is an origin `backFrom` already accepted. */
  const detail = (res: Response, m: Memory, status = 200, values = valuesOf(m), error?: string, pickAll = false, open?: 'edit' | 'history' | 'picker', selectedBy?: string, from?: string) =>
    send(res, status, 'fact', t('shell.back.fact'), detailView(m, d.store.history(m.id), values, error, {
      story: factStory(d.store, m.id), picker: d.service.pickerChoices(m.id, pickAll), pickAll, now: d.now(), open, selectedBy,
      where: {
        project: m.project === null ? null : d.service.projectNamed(m.project),
        pages: m.project === null ? [] : d.pages.forProject(d.service.projectNamed(m.project)).map((p) => ({ id: p.id, title: p.title })),
        discussion: d.discussions.decidedIn(m.id),
      },
      from,
    }), (from !== undefined ? backFrom(from, look) : undefined) ?? factBackDefault(m, look));

  router.get('/memories/:id', owner, (req, res) => {
    const m = d.store.get(req.params.id as string);
    // Desktop only (desk.js): the side fragment beside the fact sheet, Near it.
    if (req.query.pane === 'side') {
      if (!m) return res.status(404).set('Cache-Control', 'no-store').end();
      return res.set('Cache-Control', 'no-store').type('html').send(deskSideView({ near: nearIt(d, m), self: `/memories/${m.id}` }).value);
    }
    if (!m) return notFound(res);
    detail(res, m, 200, valuesOf(m), undefined, req.query.pick === 'all', undefined, undefined, origin(req).raw);
  });

  // The owner's picker: the fact picked as the one that holds now replaces this one.
  router.post('/memories/:id/supersede', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    const m = activeMemory(id);
    if (!m) return notFound(res);
    const by = str(req, 'by');
    const pickAll = str(req, 'pick') === 'all';
    const o = origin(req);
    if (by === '') return detail(res, m, 400, valuesOf(m), t('inbox.facts.pickHolds'), pickAll, 'picker', undefined, o.raw);
    try {
      d.service.supersede([id], by, OWNER);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return detail(res, m, 400, valuesOf(m), errorText(e), pickAll, 'picker', by, o.raw);
    }
    res.redirect(303, withFrom(`/memories/${id}`, o.raw));
  });

  // Undo a replacement: the old fact comes back. `back` picks where to go next; anything else is the fact's page.
  router.post('/supersessions/:id/undo', owner, async (req: Request, res) => {
    const rowId = /^\d{1,15}$/.test(req.params.id as string) ? Number(req.params.id) : NaN;
    const row = Number.isSafeInteger(rowId) ? d.store.supersessions.get(rowId) : undefined;
    if (!row) return notFound(res);
    const old = d.store.get(row.oldId);
    if (!old) return notFound(res);
    const o = origin(req);
    if (await attempt(res, () => d.service.undoSupersession(row.id, OWNER), (msg) => detail(res, d.store.get(row.oldId)!, 400, valuesOf(old), msg, false, str(req, 'part') === 'history' ? 'history' : undefined, undefined, o.raw))) {
      const back = str(req, 'back');
      const project = old.project === null ? null : d.service.projectNamed(old.project);
      if (back === 'tidy' || back === 'inbox') return tidyDone(req, res);
      res.redirect(303, back === 'panel' && project !== null ? `/?project=${encodeURIComponent(project)}#panel`
        : back === 'facts' ? '/facts?show=replaced' : withFrom(`/memories/${old.id}`, o.raw));
    }
  });

  router.post('/memories/:id', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    const m = activeMemory(id);
    if (!m) return notFound(res);
    const values = formValues(req, m.kind);
    const o = origin(req);
    // A12: the date and the source come from the same form. Only a field the owner changed from what the form was
    // opened with is saved (an assistant's change to another field meanwhile stays), and taking the source away takes
    // its note with it. A form with no record of what it was opened with sends every field it has.
    const changed = (now: string | undefined, orig: string | undefined): now is string => now !== undefined && (orig === undefined || now.trim() !== orig.trim());
    // The source select shows an assistant-set source as its own "keep" option: that is no change. Picking a source
    // on purpose, even the one already there, makes it the owner's.
    const keepSource = values.source === 'keep';
    const sourceVal: string | undefined = keepSource ? values.origSource : values.source;
    const assistantSet = m.source !== null && m.sourceBy !== null && m.sourceBy !== 'owner';
    const dateChanged = changed(values.validUntil, values.origValidUntil);
    const sourceChanged = !keepSource && (changed(sourceVal, values.origSource) || (assistantSet && (sourceVal ?? '').trim() !== ''));
    const noteChanged = changed(values.sourceNote, values.origSourceNote);
    const meta = {
      validUntil: dateChanged ? values.validUntil!.trim() : undefined,
      source: sourceChanged ? (sourceVal ?? '').trim() : undefined,
      sourceNote: sourceChanged && (sourceVal ?? '').trim() === '' ? '' : noteChanged ? values.sourceNote : undefined,
    };
    // A change the owner made to a field that someone else changed meanwhile is not applied: show what it is now.
    const was = { validUntil: m.validUntil ?? '', source: m.source ?? '', sourceNote: m.sourceNote ?? '' };
    const clash = [
      dateChanged && values.origValidUntil !== undefined && was.validUntil !== values.origValidUntil.trim() ? t('inbox.facts.clashDate') : '',
      sourceChanged && values.origSource !== undefined && was.source !== values.origSource.trim() ? t('inbox.facts.clashSource') : '',
      noteChanged && values.origSourceNote !== undefined && was.sourceNote !== values.origSourceNote.trim() ? t('inbox.facts.clashNote') : '',
    ].filter((x) => x !== '');
    if (clash.length > 0) {
      const by = m.updatedBy === 'owner' ? t('inbox.youLower') : m.updatedBy;
      const nowReads = [m.validUntil ? t('inbox.facts.nowValid', { date: m.validUntil }) : t('inbox.facts.nowNoDate'), m.source ? (m.sourceBy ? t('inbox.facts.nowSourceBy', { source: m.source, by: m.sourceBy }) : t('inbox.facts.nowSource', { source: m.source })) : t('inbox.facts.nowNoSource')].join(', ');
      return detail(res, m, 409, { ...values, source: keepSource ? 'keep' : values.source, sourceBy: m.sourceBy, base: m.updatedAt, origValidUntil: was.validUntil, origSource: was.source, origSourceNote: was.sourceNote },
        t('inbox.facts.clash', { what: clash.reduce((a, b) => t('inbox.facts.clashJoin', { a, b })), now: nowReads, by: by }), false, 'edit', undefined, o.raw);
    }
    if (await attempt(res, () => d.service.update(id, { content: values.content, project: values.project || null, tags: tagList(values.tags), keys: values.keys, meta }, OWNER, { base: values.base }),
      (msg, field) => {
        // Saved by someone else since this page was opened: show what it says now, keep the draft, and let a second
        // Save (from this page, with the current text in view) go through.
        const now = d.store.get(id);
        if (values.base && now && !now.deletedAt && now.updatedAt !== values.base) {
          const by = now.updatedBy === 'owner' ? t('inbox.youLower') : now.updatedBy;
          return detail(res, now, 409, { ...values, base: now.updatedAt },
            t('inbox.facts.changedSince', { by: by, time: now.updatedAt.slice(0, 16).replace('T', ' '), text: now.content }), false, 'edit', undefined, o.raw);
        }
        detail(res, m, 400, { ...values, errorField: field }, msg, false, 'edit', undefined, o.raw);
      })) {
      res.redirect(303, withFrom(`/memories/${id}`, o.raw));
    }
  });

  router.post('/memories/:id/delete', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    const m = d.store.get(id);
    if (!m || m.deletedAt !== null) return notFound(res);
    if (await attempt(res, () => d.service.forget(id, OWNER), () => badRequest(res))) {
      // With no `back` of its own, Delete goes to the back target itself, never to the deleted fact's page.
      const back = str(req, 'back');
      const o = origin(req);
      if (back === 'tidy' || back === 'inbox') return tidyDone(req, res);
      res.redirect(303, back === 'home' ? '/' : o.back?.href ?? factBackDefault(m, look).href);
    }
  });

  // Tidy-up "Past its date": a new date, or none ("Still true": the date is cleared). Same protections as any fact edit.
  router.post('/memories/:id/valid-until', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    if (!activeMemory(id)) return notFound(res);
    if (await attempt(res, () => d.service.update(id, { meta: { validUntil: str(req, 'valid_until').trim() } }, OWNER), (msg) => tidy(res, 400, msg))) {
      tidyDone(req, res);
    }
  });

  router.post('/memories/:id/confirm', owner, (req: Request, res) => {
    const id = req.params.id as string;
    if (!activeMemory(id)) return notFound(res);
    d.store.touch(id);
    tidyDone(req, res);
  });

  router.post('/history/:hid/undo', owner, async (req: Request, res) => {
    const hid = /^\d+$/.test(req.params.hid as string) ? Number(req.params.hid) : NaN;
    const entry = Number.isSafeInteger(hid) ? d.store.historyEntry(hid) : undefined;
    if (!entry) return notFound(res);
    const o = origin(req);
    if (await attempt(res, () => d.service.undo(hid, OWNER), (msg) => {
      const m = d.store.get(entry.memoryId);
      if (m) detail(res, m, 400, valuesOf(m), msg, false, 'history', undefined, o.raw); else notFound(res);
    })) {
      if (str(req, 'back') === 'tidy' || str(req, 'back') === 'inbox') return tidyDone(req, res);
      res.redirect(303, withFrom(`/memories/${entry.memoryId}`, o.raw));
    }
  });

  // ---- Weekly digest ----

  // The old weekly digest's address: a 302, so /week stays free to reuse later (a 301 would be cached).
  router.get('/week', owner, (req, res) => {
    const asked = weekContaining(query(req, 'week') ?? '');
    res.redirect(302, asked && asked.monday < weekOf(d.now()).monday ? `/review/${asked.monday}` : '/review/now');
  });

  // ---- What's left: replaced by the Projects home ----

  router.get('/left', owner, (req, res) => {
    const project = query(req, 'project');
    res.redirect(301, project ? `/?project=${encodeURIComponent(project)}#panel` : '/');
  });

  // ---- Tidy up ----

  router.get('/facts/tidy', owner, (req, res) => inbox.tidy(res, 200, undefined, typeof req.query.item === 'string' && req.query.item !== '' ? req.query.item : undefined));
  router.get('/settings/tidy', owner, (_req, res) => res.redirect(301, '/facts/tidy'));

  // "Newer replaces older" on a duplicate pair. Two decisions stay a dismissed pair, so an undo doesn't bring the pair
  // back to Possible duplicates; replacing a status never touches dismissed pairs.
  router.post('/tidy/duplicates/supersede', owner, async (req: Request, res) => {
    const older = str(req, 'older');
    const newer = str(req, 'newer');
    if (await attempt(res, () => {
      d.service.supersede([older], newer, OWNER);
      const a = d.store.get(older)!;
      const b = d.store.get(newer)!;
      if (replaceableKind(a) === 'decision' && replaceableKind(b) === 'decision') d.store.dismissPair(older, newer);
    }, (msg) => tidy(res, 400, msg))) tidyDone(req, res);
  });

  // "Replaced by the latest" on an older status of a project with several.
  router.post('/tidy/statuses/supersede', owner, async (req: Request, res) => {
    if (await attempt(res, () => d.service.supersede([str(req, 'id')], str(req, 'latest'), OWNER), (msg) => tidy(res, 400, msg))) {
      tidyDone(req, res);
    }
  });
  router.get('/tidy', owner, (_req, res) => res.redirect(301, '/facts/tidy'));

  router.post('/tidy/statuses/keep', owner, (req: Request, res) => {
    const project = str(req, 'project');
    if (project === '') return badRequest(res);
    keepStatuses(d.store, project);
    tidyDone(req, res);
  });

  router.post('/tidy/projects/move', owner, async (req: Request, res) => {
    if (await attempt(res, () => d.service.moveProject(str(req, 'from'), str(req, 'to'), OWNER), () => badRequest(res))) {
      tidyDone(req, res);
    }
  });

  router.post('/tidy/projects/different', owner, (req: Request, res) => {
    const a = str(req, 'a');
    const b = str(req, 'b');
    if (a === '' || b === '' || a === b) return badRequest(res);
    d.store.dismissProjects(a, b);
    tidyDone(req, res);
  });

  router.post('/duplicates/merge', owner, async (req: Request, res) => {
    const keep = str(req, 'keep');
    const drop = str(req, 'drop');
    if (keep === '' || drop === '' || keep === drop) return badRequest(res);
    if (!activeMemory(keep) || !activeMemory(drop)) return notFound(res);
    d.service.forget(drop, OWNER);
    tidyDone(req, res);
  });

  router.post('/duplicates/keep-both', owner, (req: Request, res) => {
    const a = str(req, 'a');
    const b = str(req, 'b');
    if (a === '' || b === '' || a === b) return badRequest(res);
    if (!d.store.get(a) || !d.store.get(b)) return notFound(res);
    d.store.dismissPair(a, b);
    tidyDone(req, res);
  });

  // ---- Clients and devices ----

  router.get('/clients', owner, (_req, res) => res.redirect(301, '/settings#connections'));


  router.post('/clients/:grantId/access', owner, (req: Request, res) => {
    const id = req.params.grantId as string;
    if (!d.provider.listGrants().some((g) => g.id === id)) return notFound(res);
    const access = str(req, 'access');
    if (access !== 'full' && access !== 'discussions' && access !== 'projects') return badRequest(res);
    const projects = access === 'projects' ? pickedProjects(req.body, d.service.listProjects().map((p) => p.project)) : undefined;
    if (access === 'projects' && !projects) {
      return send(res, 400, 'badRequest', t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${t('auth.consent.pickProject')}</p><p><a href="/settings#connections">${t('inbox.settings.backToSettings')}</a></p>`);
    }
    try {
      d.provider.setGrantAccess(id, access, projects);
    } catch (e) {
      if (!(e instanceof InvalidNameError)) throw e;
      // Another live connection has this name at the new level: rename one of them first.
      return send(res, 400, 'badRequest', t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${e.message}</p><p><a href="/settings#connections">${t('inbox.settings.backToSettings')}</a></p>`);
    }
    res.redirect(303, '/settings#connections');
  });

  // C2: "Saves wait for me" for one connection.
  router.post('/clients/:grantId/saves-wait', owner, (req: Request, res) => {
    const id = req.params.grantId as string;
    if (!d.provider.listGrants().some((g) => g.id === id)) return notFound(res);
    d.provider.setGrantSavesWait(id, str(req, 'wait') === '1');
    res.redirect(303, '/settings#connections');
  });

  // C2: the global pause. The banner's Resume comes back to the page it was on (a same-site Referer), else to Settings.
  const backToPage = (req: Request): string => {
    try {
      const u = new URL(req.get('referer') ?? '', d.publicUrl);
      const here = new URL(`${req.protocol}://${req.get('host') ?? ''}`);
      if (u.host === here.host && !u.pathname.startsWith('//') && !u.pathname.startsWith('/\\') && u.pathname !== '/settings/pause' && u.pathname !== '/settings/pause/resume') return `${u.pathname}${u.search}${u.hash}`;
    } catch { /* no usable Referer */ }
    return '/settings#connections';
  };
  router.post('/settings/pause', owner, (_req: Request, res) => {
    d.service.setSavesPaused(true);
    res.redirect(303, '/settings#connections');
  });
  router.post('/settings/pause/resume', owner, (req: Request, res) => {
    d.service.setSavesPaused(false);
    res.redirect(303, backToPage(req));
  });

  // Settings › Language: the owner's choice (auto, en, es) in brain_switches. The app also writes it where the desktop shell reads it.
  router.post('/settings/language', owner, (req: Request, res) => {
    const choice = str(req, 'language');
    if (!isUiLanguage(choice)) return badRequest(res);
    d.store.setSwitch(UI_LANGUAGE_SWITCH, choice);
    if (d.localMode && d.statusDir) {
      try { writeUiLanguageFile(d.statusDir, choice, d.now()); } catch (e) { console.error('writing ui-language.json failed:', e); }
    }
    res.redirect(303, '/settings#language');
  });

  // Settings › Appearance: this browser's look (Automatic, Light, Dark) in the `theme` cookie, never in the brain. With scripts theme.js sets the same cookie without this trip.
  router.post('/settings/theme', owner, (req: Request, res) => {
    const choice = str(req, 'theme');
    if (!isThemeChoice(choice)) return badRequest(res);
    const options = { path: '/', sameSite: 'lax' as const };
    if (choice === 'auto') res.clearCookie(THEME_COOKIE, options);
    else res.cookie(THEME_COOKIE, choice, { ...options, maxAge: THEME_COOKIE_MAX_AGE });
    res.redirect(303, '/settings#appearance');
  });

  // Settings › Developer coaching: a brain-wide switch (brain_switches). Off hides the growth and learning parts; nothing is deleted.
  router.post('/settings/coaching', owner, (req: Request, res) => {
    d.store.setSwitch(COACHING_SWITCH, str(req, 'coaching') === 'on' ? 'on' : null);
    res.redirect(303, '/settings#coaching');
  });

  // Settings › Appearance (desktop app only): the Monday notification switch. Stored as 'off'; no row means on.
  router.post('/settings/week-notice', owner, (req: Request, res) => {
    if (!d.localMode) return notFound(res);
    d.store.setSwitch(WEEK_NOTICE_SWITCH, str(req, 'weekNotice') === 'on' ? null : 'off');
    res.redirect(303, '/settings#appearance');
  });

  router.post('/clients/:grantId/name', owner, (req: Request, res) => {
    const grant = d.provider.listGrants().find((g) => g.id === (req.params.grantId as string));
    if (!grant) return notFound(res);
    try {
      d.provider.setGrantName(grant.id, str(req, 'name'));
    } catch (e) {
      if (!(e instanceof InvalidNameError)) throw e;
      return send(res, 400, 'badRequest', t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${e.message}</p><p><a href="/settings#connections">${t('inbox.settings.backToSettings')}</a></p>`);
    }
    res.redirect(303, '/settings#connections');
  });

  router.post('/clients/:grantId/revoke', owner, (req: Request, res) => {
    const id = req.params.grantId as string;
    if (!d.provider.listGrants().some((g) => g.id === id)) return notFound(res);
    d.provider.revokeGrant(id);
    // Claude's desktop app keeps its key in a file: a revoked key is no use there, so the file goes too.
    if (d.localMode && d.statusDir) {
      const file = join(d.statusDir, BRIDGE_KEY_FILE);
      try { if ((JSON.parse(readFileSync(file, 'utf8')) as { grant?: unknown }).grant === id) rmSync(file, { force: true }); } catch { /* no key file */ }
    }
    res.redirect(303, '/settings#connections');
  });

  router.post('/sessions/:id/revoke', owner, (req: Request, res) => {
    const id = req.params.id as string;
    const token = readCookie(req, SESSION_COOKIE);
    d.sessions.revoke(id);
    if (token && d.sessions.idFor(token) === undefined) {
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(d.publicUrl));
      // This device logged itself out: the one logout, as POST /logout (pictures and drawn diagrams go too).
      res.set('Clear-Site-Data', '"cache", "storage"');
      return res.redirect(302, '/login');
    }
    res.redirect(303, '/settings#login');
  });

  return router;
}
