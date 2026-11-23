/** Test support for src/security: lists every route the web app registers, by walking its Express router. */
import type { Express } from 'express';

export interface RouteInfo { method: string; path: string }

interface Layer { route?: { path: string | string[]; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } }

function walk(stack: Layer[], out: RouteInfo[]): void {
  for (const l of stack) {
    // A route may be registered for several paths at once (app.get([a, b], ...)): one entry for each.
    if (l.route) for (const p of [l.route.path].flat()) for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: p });
    else if (l.handle?.stack) walk(l.handle.stack, out);
  }
}

/** Every (method, path) registered by createApp, in registration order. Paths keep their :params. */
export function listRoutes(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack, out);
  return out;
}

/** A concrete URL for a route: every :param becomes a harmless made-up value. */
export const concretePath = (path: string): string => path.replace(/:[A-Za-z]+(\.json)?/g, (m) => (m.endsWith('.json') ? 'x.json' : 'x'));
