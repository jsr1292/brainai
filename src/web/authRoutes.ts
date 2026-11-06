import { Router, type Request, type RequestHandler, type Response } from 'express';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { InvalidNameError } from '../auth/clientsStore.js';
import type { PendingInfo } from '../auth/provider.js';
import type { Access } from '../discussions/types.js';
import { DEVICE_DAYS, SESSION_DAYS, type SessionStore } from '../auth/sessions.js';
import { PROJECT_RE } from '../memory/service.js';
import type { AppDeps } from './app.js';
import { projectChoices } from './dashboardViews.js';
import { rateLimitKey } from './clientIp.js';
import { html, memoryName, page, type SafeHtml } from './html.js';

export const SESSION_COOKIE = 'mem_session';
/** Marks a browser the owner has logged in from, so the login limit shared by all addresses does not apply to it. */
const DEVICE_COOKIE = 'mem_device';
const NOT_CONFIGURED = 'Set up the owner account first with the CLI';
const WRONG_CREDENTIALS = 'Wrong password or code';
const EXPIRED = 'This request expired. Start the connection again from the app.';

/** Attributes of the session cookie; clearing it must use the same ones. */
export function sessionCookieOptions(publicUrl: URL) {
  return { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: publicUrl.protocol === 'https:' };
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Lets the request through only with a valid owner session; otherwise sends the browser to log in. */
export function requireOwner(sessions: SessionStore): RequestHandler {
  return (req, res, next) => {
    if (sessions.isValid(readCookie(req, SESSION_COOKIE))) return next();
    res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
  };
}

/** A local path to return to after login: one leading slash, then printable ASCII only (no `//`, `/\`, tabs or newlines). */
function safeNext(value: unknown): string | undefined {
  return typeof value === 'string' && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : undefined;
}

const field = (body: unknown, name: string): string => {
  const v = (body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};

/** A form's ticked checkboxes: none, one (a string) or several (an array of strings). */
export const ticked = (body: unknown, name: string): string[] => {
  const v = (body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * The project names picked for read-only access, if every one is an existing project; undefined when none was picked
 * or one does not exist.
 */
export function pickedProjects(body: unknown, existing: string[]): string[] | undefined {
  const picked = [...new Set(ticked(body, 'projects'))];
  return picked.length > 0 && picked.every((p) => PROJECT_RE.test(p) && existing.includes(p)) ? picked : undefined;
}

export const PICK_A_PROJECT = 'Tick at least one project for read-only access.';


function send(res: Response, status: number, title: string, body: SafeHtml, nav = false): void {
  res.status(status).type('html').send(page(title, body, { nav, tab: null }));
}

/** Runs one task at a time, in arrival order. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

type LoginOutcome = { kind: 'ok' } | { kind: 'failed' } | { kind: 'blocked'; retryAfterSec: number };

export function authRoutes(d: AppDeps): Router {
  const router = Router();
  // LoginLimiter.check doesn't consume points, so attempts must not overlap while argon2 awaits:
  // otherwise a parallel burst would all pass check() before any fail() lands.
  const loginLock = new Mutex();
  const cookieOptions = sessionCookieOptions(d.publicUrl);

  const loginForm = (status: number, res: Response, next: string, error?: string) =>
    send(res, status, 'Log in', html`<h1 class="login-mark"><span class="brand-dot" aria-hidden="true"></span>${memoryName()}</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="/login">
  <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
  <label>6-digit code <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>
  <input type="hidden" name="next" value="${next}">
  <button type="submit" class="primary">Log in</button>
</form>`);

  const notConfigured = (res: Response) => send(res, 503, 'Log in', html`<h1>${memoryName()}</h1><p>${NOT_CONFIGURED}.</p>`);

  router.get('/login', (req, res) => {
    if (!d.owner.isConfigured()) return notConfigured(res);
    // The login form without a live session: the login ended here, elsewhere, or simply expired (and the browser
    // dropped the cookie with it). The cache may still hold pictures, so it is cleared; storage (the offline queue,
    // later) is left alone. Clearing an empty cache costs nothing.
    if (!d.sessions.isValid(readCookie(req, SESSION_COOKIE))) res.set('Clear-Site-Data', '"cache"');
    loginForm(200, res, safeNext(req.query.next) ?? '');
  });

  router.post('/login', async (req, res) => {
    if (!d.owner.isConfigured()) return notConfigured(res);
    const ip = rateLimitKey(req);
    const next = safeNext(field(req.body, 'next'));
    const knownDevice = d.sessions.isKnownDevice(readCookie(req, DEVICE_COOKIE));
    const outcome = await loginLock.run(async (): Promise<LoginOutcome> => {
      const gate = await d.limiter.check(ip, { knownDevice });
      if (!gate.allowed) return { kind: 'blocked', retryAfterSec: gate.retryAfterSec };
      // The code is only checked (and its step consumed) once the password is right.
      const ok = (await d.owner.verifyPassword(field(req.body, 'password'))) && d.owner.verifyTotp(field(req.body, 'code').trim());
      if (!ok) {
        await d.limiter.fail(ip);
        return { kind: 'failed' };
      }
      await d.limiter.succeed(ip);
      return { kind: 'ok' };
    });

    if (outcome.kind === 'blocked') {
      const minutes = Math.max(1, Math.ceil(outcome.retryAfterSec / 60));
      res.set('Retry-After', String(outcome.retryAfterSec));
      return send(res, 429, 'Too many attempts', html`<h1>Too many attempts</h1>
<p>Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.</p>`);
    }
    if (outcome.kind === 'failed') return loginForm(401, res, next ?? '', WRONG_CREDENTIALS);

    const token = d.sessions.create(req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_DAYS * 86_400_000 });
    if (!knownDevice) res.cookie(DEVICE_COOKIE, d.sessions.rememberDevice(), { ...cookieOptions, maxAge: DEVICE_DAYS * 86_400_000 });
    res.redirect(302, next ?? '/');
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) d.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    // One logout: the browser drops what it kept for this login (pictures, drawn diagrams).
    res.set('Clear-Site-Data', '"cache", "storage"');
    res.redirect(302, '/login');
  });

  const owner = requireOwner(d.sessions);
  const expired = (res: Response) => send(res, 404, 'Request expired', html`<h1>Request expired</h1><p>${EXPIRED}</p>`, true);

  const consentPage = (res: Response, status: number, id: string, pending: PendingInfo, name: string, message?: string, access: Access | null = pending.suggestedAccess, picked: string[] = []) => {
    const origin = new URL(pending.redirectUri).origin;
    const work = d.mode === 'work';
    send(res, status, 'Allow access?', html`<h1>${pending.clientName} wants access to your ${work ? 'work memory' : 'shared memory'}</h1>
<p>It will send you back to: <strong>${origin}</strong></p>
${message ? html`<p class="error" role="alert">${message}</p>` : ''}
<form method="post" action="/consent/${id}">
  <p><label>Name <input type="text" name="name" value="${name}" maxlength="100" required></label></p>
  ${work ? html`<input type="hidden" name="access" value="full">` : html`<p><label class="choice"><input type="radio" name="access" value="full" required${access === 'full' ? ' checked' : ''}> Full access: memory and discussions</label></p>
  <p><label class="choice"><input type="radio" name="access" value="discussions" required${access === 'discussions' ? ' checked' : ''}> Discussions only: no access to your profile or memories</label></p>
  <p><label class="choice"><input type="radio" name="access" value="projects" required${access === 'projects' ? ' checked' : ''}> Read only, chosen projects: no profile, no saving, no discussions</label></p>
  ${projectChoices(d.service.listProjects().map((p) => p.project), picked)}`}
  <div class="actions">
    <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
  </div>
</form>`, true);
  };

  router.get('/consent/:id', owner, (req, res) => {
    const id = req.params.id as string;
    const pending = d.provider.getPending(id);
    if (!pending) return expired(res);
    consentPage(res, 200, id, pending, pending.clientName);
  });

  router.post('/consent/:id', owner, async (req, res) => {
    const id = req.params.id as string;
    const decision = field(req.body, 'decision');
    if (decision !== 'approve' && decision !== 'deny') {
      return send(res, 400, 'Bad request', html`<h1>Bad request</h1><p>Choose Approve or Deny.</p>`, true);
    }
    const pending = d.provider.getPending(id);
    if (!pending) return expired(res);
    const body = req.body as Record<string, unknown> | undefined;
    // Missing fields keep the defaults (current name, full access); a value that is present must be valid.
    // With no suggestion (one app connected at different levels), the owner must choose.
    if (decision === 'approve' && body?.access === undefined && pending.suggestedAccess === null && d.mode !== 'work') {
      return consentPage(res, 400, id, pending, field(body, 'name') || pending.clientName, 'Choose an access level.');
    }
    const access = body?.access === undefined ? 'full' : body.access;
    if (decision === 'approve' && access !== 'full' && access !== 'discussions' && (access !== 'projects' || d.mode === 'work')) {
      return send(res, 400, 'Bad request', html`<h1>Bad request</h1><p>Choose Full access, Discussions only or Read only.</p>`, true);
    }
    if (decision === 'approve' && body?.name !== undefined && typeof body.name !== 'string') {
      return send(res, 400, 'Bad request', html`<h1>Bad request</h1><p>Enter one name.</p>`, true);
    }
    const name = body?.name as string | undefined;
    const projects = access === 'projects' ? pickedProjects(body, d.service.listProjects().map((p) => p.project)) : undefined;
    if (decision === 'approve' && access === 'projects' && !projects) {
      return consentPage(res, 400, id, pending, name ?? pending.clientName, PICK_A_PROJECT, 'projects', ticked(body, 'projects'));
    }
    let location: string;
    try {
      location = decision === 'approve' ? await d.provider.approvePending(id, { name, access: access as Access, projects }) : d.provider.denyPending(id);
    } catch (e) {
      if (e instanceof InvalidNameError) return consentPage(res, 400, id, pending, name ?? pending.clientName, e.message, access as Access, projects);
      if (!(e instanceof InvalidRequestError)) throw e;
      return send(res, 400, 'Cannot approve', html`<h1>Cannot complete this request</h1><p>${e.message}. ${EXPIRED}</p>`, true);
    }
    res.redirect(302, location);
  });

  return router;
}
