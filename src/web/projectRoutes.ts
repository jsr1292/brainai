import { LearningError } from '../learning/service.js';
import { CHECK_AREAS, CHECK_STATUSES, type CheckArea, type CheckStatus } from '../learning/types.js';
import { Router, type Request, type Response } from 'express';
import { readBackupStatus } from '../backupStatus.js';
import { folderKey } from '../folders/report.js';
import { errorText } from './errorText.js';
import { t } from '../i18n/index.js';
import { LIST_CHANGED, MemoryError } from '../memory/service.js';
import type { Memory } from '../memory/types.js';
import { AREAS, ProjectError, type Area, type ProjectStateName } from '../projects/types.js';
import type { AppDeps } from './app.js';
import { heldView } from './factMetaViews.js';
import { requireOwner } from './authRoutes.js';
import { nextHref, safeBack, withBackError } from './back.js';
import { html, page } from './html.js';
import type { ApprovalSummary } from './forYou.js';
import { needsWelcome, nextCardFor, toolEnv } from './desktopRoutes.js';
import { claudeDesktopConnected } from '../desktop/tools.js';
import { noteDecision, takeStatusLine } from './inboxUndo.js';
import { makeInbox } from './inboxPage.js';
import { healthOf } from './healthData.js';
import { coachingOn } from '../learning/coaching.js';
import { copyState } from '../desktop/backupCopy.js';
import { justUpdatedLine, modelsLine, offsiteCard, updateCard } from './desktopViews.js';
import { laterVersion, offsiteNudgeDue, offsiteNudgeHidden, readJustUpdated, readUpdate } from '../desktop/updateState.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { BRAIN_VERSION } from '../version.js';
import { firstSteps, firstStepsDue, firstStepsHidden, firstStepsView, hideFirstSteps } from './firstSteps.js';
import { projectList, projectsHomeView, type HomeViewInput } from './projectsViews.js';
import { backupProblemOf, holdBackParkOf, mondayCard, weekCandidate } from './mondayCard.js';
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

  /** How many changes wait for approval; when exactly one does, the whole card for the For-you sheet. */
  const approvalSummary = (): ApprovalSummary => {
    const pending = d.service.pendingSuggestions();
    // Skill proposals (§17c) count too; with any waiting, For you points to Approvals instead of one card.
    const proposals = d.skills.pendingProposals();
    const tidyWaiting = d.tidy.pendingCount();
    const s = pending[0];
    const p = proposals[0];
    return {
      count: pending.length + proposals.length + tidyWaiting,
      first: s ? { by: s.suggestedBy, kind: s.kind, action: s.action === 'add' ? 'create' : s.action } : p ? { by: p.proposedBy, kind: 'skill', action: p.skillId ? 'update' : 'create' } : null,
      single: pending.length === 1 && proposals.length === 0 && tidyWaiting === 0 && s ? {
        suggestion: s,
        current: s.memoryId ? d.store.get(s.memoryId)?.content : undefined,
        ...heldView(d.service, s),
        replaces: s.supersedes.map((id) => d.store.get(id)).filter((m): m is Memory => m !== undefined && m.deletedAt === null),
        deleted: s.deletedMatch ? d.store.get(s.deletedMatch) : undefined,
      } : undefined,
    };
  };
  /** Everything the Projects screen is drawn from: the home, its list, and the open project when one is asked for. */
  const homeData = (asked: string | undefined, error?: string, req?: Request): HomeViewInput => {
    const backupProblem = backupProblemOf(d);
    const candidate = weekCandidate(d, backupProblem);
    const home = d.projects.home(d.now(), { holdBackPark: candidate ? holdBackParkOf(candidate) : undefined });
    return {
      home,
      // The card's live numbers come from the cards the home just built.
      monday: candidate ? mondayCard(d, candidate, home.healthCounts) : null,
      // After Not now: the card's place says so, with Undo (only for a week that really was dismissed).
      weekHidden: (() => {
        const m = req?.query.weekHidden;
        return typeof m === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m) && m === d.reviews.lastMonday() && !candidate && d.reviews.dismissedUnread(m) ? m : undefined;
      })(),
      selected: asked === undefined ? undefined : d.projects.detail(asked, d.now()),
      approvals: approvalSummary(),
      discussionsWaiting: d.discussions.waitingOnOwner(),
      discussions: d.discussions.ownerTitles(),
      backupProblem,
      now: d.now(),
      error,
      updateCard: (() => {
        if (!d.localMode || !d.statusDir || (req && viaDoor(req))) return undefined;
        const u = readUpdate(d.statusDir, BRAIN_VERSION);
        return u ? updateCard(u, laterVersion(d.statusDir)) : undefined;
      })(),
      justUpdated: (() => {
        if (!d.localMode || !d.statusDir || (req && viaDoor(req))) return undefined;
        const j = readJustUpdated(d.statusDir, BRAIN_VERSION);
        if (!j) return undefined;
        // The Windows installer ends Claude desktop's bridge: say once that it needs a full quit and reopen.
        const env = toolEnv(d);
        return justUpdatedLine(j, { claude: !!env && (env.platform ?? process.platform) === 'win32' && claudeDesktopConnected(env) });
      })(),
      nextStep: req && viaDoor(req) ? undefined : nextCardFor(d),
      firstSteps: (() => {
        if (req && viaDoor(req)) return undefined;
        const status = d.statusDir ? readBackupStatus(d.statusDir) : undefined;
        const copy = d.backupCopy ? copyState(d.backupCopy.folder(), d.backupCopy.lastResult(), d.now()) : undefined;
        const steps = firstSteps({
          localMode: d.localMode === true, grants: d.provider.listGrants(), hasMemory: d.store.countCurrent() > 0,
          backupCopy: copy,
          backupCopyEverWorked: d.backupCopy?.everCopied() === true,
          backupElsewhere: copy?.kind === 'ok' || status?.offsite !== undefined || status?.git !== undefined,
          canHide: d.statusDir !== undefined,
        });
        return firstStepsDue(steps, firstStepsHidden(d.statusDir)) ? firstStepsView(steps, d.statusDir !== undefined, d.localMode === true) : undefined;
      })(),
      offsiteCard: (() => {
        if (!d.localMode || !d.statusDir || !d.backupCopy || (req && viaDoor(req))) return undefined;
        const status = readBackupStatus(d.statusDir);
        const due = offsiteNudgeDue({
          localMode: true, offsiteSet: d.backupCopy.folder() !== null || status.offsite !== undefined, gitSet: status.git !== undefined,
          firstMemoryAt: d.store.firstCreatedAt(), now: d.now(),
        });
        return due && !offsiteNudgeHidden(d.statusDir, d.now()) ? offsiteCard() : undefined;
      })(),
      modelsLine: d.models ? modelsLine(d.models.status(), { onlyWhenBusy: true, dataDir: d.statusDir }) : undefined,
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
    res.status(status).type('html').send(page(t('projects.title'), html`${takeStatusLine(d.service, d.now().getTime()) ?? ''}${projectsHomeView(homeData(asked, error, req))}`,
      { nav: true, tab: 'projects', back: asked ? { href: '/', labelKey: 'shell.nav.projects' } : undefined, crumb: false }));
  };
  const notFound = (res: Response) => res.status(404).type('html').send(page(t('common.notFound'), html`<h1>${t('common.notFound')}</h1>`, { nav: true, tab: null }));

  /**
   * Runs an owner action on a project: 303 back to its panel, 404 for an unknown project, 400 with the message
   * otherwise. Sent from a page or a review (a safe `back`), it returns there, with a fixed line when it failed.
   */
  const act = async (req: Request, res: Response, action: (name: string) => unknown, anchor?: string) => {
    const back = safeBack(req.body?.back);
    const name = d.service.projectNamed(req.params.name as string);
    if (!d.registry.get(name)) return back ? res.redirect(303, withBackError(back, 'changed')) : notFound(res);
    try {
      await action(name);
    } catch (e) {
      if (!(e instanceof ProjectError || e instanceof MemoryError || e instanceof LearningError)) throw e;
      if (back) return res.redirect(303, withBackError(back, e.code === 'not_found' || e.message === LIST_CHANGED ? 'changed' : 'failed'));
      if (e.code === 'not_found') return notFound(res);
      return home(req, res, 400, errorText(e), name);
    }
    res.redirect(303, back ?? (anchor ? panelHref(name).replace(/#panel$/, anchor) : panelHref(name)));
  };
  const index = (req: Request): number | undefined => {
    const raw = req.params.index as string;
    return /^\d{1,4}$/.test(raw) ? Number(raw) : undefined;
  };

  // "Hide these steps" on Home's first-steps checklist: remembered in the data directory, for good.
  router.post('/first-steps/hide', owner, (_req, res) => {
    if (d.statusDir) hideFirstSteps(d.statusDir);
    res.redirect(303, '/');
  });

  router.get('/', owner, (req, res) => {
    // A new Mac install opens on the welcome (D3); a brain in use, or one past the welcome, never does.
    if (Object.keys(req.query).length === 0 && needsWelcome(d)) return res.redirect(302, '/welcome');
    // The old memory map's Map / Globe choice used to live on the home page: old links land on the Graph tab in one hop.
    const view = req.query.view;
    if (view === 'map' || view === 'globe') return res.redirect(301, '/graph');
    // Desktop only (desk.js): the list pane by itself, with the same data and filters as the home. ?project
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
      home(req, res, 400, e instanceof Error ? errorText(e) : t('projects.err.addFolder'));
    }
  });
  router.post('/folders/ignore', owner, (req: Request, res) => {
    try {
      d.folders.ignore(str(req, 'name'));
      res.redirect(303, '/#notyet');
    } catch (e) {
      home(req, res, 400, e instanceof Error ? errorText(e) : t('projects.err.ignoreFolder'));
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
      home(req, res, 400, errorText(e));
    }
  });

  router.post('/projects/:name/state', owner, (req: Request, res) => {
    const state = str(req, 'state') as ProjectStateName;
    if (!STATE_CHOICES.includes(state)) return home(req, res, 400, t('projects.err.chooseState'));
    return act(req, res, (name) => d.projects.setState(name, state));
  });
  router.post('/projects/:name/pin', owner, (req: Request, res) => act(req, res, (name) => d.projects.pin(name)));
  router.post('/projects/:name/unpin', owner, (req: Request, res) => act(req, res, (name) => d.projects.unpin(name)));
  router.post('/projects/:name/snooze', owner, (req: Request, res) => act(req, res, (name) => d.projects.snooze(name, d.now())));

  router.post('/projects/:name/info', owner, (req: Request, res) => {
    const area = str(req, 'area');
    if (area !== '' && !(AREAS as readonly string[]).includes(area)) return home(req, res, 400, t('projects.err.areaOneOf', { list: AREAS.join(', ') }));
    const orNull = (v: string) => (v.trim() === '' ? null : v);
    return act(req, res, (name) => d.registry.setInfo(name, {
      oneLiner: orNull(str(req, 'oneLiner')), area: area === '' ? null : (area as Area), folder: orNull(str(req, 'folder')), url: orNull(str(req, 'url')),
      runsOn: str(req, 'runsOn'), nicknames: str(req, 'nicknames'),
    }, 'owner'));
  });

  // The owner sets one of a project's five areas from its panel (spec 2026-11-11).
  router.post('/projects/:name/areas/:area', owner, (req: Request, res) => {
    if (!coachingOn(d.store)) return res.redirect(303, '/settings#coaching');
    const area = req.params.area as string;
    const status = str(req, 'status');
    if (!(CHECK_AREAS as readonly string[]).includes(area)) return home(req, res, 400, t('projects.err.areaOneOf', { list: CHECK_AREAS.join(', ') }));
    if (!(CHECK_STATUSES as readonly string[]).includes(status)) return home(req, res, 400, t('projects.err.statusOneOf', { list: CHECK_STATUSES.join(', ') }));
    return act(req, res, (name) => d.learning.set(name, area as CheckArea, { status: status as CheckStatus, note: str(req, 'note') }, 'owner'), '#p-areas');
  });

  router.post('/projects/:name/waiting/:index/done', owner, (req: Request, res) => {
    const i = index(req);
    if (i === undefined) return home(req, res, 400, t('projects.err.badItem'));
    return act(req, res, (name) => d.projects.completeWaiting(name, i, str(req, 'text'), d.now()));
  });
  // B1: every open disagreement, by project; settling one (owner only) comes back to where it was settled.
  const inbox = makeInbox(d);
  const disagreementsPage = (req: Request, res: Response, status = 200, error?: string) => inbox.disagreements(req, res, status, error);
  router.get('/disagreements', owner, (req, res) => disagreementsPage(req, res));
  router.post('/disagreements/:id/settle', owner, (req: Request, res) => {
    const how = str(req, 'how');
    if (how !== 'a' && how !== 'b' && how !== 'both') return disagreementsPage(req, res, 400, t('projects.err.chooseRight'));
    try {
      d.service.settleDisagreement(req.params.id as string, how, { type: 'owner' });
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return disagreementsPage(req, res, e.code === 'not_found' ? 404 : 400, errorText(e));
    }
    // Only back to the list or a project's panel (a name as encodeURIComponent writes it): never anywhere else.
    const back = req.body?.back;
    const ok = back === '/disagreements' || back === '/approvals' || (typeof back === 'string' && /^\/\?project=[A-Za-z0-9%._~!*'()-]+#panel$/.test(back));
    noteDecision(d.service, { id: req.params.id as string, at: d.now().getTime(), message: t('inbox.said.done') });
    const next = back === '/approvals' ? nextHref(req.body?.next) : null;
    res.redirect(303, next ?? (ok ? back : '/disagreements'));
  });

  router.post('/projects/:name/done/:index/undo', owner, (req: Request, res) => {
    const i = index(req);
    if (i === undefined) return home(req, res, 400, t('projects.err.badItem'));
    return act(req, res, (name) => d.projects.undoDone(name, i, str(req, 'text'), d.now()));
  });

  return router;
}
