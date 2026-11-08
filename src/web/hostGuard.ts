import type { RequestHandler } from 'express';

/** An app's own endpoint (MCP, OAuth, uploads), a discovery document or a static file: not a page the owner opens. */
export function isAppPath(path: string, clientEndpoints: readonly string[]): boolean {
  return path.startsWith('/static/') || path.startsWith('/.well-known/') || path.startsWith('/api/')
    || clientEndpoints.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * The desktop app's guard against DNS rebinding (D1): a web page on attacker.example that re-points its name at
 * 127.0.0.1 still sends `Host: attacker.example`, so only the two exact local forms are answered. A page opened as
 * 127.0.0.1 is sent to localhost, so the dashboard has one address (one cookie jar, one Origin for its forms); the
 * apps' own endpoints answer on either. Runs before everything else in local mode.
 */
export function hostGuard(publicUrl: URL, clientEndpoints: readonly string[]): RequestHandler {
  const port = publicUrl.port || (publicUrl.protocol === 'https:' ? '443' : '80');
  const local = `localhost:${port}`;
  const loopback = `127.0.0.1:${port}`;
  return (req, res, next) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host === local) return next();
    if (host === loopback) {
      if ((req.method === 'GET' || req.method === 'HEAD') && !isAppPath(req.path, clientEndpoints)) return res.redirect(308, publicUrl.origin + req.originalUrl);
      return next();
    }
    res.status(421).type('text/plain').send('This address only answers to localhost.');
  };
}

/**
 * Fetch Metadata for the local dashboard (D1 review): the session cookie is SameSite=Lax, so another site's image,
 * script or fetch arrives without it, and in local mode would be signed in afresh. Such requests are refused; a
 * link followed from elsewhere (a GET navigation) still opens BrainAI. Browsers that send no Sec-Fetch-* headers fall
 * back to the Origin check and SameSite.
 */
export function fetchMetadataGuard(clientEndpoints: readonly string[]): RequestHandler {
  return (req, res, next) => {
    if (isAppPath(req.path, clientEndpoints)) return next();
    const site = req.get('sec-fetch-site');
    if (site !== 'cross-site' && site !== 'same-site') return next();
    if (req.get('sec-fetch-mode') === 'navigate' && (req.method === 'GET' || req.method === 'HEAD')) return next();
    res.status(403).type('text/plain').send('Another site cannot use this page.');
  };
}
