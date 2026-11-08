/** Guided setup (round 2 §17b): /settings/setup/<app> and its check line. Owner only. */
import { Router, type Response } from 'express';
import { allowableUri, type RefusedRedirects } from '../auth/refusedRedirects.js';
import { currentSetupVersion, setupApps, setupText } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { html, page } from './html.js';
import { setupPage, setupStatusLine } from './setupViews.js';

export function setupRoutes(d: AppDeps, refused: RefusedRedirects): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const mode = d.mode ?? 'personal';
  const appOf = (slug: string) => setupApps(mode).find((a) => a.slug === slug);
  const missing = (res: Response) => res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1><p>No setup page for that app.</p>`, { tab: null }));

  router.get('/settings/setup/:app', owner, (req, res) => {
    const app = appOf(req.params.app as string);
    if (!app) return missing(res);
    // While Reach is on (D4), apps on the web and the phone use the public address; tools on this Mac keep localhost.
    const reach = d.reach?.url();
    const mcpUrl = new URL('/mcp', reach && !app.file ? reach : d.publicUrl).href;
    const v = currentSetupVersion(d.setupOverlay);
    // An address allowed since (here, another page or the terminal) leaves the list.
    const allow = { allowed: (app.allow ?? []).every((e) => d.allowlist.isAllowed(e)), refused: refused.list().filter((r) => !d.allowlist.isAllowed(r.uri)) };
    res.type('html').send(page(`Set up ${app.name}`, setupPage(app, setupText(app.slug, mode, mcpUrl, d.setupOverlay), mcpUrl, setupStatusLine(app, d.provider.listGrants(), v), v, allow),
      { nav: true, tab: null, back: { href: '/settings#connections', label: 'Settings' } }));
  });

  /**
   * Allows sign-ins: with no address, the app's own known ones (app.allow); with `uri`, one address an app was refused
   * lately, as listed on the page. Never free text: anything else is 400, and an app with nothing to allow is 404.
   */
  router.post('/settings/setup/:app/allow', owner, (req, res) => {
    const app = appOf(req.params.app as string);
    if (!app) return missing(res);
    const asked = (req.body as Record<string, unknown> | undefined)?.uri;
    let entries: readonly string[];
    if (asked !== undefined) {
      const uri = allowableUri(asked);
      if (!uri || uri !== asked || !refused.has(uri)) return res.status(400).type('html').send(page('Not allowed', html`<h1>Not allowed</h1><p>Only an address listed on the setup page can be allowed here.</p>`, { tab: null }));
      entries = [uri];
    } else {
      if (!app.allow?.length) return missing(res);
      entries = app.allow;
    }
    for (const e of entries) { d.allowlist.add(e); refused.forget(e); }
    res.redirect(303, `/settings/setup/${app.slug}#allow`);
  });

  router.get('/settings/setup/:app/status', owner, (req, res) => {
    const app = appOf(req.params.app as string);
    if (!app) return missing(res);
    res.set('Cache-Control', 'no-store').type('html').send(setupStatusLine(app, d.provider.listGrants(), currentSetupVersion(d.setupOverlay)).value);
  });
  return router;
}
