import { Router, type Request, type Response } from 'express';
import { shiftWeek, weekOf, weeklyDigest } from '../memory/digest.js';
import type { StoredReview } from '../review/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { backError } from './back.js';
import { html, page, type Section } from './html.js';
import { LATEST_MAX, allWeeksView, noWeekYetView, reviewView } from './reviewViews.js';

const TITLE = 'Weekly review';
const MONDAY = /^\d{4}-\d{2}-\d{2}$/;

/** The weekly review pages (spec section 14). Every GET only reads; only the two POSTs mark a week. */
export function reviewRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const work = d.mode === 'work';
  const send = (res: Response, body: ReturnType<typeof html>, status = 200, back?: { href: string; label: string }, section?: Section) => res.status(status).type('html').send(page(TITLE, body, { nav: true, tab: 'week', section, back }));
  const notFound = (res: Response) => res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { nav: true, tab: null }));
  const prevOf = (monday: string): string | null => {
    const earliest = d.reviews.earliestMonday();
    const prev = shiftWeek(monday, -1);
    return earliest !== null && prev >= earliest ? prev : null;
  };
  const showWeek = (req: Request, res: Response, r: StoredReview) => {
    const last = r.monday === d.reviews.lastMonday();
    if (last) r = d.reviews.withTidy(r);
    const view = d.reviews.present(r, last ? 'last' : 'older', { kind: 'owner' });
    // Last week's forms always return to /review, the one address it is kept under offline.
    send(res, reviewView(view, { work, error: backError(req.query.error), prev: prevOf(r.monday), next: last ? null : shiftWeek(r.monday, 1), back: last ? '/review' : null, monday: { show: last && !view.empty && r.openedAt === null && r.dismissedAt === null } }), 200, last ? undefined : { href: '/review/all', label: 'All weeks' }, last ? 'last' : undefined);
  };

  router.get('/review', owner, (req, res) => {
    const r = d.reviews.ensure(d.reviews.lastMonday(), 'owner');
    if (!r) return send(res, noWeekYetView(work), 200, undefined, 'last');
    showWeek(req, res, r);
  });

  router.get('/review/now', owner, (req, res) => {
    const view = d.reviews.present(d.reviews.soFar(), 'now', { kind: 'owner' });
    const week = weekOf(d.now());
    const digest = weeklyDigest(d.store, week, { grants: d.provider.listGrants(), waiting: d.service.pendingSuggestions().length });
    const notes = digest.flags.filter((f) => f.kind === 'no-saves' || f.kind === 'changed-others' || f.kind === 'no-project');
    const activity = d.store.recentActivity(LATEST_MAX).filter((a) => a.at >= week.start.toISOString() && a.at < week.end.toISOString());
    send(res, reviewView(view, { work, error: backError(req.query.error), prev: null, next: null, back: '/review/now', latest: { activity, notes } }), 200, undefined, 'now');
  });

  // Before /review/:date. Builds at most MAX_BUILDS_PER_LIST missing weeks per visit.
  router.get('/review/all', owner, (_req, res) => {
    const last = d.reviews.lastMonday();
    const rows = d.reviews.all('owner').map(({ monday, review }) => {
      const href = monday === last ? '/review' : `/review/${monday}`;
      if (!review) return { monday, href, sentence: null, quiet: false };
      const view = d.reviews.present(review, monday === last ? 'last' : 'older', { kind: 'owner' });
      return { monday, href, sentence: view.sentence, quiet: view.empty };
    });
    send(res, allWeeksView(rows, work), 200, { href: '/review', label: 'Last week' });
  });

  router.get('/review/:date', owner, (req, res) => {
    const date = req.params.date as string;
    const at = d.reviews.locate(date);
    if (at.to === 'none') return notFound(res);
    if (at.to === 'now') return res.redirect(302, '/review/now');
    if (at.redirect) return res.redirect(302, `/review/${at.monday}`);
    const r = d.reviews.ensure(at.monday, 'owner');
    if (!r) return notFound(res);
    showWeek(req, res, r);
  });

  router.post('/review/:monday/open', owner, (req, res) => {
    const monday = req.params.monday as string;
    if (!MONDAY.test(monday) || !d.reviews.open(monday)) return notFound(res);
    res.redirect(303, monday === d.reviews.lastMonday() ? '/review' : `/review/${monday}`);
  });

  router.post('/review/:monday/dismiss', owner, (req, res) => {
    const monday = req.params.monday as string;
    if (!MONDAY.test(monday) || !d.reviews.dismiss(monday)) return notFound(res);
    res.redirect(303, '/');
  });

  return router;
}
