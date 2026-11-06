import { Router, type Request, type Response } from 'express';
import { MemoryError } from '../memory/service.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { discussionsView, discussionView, type Drafts } from './discussionViews.js';
import { html, page, type SafeHtml } from './html.js';
import { invalidateSideStatus } from './sideStatus.js';
import { deskSideView, nextForYou } from './deskSide.js';

const str = (req: Request, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};

/** The owner's side of discussions: the Discussions tab and one discussion. */
export function discussionRoutes(d: AppDeps): Router {
  const router = Router();
  // Guard per route, not router.use: unknown paths must still fall through to the 404 page.
  const owner = requireOwner(d.sessions);

  const send = (res: Response, status: number, title: string, body: SafeHtml, back?: { href: string; label: string }) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: title === 'Not found' ? null : 'projects', back: back ?? (title === 'Discussions' ? { href: '/', label: 'Projects' } : undefined) }));
  const notFound = (res: Response) => send(res, 404, 'Not found', html`<h1>Not found</h1>`);

  /** The discussion page, or a 404 when it is missing or removed. */
  const show = (res: Response, id: string, status = 200, error?: string, drafts?: Drafts) => {
    try {
      const projects = d.service.listProjects().map((p) => p.project);
      const discussion = d.discussions.ownerView(id);
      const name = discussion.project ? d.service.projectNamed(discussion.project) : undefined;
      send(res, status, 'Discussion', discussionView(discussion, projects, error, drafts), name ? { href: `/?project=${encodeURIComponent(name)}#panel`, label: name } : { href: '/discussions', label: 'Discussions' });
    } catch (e) {
      if (e instanceof MemoryError && e.code === 'not_found') return notFound(res);
      throw e;
    }
  };

  /** Runs an owner action, then goes back to the page. A MemoryError shows the page again with its message. */
  const act = async (req: Request, res: Response, action: () => unknown, drafts?: Drafts, to?: string) => {
    const id = req.params.id as string;
    try {
      await action();
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      return e.code === 'not_found' ? notFound(res) : show(res, id, 400, e.message, drafts);
    }
    // Any owner action (decide, delete, round, ask, note, sharing) can change what waits on the owner: the sidebar's
    // needs-you dot is worked out again on the next page.
    invalidateSideStatus();
    res.redirect(303, to ?? `/discussions/${id}`);
  };

  router.get('/discussions', owner, (_req, res) => send(res, 200, 'Discussions', discussionsView(d.discussions.ownerList())));

  router.get('/discussions/:id', owner, (req, res) => {
    const id = req.params.id as string;
    // Desktop only (desk.js): the side fragment beside the discussion sheet, its Next for you. A missing one: empty 404.
    if (req.query.pane === 'side') {
      try {
        d.discussions.ownerView(id);
      } catch (e) {
        if (e instanceof MemoryError && e.code === 'not_found') return res.status(404).type('html').send('');
        throw e;
      }
      return res.type('html').send(deskSideView({ next: nextForYou(d, { kind: 'discussion', id }) }).value);
    }
    show(res, id);
  });

  router.get('/discussions/:id/files/:name', owner, (req, res) => {
    try {
      const text = d.discussions.ownerFile(req.params.id as string, req.params.name as string);
      res.set('Content-Type', 'text/plain; charset=utf-8').set('Content-Disposition', 'inline').send(text);
    } catch (e) {
      if (e instanceof MemoryError && e.code === 'not_found') return notFound(res);
      throw e;
    }
  });

  router.post('/discussions/:id/note', owner, (req, res) => {
    const text = str(req, 'text');
    return act(req, res, () => d.discussions.addNote(req.params.id as string, text), { note: text });
  });

  router.post('/discussions/:id/round', owner, (req, res) =>
    act(req, res, () => d.discussions.nextRound(req.params.id as string)));

  router.post('/discussions/:id/ask', owner, (req, res) => act(req, res, () => {
    const id = req.params.id as string;
    const add = str(req, 'add').trim();
    const remove = str(req, 'remove').trim().toLowerCase();
    if (add === '' && remove === '') throw new MemoryError('invalid', 'Give a name to add or remove.');
    const current = d.discussions.ownerView(id).ask;
    d.discussions.setAsk(id, add !== '' ? [...current, add] : current.filter((n) => n.trim().toLowerCase() !== remove));
  }));

  router.post('/discussions/:id/sharing', owner, (req, res) => act(req, res, () => {
    const include = str(req, 'include');
    if (include !== 'yes' && include !== 'no') throw new MemoryError('invalid', 'Choose whether to share with discussions-only assistants.');
    d.discussions.setIncludeLimited(req.params.id as string, include === 'yes');
  }));

  router.post('/discussions/:id/decide', owner, (req, res) => {
    const decision = str(req, 'decision');
    const project = str(req, 'project');
    return act(req, res, async () => {
      await d.discussions.close('owner', req.params.id as string, { decision, project });
    }, { decision, project });
  });

  router.post('/discussions/:id/delete', owner, (req, res) => act(req, res, () => {
    const id = req.params.id as string;
    d.discussions.ownerView(id); // a missing discussion is a 404 before anything else
    if (str(req, 'confirm') !== 'yes') throw new MemoryError('invalid', 'Tick the box to confirm the delete.');
    d.discussions.remove(id);
  }, undefined, '/discussions'));

  return router;
}
