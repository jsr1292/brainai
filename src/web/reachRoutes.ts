/**
 * Settings › Reach from phone and web (D4), on a desktop install only: the password and the authenticator from the
 * dashboard (no terminal), then the switch for the public address (Task 3).
 */
import { Router, type Request, type Response } from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { SESSION_DAYS } from '../auth/sessions.js';
import { generateTotpSecret, otpauthUri, totpAt } from '../auth/totp.js';
import type { AppDeps } from './app.js';
import { requireOwner, SESSION_COOKIE, sessionCookieOptions } from './authRoutes.js';
import { html, page } from './html.js';
import { reachPage, reachSwitch } from './reachViews.js';
import { funnelOff, funnelOn, tailscaleState, type TailscaleEnv } from '../desktop/tailscale.js';
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
    ? { home: d.tools.home, path: d.tools.path, appPath: d.tools.tailscaleApp, extraEnv: d.tools.extraEnv }
    : { home: '', path: '', appPath: '/nonexistent/Tailscale' };
}

/**
 * cloudflared runs with a home of its own in BrainAI's data folder: its sign-in certificate and settings are BrainAI's,
 * and the owner's own ~/.cloudflared is never read or changed (D5 review). Without the tools environment cloudflared
 * is never looked for (it has no fixed place to fall back to).
 */
