import { Router, type Request, type Response } from 'express';
import type { AppDeps } from './app.js';
import { readCookie, requireOwner } from './authRoutes.js';
import { graphListPage, graphPage } from './graphViews.js';
import { page } from './html.js';

/** Remembers whether the Graph tab opens as the 3D window or the list, in this browser. */
export const GRAPH_VIEW_COOKIE = 'graph-view';
const YEAR_MS = 365 * 24 * 3600_000;

/** The Graph tab (spec section 15): the page, its three JSON endpoints and the view cookie. Owner only. */
export function graphRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, body: ReturnType<typeof graphPage>) => res.status(200).type('html').send(page('Graph', body, { nav: true, tab: 'graph' }));

  router.get('/graph', owner, (req: Request, res) => {
    const view = req.query.view;
    if (view === 'list' || view === '3d') {
      // Only this page reads it, so it needs no more protection than SameSite.
      res.cookie(GRAPH_VIEW_COOKIE, view, { sameSite: 'lax', path: '/', maxAge: YEAR_MS, secure: d.publicUrl.protocol === 'https:' });
      return res.redirect(303, '/graph');
    }
    // The old memory map's Map / Globe choice: straight here, nothing remembered.
    if (view === 'map' || view === 'globe') return res.redirect(301, '/graph');
    const list = d.graph.list();
    const asked = typeof req.query.project === 'string' ? req.query.project : undefined;
    // A deep link asks to fly in, so it opens the 3D page whatever the remembered view (the list is still in it).
    if (asked !== undefined) return send(res, graphPage({ list, focus: d.graph.focusName(asked) }));
    if (readCookie(req, GRAPH_VIEW_COOKIE) === 'list') return send(res, graphListPage(list));
    return send(res, graphPage({ list }));
  });

  router.get('/graph.json', owner, (_req, res) => { res.json(d.graph.overview()); });

  router.get('/graph/projects/:name.json', owner, (req: Request, res) => {
    const detail = d.graph.detail(req.params.name as string);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    return res.json(detail);
  });

  router.get('/graph/find.json', owner, async (req: Request, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(await d.graph.find(q));
  });

  return router;
}
