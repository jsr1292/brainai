/**
 * Settings › Reach from phone and web (D4), on a desktop install only: the password and the authenticator from the
 * dashboard (no terminal), then the switch for the public address (Task 3).
 */
import { Router, type Request, type Response } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { originOf, sessionDays, type SessionOrigin } from '../auth/sessions.js';
import { generateTotpSecret, otpauthUri, totpAt } from '../auth/totp.js';
import type { AppDeps } from './app.js';
import { readCookie, requireOwner, SESSION_COOKIE, sessionCookieOptions } from './authRoutes.js';
import { html, page } from './html.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { localRouteOnly, viaDoor } from '../desktop/publicDoor.js';
import { reachPage, reachSwitch, tailscaleBox } from './reachViews.js';
import { funnelOff, funnelOffSync, funnelOn, funnelPointsAt, tailscaleState, type TailscaleEnv } from '../desktop/tailscale.js';
import { cloudflaredState, prepareTunnel, startSignIn, stopLeftover, TunnelRunner, validHostname, type CloudflaredEnv, type SignInRun } from '../desktop/cloudflared.js';

const PENDING_MS = 10 * 60_000;
const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Without the tools environment (only tests build an app so) Tailscale is never looked for, not even the Mac app. */
function tailscaleEnv(d: AppDeps): TailscaleEnv {
  return d.tools
    ? { home: d.tools.home, path: d.tools.path, appPath: d.tools.tailscaleApp, statusTimeoutMs: d.tools.tailscaleStatusMs, extraEnv: d.tools.extraEnv }
    : { home: '', path: '', appPath: '/nonexistent/Tailscale' };
}

/**
 * cloudflared runs with a home of its own in BrainAI's data folder: its sign-in certificate and settings are BrainAI's,
 * and the owner's own ~/.cloudflared is never read or changed (D5 review). Without the tools environment cloudflared
 * is never looked for (it has no fixed place to fall back to).
 */
