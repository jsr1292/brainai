/** Shared skills (round 2 §17c): Pages › Skills and the proposal answers. Owner only. */
import { Router, type Request, type Response } from 'express';
import { renderMarkdown } from '../pages/markdown.js';
import { SkillError } from '../skills/service.js';
import type { SkillFile } from '../skills/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { nextHref, type BackTarget } from './back.js';
import { errorText } from './errorText.js';
import { t } from '../i18n/index.js';
import { noteDecision } from './inboxUndo.js';
import { invalidateSideStatus } from './sideStatus.js';
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
  const send = (res: Response, status: number, title: string, body: SafeHtml, back?: BackTarget) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: 'pages', section: 'skills', back }));
  const missing = (res: Response) => send(res, 404, t('common.notFound'), html`<h1>${t('common.notFound')}</h1><p>${t('skills.noSuch')}</p>`);
  const skill = (req: Request) => d.skills.get(req.params.id as string);
  const status = (e: SkillError) => (e.code === 'changed' ? 409 : e.code === 'not_found' ? 404 : 400);
  const form = (req: Request, id?: string): SkillForm => ({
    id, base: id ? Number(req.body.base) : undefined, name: str(req.body.name), description: str(req.body.description),
    body: str(req.body.body).replace(/\r\n/g, '\n'), files: postedFiles(req.body),
  });

  const liveDevices = () => d.devices.list().filter((x) => x.revokedAt === null);
  const deviceName = (id: string) => d.devices.list().find((x) => x.id === id)?.name ?? t('skills.aDevice');
  const folds = () => liveDevices().map((x) => ({ deviceId: x.id, deviceName: x.name, items: d.skillSync.fromDevice(x.id) })).filter((x) => x.items.length > 0);
  router.get('/skills', owner, (_req, res) => send(res, 200, t('skills.title'), skillsListView(d.skills.list(), folds())));
  router.post('/skills/share', owner, (req, res) => {
    try {
      const s = d.skillSync.share(str(req.body.device), str(req.body.name));
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), t('skills.title'), skillsListView(d.skills.list(), folds(), errorText(e)));
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
      send(res, status(e), s.name, html`<p class="error" role="alert">${errorText(e)}</p><p><a href="/skills/${s.id}">${t('skills.backTo', { name: s.name })}</a></p>`, { href: '/skills', labelKey: 'shell.nav.skills' });
    }
  };
  router.post('/skills/:id/take-device', owner, choice((id, device) => d.skillSync.takeMac(id, device)));
  router.post('/skills/:id/keep', owner, choice((id, device) => d.skillSync.keepBrain(id, device)));
  router.get('/skills/new', owner, (_req, res) => send(res, 200, t('skills.new'), skillEditView({ name: '', description: '', body: '', files: [] }), { href: '/skills', labelKey: 'shell.nav.skills' }));
  router.post('/skills', owner, (req, res) => {
    const v = form(req);
    try {
      const s = d.skills.create(v, 'owner');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), t('skills.new'), skillEditView({ ...v, error: errorText(e) }), { href: '/skills', labelKey: 'shell.nav.skills' });
    }
  });

  router.get('/skills/:id', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    const lines = d.skillSync.stateFor(s.id).filter((x) => liveDevices().some((v) => v.id === x.deviceId)).map((x) => ({ ...x, deviceName: deviceName(x.deviceId) }));
    send(res, 200, s.name, skillView(s, renderMarkdown(s.body, d.pages.resolver()), d.skills.versions(s.id).length, lines), { href: '/skills', labelKey: 'shell.nav.skills' });
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
    send(res, 200, t('skills.editName', { name: s.name }), skillEditView({ id: s.id, base: s.version, name: s.name, description: s.description, body: s.body, files: s.files }), { href: `/skills/${s.id}`, label: s.name });
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
      const message = e.code === 'changed' ? t('skills.changedDraft', { message: errorText(e) }) : errorText(e);
      send(res, status(e), t('skills.editName', { name: s.name }), skillEditView({ ...v, base, error: message }), { href: `/skills/${s.id}`, label: s.name });
    }
  });
  router.get('/skills/:id/history', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    send(res, 200, t('skills.historyTitle', { name: s.name }), skillHistoryView(s, d.skills.versions(s.id)), { href: `/skills/${s.id}`, label: s.name });
  });
  router.post('/skills/:id/restore', owner, (req, res) => {
    const s = skill(req);
    if (!s) return missing(res);
    try {
      d.skills.restore(s.id, Number(req.body.version), 'owner');
      res.redirect(303, `/skills/${s.id}`);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      send(res, status(e), t('skills.historyTitle', { name: s.name }), html`<p class="error" role="alert">${errorText(e)}</p>${skillHistoryView(s, d.skills.versions(s.id))}`, { href: `/skills/${s.id}`, label: s.name });
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
    send(res, status(e), t('shell.nav.inbox'), html`<h1>${t('shell.nav.inbox')}</h1><p class="error" role="alert">${errorText(e)}</p><p><a href="/approvals">${t('skills.backToInbox')}</a></p>`, { href: '/approvals', labelKey: 'shell.nav.inbox' });
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
      send(res, 409, t('shell.nav.inbox'), html`<div class="narrow approvals"><h1>${t('shell.nav.inbox')}</h1>${proposalCard(p, d.skills.get(p.skillId), { changed: errorText(e) })}</div>`, { href: '/approvals', labelKey: 'shell.nav.inbox' });
    }
  });
  router.post('/skill-proposals/:id/reject', owner, (req, res) => {
    try {
      d.skills.rejectProposal(req.params.id as string);
      noteDecision(d.service, { id: req.params.id as string, at: d.now().getTime(), message: t('inbox.said.rejected'), undo: { kind: 'reject-proposal' } });
      invalidateSideStatus();
      res.redirect(303, nextHref(req.body?.next) ?? '/approvals');
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      answered(res, e);
    }
  });
  return router;
}
