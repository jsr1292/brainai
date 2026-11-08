import { Router, type Request, type Response } from 'express';
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import { folderKey } from '../folders/report.js';
import { LIST_CHANGED, MemoryError } from '../memory/service.js';
import type { Memory } from '../memory/types.js';
import { AREAS, ProjectError, type Area, type ProjectStateName } from '../projects/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { safeBack, withBackError } from './back.js';
import { html, page } from './html.js';
import type { ApprovalSummary } from './forYou.js';
import { needsWelcome } from './desktopRoutes.js';
import { disagreementsView, type OpenDisagreement } from './disagreeViews.js';
import { errorBlock } from './dashboardViews.js';
import { healthOf } from './healthData.js';
import { projectList, projectsHomeView, type HomeViewInput, type WeekLine } from './projectsViews.js';
import { weekRange } from '../review/sentence.js';
import { deskSideView, projectLately } from './deskSide.js';

const STATE_CHOICES: readonly ProjectStateName[] = ['open', 'parked', 'done', 'archived'];

const str = (req: Request, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};
const queryName = (req: Request): string | undefined => {
  const v = req.query.project;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const panelHref = (name: string): string => `/?project=${encodeURIComponent(name)}#panel`;

/** The projects home (the dashboard's front page) and the owner's actions on projects. */

export function projectRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);

  /**
   * The Monday line: last week's review, built here if it isn't stored yet, while neither Read it nor Not now was
   * pressed, the week had something in it and no backup warning shows. It is an optional nudge: a failed build is
   * logged and the page renders without it (nothing was stored, so the next load tries again).
   */
  const weekLine = (backupProblem: string | null): { line: WeekLine | null; holdBackPark: Set<string> } => {
    const none = { line: null, holdBackPark: new Set<string>() };
    if (backupProblem) return none;
    const monday = d.reviews.lastMonday();
    try {
      const stored = d.reviews.ensure(monday, 'owner');
      if (!stored || stored.openedAt !== null || stored.dismissedAt !== null) return none;
      const view = d.reviews.present(stored, 'last', { kind: 'owner' });
      if (view.empty) return none;
      return {
        line: { monday, dates: weekRange(monday), text: view.lineSentence },
        holdBackPark: new Set([...view.quiet.shown, ...view.quiet.folded].map((q) => q.project)),
      };
    } catch (e) {
      console.error(`weekly review ${monday} failed: ${e instanceof Error ? e.message : String(e)}`);
      return none;
    }
  };

  /** How many changes wait for approval; when exactly one does, the whole card for the For-you sheet. */
  const approvalSummary = (): ApprovalSummary => {
    const pending = d.service.pendingSuggestions();
    // Skill proposals (§17c) count too; with any waiting, For you points to Approvals instead of one card.
    const proposals = d.skills.pendingProposals();
    const s = pending[0];
    const p = proposals[0];
    return {
      count: pending.length + proposals.length,
      first: s ? { by: s.suggestedBy, kind: s.kind, action: s.action === 'add' ? 'create' : s.action } : p ? { by: p.proposedBy, kind: 'skill', action: p.skillId ? 'update' : 'create' } : null,
      single: pending.length === 1 && proposals.length === 0 && s ? {
        suggestion: s,
        current: s.memoryId ? d.store.get(s.memoryId)?.content : undefined,
        replaces: s.supersedes.map((id) => d.store.get(id)).filter((m): m is Memory => m !== undefined && m.deletedAt === null),
        deleted: s.deletedMatch ? d.store.get(s.deletedMatch) : undefined,
      } : undefined,
    };
  };
  /** Everything the Projects screen is drawn from: the home, its list, and the open project when one is asked for. */
  const homeData = (asked: string | undefined, error?: string): HomeViewInput => {
    const backups = d.statusDir === undefined ? undefined : backupHealth(readBackupStatus(d.statusDir), d.now(), { offsite: d.mode !== 'work', jobs: d.mode !== 'work' });
    const backupProblem = backups && !backups.ok ? backups.problems[0] ?? null : null;
    const week = weekLine(backupProblem);
    return {
      home: d.projects.home(d.now(), { holdBackPark: week.holdBackPark }),
      weekLine: week.line,
      selected: asked === undefined ? undefined : d.projects.detail(asked, d.now()),
      approvals: approvalSummary(),
      discussionsWaiting: d.discussions.waitingOnOwner(),
      discussions: d.discussions.ownerTitles(),
      backupProblem,
      now: d.now(),
      error,
      connected: d.provider.listGrants().length > 0,
      disagreements: d.service.openDisagreements().length,
      // A brain with no memories yet has its own first steps: brain health waits until there is something to judge.
      health: d.store.countCurrent() > 0 ? healthOf(d, d.now()) : undefined,
      // Stored by key (lowercase, dashes); shown by the folder's own name while the Mac still reports it.
      ignored: (() => {
        const names = new Map((d.devices.latestReport()?.folders ?? []).map((x) => [folderKey(x.name), x.name]));
        return [...d.devices.ignored()].sort().map((key) => ({ key, name: names.get(key) ?? key }));
      })(),
    };
  };
  const home = (req: Request, res: Response, status = 200, error?: string, select?: string) => {
    const asked = select ?? queryName(req);
    res.status(status).type('html').send(page('Projects', projectsHomeView(homeData(asked, error)),
      { nav: true, tab: 'projects', back: asked ? { href: '/', label: 'Projects' } : undefined, crumb: false }));
  };
  const notFound = (res: Response) => res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { nav: true, tab: null }));

  /**
   * Runs an owner action on a project: 303 back to its panel, 404 for an unknown project, 400 with the message
   * otherwise. Sent from a page or a review (a safe `back`), it returns there, with a fixed line when it failed.
   */
  const act = async (req: Request, res: Response, action: (name: string) => unknown) => {
    const back = safeBack(req.body?.back);
    const name = d.service.projectNamed(req.params.name as string);
    if (!d.registry.get(name)) return back ? res.redirect(303, withBackError(back, 'changed')) : notFound(res);
    try {
      await action(name);
    } catch (e) {
      if (!(e instanceof ProjectError || e instanceof MemoryError)) throw e;
      if (back) return res.redirect(303, withBackError(back, e.code === 'not_found' || e.message === LIST_CHANGED ? 'changed' : 'failed'));
      if (e.code === 'not_found') return notFound(res);
      return home(req, res, 400, e.message, name);
    }
    res.redirect(303, back ?? panelHref(name));
  };
  const index = (req: Request): number | undefined => {
    const raw = req.params.index as string;
    return /^\d{1,4}$/.test(raw) ? Number(raw) : undefined;
  };

  router.get('/', owner, (req, res) => {
    // A new Mac install opens on the welcome (D3); a brain in use, or one past the welcome, never does.
    if (Object.keys(req.query).length === 0 && needsWelcome(d)) return res.redirect(302, '/welcome');
    // The old memory map's Map / Globe choice used to live on the home page: old links land on the Graph tab in one hop.
    const view = req.query.view;
    if (view === 'map' || view === 'globe') return res.redirect(301, '/graph');
    // Desktop only (desk.js): the list pane by itself, with the same data, filters and work mode as the home. ?project
    // is ignored here: desk.js marks the selection.
    if (req.query.pane === 'projects') return res.type('html').send(projectList(homeData(undefined), 'list').value);
    // Desktop only (desk.js): the side fragment beside a project's sheet, its Lately. An unknown project is an empty 404.
    if (req.query.pane === 'side') {
      const asked = queryName(req);
      const name = asked === undefined ? undefined : d.service.projectNamed(asked);
      if (name === undefined || !d.registry.get(name)) return res.status(404).type('html').send('');
      return res.type('html').send(deskSideView({ lately: projectLately(d, name), self: `/?project=${encodeURIComponent(name)}` }).value);
    }
    home(req, res);
  });

  // Not in the brain yet: a folder from the Mac's report becomes a project, or is ignored.
  router.post('/folders/add', owner, (req: Request, res) => {
    try {
      const p = d.folders.add(str(req, 'name'));
      res.redirect(303, panelHref(p.name));
    } catch (e) {
      home(req, res, 400, e instanceof Error ? e.message : 'Could not add the folder');
    }
  });
  router.post('/folders/ignore', owner, (req: Request, res) => {
    try {
      d.folders.ignore(str(req, 'name'));
      res.redirect(303, '/#notyet');
    } catch (e) {
      home(req, res, 400, e instanceof Error ? e.message : 'Could not ignore the folder');
    }
  });
  // Undo lists an ignored folder under "Not in the brain yet" again; the old Settings path stays for one release.
  const unignore = (req: Request, res: Response) => {
    const name = str(req, 'name');
    if (name.trim() !== '') d.devices.unignore(name);
    res.redirect(303, '/#notyet');
  };
  router.post('/folders/unignore', owner, unignore);
  router.post('/settings/folders/unignore', owner, unignore);

  router.post('/projects/ideas', owner, (req: Request, res) => {
    try {
      const p = d.projects.createIdea(str(req, 'text'), d.now());
      res.redirect(303, panelHref(p.name));
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e;
      home(req, res, 400, e.message);
    }
  });

  router.post('/projects/:name/state', owner, (req: Request, res) => {
    const state = str(req, 'state') as ProjectStateName;
    if (!STATE_CHOICES.includes(state)) return home(req, res, 400, 'Choose open, parked, done or archived');
    return act(req, res, (name) => d.projects.setState(name, state));
  });
  router.post('/projects/:name/pin', owner, (req: Request, res) => act(req, res, (name) => d.projects.pin(name)));
  router.post('/projects/:name/unpin', owner, (req: Request, res) => act(req, res, (name) => d.projects.unpin(name)));
  router.post('/projects/:name/snooze', owner, (req: Request, res) => act(req, res, (name) => d.projects.snooze(name, d.now())));

  router.post('/projects/:name/info', owner, (req: Request, res) => {
    const area = str(req, 'area');
    if (area !== '' && !(AREAS as readonly string[]).includes(area)) return home(req, res, 400, `area must be one of: ${AREAS.join(', ')}`);
    const orNull = (v: string) => (v.trim() === '' ? null : v);
    return act(req, res, (name) => d.registry.setInfo(name, {
      oneLiner: orNull(str(req, 'oneLiner')), area: area === '' ? null : (area as Area), folder: orNull(str(req, 'folder')), url: orNull(str(req, 'url')),
      runsOn: str(req, 'runsOn'),
    }, 'owner'));
  });

  router.post('/projects/:name/waiting/:index/done', owner, (req: Request, res) => {
    const i = index(req);
    if (i === undefined) return home(req, res, 400, 'Bad item number');
    return act(req, res, (name) => d.projects.completeWaiting(name, i, str(req, 'text'), d.now()));
  });
  // B1: every open disagreement, by project; settling one (owner only) comes back to where it was settled.
  const disagreementsPage = (res: Response, status = 200, error?: string) => {
    const groups = new Map<string | null, OpenDisagreement[]>();
    for (const x of d.service.openDisagreements()) {
      const raw = x.factA.project ?? x.factB.project;
      const key = raw === null ? null : d.service.projectNamed(raw);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    const sorted = [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b))).map(([project, list]) => ({ project, list }));
    res.status(status).type('html').send(page('Facts that disagree', html`${errorBlock(error)}${disagreementsView(sorted, d.now())}`, { nav: true, tab: 'projects', back: { href: '/', label: 'Projects' } }));
  };
  router.get('/disagreements', owner, (_req, res) => disagreementsPage(res));
  router.post('/disagreements/:id/settle', owner, (req: Request, res) => {
    const how = str(req, 'how');
    if (how !== 'a' && how !== 'b' && how !== 'both') return disagreementsPage(res, 400, 'Choose which fact is right, or both.');
    try {
      d.service.settleDisagreement(req.params.id as string, how, { type: 'owner' });
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return disagreementsPage(res, e.code === 'not_found' ? 404 : 400, e.message);
    }
    // Only back to the list or a project's panel (a name as encodeURIComponent writes it): never anywhere else.
    const back = req.body?.back;
    const ok = back === '/disagreements' || (typeof back === 'string' && /^\/\?project=[A-Za-z0-9%._~!*'()-]+#panel$/.test(back));
    res.redirect(303, ok ? back : '/disagreements');
  });

  router.post('/projects/:name/done/:index/undo', owner, (req: Request, res) => {
    const i = index(req);
    if (i === undefined) return home(req, res, 400, 'Bad item number');
    return act(req, res, (name) => d.projects.undoDone(name, i, str(req, 'text'), d.now()));
  });

  return router;
}
