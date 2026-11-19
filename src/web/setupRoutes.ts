/** Guided setup (round 2 §17b): /settings/setup/<app> and its check line. Owner only. */
import { Router, type Response } from 'express';
import { allowableUri, type RefusedRedirects } from '../auth/refusedRedirects.js';
import { currentSetupVersion, setupApps, setupText } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { html, page } from './html.js';
import { currentLanguage, t } from '../i18n/core.js';
import { setupPage, setupStatusLine, toolsOnThisComputer } from './setupViews.js';

export function setupRoutes(d: AppDeps, refused: RefusedRedirects): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const appOf = (slug: string) => setupApps().find((a) => a.slug === slug);
  const missing = (res: Response) => res.status(404).type('html').send(page(t('common.notFound'), html`<h1>${t('common.notFound')}</h1><p>${t('setup.noPage')}</p>`, { tab: null }));

  router.get('/settings/setup/:app', owner, (req, res) => {
    const app = appOf(req.params.app as string);
    if (!app) return missing(res);
    // While Reach is on (D4), apps on the web and the phone use the public address; coding tools on this computer use it too, since their steps here are for another computer.
    const reach = d.reach?.url();
    const mcpUrl = new URL('/mcp', reach && (!app.file || toolsOnThisComputer(app, { needsReach: false, signIn: 'password', local: !!d.localMode })) ? reach : d.publicUrl).href;
    // A cloud app is called from the vendor's servers: with no public address (local mode, Reach off) there is nothing to give it.
    const ctx = { needsReach: !!d.localMode && !reach, local: !!d.localMode, signIn: d.owner.isConfigured() || !!reach ? 'password' as const : 'window' as const };
    const v = currentSetupVersion(d.setupOverlay);
    // An address allowed since (here, another page or the terminal) leaves the list.
    const allow = { allowed: (app.allow ?? []).every((e) => d.allowlist.isAllowed(e)), refused: refused.list().filter((r) => !d.allowlist.isAllowed(r.uri)) };
    res.type('html').send(page(t('setup.title', { app: app.name }), setupPage(app, setupText(app.slug, mcpUrl, d.setupOverlay, currentLanguage()), mcpUrl, setupStatusLine(app, d.provider.listGrants(), v), v, allow, ctx),
      { nav: true, tab: null, back: { href: '/settings#connections', labelKey: 'shell.nav.settings' } }));
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
      if (!uri || uri !== asked || !refused.has(uri)) return res.status(400).type('html').send(page(t('setup.notAllowed'), html`<h1>${t('setup.notAllowed')}</h1><p>${t('setup.notAllowedText')}</p>`, { tab: null }));
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
