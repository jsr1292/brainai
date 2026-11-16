/** What BrainAI could not remove by itself: the list the person works through, and the apps it starts from. */
import { systemClock } from '../clock.js';
import type { DB } from '../db.js';
import { RedirectAllowlist } from '../auth/redirects.js';
import { ClientsStore } from '../auth/clientsStore.js';
import { MemoryOAuthProvider } from '../auth/provider.js';

const WEB_APP_LINES: Record<string, string> = {
  Claude: 'Claude (claude.ai and the phone app): Settings › Connectors › BrainAI › Remove',
  ChatGPT: 'ChatGPT: Settings › Apps & Connectors › BrainAI › Delete',
  Grok: 'Grok: Settings › Connectors › BrainAI › Remove',
};

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
  const lines = i.webApps.map((n) => WEB_APP_LINES[n] ?? `${n}: remove BrainAI from its connector or MCP settings`);
  lines.push("The text you pasted into each app's instructions to use BrainAI");
  if (i.install === 'server' || (i.tunnel !== null && !i.tunnel.deleted)) {
    const address = i.tunnel?.hostname ? ` ${i.tunnel.hostname}` : '';
    lines.push(`Cloudflare: delete the tunnel and the public address${address} (Zero Trust › Networks › Tunnels)`);
  }
  if (i.install === 'server') {
    lines.push('Your uptime alert, if you set one up');
    lines.push('The off-site key on your own computer (memory-offsite-key.txt), once you no longer need the Google Drive copies');
  }
  for (const t of i.leftTools) lines.push(`${t.name}: ${t.reason}`);
  lines.push(...i.kept);
  return lines;
}
