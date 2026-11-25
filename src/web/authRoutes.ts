import { dirname, join } from 'node:path';
import { temporaryHomePort } from '../desktop/homePort.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { InvalidNameError } from '../auth/clientsStore.js';
import { PENDING_TTL_SEC, type PendingInfo } from '../auth/provider.js';
import type { Access } from '../discussions/types.js';
import { DEVICE_DAYS, sessionDays, type SessionStore } from '../auth/sessions.js';
import { PROJECT_RE } from '../memory/service.js';
import type { AppDeps } from './app.js';
import { projectChoices } from './dashboardViews.js';
import { rateLimitKey } from './clientIp.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';
import { isAppPath, viaDoor } from '../desktop/publicDoor.js';
import { html, memoryName, page, type SafeHtml } from './html.js';
import { approvedView, deniedView, waitingView } from './consentViews.js';

export const SESSION_COOKIE = 'mem_session';
/** Marks a browser the owner has logged in from, so the login limit shared by all addresses does not apply to it. */
const DEVICE_COOKIE = 'mem_device';

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

/**
 * Where to come back to after logging in. A page view: that page. A form POST has no page of its own (landing on its URL
 * is "Not found" or a second send): the page the form came from, when the browser says so (Referer, this host only).
 */
export function returnPath(req: Request): string {
  if (req.method === 'GET' || req.method === 'HEAD') return req.originalUrl;
  try {
    const from = new URL(req.get('referer') ?? '');
    if (from.host.toLowerCase() !== String(req.get('host') ?? '').toLowerCase()) return '/';
    let path = from.pathname + from.search;
    // A page drawn by a POST to its own URL (Preview, a refused save, a conflict) is the editor: go back to it.
    const own = req.originalUrl.split('?')[0]!;
    if (from.pathname === own) {
      const section = (req.body as Record<string, unknown> | undefined)?.section;
      const anchor = typeof section === 'string' && /^[\p{L}\p{N}_-]+$/u.test(section) ? `?section=${encodeURIComponent(section)}` : '';
      if (own === '/pages') path = '/pages/new';
      else if (/^\/pages\/[^/]+$/.test(own)) path = `${own}/edit${anchor}`;
    }
    return /^\/(?![/\\])[\x21-\x7e]*$/.test(path) && !/^\/(login|logout)(\/|\?|$)/i.test(path) ? path : '/';
  } catch { return '/'; /* no Referer, or not an address */ }
}