function cloudflaredEnv(d: AppDeps): CloudflaredEnv {
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

/** Turns Reach off and says how it went: forgotten and the door shut first (and a Cloudflare tunnel stopped), so
 * nothing answers at the public address even if Tailscale does not reply. */
export async function reachOff(d: AppDeps): Promise<string> {
  const via = d.reach?.via();
  d.reach?.set(null);
  if (via === 'cloudflare') return 'Off: BrainAI answers only on this Mac again. The name stays in Cloudflare, ready for next time.';
  const r = await funnelOff(tailscaleEnv(d));
  return r.ok ? 'Off: BrainAI answers only on this Mac again.'
    : `Off: BrainAI no longer answers at the public address, but Tailscale still lists it (${r.reason}). Press Turn off again, or turn Funnel off in Tailscale.`;
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
  d.reach?.onChange((url) => { if (!url) runner?.stop(); });
  d.reach?.onShutdown(() => runner?.stop());
  let signing: SignInRun | null = null;
  // Reach from phone and web is Mac-only in D6: on Windows nothing here runs tailscale or cloudflared.
  const windows = (d.tools?.platform ?? process.platform) === 'win32';
  const macOnly = (_req: Request, res: Response, next: () => void) => (windows ? back(res, 'Reach from phone and web is not on Windows yet.') : next());
  let pending: { secret: string; until: number } | null = null;
  // The last result, shown once on the page: kept here, never taken from the URL.
  let said: string | null = null;

  /** A new password or authenticator signs every browser out: this one gets a fresh session, so the owner stays in. */
  const keepSignedIn = (req: Request, res: Response) => {
    const token = d.sessions.create(req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(d.publicUrl), maxAge: SESSION_DAYS * 86_400_000 });
  };
  const back = (res: Response, text: string | null) => { said = text; res.redirect(303, '/settings/reach'); };

  router.get('/settings/reach', owner, async (_req, res) => {
    const now = d.now().getTime();
    if (pending && pending.until < now) pending = null;
    const view = {
      said, hasPassword: d.owner.hasPassword(), hasAuthenticator: d.owner.isConfigured(),
      pending: pending ? { secret: pending.secret, svg: await QRCode.toString(otpauthUri(pending.secret, 'owner'), { type: 'svg', margin: 1 }) } : null,
      reach: d.owner.isConfigured()
        ? windows ? html`<p>Reach from phone and web is not on Windows yet: for now, use BrainAI from the apps on this computer, or <a href="/settings/move">move it to a server</a>.</p>` : reachSwitch({ on: d.reach?.url() ?? null, via: d.reach?.via() ?? 'tailscale', tailscale: await tailscaleState(ts), cloudflare: { ...(await cloudflaredState(cf)), signingIn: signing ? signing.url() ?? '' : null } })
        : null,
    };
    said = null;
    res.type('html').send(page('Reach from phone and web', reachPage(view), { nav: true, tab: null, back: { href: '/settings', label: 'Settings' } }));
  });

  // A saved Reach comes back at start: on the door Tailscale already points at, or shared again from a new one;
  // if that fails, Reach is turned off and the page says why (D4 review: never leave Funnel on another program).
  const resume = async () => {
    if (windows) return;
    const reach = d.reach;
    const door = d.door;
    if (!reach || !door || !reach.url()) return;
    if (reach.via() === 'cloudflare') {
      const dir = d.statusDir;
      const url = reach.url()!;
      if (!dir || !runner) return reach.set(null);
      const p = await prepareTunnel(cf, dir, url.hostname);
      if (!p.ok) { reach.set(null); said = `Reach was turned off: ${p.reason}`; return; }
      const port = await door.open();
      runner.start(p.tunnelId, p.credentials, port);
      reach.set(url, port, { via: 'cloudflare', tunnel: p.tunnelId });
      return;
    }
    const saved = reach.port();
    if (saved !== null) {
      try { await door.open(saved); return; } catch { /* taken by another program: a new door below */ }
    }
    const on = await funnelOn(ts, await door.open());
    if (on.ok) return reach.set(new URL(on.url), door.port());
    reach.set(null);
    await funnelOff(ts);
    said = `Reach was turned off: ${on.reason}`;
  };
  if (d.reach) {
    d.reach.ready = resume().catch((e: unknown) => {
      console.error('bringing Reach back failed:', e);
      d.reach?.set(null);
      said = 'Reach was turned off: BrainAI could not open its public door.';
    });
  }

  // Once set, the password and the authenticator are not replaced from here (D4 review): a borrowed or stolen
  // session must not be able to lock the owner out. Adding the authenticator asks for the password again.
  router.post('/settings/reach/password', owner, async (req, res) => {
    if (d.owner.hasPassword()) return back(res, 'A password is already set.');
    const pw = field(req, 'password');
    if (pw !== field(req, 'again')) return back(res, 'The two passwords are not the same.');
    if (pw.length < 12) return back(res, 'The password needs at least 12 characters.');
    await d.owner.setPassword(pw);
    keepSignedIn(req, res);
    back(res, 'Password set. Every other browser is signed out.');
  });

  router.post('/settings/reach/authenticator/start', owner, async (req, res) => {
    if (!d.owner.hasPassword()) return back(res, 'Set the password first.');
    if (d.owner.isConfigured()) return back(res, 'The authenticator is already set.');
    if (!(await d.owner.verifyPassword(field(req, 'current')))) return back(res, 'That password is not right.');
    pending = { secret: generateTotpSecret(), until: d.now().getTime() + PENDING_MS };
    back(res, null);
  });

  router.post('/settings/reach/authenticator/confirm', owner, (req, res) => {
    const now = d.now().getTime();
    if (!pending || pending.until < now) { pending = null; return back(res, 'That QR code expired: show a new one.'); }
    const code = field(req, 'code').trim();
    const step = Math.floor(now / 30_000);
    if (![step - 1, step, step + 1].some((s) => same(totpAt(pending!.secret, s), code))) return back(res, 'That code is not right: try the newest one.');
    if (d.owner.isConfigured()) { pending = null; return back(res, 'The authenticator is already set.'); }
    d.owner.setTotpSecret(pending.secret);
    pending = null;
    keepSignedIn(req, res);
    back(res, 'Authenticator added. Browsers now ask for the password and a code.');
  });
  router.post('/settings/reach/on', owner, macOnly, async (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, 'Set the password and the authenticator first.');
    if (!d.reach || !d.door) return back(res, 'Reach is not available here.');
    const door = await d.door.open();
    const r = await funnelOn(ts, door);
    if (!r.ok) { if (!d.reach.url()) d.door.close(); return back(res, r.reason); }
    d.reach.set(new URL(r.url), door);
    back(res, `On: BrainAI answers at ${r.url}.`);
  });

  // Reach through Cloudflare (D5): sign in once (the browser opens Cloudflare's page), then a name on your domain.
  const beginSignIn = () => {
    if (signing) return;
    const run = startSignIn(cf);
    signing = run;
    void run.done.then((r) => {
      if (signing === run) signing = null;
      said = r.ok ? 'Signed in to Cloudflare. Now choose the name BrainAI answers at.' : r.reason;
    });
  };
  router.post('/settings/reach/cloudflare/signin', owner, macOnly, (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, 'Set the password and the authenticator first.');
    beginSignIn();
    back(res, null);
  });

  // Signed in with the wrong domain or account: BrainAI forgets its own sign-in and tunnel, then signs in again.
  router.post('/settings/reach/cloudflare/another', owner, macOnly, (_req, res) => {
    if (!d.owner.isConfigured()) return back(res, 'Set the password and the authenticator first.');
    if (d.reach?.saved()) return back(res, 'Reach is on: turn it off first.');
    if (!d.statusDir || !cf.home) return back(res, 'Reach is not available here.');
    rmSync(join(cf.home, '.cloudflared', 'cert.pem'), { force: true });
    rmSync(join(d.statusDir, 'cloudflared', 'tunnel.json'), { force: true });
    beginSignIn();
    back(res, null);
  });

  router.post('/settings/reach/cloudflare/on', owner, macOnly, async (req, res) => {
    if (!d.owner.isConfigured()) return back(res, 'Set the password and the authenticator first.');
    if (!d.reach || !d.door || !runner || !d.statusDir) return back(res, 'Reach is not available here.');
    if (d.reach.saved()) return back(res, 'Reach is already on: turn it off first.');
    const hostname = String((req.body as Record<string, unknown> | undefined)?.hostname ?? '').trim().toLowerCase();
    if (!validHostname(hostname)) return back(res, 'Give a name under your domain, such as brain.example.com.');
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
      return back(res, `Cloudflare did not reach BrainAI at ${url.origin} within a minute, so Reach stays off.${log ? ` The tunnel said: ${log}` : ''}`);
    }
    back(res, `On: BrainAI answers at ${url.origin}.`);
  });

  router.post('/settings/reach/off', owner, async (_req, res) => {
    back(res, await reachOff(d));
  });
  return router;
}
