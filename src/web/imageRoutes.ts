/**
 * The owner's pictures (round 2 section 12): POST /images stores one (raw bytes, at most 10 MB; the Origin check in
 * app.ts covers it) and answers its Markdown line; GET /images/<id>.<ext> serves it with its exact type, a sandbox
 * policy and nosniff, so a picture can never run as a page. Both are behind the owner's session.
 */
import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { pictureLine } from '../images/line.js';
import { rateLimitKey } from './clientIp.js';
import { ImageError, MAX_UPLOAD } from '../images/clean.js';
import { PICTURE_PATH } from '../pages/markdown.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';

const MAX_ALT = 300;
const PLACEHOLDER_ALT = 'Describe the picture';
const TOO_LARGE = new ImageError('too_large').message;

/** A description can't break out of the Markdown image it goes in: brackets and line breaks become spaces. */
const altText = (raw: unknown): string => (typeof raw === 'string' ? raw : '').replace(/[[\]\r\n]+/g, ' ').trim().slice(0, MAX_ALT);

export function imageRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);

  router.post('/images', owner, express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const img = d.images.add(body, { alt: altText(req.query.alt), by: 'owner' });
      const alt = altText(req.query.alt) || PLACEHOLDER_ALT;
      res.status(201).json({ id: img.id, markdown: `![${alt}](/images/${img.id}.${img.ext})`, width: img.width, height: img.height, bytes: img.bytes, type: img.type });
    } catch (e) {
      if (!(e instanceof ImageError)) throw e;
      res.status(e.code === 'too_large' ? 413 : 400).json({ error: e.message });
    }
  });

  router.get('/images/:file', owner, (req, res) => {
    const m = PICTURE_PATH.exec(`/images/${req.params.file as string}`);
    const img = m ? d.images.get(m[1]!) : undefined;
    if (!img || img.removedAt !== null || img.ext !== m![2]) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // Relative to the pictures folder, so only the checked name is tested for dot-segments, wherever DATA_DIR is.
    res.sendFile(d.images.relPath(img), {
      root: d.images.root,
      dotfiles: 'deny',
      headers: {
        'Content-Type': `image/${img.type}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        // A picture's file never changes (its name is its content's hash): kept privately in the browser for a year,
        // never in Cloudflare's cache, and cleared at logout (Clear-Site-Data).
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found');
    });
  });

  // Assistants with a shell: PUT the file to a one-use link (begin_image_upload). No session and no Origin (curl sends
  // none): the token is the key, checked with its connection before the body is read.
  const USED_UP = { error: 'This upload link is used up or expired. Ask for a new one with begin_image_upload.' };
  const perIp = new RateLimiterMemory({ points: 100, duration: 15 * 60 });
  const limit: RequestHandler = async (req, res, next) => {
    try { await perIp.consume(rateLimitKey(req)); next(); } catch { res.status(429).json({ error: 'Too many uploads; try again later.' }); }
  };
  router.put('/api/image-upload/:token', limit, (req, res, next) => {
    const link = d.uploadLinks.take(req.params.token as string);
    if (!link) return void res.status(410).json(USED_UP);
    if (!d.provider.grantLive(link.grantId) || d.provider.grantAccess(link.grantId) !== 'full') {
      return void res.status(403).json({ error: 'This connection can no longer add pictures.' });
    }
    const page = d.pages.get(link.pageId);
    if (!page || page.deletedAt !== null) return void res.status(410).json(USED_UP);
    res.locals.link = link;
    next();
  }, express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
    const link = res.locals.link as import('../images/uploadLinks.js').UploadLink;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Checked again now the body has arrived (a slow upload), and the link claimed in the same step as the store.
    if (!d.provider.grantLive(link.grantId) || d.provider.grantAccess(link.grantId) !== 'full') {
      return void res.status(403).json({ error: 'This connection can no longer add pictures.' });
    }
    if (!d.uploadLinks.claim(link.tokenHash)) return void res.status(410).json(USED_UP);
    try {
      const img = d.images.add(body, { alt: link.alt, by: link.by, pageId: link.pageId });
      d.uploadLinks.markUsed(link.tokenHash, img.id);
      res.status(201).type('text/plain').send(pictureLine(link.alt, img, link.title));
    } catch (e) {
      // The link goes back: the assistant can send a proper file within its ten minutes.
      d.uploadLinks.release(link.tokenHash);
      if (!(e instanceof ImageError)) throw e;
      res.status(e.code === 'too_large' ? 413 : 400).json({ error: e.message });
    }
  });

  // The raw parser's own refusal of a body over 10 MB, in the route's JSON.
  const tooLarge: ErrorRequestHandler = (err, req, res, next) => {
    if (err?.type !== 'entity.too.large' || !(req.path === '/images' || req.path.startsWith('/api/image-upload/')) || res.headersSent) return next(err);
    res.status(413).json({ error: TOO_LARGE });
  };
  router.use(tooLarge);
  return router;
}