export function cloudflaredEnv(d: AppDeps): CloudflaredEnv {
  if (!d.tools || !d.statusDir) return { home: '', path: '' };
  const home = join(d.statusDir, 'cloudflared', 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { home, path: d.tools.path, extraEnv: d.tools.extraEnv };
}

/** Answers once `url` serves this BrainAI's protected-resource document (every 2 s, up to 60 s). */
export async function answersAt(url: URL, waitMs = 60_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  const want = new URL('/mcp', url).href;
  while (Date.now() < until) {
    try {
      const r = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', url), { signal: AbortSignal.timeout(5_000) });
      if (r.ok && ((await r.json()) as { resource?: unknown }).resource === want) return true;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/** A Turn off whose `funnel off` failed leaves this file: the next start asks Tailscale again until it confirms. */
const pendingOff = (d: AppDeps) => (d.statusDir ? join(d.statusDir, 'funnel-off-pending') : null);

/**
 * The door port Funnel was last pointed at (`<data>/funnel-on`), written before Funnel is turned on and forgotten when
 * Tailscale confirms it is off. It survives a hard kill (a crash, kill -9, Task Manager), which no exit handler sees:
 * the next start reads it to turn a Funnel that was left behind off, or to remove the mapping of an earlier port,
 * so whatever listens on that port next is never public. Only the CLI calls Reach already makes are used, and none of
 * them can list what Funnel points at, so this file is the memory of it.
 */
const funnelMark = (d: AppDeps) => (d.statusDir ? join(d.statusDir, 'funnel-on') : null);
function markFunnelOn(d: AppDeps, port: number): void {
  const f = funnelMark(d);
  if (f) { try { writeFileSync(f, `${port}\n`); } catch { /* nowhere to say it: the next start's own checks still run */ } }
}
function unmarkFunnelOn(d: AppDeps): void {
  const f = funnelMark(d);
  if (f) rmSync(f, { force: true });
}
/** The port in the mark; `true` when a mark exists but its port cannot be read; null without one. */
function markedPort(d: AppDeps): number | true | null {
  const f = funnelMark(d);
  if (!f || !existsSync(f)) return null;
  try {
    const n = Number(readFileSync(f, 'utf8').trim());
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : true;
  } catch { return true; }
}

/** Asks Tailscale to stop sharing; a failure is remembered (the marker), a confirmation forgets it. */
async function funnelOffRemembered(d: AppDeps, env: TailscaleEnv = tailscaleEnv(d)): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await funnelOff(env);
  const marker = pendingOff(d);
  if (marker) { if (r.ok) rmSync(marker, { force: true }); else writeFileSync(marker, ''); }
  if (r.ok) unmarkFunnelOn(d);
  return r;
}

/** A short limit for the start-up and Remove checks: Tailscale may be installed but not running. */
const quickEnv = (d: AppDeps): TailscaleEnv => ({ ...tailscaleEnv(d), timeoutMs: tailscaleEnv(d).statusTimeoutMs ?? 10_000 });

/**
 * Turns off a Funnel BrainAI left behind, but only one that is BrainAI's: `funnel off` clears everything shared on 443,
 * the owner's own Funnel included, so the mark's port is checked against `tailscale serve status` first. A share that
 * is not BrainAI's (or none) only drops the mark. Not sure (Tailscale not running or not answering): nothing is
 * changed, the marks stay and the next start asks again. A failed Turn off (the pending marker) with no mark to check is
 * asked again as it always was.
 */
export async function leftoverFunnelOff(d: AppDeps, env: TailscaleEnv = quickEnv(d)): Promise<{ ok: true; did: 'off' | 'dropped' | 'nothing' } | { ok: false; reason: string }> {
  const port = markedPort(d);
  const marker = pendingOff(d);
  const pending = !!marker && existsSync(marker);
  if (port === null && !pending) return { ok: true, did: 'nothing' };
  if (typeof port === 'number') {
    const at = await funnelPointsAt(env, port);
    if (at.at === 'unknown') return { ok: false, reason: at.reason };
    if (at.at !== 'ours') {
      unmarkFunnelOn(d);
      if (marker) rmSync(marker, { force: true });
      return { ok: true, did: 'dropped' };
    }
  } else {
    // A mark nobody can read says nothing about what Tailscale shares: it is dropped, and only a failed Turn off (the pending marker) still asks Tailscale to stop.
    if (port === true) unmarkFunnelOn(d);
    if (!pending) return { ok: true, did: 'dropped' };
  }
  const r = await funnelOffRemembered(d, env);
  return r.ok ? { ok: true, did: 'off' } : r;
}

/**
 * Every Tailscale funnel operation (Turn on, Turn off, the start-up share and its retries, the pending-off retry) runs
 * one at a time, and `gen` changes on every Turn on, Turn off and shutdown, so an operation that was waiting or running
 * while one of those happened can tell that it is stale and must not save Reach. `waiting`: Reach is saved but Funnel is
 * not on yet because Tailscale is not ready (with `reason`, Tailscale's last answer): the page says so and never shows On.
 */
const gates = new WeakMap<AppDeps, { chain: Promise<unknown>; gen: number; waiting: boolean; reason: string | null }>();
const gateOf = (d: AppDeps) => { let g = gates.get(d); if (!g) { g = { chain: Promise.resolve(), gen: 0, waiting: false, reason: null }; gates.set(d, g); } return g; };
export function locked<T>(d: AppDeps, fn: () => Promise<T>): Promise<T> {
  const g = gateOf(d);
  const run = g.chain.then(fn, fn);
  g.chain = run.catch(() => {});
  return run;
}

/** Turns Reach off and says how it went: forgotten and the door shut first (and a Cloudflare tunnel stopped), so
 * nothing answers at the public address even if Tailscale does not reply. With no address saved, Reach was never on:
 * Tailscale is not asked at all, because its funnel command opens a browser page on a tailnet without Funnel. */
export async function reachOff(d: AppDeps): Promise<string> {
  const via = d.reach?.via();
  const wasOn = d.reach?.saved() != null;
  const waited = gateOf(d).waiting;
  gateOf(d).gen++;
  d.reach?.set(null);
  if (!wasOn || via === 'cloudflare') return t('setup.reach.off.local') + (wasOn ? ` ${t('setup.reach.off.cfName')}` : '');
  const r = await locked(d, () => funnelOffRemembered(d));
  if (!r.ok && waited) return t('setup.reach.off.unchecked');
  return r.ok ? t('setup.reach.off.local')
    : t('setup.reach.off.stillListed', { reason: r.reason });
}

export function reachRoutes(d: AppDeps): Router {
  const router = Router();
  if (!d.localMode) return router;
  const owner = requireOwner(d.sessions);
  const ts = tailscaleEnv(d);
  const cf = cloudflaredEnv(d);
  // The Cloudflare tunnel process: running only while Reach through Cloudflare is on, stopped with the server.
  const runner = d.statusDir ? new TunnelRunner(cf, d.statusDir) : null;
  // A tunnel an earlier BrainAI left running (a crash, even during Turn on before anything was saved) stops now, so two
  // never serve one tunnel (D5 review).
  if (d.statusDir) stopLeftover(d.statusDir);
  const gate = gateOf(d);
  d.reach?.onChange((url) => { if (!url) { runner?.stop(); stopRetry(); gate.waiting = false; } });
  // Reach through Tailscale is turned off when BrainAI stops (Quit, an update, a crash handler), so Funnel never
  // outlives it and points at a freed port; the next start turns it back on. Runs in process 'exit': synchronous only.
  let retry: NodeJS.Timeout | null = null;
  const stopRetry = () => { if (retry) clearTimeout(retry); retry = null; };
  d.reach?.onShutdown(() => {
    gateOf(d).gen++;
    stopRetry();
    runner?.stop();
    if (!windows && d.reach?.saved() && d.reach.via() === 'tailscale' && funnelOffSync(ts)) unmarkFunnelOn(d);
    else if (!windows && d.reach?.saved() && d.reach.via() === 'tailscale') {
      // Tailscale did not confirm within the 3 seconds (slow, hung, or not answering): the share may still point at the door's
      // port, which another program could take. Leave the marker so the next start turns it off first (it exists for
      // the same case in Turn off). Synchronous: this runs in process 'exit'.
      const marker = pendingOff(d);
      if (marker) { try { writeFileSync(marker, ''); } catch { /* nowhere to say it: the next start's own check still runs */ } }
    }
  });
  let signing: SignInRun | null = null;
  // Reach from phone and web is Mac-only in D6: on Windows nothing here runs tailscale or cloudflared.
  const windows = (d.tools?.platform ?? process.platform) === 'win32';
  const macOnly = (_req: Request, res: Response, next: () => void) => (windows ? back(res, () => t('setup.reach.noWindows')) : next());
  // One pending authenticator per signed-in session: another session's QR code and secret are not shared.
  const pendingBy = new Map<string, { secret: string; until: number }>();
  // Keyed by a hash of the session token (the token itself is never kept here); no cookie, no key.
  const sid = (req: Request): string => { const c = readCookie(req, SESSION_COOKIE); return c ? createHash('sha256').update(c).digest('hex') : ''; };
  // The last result, shown once on the page: kept here, never taken from the URL. A function is worked out when the page is drawn, in the owner's language.
  let said: string | (() => string) | null = null;

  /** A new password or authenticator signs every browser out: this one gets a fresh session, so the owner stays in. */
  const keepSignedIn = (req: Request, res: Response) => {
    // The new session is made where the old one was: the window stays a window session.
    const origin: SessionOrigin = viaDoor(req) || !d.localMode ? 'door' : (originOf(readCookie(req, SESSION_COOKIE) ?? '') === 'app' ? 'app' : 'local');
    const token = d.sessions.create(req.get('user-agent'), origin);
    const secure = sessionCookieOptions(d.publicUrl);
    res.cookie(SESSION_COOKIE, token, { ...secure, secure: secure.secure || viaDoor(req), maxAge: sessionDays(origin) * 86_400_000 });
  };
  const back = (res: Response, text: string | (() => string) | null) => { said = text; res.redirect(303, '/settings/reach'); };

  router.get('/settings/reach', owner, async (req, res) => {
    const now = d.now().getTime();
    let pending = pendingBy.get(sid(req)) ?? null;
    if (pending && pending.until < now) { pendingBy.delete(sid(req)); pending = null; }
    const view = {
      said: typeof said === 'function' ? said() : said, hasPassword: d.owner.hasPassword(), hasAuthenticator: d.owner.isConfigured(),
      pending: pending ? { secret: pending.secret, svg: await QRCode.toString(otpauthUri(pending.secret, 'owner'), { type: 'svg', margin: 1 }) } : null,
      reach: d.owner.isConfigured()
        ? windows ? html`<p>${tHtml('setup.reach.noWindowsNote', { link: html`<a href="/settings/move">${t('setup.reach.moveItLink')}</a>` })}</p>` : reachSwitch({ waiting: gate.waiting, reason: gate.reason, on: d.reach?.url() ?? null, via: d.reach?.via() ?? 'tailscale', cloudflare: { ...(await cloudflaredState(cf)), signingIn: signing ? signing.url() ?? '' : null } })
        : null,
    };
    said = null;
    res.type('html').send(page(t('setup.reach.title'), reachPage(view), { nav: true, tab: null, back: { href: '/settings', labelKey: 'shell.nav.settings' } }));
  });

  // The Tailscale check shown in step 3, off the page's own request (Tailscale can take seconds to answer, or never):
  // one check at a time, and an answer from the last few seconds is reused unless Check again asks afresh.
  let checking: Promise<Awaited<ReturnType<typeof tailscaleState>>> | null = null;
  let checked: { at: number; state: Awaited<ReturnType<typeof tailscaleState>> } | null = null;
  const CHECK_REUSE_MS = 5_000;
  const tailscaleNow = (fresh: boolean) => {
    if (!fresh && checked && d.now().getTime() - checked.at < CHECK_REUSE_MS) return Promise.resolve(checked.state);
    if (!checking) {
      const run = tailscaleState(ts).then((state) => { checked = { at: d.now().getTime(), state }; return state; }).finally(() => { if (checking === run) checking = null; });
      checking = run;
    }
    return checking;
  };
  // Only on this computer: never through the public door, whatever Host it names (as its siblings in the other route files).
  router.get('/settings/reach/tailscale', localRouteOnly, owner, macOnly, async (req, res) => {
    const state = await tailscaleNow(req.query.fresh === '1');
    res.set('Cache-Control', 'no-store').type('html').send(tailscaleBox(state).value);
  });

  // A saved Reach comes back at start: on the door Tailscale already points at, or shared again from a new one.
  // A definite refusal turns Reach off and the page says why; a temporary failure keeps it waiting (Funnel is off meanwhile).
  const resume = async () => {
    if (windows) return;
    const reach = d.reach;
    const door = d.door;
    // An earlier Turn off that Tailscale did not confirm: ask again until it does (Reach is not on through Tailscale).
    const marker = pendingOff(d);
    // Reconcile after a hard kill: Funnel may still point at the door's old port. Tailscale may not be running (each
    // call can take its whole time limit), so the limit is short, the start never waits for this, and the result is logged.
    const quick = quickEnv(d);
    const shouldBeOn = !!reach?.url() && reach.via() === 'tailscale';
    if (!shouldBeOn) {
      const r = await locked(d, () => leftoverFunnelOff(d, quick));
      if (!r.ok) console.log(`Reach is off but BrainAI could not confirm that Tailscale stopped sharing (${r.reason}); it will check again at the next start.`);
      else if (r.did === 'off') console.log('Reach is off: the Tailscale share BrainAI left behind was turned off.');
      else if (r.did === 'dropped') console.log('Reach is off: Tailscale shares nothing of BrainAI\'s, so nothing was changed.');
    }
    if (!reach || !door || !reach.url()) return;
    if (reach.via() === 'cloudflare') {
      const dir = d.statusDir;
      const url = reach.url()!;
      if (!dir || !runner) return reach.set(null);
      const p = await prepareTunnel(cf, dir, url.hostname);
      if (!p.ok) { reach.set(null); said = () => t('setup.reach.turnedOff', { reason: p.reason }); return; }
      const port = await door.open();
      runner.start(p.tunnelId, p.credentials, port);
      reach.set(url, port, { via: 'cloudflare', tunnel: p.tunnelId });
      return;
    }
    const saved = reach.port();
    let port: number | null = null;
    if (saved !== null) {
      try { port = await door.open(saved); } catch { /* taken by another program: a new door below */ }
    }
    if (port === null) port = await door.open();
    // The door moved since Funnel was last pointed (its old port was taken): remove the old mapping first, so that
    // whatever listens on the old port is not public while this waits for Tailscale; the share below replaces it anyway.
    const was = markedPort(d);
    if (reach.via() === 'tailscale' && was !== null && was !== port) {
      const r = await locked(d, () => leftoverFunnelOff(d, quick));
      console.log(r.ok ? `The door moved to port ${port}: the old Tailscale share (${r.did === 'off' ? 'removed' : 'none of BrainAI\'s found'}).` : `The door moved to port ${port}, but BrainAI could not confirm the old Tailscale share is gone (${r.reason}); sharing again at the new port.`);
    }
    // Funnel was turned off when BrainAI stopped: share the door again, at every start.
    await shareAgain(port, 0, gateOf(d).gen);
  };

  /**
   * One try at turning Funnel on at the door, alone among the funnel operations. If Tailscale is not ready (login order),
   * Reach waits and asks again, for as long as that lasts; only a definite refusal turns it off. A try that finds Reach turned on or off meanwhile (`gen` moved) does not
   * save Reach, and undoes a Funnel it turned on.
   */
  const shareAgain = (port: number, tried: number, gen: number): Promise<void> => locked(d, async () => {
    const reach = d.reach!;
    const g = gateOf(d);
    if (g.gen !== gen || !reach.saved() || reach.via() !== 'tailscale') return;
    // Waiting from the first try on: it can last two 30-second Tailscale timeouts, and Funnel is not on until it succeeds.
    g.waiting = true;
    const on = await funnelOn(ts, port, { before: () => markFunnelOn(d, port), rolledBack: () => unmarkFunnelOn(d) });
    if (g.gen !== gen) { if (on.ok) await funnelOffRemembered(d); return; }
    if (on.ok) {
      const m = pendingOff(d);
      if (m) rmSync(m, { force: true });
      gate.waiting = false;
      reach.set(new URL(on.url), port);
      return;
    }
    if (on.refused) {
      gate.waiting = false;
      reach.set(null);
      said = () => t('setup.reach.turnedOff', { reason: on.reason });
      await funnelOffRemembered(d);
      return;
    }
    // Tailscale is not ready (not running, not signed in, no answer): Funnel stays off, so waiting costs nothing.
    // Keep Reach saved and ask again: at the short interval for the first `max` tries, then at the long one, for as long as it lasts.
    const { everyMs, max, laterMs } = d.reachRetry ?? { everyMs: 60_000, max: 10, laterMs: 15 * 60_000 };
    g.reason = on.reason;
    // Saving again rebuilds the public side (rate-limit stores with timers): only when the door's port changed.
    if (reach.port() !== port) reach.set(reach.saved()!, port);
    stopRetry();
    retry = setTimeout(() => { retry = null; void shareAgain(port, tried + 1, gen).catch(() => {}); }, tried < max ? everyMs : laterMs);
    retry.unref();
  });
  if (d.reach) {
    d.reach.ready = resume().catch(async (e: unknown) => {
      console.error('bringing Reach back failed:', e);
      d.reach?.set(null);
      // The door could not be opened: a Funnel left at the old port must not stay.
      await locked(d, () => leftoverFunnelOff(d)).catch(() => {});
      said = () => t('setup.reach.noDoor');
    });
  }

  // Once set, the password and the authenticator are not replaced from here (D4 review): a borrowed or stolen
  // session must not be able to lock the owner out. Adding the authenticator asks for the password again.
  router.post('/settings/reach/password', owner, async (req, res) => {
    if (d.owner.hasPassword()) return back(res, () => t('setup.reach.pwAlreadySet'));
    const pw = field(req, 'password');
    if (pw !== field(req, 'again')) return back(res, () => t('setup.reach.pwMismatch'));
    if (pw.length < 12) return back(res, () => t('setup.reach.pwShort'));
    await d.owner.setPassword(pw);
    keepSignedIn(req, res);
    back(res, () => t('setup.reach.pwSet'));
  });

  router.post('/settings/reach/authenticator/start', owner, async (req, res) => {
    if (!d.owner.hasPassword()) return back(res, () => t('setup.reach.pwFirst'));
    if (d.owner.isConfigured()) return back(res, () => t('setup.reach.authAlreadySet'));
    if (!(await d.owner.verifyPassword(field(req, 'current')))) return back(res, () => t('setup.reach.pwWrong'));
    const key = sid(req);
    if (key === '') return back(res, null);
    const now = d.now().getTime();
    for (const [k, v] of pendingBy) if (v.until < now) pendingBy.delete(k);
    pendingBy.set(key, { secret: generateTotpSecret(), until: now + PENDING_MS });
    back(res, null);
  });

  router.post('/settings/reach/authenticator/confirm', owner, (req, res) => {
    const now = d.now().getTime();
    const pending = sid(req) === '' ? undefined : pendingBy.get(sid(req));
    if (!pending || pending.until < now) { pendingBy.delete(sid(req)); return back(res, () => t('setup.reach.qrExpired')); }
    const code = field(req, 'code').trim();
    const step = Math.floor(now / 30_000);
    const used = [step - 1, step, step + 1].filter((s) => same(totpAt(pending!.secret, s), code)).pop();
    if (used === undefined) return back(res, () => t('setup.reach.codeWrong'));
    if (d.owner.isConfigured()) { pendingBy.clear(); return back(res, () => t('setup.reach.authAlreadySet')); }
    d.owner.setTotpSecret(pending.secret, used);
    pendingBy.clear();
    keepSignedIn(req, res);
    back(res, () => t('setup.reach.authAdded'));
  });
  router.post('/settings/reach/on', owner, macOnly, async (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, () => t('setup.reach.setBoth'));
    if (!d.reach || !d.door) return back(res, () => t('setup.reach.notHere'));
    const reach = d.reach;
    const doorOf = d.door;
    gateOf(d).gen++;
    stopRetry();
    gate.waiting = false;
    await locked(d, async () => {
      const door = await doorOf.open();
      const r = await funnelOn(ts, door, { before: () => markFunnelOn(d, door), rolledBack: () => unmarkFunnelOn(d) });
      if (!r.ok) { if (!reach.url()) doorOf.close(); return back(res, r.reason); }
      const m = pendingOff(d);
      if (m) rmSync(m, { force: true });
      reach.set(new URL(r.url), door);
      back(res, () => t('setup.reach.onAt', { address: r.url }));
    });
  });

  // Reach through Cloudflare (D5): sign in once (the browser opens Cloudflare's page), then a name on your domain.
  const beginSignIn = () => {
    if (signing) return;
    const run = startSignIn(cf);
    signing = run;
    void run.done.then((r) => {
      if (signing === run) signing = null;
      said = r.ok ? () => t('setup.reach.cfSignedIn') : r.reason;
    });
  };
  router.post('/settings/reach/cloudflare/signin', owner, macOnly, (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, () => t('setup.reach.setBoth'));
    beginSignIn();
    back(res, null);
  });

  // Signed in with the wrong domain or account: BrainAI forgets its own sign-in and tunnel, then signs in again.
  router.post('/settings/reach/cloudflare/another', owner, macOnly, (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, () => t('setup.reach.setBoth'));
    if (d.reach?.saved()) return back(res, () => t('setup.reach.turnOffFirst'));
    if (!d.statusDir || !cf.home) return back(res, () => t('setup.reach.notHere'));
    rmSync(join(cf.home, '.cloudflared', 'cert.pem'), { force: true });
    rmSync(join(d.statusDir, 'cloudflared', 'tunnel.json'), { force: true });
    beginSignIn();
    back(res, null);
  });

  router.post('/settings/reach/cloudflare/on', owner, macOnly, async (req, res) => {
    if (!d.owner.isConfigured()) return back(res, () => t('setup.reach.setBoth'));
    if (!d.reach || !d.door || !runner || !d.statusDir) return back(res, () => t('setup.reach.notHere'));
    if (d.reach.saved()) return back(res, () => t('setup.reach.alreadyOn'));
    const hostname = String((req.body as Record<string, unknown> | undefined)?.hostname ?? '').trim().toLowerCase();
    if (!validHostname(hostname)) return back(res, () => t('setup.reach.giveName'));
    const p = await prepareTunnel(cf, d.statusDir, hostname);
    if (!p.ok) return back(res, p.reason);
    const door = await d.door.open();
    runner.start(p.tunnelId, p.credentials, door);
    const url = new URL(`https://${hostname}`);
    // In use before the check: the door answers nothing while no public address is in use, so the check could never
    // pass otherwise (D5 review). If Cloudflare does not reach BrainAI, forgetting it stops the tunnel and shuts the door.
    d.reach.set(url, door, { via: 'cloudflare', tunnel: p.tunnelId });
    if (!(await (d.reachCheck ?? answersAt)(url))) {
      const log = runner.lastLog();
      d.reach.set(null);
      return back(res, () => t('setup.reach.cfNoReach', { address: url.origin }) + (log ? ` ${t('setup.reach.tunnelSaid', { log })}` : ''));
    }
    back(res, () => t('setup.reach.onAt', { address: url.origin }));
  });

  router.post('/settings/reach/off', owner, async (_req, res) => {
    back(res, await reachOff(d));
  });
  return router;
}
