/** Guided setup (round 2 §17b): for each connection, its setup text and whether its tool list is stale. */
import type { GrantInfo } from '../auth/provider.js';
import { servedToolNames } from '../mcp/server.js';
import { appOfGrant, currentSetupVersion, SETUP_VERSION, setupApps } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { mcpServerFor } from './mcpFor.js';

export interface ConnStatus {
  /** 'none': the connection has no load_profile (discussions only, read only), so it can't report one. */
  setup: 'current' | 'older' | 'unknown' | 'none';
  version: number | null;
  /** Tools the brain serves this connection now that its last tools/list didn't have. */
  added: number;
  /** Its last list differs only by tools that went away. */
  changed: boolean;
  /** The app its name suggests, for the link to its setup page; null when none does. */
  app: string | null;
}

export const needsLook = (s: ConnStatus) => s.setup === 'older' || s.setup === 'unknown' || s.added > 0 || s.changed;

/** `apps`: the slugs with a setup page in this brain's mode, so a link never leads to a 404. */
export function connStatus(g: GrantInfo, current: readonly string[], apps: readonly string[], version = SETUP_VERSION): ConnStatus {
  // A number newer than the brain's own is a guess or an old draft: never a false "up to date".
  const setup = !current.includes('load_profile') ? 'none'
    : g.setupVersion === null || g.setupVersion > version ? 'unknown' : g.setupVersion === version ? 'current' : 'older';
  const seen = g.toolNames;
  const added = seen === null ? 0 : current.filter((n) => !seen.includes(n)).length;
  const changed = seen !== null && added === 0 && seen.some((n) => !current.includes(n));
  const app = appOfGrant(g.clientName);
  return { setup, version: g.setupVersion, added, changed, app: app !== null && apps.includes(app) ? app : null };
}

/** Every live connection's status. */
export function connStatuses(d: AppDeps, grants: readonly GrantInfo[]): Map<string, ConnStatus> {
  // Built exactly as /mcp builds it for that grant: some tools depend on the grant itself (picture uploads).
  const toolsFor = (g: GrantInfo) => {
    const server = mcpServerFor(d, { actorName: g.clientName, access: g.access, projects: g.access === 'projects' ? g.projects : undefined, clientId: g.clientId, grantId: g.id });
    const names = servedToolNames(server);
    void server.close();
    return names;
  };
  const apps = setupApps(d.mode ?? 'personal').map((a) => a.slug);
  const version = currentSetupVersion(d.setupOverlay);
  return new Map(grants.filter((g) => !g.revokedAt).map((g) => [g.id, connStatus(g, toolsFor(g), apps, version)]));
}
