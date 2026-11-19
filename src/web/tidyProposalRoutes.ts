/** B2: answering a tidy proposal in the Inbox. Owner only; the same same-origin protections as every other answer. */
import { Router, type Request } from 'express';
import { TidyError } from '../memory/tidyService.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { nextHref } from './back.js';
import { noteDecision } from './inboxUndo.js';
import { makeInbox } from './inboxPage.js';
import { invalidateSideStatus } from './sideStatus.js';
import { t, tKey } from '../i18n/core.js';
import { errorText } from './errorText.js';

const str = (req: Request, k: string): string => (typeof req.body?.[k] === 'string' ? (req.body[k] as string) : '');

export function tidyProposalRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const inbox = makeInbox(d);
  const refused = (res: Parameters<typeof inbox.render>[0], e: TidyError, id: string) =>
    inbox.render(res, { status: e.code === 'changed' || e.code === 'page' ? 409 : e.code === 'not_found' ? 404 : 400, error: errorText(e), pick: { tidyProposal: id } });

  router.post('/tidy-proposals/:id/approve', owner, async (req, res) => {
    const id = req.params.id as string;
    try {
      const r = await d.tidy.approve(id, { retire: str(req, 'retire') === '1' });
      invalidateSideStatus();
      noteDecision(d.service, { id, at: d.now().getTime(), message: tKey(r.say.key, r.say.params), undo: r.undoable ? { kind: 'tidy-approved' } : undefined });
      res.redirect(303, nextHref(str(req, 'next')) ?? '/approvals');
    } catch (e) {
      if (!(e instanceof TidyError)) throw e;
      refused(res, e, id);
    }
  });

  router.post('/tidy-proposals/:id/reject', owner, (req, res) => {
    const id = req.params.id as string;
    try {
      const dismissing = d.tidy.get(id) !== undefined && d.tidy.staleReason(d.tidy.get(id)!) !== null;
      d.tidy.reject(id);
      invalidateSideStatus();
      noteDecision(d.service, { id, at: d.now().getTime(), message: dismissing ? t('inbox.said.dismissed') : t('inbox.said.rejected'), undo: { kind: 'tidy-rejected' } });
      res.redirect(303, nextHref(str(req, 'next')) ?? '/approvals');
    } catch (e) {
      if (!(e instanceof TidyError)) throw e;
      refused(res, e, id);
    }
  });
  return router;
}
