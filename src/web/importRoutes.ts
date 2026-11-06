import { Router, type Response } from 'express';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { html, page, type SafeHtml } from './html.js';
import { importCompareView, importListView } from './importViews.js';
import { renderMarkdown } from '../pages/markdown.js';

/** Moved from Outline lives under Pages. Old form actions remain usable for one release. */
export function importRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, status: number, body: SafeHtml, back: { href: string; label: string }) =>
    res.status(status).type('html').send(page('Moved from Outline', body, { nav: true, tab: 'pages', back }));
  const missing = (res: Response) => res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { tab: null }));

  router.get('/settings/import', owner, (_req, res) => res.redirect(301, '/pages/moved'));
  router.get('/settings/import/:id', owner, (req, res) => res.redirect(301, `/pages/moved/${encodeURIComponent(req.params.id as string)}`));

  router.get('/pages/moved', owner, (_req, res) => {
    const rows = d.imports.list();
    const pages = new Map(d.pages.list().map((p) => [p.id, p]));
    for (const r of rows) if (r.pageId && !pages.has(r.pageId)) { const p = d.pages.get(r.pageId); if (p) pages.set(p.id, p); }
    send(res, 200, importListView(rows, pages, d.imports.notMoved()), { href: '/pages', label: 'Pages' });
  });
  router.get('/pages/moved/:id', owner, (req, res) => {
    const r = d.imports.get(req.params.id as string);
    if (!r) return missing(res);
    const p = r.pageId ? d.pages.get(r.pageId) : undefined;
    const live = p && p.deletedAt === null ? p : undefined;
    send(res, 200, importCompareView(r, live, live ? renderMarkdown(live.body, d.pages.resolver()) : html``), { href: '/pages/moved', label: 'Moved from Outline' });
  });
  const check = (req: import('express').Request, res: Response) => {
    const id = req.params.id as string;
    if (!d.imports.get(id)) return missing(res);
    d.imports.check(id);
    const rows = d.imports.list();
    const at = rows.findIndex((r) => r.outlineId === id);
    const next = [...rows.slice(at + 1), ...rows.slice(0, at)].find((r) => r.checkedAt === null);
    res.redirect(303, next ? `/pages/moved/${encodeURIComponent(next.outlineId)}` : '/pages/moved');
  };
  router.post('/pages/moved/:id/check', owner, check);
  router.post('/settings/import/:id/check', owner, check);
  return router;
}
