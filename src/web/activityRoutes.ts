import { Router, type Request, type Response } from 'express';
import { MemoryError } from '../memory/service.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { activityView, ALREADY_BACK, CHANGED_SINCE, UNDONE_SAID, type ActivityRowView } from './activityViews.js';
import { pageEditSummary } from './pageEditSummary.js';
import { html, page } from './html.js';

const OWNER = { type: 'owner' } as const;
const KINDS = ['saved', 'updated', 'deleted', 'replaced'] as const;
type UndoKind = (typeof KINDS)[number];

/** Week › Activity: what assistants saved or changed, with Undo (the owner's own changes are never listed). */
export function activityRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);

  const pageNumber = (v: unknown): number => {
    const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : 1;
    return n >= 1 ? n : 1;
  };
  /** Only an assistant that appears in the feed can be filtered on; anything else is no filter. */
  const assistant = (v: unknown, known: string[]): string | undefined => (typeof v === 'string' && known.includes(v) ? v : undefined);

  const show = (res: Response, status: number, q: { by?: unknown; page?: unknown }, extra: { said?: string; error?: string; factId?: string } = {}) => {
    const known = d.store.activityAssistants();
    const by = assistant(q.by, known);
    const pg = pageNumber(q.page);
    const feed = d.store.assistantActivity({ by, page: pg });
    const rows = feed.rows.map((r): ActivityRowView => {
      if (r.kind === 'page') {
        const now = r.pageVersion !== null && r.pageVersion > 1 ? d.pages.version(r.pageId!, r.pageVersion) : undefined;
        const before = now ? d.pages.version(r.pageId!, r.pageVersion! - 1) : undefined;
        const renamed = now && before && now.title !== before.title ? before.title : null;
        return { ...r, edit: now && before ? pageEditSummary(before.body, now.body) : null, renamedFrom: renamed };
      }
      return r.undoable ? r : { ...r, why: d.store.activityWhyNot(r.kind, r.memoryId, r.kind === 'saved' ? r.memoryId! : r.kind === 'replaced' ? r.supersessionId! : r.historyId!) };
    });
    res.status(status).type('html').send(page('Activity', activityView({ ...feed, rows, assistants: known, by, page: pg, now: d.now(), ...extra }), { nav: true, tab: 'week', section: 'activity' }));
  };

  router.get('/activity', owner, (req, res) => {
    const said = typeof req.query.undone === 'string' ? UNDONE_SAID[req.query.undone] : undefined;
    // A refused Undo comes back here (post, redirect, get) with its reason and the fact it was about.
    const refused = req.query.refused === 'changed' ? CHANGED_SINCE : req.query.refused === 'back' ? ALREADY_BACK : undefined;
    const factId = typeof req.query.fact === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.query.fact) ? req.query.fact : undefined;
    show(res, 200, req.query, { said, error: refused, factId: refused ? factId : undefined });
  });

  router.post('/activity/undo', owner, async (req: Request, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === 'string' && (KINDS as readonly string[]).includes(body.kind) ? (body.kind as UndoKind) : undefined;
    const ref = typeof body.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.ref) ? body.ref : undefined;
    if (!kind || !ref || (kind !== 'saved' && !/^\d{1,15}$/.test(ref))) {
      return void res.status(400).type('html').send(page('Bad request', html`<h1>Bad request</h1>`, { nav: true, tab: 'week', section: 'activity' }));
    }
    const back = (extra?: string) => `/activity?${[
      typeof body.by === 'string' && body.by !== '' ? `by=${encodeURIComponent(body.by)}` : '', `page=${pageNumber(body.page)}`, extra ?? '',
    ].filter(Boolean).join('&')}`;
    // The same rule the rows were drawn with: refused, with a plain message, when the fact changed since.
    if (!d.store.activityUndoable(kind, ref)) {
      const fact = kind === 'saved' ? ref : kind === 'replaced' ? d.store.supersessions.get(Number(ref))?.oldId : d.store.historyEntry(Number(ref))?.memoryId;
      if (!fact) return show(res, 409, body, { error: kind === 'replaced' ? ALREADY_BACK : CHANGED_SINCE });
      return void res.redirect(303, back(`refused=${kind === 'replaced' ? 'back' : 'changed'}&fact=${encodeURIComponent(fact)}`));
    }
    try {
      if (kind === 'saved') d.service.undoSaved(ref, OWNER);
      else if (kind === 'replaced') await d.service.undoSupersession(Number(ref), OWNER);
      else await d.service.undo(Number(ref), OWNER);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return show(res, e.code === 'not_found' ? 404 : 409, body, { error: `Not undone: ${e.message}` });
    }
    res.redirect(303, back(`undone=${kind}`));
  });

  return router;
}
