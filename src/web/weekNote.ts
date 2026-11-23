/** The desktop app's Monday notice: the one line the app shows as a notification when last week's review is ready. */
import { Router } from 'express';
import type { MemoryStore } from '../memory/store.js';
import type { AppDeps } from './app.js';
import { appKeyCheck } from './authRoutes.js';
import { viaDoor } from '../desktop/publicDoor.js';
import { mondayNote } from './mondayCard.js';

/** The owner's choice (brain_switches): the notice is on unless the row says 'off'. */
export const WEEK_NOTICE_SWITCH = 'week_notice';
export const weekNoticeOn = (store: Pick<MemoryStore, 'switchValue'>): boolean => store.switchValue(WEEK_NOTICE_SWITCH) !== 'off';

export function weekNoteRoutes(d: AppDeps): Router {
  const router = Router();
  const fromApp = appKeyCheck(d);
  /** Local only, the app's key only. 204: nothing to say (switch off, or the same decision as the Monday line says no). */
  router.get('/app/week-note', (req, res, next) => {
    if (viaDoor(req)) return next('router');
    if (!fromApp(req)) return next('router'); // like an unknown page, as the other /app endpoints
    res.set('Cache-Control', 'no-store');
    if (!weekNoticeOn(d.store)) return res.status(204).end();
    const note = mondayNote(d);
    if (!note) return res.status(204).end();
    res.json(note);
  });
  return router;
}
