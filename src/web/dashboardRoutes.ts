import { healthOf } from './healthData.js';
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { InvalidNameError } from '../auth/clientsStore.js';
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import { connStatuses } from './connStatus.js';
import { BRAIN_VERSION } from '../version.js';
import { weekContaining, weekOf } from '../memory/digest.js';
import { makeTidyItems, tidySentence, tidySummary } from './tidyItems.js';
import { keepStatuses } from '../memory/tidy.js';
import { MemoryError } from '../memory/service.js';
import { factStory } from '../memory/factStory.js';
import { replaceableKind } from '../memory/supersessions.js';
import { KINDS, type Kind, type Memory } from '../memory/types.js';
import type { AppDeps } from './app.js';
import { PICK_A_PROJECT, pickedProjects, readCookie, requireOwner, SESSION_COOKIE, sessionCookieOptions } from './authRoutes.js';
import {
  detailView, listView, newView, PAGE_SIZE, tidyView, valuesOf,
  type FactsShow, type MemoryFormValues, type ReplacedItem,
} from './dashboardViews.js';
import { deviceLabel } from './deviceLabel.js';
import { FACT_RESULTS } from './searchRoutes.js';
import { settingsView } from './settingsViews.js';
import { html, page, type SafeHtml } from './html.js';
import { backFrom, factBackDefault, suggestionBack, withFrom, type Back } from './back.js';
import { backLookups } from './backLookups.js';
import { ALREADY_ANSWERED, approvalsView } from './approvalsViews.js';
import { invalidateSideStatus } from './sideStatus.js';
import { deskSideView, nearIt, nextForYou, profileToday } from './deskSide.js';

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
const formValues = (req: Request, kind: string): MemoryFormValues =>
  ({ kind, content: str(req, 'content'), project: str(req, 'project').trim(), tags: str(req, 'tags'), base: str(req, 'base') || undefined });
const tagList = (raw: string): string[] => raw.split(/[\s,]+/).filter((t) => t !== '');

