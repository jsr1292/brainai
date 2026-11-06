import type { Clock } from '../clock.js';

/** One sign-in address an app asked for and the server refused, as the owner can allow it. */
export interface Refused { uri: string; clientName: string; at: string }

const MAX = 10;
const KEEP_MS = 24 * 3_600_000;
const MAX_NAME = 100;

/**
 * Hosts on this machine or the home network: an IP literal, localhost, a single-label name, or a local-only suffix.
 * Allowing one would also let the server fetch client documents from it (clientsStore's originAllowed), so the
 * dashboard never offers them; the CLI can still add one on purpose.
 */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.')) return true;
  return /\.(local|lan|internal|home\.arpa|intranet|corp|home)$/.test(h);
}

/** The form an allowlist entry takes (origin + path), or undefined for anything the dashboard would not offer. */
export function allowableUri(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2000) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) return undefined;
    if (isInternalHost(u.hostname)) return undefined;
    return u.origin + u.pathname;
  } catch {
    return undefined;
  }
}

/**
 * The sign-in addresses apps were refused lately, so the owner can allow one with a click instead of a terminal
 * command. Kept in memory only: at most 10, each for a day, newest first. An anonymous client can add to it, so it is
 * only ever shown to the owner, who decides; nothing here is allowed by itself.
 */
export class RefusedRedirects {
  private items: Refused[] = [];
  constructor(private readonly now: Clock) {}

  record(clientName: unknown, uris: unknown, isAllowed: (uri: string) => boolean): void {
    if (!Array.isArray(uris)) return;
    // Control and format characters (U+202E and friends) would let a name reverse how the address beside it reads.
    const clean = typeof clientName === 'string' ? clientName.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
    const name = clean !== '' ? clean.slice(0, MAX_NAME) : 'An app';
    for (const raw of uris.slice(0, 5)) {
      const uri = allowableUri(raw);
      if (!uri || isAllowed(uri)) continue;
      this.items = [{ uri, clientName: name, at: this.now().toISOString() }, ...this.items.filter((r) => r.uri !== uri)].slice(0, MAX);
    }
  }

  list(): Refused[] {
    const since = this.now().getTime() - KEEP_MS;
    this.items = this.items.filter((r) => Date.parse(r.at) >= since);
    return [...this.items];
  }

  has(uri: string): boolean {
    return this.list().some((r) => r.uri === uri);
  }

  forget(uri: string): void {
    this.items = this.items.filter((r) => r.uri !== uri);
  }
}
