import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { posesAsOwner } from '../memory/types.js';
import { randomToken } from './hash.js';
import { fetchClientMetadata, TransientFetchError } from './cimd.js';
import type { RedirectAllowlist } from './redirects.js';

export const CIMD_TTL_HOURS = 24;
export const MAX_CLIENT_NAME = 100;
/** Largest stored registration record (serialized JSON, bytes). */
export const MAX_CLIENT_METADATA_BYTES = 2 * 1024;
/** Unused dynamic registrations accepted per day; anonymous registrations can't pile up beyond this. */
export const MAX_NEW_CLIENTS_PER_DAY = 200;
/** What a registration keeps: the fields the server uses. The rest (contacts, jwks, statements) is dropped. */
const KEPT_FIELDS = [
  'client_id', 'client_id_issued_at', 'client_secret', 'client_secret_expires_at', 'redirect_uris', 'client_name',
  'token_endpoint_auth_method', 'grant_types', 'response_types', 'scope',
] as const;

interface Row { metadata: string; is_cimd: number; fetched_at: string | null; display_name: string | null }

/** A display name the owner chose is not acceptable; the message is safe to show. */
export class InvalidNameError extends Error {}

/** Trims a name the owner typed and checks it: 1 to MAX_CLIENT_NAME characters, not posing as the owner. */
export function validateDisplayName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw new InvalidNameError('Enter a name.');
  if (name.length > MAX_CLIENT_NAME) throw new InvalidNameError(`The name must be at most ${MAX_CLIENT_NAME} characters.`);
  if (posesAsOwner(name)) throw new InvalidNameError('The name must not read as the owner ("owner", "you" or "me").');
  return name;
}

/** An allowlist entry plain enough to print inside a command for the owner to paste: no shell characters at all. */
const PLAIN_ENTRY = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]*$/;
const ADD_COMMAND = 'docker compose exec app node dist/cli.js redirects add';