export function dashboardRoutes(d: AppDeps): Router {
  const router = Router();
  // Guard per route, not router.use: unknown paths must still fall through to the 404 page.
  const owner = requireOwner(d.sessions);

  const send = (res: Response, status: number, title: string, body: SafeHtml, back?: Back) => {
    const tab = title === 'Settings' ? 'settings' : title === 'Not found' || title === 'Bad request' ? null : 'pages';
    const fixed = title === 'Tidy up' ? { href: '/facts', label: 'Facts' } : title === 'Moved from Outline' ? { href: '/pages', label: 'Pages' } : title === 'New fact' ? { href: '/facts', label: 'Facts' } : title === 'Settings' ? { href: '/', label: 'Projects' } : undefined;
    const section = ['Facts', 'Fact', 'Tidy up', 'New fact'].includes(title) ? 'facts' as const : undefined;
    res.status(status).type('html').send(page(title, body, { nav: true, tab: back?.tab ?? tab, section, back: back ?? fixed, crumb: title === 'Settings' ? false : undefined }));
  };
  const notFound = (res: Response) => send(res, 404, 'Not found', html`<h1>Not found</h1>`);
  const badRequest = (res: Response) => send(res, 400, 'Bad request', html`<h1>Bad request</h1>`);
  const activeMemory = (id: string): Memory | undefined => {
    const m = d.store.get(id);
    return m && !m.deletedAt ? m : undefined;
  };

  /** Runs an owner action. A MemoryError becomes `onError(error)`; a missing memory becomes a 404. */
  const attempt = async (res: Response, action: () => unknown, onError: (message: string) => void): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      if (e.code === 'not_found') notFound(res);
      else onError(e.message);
      return false;
    }
  };

  const tidyItems = makeTidyItems(d);
  const tidy = (res: Response, status = 200, error?: string) => send(res, status, 'Tidy up', tidyView(tidyItems(), error, d.now()));
  const look = backLookups(d);
  /** The origin a fact was opened from (its link's `from`, or the same field on its forms), kept only when `backFrom` accepts it. */
  const origin = (req: Request): { raw?: string; back?: Back } => {
    const v = req.method === 'GET' ? req.query.from : str(req, 'from');
    const raw = typeof v === 'string' && v !== '' ? v : undefined;
    const back = raw === undefined ? undefined : backFrom(raw, look);
    return back === undefined ? {} : { raw, back };
  };

  // ---- Home ----

  /** Every held suggestion as a full card, for the For-you sheet and the Approvals page. */
  const pendingCards = () => d.service.pendingSuggestions().map((suggestion) => ({
    suggestion,
    current: suggestion.memoryId ? d.store.get(suggestion.memoryId)?.content : undefined,
    replaces: suggestion.supersedes.map((id) => d.store.get(id)).filter((m): m is Memory => m !== undefined && m.deletedAt === null),
    deleted: suggestion.deletedMatch ? d.store.get(suggestion.deletedMatch) : undefined,
  }));

  /** Approvals (lit Projects): the list, or its message when an approval was refused or answered elsewhere. */
  const approvals = (res: Response, status = 200, error?: string, notice?: string) =>
    send(res, status, 'Approvals', approvalsView({ pending: pendingCards(), proposals: d.skills.pendingProposals().map((proposal) => ({ proposal, current: proposal.skillId ? d.skills.get(proposal.skillId) : undefined })), error, notice }), { href: '/', label: 'Projects', tab: 'projects' });

  /** Settings: the owner's device, connections, devices, backups and health, and their login. */
  const settings = (req: Request, res: Response, status = 200, error?: string, created?: { name: string; token: string }) => {
    const token = readCookie(req, SESSION_COOKIE);
    send(res, status, 'Settings', settingsView({
      error,
      grants: d.provider.listGrants(),
      connStatus: connStatuses(d, d.provider.listGrants()),
      sessions: d.sessions.list(),
      currentSessionId: token ? d.sessions.idFor(token) : undefined,
      work: d.mode === 'work',
      localMode: d.localMode,
      projects: d.service.listProjects().map((p) => p.project),
      version: { brain: BRAIN_VERSION, database: d.store.schemaVersion() },
      brainUrl: d.publicUrl.origin,
      counts: { facts: KINDS.reduce((n, kind) => n + d.store.list({ kind }).length, 0), projects: d.registry.list().length, pages: d.pages.count() },
      pictures: d.images.totals(),
      devices: d.devices.list(),
      now: d.now(),
      device: deviceLabel(req.get('user-agent') ?? null),
      created,
      health: healthOf(d, d.now()),
      backups: d.statusDir === undefined ? undefined : (() => {
        const status = readBackupStatus(d.statusDir);
        // The work copy's backups go to OneDrive, outside the house already: no separate off-site copy.
        // The work copy's backups go to OneDrive, and it has no git copy or Markdown export of its own.
        return { status, health: backupHealth(status, d.now(), { offsite: d.mode !== 'work', jobs: d.mode !== 'work' }), offsite: d.mode !== 'work', jobs: d.mode !== 'work' };
      })(),
    }));
  };


  // A new device's token, kept until the page after the redirect shows it (once), so a reload never mints another.
  const justAdded = new Map<string, { name: string; token: string; at: number }>();
  const ADDED_MS = 10 * 60_000;
  router.get('/settings', owner, (req, res) => {
    const key = query(req, 'added');
    const added = key === undefined ? undefined : justAdded.get(key);
    if (key !== undefined) justAdded.delete(key);
    settings(req, res, 200, undefined, added && Date.now() - added.at < ADDED_MS ? { name: added.name, token: added.token } : undefined);
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
      settings(req, res, 400, e instanceof Error ? e.message : 'Could not add the device');
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
    // Desktop only (desk.js): the side fragment beside the approval sheet, which shows one suggestion (?id=, else the
    // first): Next for you, and Your profile today when that suggestion is a pending profile one.
    if (req.query.pane === 'side') {
      const id = typeof req.query.id === 'string' ? req.query.id : undefined;
      const pending = d.service.pendingSuggestions();
      const s = id === undefined ? pending[0] : pending.find((x) => x.id === id);
      return res.type('html').send(deskSideView({ next: nextForYou(d, { kind: 'approval', id: s?.id ?? id }), profile: s ? profileToday(d, s) : null }).value);
    }
    approvals(res);
  });

  router.post('/suggestions/:id/approve', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    // Answered on another device since this page was made: say so here, never a bare 404, and change nothing.
    if (!d.service.pendingSuggestions().some((s) => s.id === id)) return approvals(res, 400, ALREADY_ANSWERED);
    const content = str(req, 'content');
    const back = suggestionBack(str(req, 'back'));
    let skipped: { id: string; why: string }[] = [];
    if (await attempt(res, async () => {
      skipped = (await d.service.approveSuggestionReport(id, content !== '' ? content : undefined)).notReplaced;
    }, (m) => approvals(res, 400, m))) {
      invalidateSideStatus();
      // Facts it could no longer replace are named on the page that loads; otherwise the approval is its own confirmation.
      if (skipped.length === 0) return res.redirect(303, back);
      const lead = skipped.length === 1 ? 'Approved. 1 fact was not replaced:' : `Approved. ${skipped.length} facts were not replaced:`;
      approvals(res, 200, undefined, `${lead} ${skipped.map((x) => x.why).join('; ')}`);
    }
  });

  router.post('/suggestions/:id/reject', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    if (!d.service.pendingSuggestions().some((s) => s.id === id)) return approvals(res, 400, ALREADY_ANSWERED);
    if (await attempt(res, () => d.service.rejectSuggestion(id), (m) => approvals(res, 400, m))) {
      invalidateSideStatus();
      res.redirect(303, suggestionBack(str(req, 'back')));
    }
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
    const filter = { kind, project, q };
    const factsBack: Back | undefined = project ? { href: `/?project=${encodeURIComponent(d.service.projectNamed(project))}#panel`, label: d.service.projectNamed(project), tab: 'pages' } : kind || q || show !== 'current' || pageNo > 1 ? { href: '/facts', label: 'Facts', tab: 'pages' } : undefined;
    const factsSend = (body: SafeHtml) => send(res, 200, 'Facts', body, factsBack);
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
    if (show === 'replaced') {
      const replaced = d.store.supersessions.replacedList({ kind, project, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
      const total = d.store.supersessions.replacedCount({ kind, project });
      return factsSend(listView({ items: [], replaced, replacedTotal: total, filter, page: pageNo, hasNext: pageNo * PAGE_SIZE < total, show, now, ...common }));
    }
    const rows = d.store.list({ kind, project, limit: PAGE_SIZE + 1, offset: (pageNo - 1) * PAGE_SIZE, replaced: show === 'everything' ? 'include' : 'hide' });
    const items = rows.slice(0, PAGE_SIZE);
    const replacedIds = show === 'everything' ? new Set(items.filter((m) => d.store.supersessions.liveFor(m.id)).map((m) => m.id)) : undefined;
    factsSend(listView({ items, filter, page: pageNo, hasNext: rows.length > PAGE_SIZE, show, replacedIds, now, ...common }));
  });

  router.get('/memories/new', owner, (req, res) =>
    send(res, 200, 'New fact', newView({ kind: 'decision', content: '', project: query(req, 'project') ?? '', tags: '' })));

  router.post('/memories', owner, async (req: Request, res) => {
    const values = formValues(req, str(req, 'kind'));
    let id = '';
    const ok = await attempt(res, async () => {
      const r = await d.service.remember({
        kind: values.kind as Kind, content: values.content, project: values.project || undefined, tags: tagList(values.tags),
      }, OWNER);
      if (r.status === 'saved' || r.status === 'roadmap_updated') id = r.memory.id;
    }, (m) => send(res, 400, 'New fact', newView(values, m)));
    if (ok) res.redirect(303, `/memories/${id}`);
  });

  // ---- One memory ----

  /** A fact's page, with what section 16 adds: its replacements and, on a current fact, the owner's picker. `from` is an origin `backFrom` already accepted. */
  const detail = (res: Response, m: Memory, status = 200, values = valuesOf(m), error?: string, pickAll = false, open?: 'edit' | 'history' | 'picker', selectedBy?: string, from?: string) =>
    send(res, status, 'Fact', detailView(m, d.store.history(m.id), values, error, {
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
    if (by === '') return detail(res, m, 400, valuesOf(m), 'Pick the fact that holds now.', pickAll, 'picker', undefined, o.raw);
    try {
      d.service.supersede([id], by, OWNER);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return detail(res, m, 400, valuesOf(m), e.message, pickAll, 'picker', by, o.raw);
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
      res.redirect(303, back === 'panel' && project !== null ? `/?project=${encodeURIComponent(project)}#panel`
        : back === 'tidy' ? '/facts/tidy' : back === 'facts' ? '/facts?show=replaced' : withFrom(`/memories/${old.id}`, o.raw));
    }
  });

  router.post('/memories/:id', owner, async (req: Request, res) => {
    const id = req.params.id as string;
    const m = activeMemory(id);
    if (!m) return notFound(res);
    const values = formValues(req, m.kind);
    const o = origin(req);
    if (await attempt(res, () => d.service.update(id, { content: values.content, project: values.project || null, tags: tagList(values.tags) }, OWNER, { base: values.base }),
      (msg) => {
        // Saved by someone else since this page was opened: show what it says now, keep the draft, and let a second
        // Save (from this page, with the current text in view) go through.
        const now = d.store.get(id);
        if (values.base && now && !now.deletedAt && now.updatedAt !== values.base) {
          const by = now.updatedBy === 'owner' ? 'you' : now.updatedBy;
          return detail(res, now, 409, { ...values, base: now.updatedAt },
            `This fact changed since you opened it (saved by ${by} at ${now.updatedAt.slice(0, 16).replace('T', ' ')} UTC). It now reads: “${now.content}”. Your text is still in the form below: merge in what you want to keep, then save again.`, false, 'edit', undefined, o.raw);
        }
        detail(res, m, 400, values, msg, false, 'edit', undefined, o.raw);
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
      res.redirect(303, back === 'home' ? '/' : back === 'tidy' ? '/facts/tidy' : o.back?.href ?? factBackDefault(m, look).href);
    }
  });

  router.post('/memories/:id/confirm', owner, (req: Request, res) => {
    const id = req.params.id as string;
    if (!activeMemory(id)) return notFound(res);
    d.store.touch(id);
    res.redirect(303, '/facts/tidy');
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
      res.redirect(303, str(req, 'back') === 'tidy' ? '/facts/tidy' : withFrom(`/memories/${entry.memoryId}`, o.raw));
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

  router.get('/facts/tidy', owner, (_req, res) => tidy(res));
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
    }, (msg) => tidy(res, 400, msg))) res.redirect(303, '/facts/tidy');
  });

  // "Replaced by the latest" on an older status of a project with several.
  router.post('/tidy/statuses/supersede', owner, async (req: Request, res) => {
    if (await attempt(res, () => d.service.supersede([str(req, 'id')], str(req, 'latest'), OWNER), (msg) => tidy(res, 400, msg))) {
      res.redirect(303, '/facts/tidy');
    }
  });
  router.get('/tidy', owner, (_req, res) => res.redirect(301, '/facts/tidy'));

  router.post('/tidy/statuses/keep', owner, (req: Request, res) => {
    const project = str(req, 'project');
    if (project === '') return badRequest(res);
    keepStatuses(d.store, project);
    res.redirect(303, '/facts/tidy');
  });

  router.post('/tidy/projects/move', owner, async (req: Request, res) => {
    if (await attempt(res, () => d.service.moveProject(str(req, 'from'), str(req, 'to'), OWNER), () => badRequest(res))) {
      res.redirect(303, '/facts/tidy');
    }
  });

  router.post('/tidy/projects/different', owner, (req: Request, res) => {
    const a = str(req, 'a');
    const b = str(req, 'b');
    if (a === '' || b === '' || a === b) return badRequest(res);
    d.store.dismissProjects(a, b);
    res.redirect(303, '/facts/tidy');
  });

  router.post('/duplicates/merge', owner, async (req: Request, res) => {
    const keep = str(req, 'keep');
    const drop = str(req, 'drop');
    if (keep === '' || drop === '' || keep === drop) return badRequest(res);
    if (!activeMemory(keep) || !activeMemory(drop)) return notFound(res);
    d.service.forget(drop, OWNER);
    res.redirect(303, '/facts/tidy');
  });

  router.post('/duplicates/keep-both', owner, (req: Request, res) => {
    const a = str(req, 'a');
    const b = str(req, 'b');
    if (a === '' || b === '' || a === b) return badRequest(res);
    if (!d.store.get(a) || !d.store.get(b)) return notFound(res);
    d.store.dismissPair(a, b);
    res.redirect(303, '/facts/tidy');
  });

  // ---- Clients and devices ----

  router.get('/clients', owner, (_req, res) => res.redirect(301, '/settings#connections'));


  router.post('/clients/:grantId/access', owner, (req: Request, res) => {
    const id = req.params.grantId as string;
    if (!d.provider.listGrants().some((g) => g.id === id)) return notFound(res);
    const access = str(req, 'access');
    // Work mode connects only the owner's own assistants, so it offers neither discussions-only nor read-only access.
    if (access !== 'full' && ((access !== 'discussions' && access !== 'projects') || d.mode === 'work')) return badRequest(res);
    const projects = access === 'projects' ? pickedProjects(req.body, d.service.listProjects().map((p) => p.project)) : undefined;
    if (access === 'projects' && !projects) {
      return send(res, 400, 'Bad request', html`<h1>Bad request</h1><p>${PICK_A_PROJECT}</p><p><a href="/settings#connections">Back to Settings</a></p>`);
    }
    d.provider.setGrantAccess(id, access, projects);
    res.redirect(303, '/settings#connections');
  });

  router.post('/clients/:grantId/name', owner, (req: Request, res) => {
    const grant = d.provider.listGrants().find((g) => g.id === (req.params.grantId as string));
    if (!grant) return notFound(res);
    try {
      d.provider.setGrantName(grant.id, str(req, 'name'));
    } catch (e) {
      if (!(e instanceof InvalidNameError)) throw e;
      return send(res, 400, 'Bad request', html`<h1>Bad request</h1><p>${e.message}</p><p><a href="/settings#connections">Back to Settings</a></p>`);
    }
    res.redirect(303, '/settings#connections');
  });

  router.post('/clients/:grantId/revoke', owner, (req: Request, res) => {
    const id = req.params.grantId as string;
    if (!d.provider.listGrants().some((g) => g.id === id)) return notFound(res);
    d.provider.revokeGrant(id);
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

  // ---- Activity ----

  router.get('/activity', owner, (_req, res) => res.redirect(301, '/review/now#latest'));

  return router;
}
