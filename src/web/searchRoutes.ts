import { Router } from 'express';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { searchView } from './searchViews.js';
import { normalWords } from '../graph/words.js';

export const MAX_QUERY = 200;
const PROJECT_RESULTS = 10;
/** Facts in the header search; All facts' search uses the same number, so the "Also N" count and that page agree. */
export const FACT_RESULTS = 20;
const PAGE_RESULTS = 10;

/** The header search: projects by name and one-liner, facts by the hybrid memory search, page sections the same way. */
export function searchRoutes(d: AppDeps): Router {
  const router = Router();
  router.get('/search', requireOwner(d.sessions), async (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const q = raw.trim().slice(0, MAX_QUERY);
    const wanted = normalWords(q).split(' ').filter(Boolean);
    const projects = wanted.length === 0 ? [] : d.registry.list()
      .filter((p) => { const hay = normalWords(`${p.name} ${p.oneLiner ?? ''}`); return wanted.every((w) => hay.includes(w)); })
      .slice(0, PROJECT_RESULTS);
    // One embedding of the query for facts and pages.
    const vector = q === '' ? undefined : await d.pages.embedQuery(q);
    // Replaced facts stay out of the results; the ones that ranked among them are counted in one quiet line.
    const found = vector === undefined ? [] : await d.service.recall({
      query: q, limit: FACT_RESULTS, touch: false, vector, replaced: 'include', replacedCut: 'joint-top', replacedLimit: FACT_RESULTS,
    });
    const facts = found.filter((r) => !r.replaced).map((r) => r.memory);
    const alsoReplaced = found.length - facts.length;
    const hits = vector === undefined ? [] : d.pages.search(q, vector, PAGE_RESULTS, d.service.recallFloor());
    const flagged = d.pages.flaggedIds([...new Map(hits.map((r) => [r.page.id, r.page])).values()]);
    const pages = hits.map((r) => ({ ...r, stale: flagged.has(r.page.id) }));
    res.status(200).type('html').send(page('Search', searchView({ q, projects, facts, pages, alsoReplaced }), { nav: true, query: q, tab: null }));
  });
  return router;
}