function parseUri(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

/** An http callback on the IPv6 loopback [::1], which the consent page's CSP cannot allow (see redirects.ts). */
function isIpv6Loopback(uri: string): boolean {
  const u = parseUri(uri);
  return u?.protocol === 'http:' && u.hostname === '[::1]';
}

/**
 * Why a redirect URI was refused, and what the owner can do. The URI comes from an anonymous caller, so it is shown
 * parsed (spaces and quotes encoded), and a ready-to-paste command is offered only when the entry has no characters a
 * shell would act on.
 */
function rejectionMessage(uri: string): string {
  const u = parseUri(uri);
  const shown = u ? u.href : JSON.stringify(uri);
  if (u && isIpv6Loopback(uri)) {
    return `Redirect URI ${shown} uses the IPv6 loopback address [::1], which this server does not support. The app must use a localhost or 127.0.0.1 callback instead.`;
  }
  const head = `Redirect URI ${shown} is not on this server's allowlist.`;
  if (u?.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    return `${head} To allow it, run on your server: ${ADD_COMMAND} loopback`;
  }
  const entry = u ? u.origin + u.pathname : '';
  if (PLAIN_ENTRY.test(entry)) return `${head} To allow it, run on your server: ${ADD_COMMAND} ${entry}`;
  return `${head} It is not a plain address (it holds characters a command line would act on), so no command is suggested. Check where it came from before allowing anything.`;
}

export class ClientsStore implements OAuthRegisteredClientsStore {
  static readonly CIMD_TTL_HOURS = CIMD_TTL_HOURS;
  readonly CIMD_TTL_HOURS = CIMD_TTL_HOURS;

  constructor(
    private readonly db: DB,
    private readonly allowlist: RedirectAllowlist,
    private readonly now: Clock,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT metadata, is_cimd, fetched_at, display_name FROM oauth_clients WHERE client_id = ?').get(id) as Row | undefined;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (!clientId.startsWith('https://')) {
      const r = this.row(clientId);
      return r ? (JSON.parse(r.metadata) as OAuthClientInformationFull) : undefined;
    }
    let origin: string;
    try {
      origin = new URL(clientId).origin;
    } catch {
      return undefined;
    }
    // Never fetch from hosts the owner has not allowlisted (SSRF guard).
    if (!this.allowlist.originAllowed(origin)) return undefined;

    const cached = this.row(clientId);
    const fromCache = (): OAuthClientInformationFull | undefined => {
      const c = JSON.parse(cached!.metadata) as OAuthClientInformationFull;
      const uris = c.redirect_uris.filter((u) => this.allowlist.isAllowed(u));
      return uris.length ? { ...c, redirect_uris: uris } : undefined;
    };
    const nowMs = this.now().getTime();
    if (cached?.is_cimd && cached.fetched_at && nowMs - Date.parse(cached.fetched_at) < CIMD_TTL_HOURS * 3600_000) {
      return fromCache();
    }

    let fetched: OAuthClientInformationFull;
    try {
      fetched = await fetchClientMetadata(clientId, this.fetchFn);
    } catch (e) {
      // A transient failure must not break token refresh: keep using the last good document. A missing (404/410),
      // unreadable or invalid document means the client is gone or changed, so it is refused.
      return e instanceof TransientFetchError && cached?.is_cimd ? fromCache() : undefined;
    }
    const redirect_uris = fetched.redirect_uris.filter((u) => this.allowlist.isAllowed(u));
    if (redirect_uris.length === 0) return undefined;
    const client = { ...fetched, redirect_uris };
    const iso = this.now().toISOString();
    this.db.prepare(
      `INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at, fetched_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, metadata = excluded.metadata, is_cimd = 1, fetched_at = excluded.fetched_at`,
    ).run(clientId, client.client_name ?? null, JSON.stringify(client), iso, iso);
    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    // A client listing several loopback variants (RFC 8252) keeps the ones that work; [::1] is dropped, not fatal.
    const listed = (client.redirect_uris ?? []).map(String);
    const usable = listed.filter((u) => !isIpv6Loopback(u));
    if (usable.length > 0 && usable.length < listed.length) client = { ...client, redirect_uris: usable };
    for (const uri of client.redirect_uris ?? []) {
      if (!this.allowlist.isAllowed(String(uri))) throw new InvalidClientMetadataError(rejectionMessage(String(uri)));
    }
    if (typeof client.client_name === 'string' && client.client_name.length > MAX_CLIENT_NAME) {
      throw new InvalidClientMetadataError(`client_name must be at most ${MAX_CLIENT_NAME} characters`);
    }
    if (posesAsOwner(client.client_name)) throw new InvalidClientMetadataError('client_name must not read as the owner ("owner", "you" or "me")');
    const dayAgo = new Date(this.now().getTime() - 86_400_000).toISOString();
    const recent = (this.db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients WHERE is_cimd = 0 AND created_at > ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`).get(dayAgo) as { n: number }).n;
    if (recent >= MAX_NEW_CLIENTS_PER_DAY) throw new InvalidClientMetadataError('Too many new client registrations today. Try again tomorrow.');
    // The SDK register handler already generates client_id and the secret; keep them, fill in only if absent.
    const kept = Object.fromEntries(KEPT_FIELDS.filter((k) => client[k as keyof typeof client] !== undefined).map((k) => [k, client[k as keyof typeof client]]));
    const full = {
      ...kept,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(this.now().getTime() / 1000),
    } as OAuthClientInformationFull;
    if (full.token_endpoint_auth_method !== 'none' && !full.client_secret) full.client_secret = randomToken();
    const metadata = JSON.stringify(full);
    if (Buffer.byteLength(metadata) > MAX_CLIENT_METADATA_BYTES) {
      throw new InvalidClientMetadataError(`Client metadata must be at most ${MAX_CLIENT_METADATA_BYTES / 1024} KB`);
    }
    this.db.prepare('INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(full.client_id, full.client_name ?? null, metadata, this.now().toISOString());
    return full;
  }

  /** Sets the name the owner gave this client (shown instead of its registered name); null clears it. */
  setDisplayName(clientId: string, name: string | null): void {
    this.db.prepare('UPDATE oauth_clients SET display_name = ? WHERE client_id = ?')
      .run(name === null ? null : validateDisplayName(name), clientId);
  }

  clientName(clientId: string): string {
    const r = this.row(clientId);
    if (!r) return 'Unknown client';
    if (r.display_name) return r.display_name;
    try {
      const c = JSON.parse(r.metadata) as OAuthClientInformationFull;
      if (c.client_name) return c.client_name;
      const first = c.redirect_uris?.[0];
      if (first) return new URL(String(first)).hostname;
    } catch { /* fall through */ }
    return 'Unknown client';
  }
}
