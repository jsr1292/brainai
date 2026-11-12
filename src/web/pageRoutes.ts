import { Router, type Request, type Response } from 'express';
import { changedSections, diffBodies } from '../pages/diff.js';
import { renderMarkdown, splitSections } from '../pages/markdown.js';
import { NoteError } from '../pages/notes.js';
import { PageError, type Page } from '../pages/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { backError, backFrom, type Back } from './back.js';
import { backLookups } from './backLookups.js';
import { html, page, type SafeHtml } from './html.js';
import { conflictView, editView, historyView, type EditForm } from './pageEditViews.js';
import { NOTES_ID, pageView, pagesHomeView, type Live, type NavEntry, type NoteDraft } from './pageViews.js';

const RECENT = 8;

/** The owner's pages: the Pages tab, the reading view, the editor, history, restore and delete. */
export function pageRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const look = backLookups(d);
  /** A page's back target, when its link carried an origin `backFrom` accepts (search lights no tab). */
  const openedFrom = (req: Request): Back | undefined => {
    const v = req.query.from;
    return typeof v === 'string' && v !== '' ? backFrom(v, look) : undefined;
  };
  const send = (res: Response, status: number, title: string, body: SafeHtml, back?: Back | { href: string; label: string }, crumb?: boolean) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: back !== undefined && 'tab' in back ? back.tab : status === 404 ? null : 'pages', back: back ?? (title === 'New page' ? { href: '/pages', label: 'Pages' } : undefined), crumb }));
  const nav = (): NavEntry[] => d.pages.headers().map((p) => ({ id: p.id, title: p.title, area: d.pages.areaOf(p) }));
  const summary = (p: Page): string => {
    const before = p.version > 1 ? d.pages.version(p.id, p.version - 1)?.body ?? '' : '';
    return changedSections(before, p.body);
  };

  router.get('/pages', owner, (_req, res) => {
    const all = d.pages.list();
    const moved = d.imports.summary().moved;
    // One working-out for the whole tab: it serves Recently updated's chips and the fold.
    const flags = d.pages.freshness.forPages(all);
    const flagged = all.filter((p) => flags.get(p.id));
    const asked = d.notes.openOn(flagged.map((p) => p.id));
    send(res, 200, 'Pages', pagesHomeView({
      nav: nav(),
      recent: all.slice(0, RECENT).map((p) => ({ page: p, area: d.pages.areaOf(p), summary: summary(p), stale: Boolean(flags.get(p.id)) })),
      stale: flagged.map((p) => ({ page: p, flag: flags.get(p.id)!, noteOpen: asked.has(p.id) })),
      start: all.filter((p) => p.project === null && p.area === 'start').sort((a, b) => a.title.localeCompare(b.title)),
      withoutPage: d.pages.withoutPage(),
      moved: moved > 0 ? { moved } : null,
    }));
  });

  // ---- Writing ----

  const field = (req: Request, name: string): string => (typeof req.body?.[name] === 'string' ? req.body[name] as string : '');
  const projectNames = () => d.registry.list().map((p) => p.name).sort();
  const live = (id: string): Page | undefined => { const p = d.pages.get(id); return p && p.deletedAt === null ? p : undefined; };
  /** A section's own lines, heading included, as the editor shows them. */
  const sectionText = (body: string, anchor: string): string | undefined => {
    const s = splitSections(body).find((x) => x.anchor === anchor);
    return s ? body.split('\n').slice(s.start, s.end).join('\n').replace(/\s+$/, '') : undefined;
  };
  const formFor = (p: Page, section: string | undefined): EditForm | undefined => {
    const base = { pageId: p.id, pageTitle: p.title, base: p.version, title: p.title, project: p.project === null ? '' : d.service.projectNamed(p.project), area: p.area ?? 'start', projects: projectNames() };
    if (section === undefined) return { ...base, mode: 'page', body: p.body };
    const text = sectionText(p.body, section);
    const s = splitSections(p.body).find((x) => x.anchor === section);
    return text === undefined || !s ? undefined : { ...base, mode: 'section', section: { anchor: s.anchor, heading: s.heading }, body: text };
  };
  const preview = (body: string) => renderMarkdown(body, d.pages.resolver(), d.pages.pictures(body));

  router.get('/pages/new', owner, (req, res) => {
    const wanted = typeof req.query.project === 'string' ? d.service.projectNamed(req.query.project) : '';
    const project = d.registry.get(wanted) ? wanted : '';
    send(res, 200, 'New page', editView(nav(), { mode: 'new', title: '', project, area: 'start', body: '', projects: projectNames() }));
  });

  router.post('/pages', owner, async (req, res) => {
    const v: EditForm = { mode: 'new', title: field(req, 'title'), project: field(req, 'project'), area: field(req, 'area'), body: field(req, 'body'), projects: projectNames() };
    const intent = field(req, 'intent');
    if (intent !== 'save') return send(res, 200, 'New page', editView(nav(), { ...v, preview: intent === 'preview' ? preview(v.body) : undefined }));
    try {
      const p = await d.pages.create({ title: v.title, project: v.project || undefined, area: v.area, body: v.body }, 'owner');
      res.redirect(303, `/pages/${p.id}`);
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      send(res, 400, 'New page', editView(nav(), { ...v, error: e.message }));
    }
  });

  /** The reading view, also shown again with a message when a note is refused. */
  const reading = (res: Response, p: Page, status = 200, error?: string, noteDraft?: NoteDraft, back?: Back) => {
    let live: Live | null = null;
    if (p.project !== null && p.deletedAt === null) {
      const detail = d.projects.detail(p.project, d.now());
      if (detail?.card.roadmap) live = { project: detail.card.project.name, now: detail.card.roadmap.now, next: detail.nextSteps, waiting: detail.waiting };
    }
    send(res, status, p.title, pageView({
      page: p, nav: nav(), area: d.pages.areaOf(p), versions: p.version, sections: d.pages.sections(p.id), resolve: d.pages.resolver(),
      project: p.project === null ? null : d.service.projectNamed(p.project), notes: p.deletedAt === null ? d.notes.forPage(p.id) : [], error, noteDraft,
      live, related: p.deletedAt === null ? d.pages.relatedFacts(p, d.relatedSimilarity) : [], linkedFrom: p.deletedAt === null ? d.pages.linkedFrom(p) : [],
      flag: p.deletedAt === null ? d.pages.freshness.forPage(p, { hints: true }) : null,
      pictures: d.pages.pictures(p.body),
      diagramProblems: p.deletedAt === null ? d.diagramChecks.problems(p).map((x) => x.block) : [],
    }), back ?? { href: '/pages', label: 'Pages' }, false);
  };

  router.get('/pages/:id', owner, (req, res) => {
    const p = d.pages.get(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    // A stale tick in the live box comes back with ?error=changed: only a fixed line is shown.
    reading(res, p, 200, backError(req.query.error), undefined, openedFrom(req));
  });

  // ---- Notes for the AIs ----

  router.post('/pages/:id/notes', owner, (req, res) => {
    const p = d.pages.get(req.params.id as string);
    if (!p || p.deletedAt !== null) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    try {
      d.notes.add(p.id, { text: field(req, 'text'), anchor: field(req, 'section') || undefined });
    } catch (e) {
      if (!(e instanceof NoteError)) throw e;
      if (e.code === 'not_found') return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
      // The reason shows once, beside the kept form (not again in the page's error block).
      return reading(res, p, 400, undefined, { text: field(req, 'text'), section: field(req, 'section'), error: e.message });
    }
    res.redirect(303, `/pages/${p.id}#${NOTES_ID}`);
  });

  router.post('/pages/:id/notes/:noteId/withdraw', owner, (req, res) => {
    const n = d.notes.get(req.params.noteId as string);
    if (!n || n.pageId !== req.params.id) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    try {
      d.notes.withdraw(n.id);
    } catch (e) {
      if (!(e instanceof NoteError)) throw e;
    }
    res.redirect(303, `/pages/${n.pageId}#${NOTES_ID}`);
  });

  // ---- May be out of date: the owner's Still true, and its one Undo ----

  router.post('/pages/:id/still-true', owner, (req, res) => {
    const p = live(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    d.pages.stillTrue(p.id);
    res.redirect(303, `/pages/${p.id}`);
  });

  router.post('/pages/:id/still-true/undo', owner, (req, res) => {
    const p = live(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    try {
      d.pages.undoStillTrue(p.id);
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      if (e.code === 'not_found') return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
      return reading(res, d.pages.get(p.id)!, 409, e.message);
    }
    res.redirect(303, `/pages/${p.id}`);
  });

  router.get('/pages/:id/edit', owner, (req, res) => {
    const p = live(req.params.id as string);
    const section = typeof req.query.section === 'string' ? req.query.section : undefined;
    const form = p ? formFor(p, section) : undefined;
    if (!p || !form) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    send(res, 200, `Editing ${p.title}`, editView(nav(), form), { href: `/pages/${p.id}`, label: p.title });
  });

  router.post('/pages/:id', owner, async (req, res) => {
    const p = live(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    const anchor = field(req, 'section') || undefined;
    const base = Number(field(req, 'base'));
    if (!Number.isInteger(base)) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    const shown = formFor(p, anchor);
    if (!shown) {
      // The section was renamed or removed since the editor opened: a conflict, never a lost edit.
      if (anchor === undefined || base === p.version) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
      const whole = formFor(p, undefined)!;
      return send(res, 409, `Editing ${p.title}`, conflictView(nav(), { ...whole, base, savedBy: p.updatedBy, version: p.version, theirs: p.body, mine: field(req, 'body') }), { href: `/pages/${p.id}`, label: p.title });
    }
    const v: EditForm = anchor === undefined
      ? { ...shown, base, title: field(req, 'title'), project: field(req, 'project'), area: field(req, 'area'), body: field(req, 'body') }
      : { ...shown, base, body: field(req, 'body') };
    const intent = field(req, 'intent');
    if (intent !== 'save') return send(res, 200, `Editing ${v.title}`, editView(nav(), { ...v, preview: intent === 'preview' ? preview(v.body) : undefined }), { href: `/pages/${p.id}`, label: p.title });
    try {
      const before = splitSections(p.body).findIndex((s) => s.anchor === anchor);
      const saved = anchor === undefined
        ? await d.pages.save(p.id, { base, title: v.title, project: v.project || null, area: v.area || null, body: v.body }, 'owner')
        : await d.pages.saveSection(p.id, { base, anchor, text: v.body }, 'owner');
      const after = splitSections(saved.body);
      // The edited section keeps its place even if its heading (and so its anchor) changed.
      const landing = anchor === undefined ? 'top' : (v.body.trim() === '' ? 'top' : after[before]?.anchor ?? 'top');
      res.redirect(303, `/pages/${p.id}#${landing}`);
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      if (e.code === 'conflict') {
        const now = d.pages.get(p.id)!;
        const theirs = anchor === undefined ? now.body : sectionText(now.body, anchor) ?? now.body;
        const saved = formFor(now, undefined)!;
        return send(res, 409, `Editing ${p.title}`, conflictView(nav(), { ...v, mode: anchor !== undefined && sectionText(now.body, anchor) !== undefined ? 'section' : 'page', savedBy: now.updatedBy, version: now.version, theirs, mine: v.body, current: anchor === undefined ? { title: saved.title, project: saved.project, area: saved.area } : undefined }), { href: `/pages/${p.id}`, label: p.title });
      }
      send(res, 400, `Editing ${v.title}`, editView(nav(), { ...v, error: e.message }), { href: `/pages/${p.id}`, label: p.title });
    }
  });

  // ---- History, restore and delete ----

  router.get('/pages/:id/history', owner, (req, res) => {
    const p = d.pages.get(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    const all = d.pages.versions(p.id);
    const wanted = typeof req.query.v === 'string' ? Number(req.query.v) : p.version;
    const selected = all.find((x) => x.version === wanted);
    if (!selected) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    const before = (n: number) => all.find((x) => x.version === n - 1);
    const previous = before(selected.version);
    send(res, 200, 'History', historyView(nav(), {
      pageId: p.id, pageTitle: p.title, selected, previous, diff: diffBodies(previous?.body ?? '', selected.body),
      versions: all.map((x) => ({ ...x, summary: changedSections(before(x.version)?.body ?? '', x.body) })),
    }), { href: `/pages/${p.id}`, label: p.title });
  });

  const act = async (req: Request, res: Response, run: (p: Page) => Promise<unknown> | unknown, to: (p: Page) => string) => {
    const p = d.pages.get(req.params.id as string);
    if (!p) return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
    try {
      await run(p);
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      if (e.code === 'not_found') return send(res, 404, 'Not found', html`<h1>Not found</h1>`);
      return send(res, 400, 'Could not do that', html`<h1>Could not do that</h1><p>${e.message}</p><p><a href="/pages/${p.id}">← Back to the page</a></p>`);
    }
    res.redirect(303, to(p));
  };
  router.post('/pages/:id/restore', owner, (req, res) => act(req, res, (p) => d.pages.restore(p.id, Number(field(req, 'version')), 'owner'), (p) => `/pages/${p.id}`));
  router.post('/pages/:id/delete', owner, (req, res) => act(req, res, (p) => d.pages.remove(p.id, 'owner'), () => '/pages'));
  router.post('/pages/:id/undelete', owner, (req, res) => act(req, res, (p) => d.pages.undelete(p.id, 'owner'), (p) => `/pages/${p.id}`));

  return router;
}
