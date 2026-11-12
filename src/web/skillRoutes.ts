/** Shared skills (round 2 §17c): Pages › Skills and the proposal answers. Owner only. */
import { Router, type Request, type Response } from 'express';
import { renderMarkdown } from '../pages/markdown.js';
import { SkillError } from '../skills/service.js';
import type { SkillFile } from '../skills/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { html, page, type SafeHtml } from './html.js';
import { proposalCard, skillEditView, skillFileView, skillHistoryView, skillsListView, skillView, type SkillForm } from './skillViews.js';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The files as the editor posts them: parallel file_path / file_text lists, minus removed and empty rows. */
function postedFiles(body: Record<string, unknown>): SkillFile[] {
  const paths = list(body.file_path);
  const texts = list(body.file_text);
  const removed = new Set(list(body.file_remove));
  return paths.map((path, i) => ({ path: path.trim(), text: (texts[i] ?? '').replace(/\r\n/g, '\n') }))
    .filter((f) => f.path !== '' && !removed.has(f.path));
}

export function skillRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const send = (res: Response, status: number, title: string, body: SafeHtml, back?: { href: string; label: string }) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: 'pages', back }));
  const missing = (res: Response) => send(res, 404, 'Not found', html`<h1>Not found</h1><p>No such skill.</p>`);
  const skill = (req: Request) => d.skills.get(req.params.id as string);
  const status = (e: SkillError) => (e.code === 'changed' ? 409 : e.code === 'not_found' ? 404 : 400);
  const form = (req: Request, id?: string): SkillForm => ({
    id, base: id ? Number(req.body.base) : undefined, name: str(req.body.name), description: str(req.body.description),
    body: str(req.body.body).replace(/\r\n/g, '\n'), files: postedFiles(req.body),
  });

  const liveDevices = () => d.devices.list().filter((x) => x.revokedAt === null);
  const deviceName = (id: string) => d.devices.list().find((x) => x.id === id)?.name ?? 'a device';
  const folds = () => liveDevices().map((x) => ({ deviceId: x.id, deviceName: x.name, items: d.skillSync.fromDevice(x.id) })).filter((x) => x.items.length > 0);
  router.get('/skills', owner, (_req, res) => send(res, 200, 'Skills', skillsListView(d.skills.list(), folds())));
  router.post('/skills/share', owner, (req, res) => {
    try {
      const s = d.skillSync.share(str(req.body.device), str(req.body.name));
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), 'Skills', skillsListView(d.skills.list(), folds(), e.message));
    }
  });
  const choice = (fn: (id: string, device: string) => unknown) => (req: Request, res: Response) => {
    const s = skill(req);
    if (!s) return missing(res);
    try {
      fn(s.id, str(req.body.device));
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), s.name, html`<p class="error" role="alert">${e.message}</p><p><a href="/skills/${s.id}">Back to ${s.name}</a></p>`, { href: '/skills', label: 'Skills' });
    }
  };
  router.post('/skills/:id/take-device', owner, choice((id, device) => d.skillSync.takeMac(id, device)));
  router.post('/skills/:id/keep', owner, choice((id, device) => d.skillSync.keepBrain(id, device)));
  router.get('/skills/new', owner, (_req, res) => send(res, 200, 'New skill', skillEditView({ name: '', description: '', body: '', files: [] }), { href: '/skills', label: 'Skills' }));
  router.post('/skills', owner, (req, res) => {
    const v = form(req);
    try {
      const s = d.skills.create(v, 'owner');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), 'New skill', skillEditView({ ...v, error: e.message }), { href: '/skills', label: 'Skills' });
    }
  });

  router.get('/skills/:id', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    const lines = d.skillSync.stateFor(s.id).filter((x) => liveDevices().some((v) => v.id === x.deviceId)).map((x) => ({ ...x, deviceName: deviceName(x.deviceId) }));
    send(res, 200, s.name, skillView(s, renderMarkdown(s.body, d.pages.resolver()), d.skills.versions(s.id).length, lines), { href: '/skills', label: 'Skills' });
  });
  router.post('/skills/:id/enabled', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    d.skills.setEnabled(s.id, req.body.on === '1', 'owner');
    res.redirect(303, `/skills/${s.id}`);
  });
  router.get('/skills/:id/edit', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    send(res, 200, `Edit ${s.name}`, skillEditView({ id: s.id, base: s.version, name: s.name, description: s.description, body: s.body, files: s.files }), { href: `/skills/${s.id}`, label: s.name });
  });
  router.post('/skills/:id', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    const v = form(req, s.id);
    try {
      d.skills.update(s.id, { base: v.base!, name: v.name, description: v.description, body: v.body, files: v.files }, 'owner');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      // Changed meanwhile: the draft stays, on the version there now, so saving again keeps the owner's text.
      const base = e.code === 'changed' ? d.skills.get(s.id)!.version : v.base;
      const message = e.code === 'changed' ? `${e.message} Your text is below: save again to keep it, or open the skill to see the other change.` : e.message;
      send(res, status(e), `Edit ${s.name}`, skillEditView({ ...v, base, error: message }), { href: `/skills/${s.id}`, label: s.name });
    }
  });
  router.get('/skills/:id/history', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    send(res, 200, `History · ${s.name}`, skillHistoryView(s, d.skills.versions(s.id)), { href: `/skills/${s.id}`, label: s.name });
  });
  router.post('/skills/:id/restore', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    try {
      d.skills.restore(s.id, Number(req.body.version), 'owner');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), `History · ${s.name}`, html`<p class="error" role="alert">${e.message}</p>${skillHistoryView(s, d.skills.versions(s.id))}`, { href: `/skills/${s.id}`, label: s.name });
    }
  });
  router.post('/skills/:id/delete', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    d.skills.remove(s.id, 'owner');
    res.redirect(303, '/skills');
  });
  router.get('/skills/:id/files', owner, (req, res) => {
    const s = skill(req);
    const f = s?.files.find((x) => x.path === req.query.path);
    if (!s || !f) return missing(res);
    send(res, 200, f.path, skillFileView(s, f), { href: `/skills/${s.id}`, label: s.name });
  });

  // ---- Proposals (Approvals) ----
  const answered = (res: Response, e: SkillError) =>
    send(res, status(e), 'Inbox', html`<h1>Inbox</h1><p class="error" role="alert">${e.message}</p><p><a href="/approvals">Back to the Inbox</a></p>`, { href: '/approvals', label: 'Inbox' });
  router.post('/skill-proposals/:id/add', owner, (req, res) => {
    try {
      const s = d.skills.addProposal(req.params.id as string, req.body.on === '1');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      answered(res, e);
    }
  });
  router.post('/skill-proposals/:id/apply', owner, (req, res) => {
    try {
      const s = d.skills.applyProposal(req.params.id as string, req.body.confirm === '1');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      const p = d.skills.proposal(req.params.id as string);
      if (e.code !== 'changed' || !p || !p.skillId) return answered(res, e);
      // The skill moved on since: the same card again, saying so, with Apply it confirming.
      send(res, 409, 'Inbox', html`<div class="narrow approvals"><h1>Inbox</h1>${proposalCard(p, d.skills.get(p.skillId), { changed: e.message })}</div>`, { href: '/approvals', label: 'Inbox' });
    }
  });
  router.post('/skill-proposals/:id/reject', owner, (req, res) => {
    try {
      d.skills.rejectProposal(req.params.id as string);
      res.redirect(303, '/approvals');
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      answered(res, e);
    }
  });
  return router;
}
