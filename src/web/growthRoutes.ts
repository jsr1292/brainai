import { Router, type Request, type Response } from 'express';
import { GrowthError, REACTIONS, type Reaction } from '../growth/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { safeBack } from './back.js';
import { growthView } from './growthViews.js';
import { html, page } from './html.js';

/** Week › Growth: the owner's list of what assistants noticed, and their reactions to it. */
export function growthRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);

  router.get('/growth', owner, (_req, res) => {
    if (d.mode === 'work') return res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { nav: true, tab: null }));
    res.status(200).type('html').send(page('Growth', growthView(d.growth.list()), { nav: true, tab: 'week', section: 'growth' }));
  });

  router.get('/settings/growth', owner, (_req, res) => {
    if (d.mode === 'work') return res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { nav: true, tab: null }));
    res.redirect(301, '/growth');
  });

  const react = (req: Request, res: Response) => {
    const id = req.params.id as string;
    const raw = typeof req.body?.reaction === 'string' ? req.body.reaction : '';
    if (raw !== 'clear' && !(REACTIONS as readonly string[]).includes(raw)) {
      res.status(400).type('html').send(page('Bad request', html`<h1>Bad request</h1>`, { nav: true, tab: null }));
      return;
    }
    try {
      d.growth.react(id, raw === 'clear' ? null : (raw as Reaction));
    } catch (e) {
      if (e instanceof GrowthError && e.code === 'not_found') {
        res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { nav: true, tab: null }));
        return;
      }
      throw e;
    }
    // Agree / Disagree in a weekly review returns to it.
    res.redirect(303, safeBack(req.body?.back) ?? `/growth#o-${encodeURIComponent(id)}`);
  };
  router.post('/growth/:id/react', owner, react);
  router.post('/settings/growth/:id/react', owner, react);

  return router;
}