/** Lets the request through only with a valid owner session; otherwise sends the browser to log in. */
export function requireOwner(sessions: SessionStore): RequestHandler {
  return (req, res, next) => {
    if (sessions.isValid(readCookie(req, SESSION_COOKIE))) return next();
    res.redirect(302, '/login?next=' + encodeURIComponent(returnPath(req)));
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

const locks = new WeakMap<object, Mutex>();
/** The one lock for every check of the owner's authenticator code against this limiter (login and Save a copy). */
export function codeLock(limiter: object): Mutex {
  let m = locks.get(limiter);
  if (!m) locks.set(limiter, m = new Mutex());
  return m;
}

type LoginOutcome = { kind: 'ok' } | { kind: 'failed' } | { kind: 'blocked'; retryAfterSec: number };

/**
 * The desktop app's key check, for the calls only the app's own HTTP client makes (header X-App-Key): local mode
 * only, compared as hashes in constant time. False when there is no key to check against.
 */
export function appKeyCheck(d: Pick<AppDeps, 'localMode' | 'appSecret'>): (req: Request) => boolean {
  const appKey = d.localMode && d.appSecret ? createHash('sha256').update(d.appSecret).digest() : null;
  return (req) => {
    const given = req.get('x-app-key') ?? '';
    return appKey !== null && given !== '' && timingSafeEqual(createHash('sha256').update(given).digest(), appKey);
  };
}

/** How many tool sign-ins wait for the owner's decision in the window (set by authRoutes). */
export let waitingCount: () => number = () => 0;

export function authRoutes(d: AppDeps): Router {
  const router = Router();
  // LoginLimiter.check doesn't consume points, so attempts must not overlap while argon2 awaits:
  // otherwise a parallel burst would all pass check() before any fail() lands.
  const loginLock = codeLock(d.limiter);
  const cookieOptions = sessionCookieOptions(d.publicUrl);
  // At the desktop app's public address (D4) the browser is on https: its cookies are Secure there.
  const optionsFor = (req: Request) => ({ ...cookieOptions, secure: cookieOptions.secure || viaDoor(req) });

  const loginForm = (status: number, res: Response, next: string, error?: string) =>
    send(res, status, t('auth.login.title'), html`<h1 class="login-mark"><span class="brand-dot" aria-hidden="true"></span>${memoryName()}</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="/login">
  <label>${t('auth.login.password')} <input type="password" name="password" autocomplete="current-password" required autofocus></label>
  <label>${t('auth.login.code')} <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>
  <input type="hidden" name="next" value="${next}">
  <button type="submit" class="primary">${t('auth.login.submit')}</button>
</form>`);

  const notConfigured = (res: Response) => send(res, 503, t('auth.login.title'), html`<h1>${memoryName()}</h1><p>${t('auth.login.notConfigured')}</p>`);

  /**
   * The desktop app's window opens a session without its key ever being in a URL (browser history is a file on
   * disk): the app's own HTTP client trades the key (header X-App-Key) for a ticket that works once, within a minute,
   * and the window opens /app/open?ticket=…. Local mode only. Anything wrong falls through to the unknown-page answer.
   */
  const appKey = d.localMode && d.appSecret ? createHash('sha256').update(d.appSecret).digest() : null;
  // The app's endpoints are for this computer only. The door's own block in createApp already refuses them; this is the second
  // lock, on the routes themselves, in case that one is ever bypassed (any letter case, encoded letters): no ticket is made or
  // accepted, no proof given, through the door.
  router.use((req, res, next) => (viaDoor(req) && isAppPath(req.path) ? res.status(404).type('text/plain').send('Not found') : next()));
  const fromApp = appKeyCheck(d);
  const tickets = new Map<string, number>();
  const TICKET_MS = 60_000;
  const MAX_TICKETS = 20;
  router.post('/app/ticket', (req, res, next) => {
    if (!fromApp(req)) return next();
    const now = d.now().getTime();
    for (const [t, until] of tickets) if (until < now) tickets.delete(t);
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, now + TICKET_MS);
    res.set('Cache-Control', 'no-store').json({ ticket });
  });
  /**
   * The desktop app checks the server it is about to trust is its own before it sends the key (D2): it sends a
   * random challenge, and only a server holding APP_SECRET can answer with its HMAC. A squatter on the port cannot.
   */
  router.get('/app/hello', (req, res, next) => {
    const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : '';
    if (!appKey || !d.appSecret || !/^[0-9a-f]{64}$/.test(challenge)) return next();
    res.set('Cache-Control', 'no-store').json({ proof: createHmac('sha256', d.appSecret).update(challenge).digest('hex') });
  });
  // The Claude bridge asks this on every new connection, before it sends its key: only a BrainAI that knows the key's
  // stored hash can answer. The port is part of the proof, so another BrainAI's answer is no use on this port.
  router.get('/app/bridge-hello', (req, res, next) => {
    const grant = typeof req.query.grant === 'string' ? req.query.grant : '';
    const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : '';
    if (!d.localMode || !/^[0-9a-f]{64}$/.test(challenge)) return next();
    // A key made at the usual address still works on a temporary port: the proof is looked up for either address (and /mcp
    // accepts such a token on this computer too, see localVerifier in app.ts).
    const running = new URL('/mcp', d.publicUrl);
    const home = d.statusDir ? temporaryHomePort(join(dirname(d.statusDir), 'brainai.json'), Number(d.publicUrl.port)) : null;
    const homeUrl = home !== null ? (() => { const u = new URL(running); u.port = String(home); return u.href; })() : null;
    const proof = d.provider.bridgeProof(grant, running.href, challenge, d.publicUrl.port) ?? (homeUrl ? d.provider.bridgeProof(grant, homeUrl, challenge, d.publicUrl.port) : null);
    // No live key for this grant (revoked, expired or unknown): the bridge tells the person to connect again.
    if (!proof) return res.status(410).set('Cache-Control', 'no-store').json({ state: 'not_connected' });
    res.set('Cache-Control', 'no-store').json({ proof });
  });
  router.get('/app/open', (req, res, next) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const until = appKey ? tickets.get(ticket) : undefined;
    if (until === undefined) return next();
    tickets.delete(ticket);
    if (until < d.now().getTime()) return next();
    const token = d.sessions.create(req.get('user-agent'), 'app');
    res.cookie(SESSION_COOKIE, token, { ...optionsFor(req), maxAge: sessionDays('app') * 86_400_000 });
    res.set('Cache-Control', 'no-store').redirect(303, safeNext(req.query.next) ?? '/');
  });

  router.get('/login', (req, res) => {
    // Local mode with the owner account not fully set up (no password, or a password and no authenticator yet): there is
    // nothing to log in with. Sessions come only from the app's window.
    if (d.localMode && !d.owner.isConfigured()) {
      const win = (d.tools?.platform ?? process.platform) === 'win32';
      return send(res, 200, t('auth.window.title'), html`<h1>${t('auth.window.title')}</h1>
<p>${win ? t('auth.window.tray', { here: computerName() }) : t('auth.window.menuBar', { here: computerName() })}</p>`);
    }
    if (!d.owner.isConfigured()) return notConfigured(res);
    // The login form without a live session: the login ended here, elsewhere, or simply expired (and the browser
    // dropped the cookie with it). The cache may still hold pictures, so it is cleared; storage (the offline queue,
    // later) is left alone. Clearing an empty cache costs nothing.
    if (!d.sessions.isValid(readCookie(req, SESSION_COOKIE))) res.set('Clear-Site-Data', '"cache"');
    loginForm(200, res, safeNext(req.query.next) ?? '');
  });

  router.post('/login', async (req, res) => {
    if (!d.owner.isConfigured()) return notConfigured(res);
    const next = safeNext(field(req.body, 'next'));
    const deviceToken = readCookie(req, DEVICE_COOKIE);
    const knownDevice = d.sessions.isKnownDevice(deviceToken);
    // A known device has a limit of its own: strangers failing from anywhere (or from the same address) cannot lock the owner's
    // phone out. Its cookie is a random secret the database knows, so it cannot be made up to get fresh limits.
    const ip = knownDevice && deviceToken ? `device:${createHash('sha256').update(deviceToken).digest('hex').slice(0, 24)}` : rateLimitKey(req);
    const outcome = await loginLock.run(async (): Promise<LoginOutcome> => {
      const gate = await d.limiter.check(ip, { knownDevice, door: viaDoor(req) });
      if (!gate.allowed) return { kind: 'blocked', retryAfterSec: gate.retryAfterSec };
      // The code is only checked (and its step consumed) once the password is right.
      const ok = (await d.owner.verifyPassword(field(req.body, 'password'))) && d.owner.verifyTotp(field(req.body, 'code').trim());
      if (!ok) {
        await d.limiter.fail(ip, { door: viaDoor(req) });
        return { kind: 'failed' };
      }
      await d.limiter.succeed(ip);
      return { kind: 'ok' };
    });

    if (outcome.kind === 'blocked') {
      const minutes = Math.max(1, Math.ceil(outcome.retryAfterSec / 60));
      res.set('Retry-After', String(outcome.retryAfterSec));
      return send(res, 429, t('auth.tooMany.title'), html`<h1>${t('auth.tooMany.title')}</h1>
<p>${t('auth.tooMany.text', { count: minutes })}</p>`);
    }
    if (outcome.kind === 'failed') return loginForm(401, res, next ?? '', t('auth.login.wrong'));

    // Remember where it was made: a session from this computer's address is refused at the public door, and lasts less.
    // (A server, not the desktop app, has only one address: its logins are 'door' ones, a month long.)
    const origin = viaDoor(req) || !d.localMode ? 'door' : 'local';
    const token = d.sessions.create(req.get('user-agent'), origin);
    res.cookie(SESSION_COOKIE, token, { ...optionsFor(req), maxAge: sessionDays(origin) * 86_400_000 });
    if (!knownDevice) res.cookie(DEVICE_COOKIE, d.sessions.rememberDevice(), { ...optionsFor(req), maxAge: DEVICE_DAYS * 86_400_000 });
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
  // The sidebar is the owner's: shown only to a signed-in session.
  const expired = (res: Response, signedIn = true) => send(res, 404, t('auth.expired.title'), html`<h1>${t('auth.expired.title')}</h1><p>${t('auth.expired.text')}</p>`, signedIn);

  const consentPage = (res: Response, status: number, id: string, pending: PendingInfo, name: string, message?: string, access: Access | null = pending.suggestedAccess, picked: string[] = []) => {
    const origin = new URL(pending.redirectUri).origin;
    send(res, status, t('auth.consent.title'), html`<h1>${t('auth.consent.wants', { client: pending.clientName })}</h1>
<p>${tHtml('auth.consent.sendBack', { origin: html`<strong>${origin}</strong>` })}</p>
${message ? html`<p class="error" role="alert">${message}</p>` : ''}
<form method="post" action="/consent/${id}">
  <input type="hidden" name="from" value="window">
  <p><label>${t('auth.consent.name')} <input type="text" name="name" value="${name}" maxlength="100" required></label></p>
  <p><label class="choice"><input type="radio" name="access" value="full" required${access === 'full' ? ' checked' : ''}> ${t('auth.consent.full')}</label></p>
  <p><label class="choice"><input type="radio" name="access" value="discussions" required${access === 'discussions' ? ' checked' : ''}> ${t('auth.consent.discussions')}</label></p>
  <p><label class="choice"><input type="radio" name="access" value="projects" required${access === 'projects' ? ' checked' : ''}> ${t('auth.consent.projects')}</label></p>
  ${projectChoices(d.service.listProjects().map((p) => p.project), picked)}
  <div class="actions">
    <button type="submit" name="decision" value="approve" class="primary">${t('auth.consent.approve')}</button>
    <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>${t('auth.consent.deny')}</button>
  </div>
</form>`, true);
  };

  // Local mode with the owner account not fully set up: a tool's browser has no session, so its sign-in waits here until the owner decides in
  // BrainAI's window. Only ids in these two maps are ever answered, and a decided location is handed out once.
  const PENDING_MS = PENDING_TTL_SEC * 1000;
  const MAX_WAITING = 50;
  // One tool cannot push the others' waiting sign-ins out: it has its own small share, and its oldest goes first.
  const MAX_WAITING_PER_CLIENT = 5;
  const waiting = new Map<string, number>();
  const waitingClient = new Map<string, string>();
  const decided = new Map<string, { location: string; untilMs: number }>();
  const prune = () => {
    const now = d.now().getTime();
    for (const [id, until] of waiting) if (until <= now) { waiting.delete(id); waitingClient.delete(id); }
    for (const [id, v] of decided) if (v.untilMs <= now) decided.delete(id);
  };

  // Sign-ins still waiting: the window keeps asking for them even after the owner account is set up, so none is stranded.
  waitingCount = () => { prune(); return waiting.size; };

  router.get('/consent/:id/wait', (req, res) => {
    prune();
    const id = req.params.id as string;
    res.set('Cache-Control', 'no-store');
    const done = decided.get(id);
    if (done) {
      decided.delete(id);
      return res.json({ state: 'done', location: done.location });
    }
    if (waiting.has(id) && d.provider.getPending(id)) return res.json({ state: 'pending' });
    waiting.delete(id);
    waitingClient.delete(id);
    res.json({ state: 'gone' });
  });

  router.get('/consents/waiting', owner, (_req, res) => {
    prune();
    const list = [];
    for (const id of waiting.keys()) {
      const pending = d.provider.getPending(id);
      if (pending) list.push({ id, clientName: pending.clientName, origin: new URL(pending.redirectUri).origin });
    }
    res.set('Cache-Control', 'no-store').json(list);
  });

  router.get('/consent/:id', (req, res) => {
    const id = req.params.id as string;
    if (d.sessions.isValid(readCookie(req, SESSION_COOKIE))) {
      const pending = d.provider.getPending(id);
      if (!pending) return expired(res);
      return consentPage(res, 200, id, pending, pending.clientName);
    }
    if (!(d.localMode && !d.owner.isConfigured())) return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    const pending = d.provider.getPending(id);
    if (!pending) return expired(res, false);
    prune();
    if (!waiting.has(id)) {
      const mine = [...waiting.keys()].filter((w) => waitingClient.get(w) === pending.clientId);
      while (mine.length >= MAX_WAITING_PER_CLIENT) { const old = mine.shift()!; waiting.delete(old); waitingClient.delete(old); }
      // Full: the newcomer is refused, so a flood of requests can never push out one the owner is about to approve.
      if (waiting.size >= MAX_WAITING) return send(res, 503, t('auth.waiting.fullTitle'), html`<h1>${t('auth.waiting.fullTitle')}</h1><p>${t('auth.waiting.fullText')}</p>`);
      waiting.set(id, d.now().getTime() + PENDING_MS);
      waitingClient.set(id, pending.clientId);
    }
    res.set('Cache-Control', 'no-store');
    send(res, 200, t('auth.window.title'), waitingView(id, pending.clientName, new URL(pending.redirectUri).origin));
  });

  router.post('/consent/:id', owner, async (req, res) => {
    const id = req.params.id as string;
    const decision = field(req.body, 'decision');
    if (decision !== 'approve' && decision !== 'deny') {
      return send(res, 400, t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${t('auth.consent.chooseDecision')}</p>`, true);
    }
    const pending = d.provider.getPending(id);
    if (!pending) return expired(res);
    const body = req.body as Record<string, unknown> | undefined;
    // Missing fields keep the defaults (current name, full access); a value that is present must be valid.
    // With no suggestion (one app connected at different levels), the owner must choose.
    if (decision === 'approve' && body?.access === undefined && pending.suggestedAccess === null) {
      return consentPage(res, 400, id, pending, field(body, 'name') || pending.clientName, t('auth.consent.chooseLevel'));
    }
    const access = body?.access === undefined ? 'full' : body.access;
    if (decision === 'approve' && access !== 'full' && access !== 'discussions' && access !== 'projects') {
      return send(res, 400, t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${t('auth.consent.chooseAccess')}</p>`, true);
    }
    if (decision === 'approve' && body?.name !== undefined && typeof body.name !== 'string') {
      return send(res, 400, t('common.badRequest'), html`<h1>${t('common.badRequest')}</h1><p>${t('auth.consent.oneName')}</p>`, true);
    }
    const name = body?.name as string | undefined;
    const projects = access === 'projects' ? pickedProjects(body, d.service.listProjects().map((p) => p.project)) : undefined;
    if (decision === 'approve' && access === 'projects' && !projects) {
      return consentPage(res, 400, id, pending, name ?? pending.clientName, t('auth.consent.pickProject'), 'projects', ticked(body, 'projects'));
    }
    let location: string;
    try {
      location = decision === 'approve' ? await d.provider.approvePending(id, { name, access: access as Access, projects }) : d.provider.denyPending(id);
    } catch (e) {
      if (e instanceof InvalidNameError) return consentPage(res, 400, id, pending, name ?? pending.clientName, e.message, access as Access, projects);
      if (!(e instanceof InvalidRequestError)) throw e;
      return send(res, 400, t('auth.consent.cannotTitle'), html`<h1>${t('auth.consent.cannot')}</h1><p>${tHtml('auth.consent.cannotText', { reason: e.message, expired: t('auth.expired.text') })}</p>`, true);
    }
    prune();
    waitingClient.delete(id);
    if (waiting.delete(id)) {
      // The browser that started this sign-in is waiting: it goes on to the tool, the window stays here.
      decided.set(id, { location, untilMs: d.now().getTime() + PENDING_MS });
      return send(res, 200, decision === 'approve' ? t('auth.consent.approved') : t('auth.consent.denied'), decision === 'approve' ? approvedView(pending.clientName) : deniedView(pending.clientName), true);
    }
    res.redirect(302, location);
  });

  return router;
}
