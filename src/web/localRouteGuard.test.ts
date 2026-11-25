/**
 * The local-only routers must refuse the public door route by route. Each router is built the way the route tests build
 * it (a desktop test app), and its real route stack is walked: a route whose first handler is the shared `localRouteOnly`
 * is local-only. Every other route has to be on the list below on purpose (the owner's pages that the door may reach), so
 * a new route that forgets the guard fails here, and so does a router that gains a bare `router.use`.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { startTestApp } from '../testing/helpers.js';
import { localRouteOnly } from '../desktop/publicDoor.js';
import type { AppDeps } from './app.js';
import { dashboardRoutes } from './dashboardRoutes.js';
import { desktopRoutes } from './desktopRoutes.js';
import { moveRoutes } from './moveRoutes.js';
import { reachRoutes } from './reachRoutes.js';
import { removeRoutes } from './removeRoutes.js';
import { savedRoutes } from './savedRoutes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }

/** What a router answers without the guard in front: "get /path" for a route, "(middleware)" for anything else. */
function unguarded(router: Router): { guarded: number; open: string[] } {
  let guarded = 0;
  const open: string[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) { open.push('(middleware)'); continue; }
    if (layer.route.stack[0]?.handle === localRouteOnly) guarded++;
    else open.push(`${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  }
  return { guarded, open };
}

/** The owner's pages and actions that are meant to work through the public door (the dashboard is the same one there). */
const DASHBOARD_OPEN = [
  'get /settings', 'post /settings/devices', 'post /settings/devices/:id/revoke', 'get /overview', 'get /approvals',
  'post /suggestions/:id/approve', 'post /suggestions/:id/reject', 'post /harvest/:batch/approve', 'post /harvest/:batch/reject',
  'post /inbox/undo', 'get /memories', 'get /facts', 'get /memories/new', 'post /memories', 'get /memories/:id',
  'post /memories/:id/supersede', 'post /supersessions/:id/undo', 'post /memories/:id', 'post /memories/:id/delete',
  'post /memories/:id/valid-until', 'post /memories/:id/confirm', 'post /history/:hid/undo', 'get /week', 'get /left',
  'get /facts/tidy', 'get /settings/tidy', 'post /tidy/duplicates/supersede', 'post /tidy/statuses/supersede', 'get /tidy',
  'post /tidy/statuses/keep', 'post /tidy/projects/move', 'post /tidy/projects/different', 'post /duplicates/merge',
  'post /duplicates/keep-both', 'get /clients', 'post /clients/:grantId/access', 'post /clients/:grantId/saves-wait',
  'post /settings/pause', 'post /settings/pause/resume', 'post /settings/language', 'post /settings/theme',
  'post /settings/coaching', 'post /settings/week-notice', 'post /clients/:grantId/name', 'post /clients/:grantId/revoke',
  'post /sessions/:id/revoke',
];
/** Reach is set up from the dashboard too (password, authenticator, on and off); only the Tailscale status is local. */
const REACH_OPEN = [
  'get /settings/reach', 'post /settings/reach/password', 'post /settings/reach/authenticator/start',
  'post /settings/reach/authenticator/confirm', 'post /settings/reach/on', 'post /settings/reach/cloudflare/signin',
  'post /settings/reach/cloudflare/another', 'post /settings/reach/cloudflare/on', 'post /settings/reach/off',
];

async function build(t: import('node:test').TestContext): Promise<AppDeps> {
  const home = mkdtempSync(join(tmpdir(), 'route-guard-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: home, tools: { home, path: '/usr/bin:/bin', apps: home, system: {}, claudeConfig: join(home, 'claude.json') } });
  t.after(() => app.close());
  return app.deps;
}

const CASES: [string, (d: AppDeps) => Router, string[], number][] = [
  // [name, builder, routes allowed to stay open, at least this many guarded routes]
  ['dashboardRoutes', dashboardRoutes, DASHBOARD_OPEN, 8],
  ['desktopRoutes', desktopRoutes, ['get /models/progress', 'get /welcome/first'], 23],
  ['moveRoutes', moveRoutes, [], 8],
  ['reachRoutes', reachRoutes, REACH_OPEN, 1],
  ['removeRoutes', removeRoutes, [], 7],
  ['savedRoutes', savedRoutes, [], 3],
];

test('every route of the local-only routers has the shared guard first, unless it is meant for the door', async (t) => {
  const deps = await build(t);
  for (const [name, build, allowed, atLeast] of CASES) {
    const { guarded, open } = unguarded(build(deps));
    assert.ok(guarded >= atLeast, `${name}: only ${guarded} guarded routes found (the router was probably not built)`);
    assert.deepEqual(open, allowed, `${name}: routes without the localRouteOnly guard`);
  }
});

test('the routers use the one shared guard, not a copy of it', () => {
  for (const name of ['dashboard', 'desktop', 'move', 'reach', 'remove', 'saved']) {
    const source = readFileSync(new URL(`./${name}Routes.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /viaDoor\(req\)\s*\?\s*next\('router'\)/, name);
    assert.match(source, /import \{[^}]*\blocalRouteOnly\b[^}]*\} from '\.\.\/desktop\/publicDoor\.js'/, name);
  }
});
