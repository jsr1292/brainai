import type { DB } from '../db.js';

/**
 * Loopback callbacks a native client may use. Only hosts the consent page's CSP form-action lets the browser redirect
 * to (src/web/app.ts): CSP can't name the IPv6 literal [::1], so such a client is refused at registration rather than
 * having its approval silently blocked.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function parse(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

/** Canonical form of an https entry: origin + pathname. */
function normalizeHttps(entry: string): string | undefined {
  const u = parse(entry);
  if (!u || u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) return undefined;
  return u.origin + u.pathname;
}

export class RedirectAllowlist {
  constructor(private readonly db: DB) {}

  list(): string[] {
    return (this.db.prepare('SELECT entry FROM redirect_allowlist ORDER BY entry').all() as { entry: string }[]).map((r) => r.entry);
  }

  add(entry: string): void {
    let value: string | undefined;
    if (entry === 'loopback') value = entry;
    else if (entry.includes('?') || entry.includes('#')) value = undefined;
    else value = normalizeHttps(entry);
    if (!value) throw new Error(`Invalid redirect entry "${entry}": use "loopback" or an https URL with no query or fragment`);
    this.db.prepare("INSERT OR IGNORE INTO redirect_allowlist(entry, added_at) VALUES (?, datetime('now'))").run(value);
  }

  remove(entry: string): void {
    const value = entry === 'loopback' ? entry : (normalizeHttps(entry) ?? entry);
    this.db.prepare('DELETE FROM redirect_allowlist WHERE entry = ?').run(value);
  }

  isAllowed(uri: string): boolean {
    try {
      const u = parse(uri);
      if (!u || u.hash || u.username || u.password) return false;
      const entries = this.list();
      if (u.protocol === 'http:') return entries.includes('loopback') && LOOPBACK_HOSTS.has(u.hostname);
      if (u.protocol !== 'https:') return false;
      return entries.includes(u.origin + u.pathname);
    } catch {
      return false;
    }
  }

  originAllowed(origin: string): boolean {
    try {
      return this.list().some((e) => e !== 'loopback' && parse(e)?.origin === origin);
    } catch {
      return false;
    }
  }
}
