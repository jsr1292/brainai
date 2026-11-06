/**
 * The diagram renderer frame (round 2 section 12): a near-empty document whose only job is to run Mermaid. It has
 * its own policy, the one place inline styles are allowed (Mermaid needs them), with scripts still only from the
 * brain and no images, outside fonts or fetches; the page's own policy is unchanged.
 */
import express, { Router } from 'express';
import { DiagramCheckError } from '../pages/diagramChecks.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { asset } from './html.js';

export const FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function diagramRoutes(d: AppDeps): Router {
  const router = Router();
  router.get('/diagram-frame', requireOwner(d.sessions), (_req, res) => {
    res.set('Content-Security-Policy', FRAME_CSP);
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Diagram</title><script type="module" src="${asset('diagram-frame.js')}"></script></head><body></body></html>`);
  });
  // What a diagram drew when the owner viewed the page: an error sentence, or null. The server hashes the stored block.
  router.post('/pages/:id/diagram-checks', requireOwner(d.sessions), express.json({ limit: '4kb' }), (req, res) => {
    const p = d.pages.get(req.params.id as string);
    const body = (req.body ?? {}) as { version?: unknown; block?: unknown; error?: unknown };
    if (!p || p.deletedAt !== null) return void res.status(404).json({ error: 'No such page' });
    if (!Number.isInteger(body.version) || !Number.isInteger(body.block) || !(body.error === null || typeof body.error === 'string')) {
      return void res.status(400).json({ error: 'Send version, block and error (a sentence or null).' });
    }
    try {
      d.diagramChecks.record(p, body.version as number, body.block as number, body.error as string | null);
    } catch (e) {
      if (!(e instanceof DiagramCheckError)) throw e;
      return void res.status(e.code === 'version' ? 409 : 400).json({ error: e.message });
    }
    res.status(204).end();
  });
  return router;
}
