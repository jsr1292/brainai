/** GET /map: every project against the five areas (spec 2026-11-11), owner only; viewing it records this week's counts. */
import { Router } from 'express';
import { CHECK_AREAS, type CheckArea } from '../learning/types.js';
import { weekOf } from '../memory/digest.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { mapView, type MapRow, type MapView } from './mapViews.js';

/** Weeks of history the Map shows. */
export const MAP_WEEKS = 8;

export function mapRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  router.get('/map', owner, (_req, res) => {
    const now = d.now();
    // One read of the Mac's folder report for the whole page, not one per project.
    const folders = d.folders.match();
    d.learning.snapshot(weekOf(now).monday);
    const sections = d.projects.home(now).sections
      .map((s) => ({
        area: s.area,
        rows: [...s.live, ...s.quiet, ...s.parked].flatMap((c): MapRow[] => {
          const areas = d.learning.areas(c.project.name, folders);
          return areas ? [{ name: c.project.name, areas, next: c.next }] : [];
        }),
      }))
      .filter((s) => s.rows.length > 0);
    // The next thing to learn: the earliest area in learning order that any project has waiting, on the first such project.
    let learnNext: MapView['learnNext'] = null;
    const nexts = sections.flatMap((s) => s.rows).map((r) => ({ project: r.name, area: d.learning.nextArea(r.name, folders) }))
      .filter((x): x is { project: string; area: CheckArea } => x.area !== null);
    for (const area of CHECK_AREAS) { const hit = nexts.find((x) => x.area === area); if (hit) { learnNext = hit; break; } }
    const view: MapView = { sections, total: sections.reduce((n, s) => n + s.rows.length, 0), learnNext, history: d.learning.history(MAP_WEEKS), now };
    res.type('html').send(page('Map', mapView(view), { nav: true, tab: 'projects', back: { href: '/', label: 'Projects' } }));
  });
  return router;
}
