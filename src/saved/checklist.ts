/** What BrainAI could not remove by itself: the list the person works through, and the apps it starts from. */
import { systemClock } from '../clock.js';
import type { DB } from '../db.js';
import { RedirectAllowlist } from '../auth/redirects.js';
import { ClientsStore } from '../auth/clientsStore.js';
import { MemoryOAuthProvider } from '../auth/provider.js';
import { t, type PlainKey } from '../i18n/core.js';

const WEB_APP_LINES = new Map<string, PlainKey>([
  ['Claude', 'data.checklist.claude'],
  ['ChatGPT', 'data.checklist.chatgpt'],
  ['Grok', 'data.checklist.grok'],
]);

/**
 * The names of the web apps connected to this brain, as the dashboard shows them: one per app, from grants that are not
 * revoked. Grant listing never uses the resource URL, so a placeholder is enough to build the provider (as `cli clients`).
 */
export function webAppNames(db: DB): string[] {
  const allowlist = new RedirectAllowlist(db);
  const provider = new MemoryOAuthProvider(db, new ClientsStore(db, allowlist, systemClock), allowlist, systemClock, new URL('http://localhost/mcp'));
  return [...new Set(provider.listGrants().filter((g) => !g.revokedAt).map((g) => g.clientName))];
}

/**
 * A server's tunnel for the checklist: named by the public address's host, none for a localhost address (or none at
 * all). The server never deletes it, so it is always on the list.
 */
export function serverTunnel(publicUrl: string | URL | undefined): { hostname: string | null; deleted: false } {
  let hostname: string | null = null;
  try { hostname = new URL(publicUrl ?? '').hostname || null; } catch { /* no public address */ }
  if (hostname === 'localhost' || hostname === '127.0.0.1') hostname = null;
  return { hostname, deleted: false };
}

export interface ChecklistInput {
  install: 'app' | 'server';
  webApps: string[];
  tunnel: { hostname: string | null; deleted: boolean } | null;
  leftTools: { name: string; reason: string }[];
  kept: string[];
}

/** The lines, in the order a person would work through them: the apps, then the tunnel, then what is left behind. */
export function checklist(i: ChecklistInput): string[] {
  const lines = i.webApps.map((name) => {
    const key = WEB_APP_LINES.get(name);
    return key ? t(key) : t('data.checklist.otherApp', { name });
  });
  lines.push(t('data.checklist.instructions'));
  if (i.install === 'server' || (i.tunnel !== null && !i.tunnel.deleted)) {
    const address = i.tunnel?.hostname ? ` ${i.tunnel.hostname}` : '';
    lines.push(t('data.checklist.tunnel', { address }));
  }
  if (i.install === 'server') {
    lines.push(t('data.checklist.uptime'));
    lines.push(t('data.checklist.offsite'));
  }
  for (const tool of i.leftTools) lines.push(`${tool.name}: ${tool.reason}`);
  lines.push(...i.kept);
  return lines;
}
