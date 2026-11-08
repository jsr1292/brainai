import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import type { Access } from '../discussions/types.js';
import { PROJECT_RE } from '../memory/service.js';
import { validateDisplayName, type ClientsStore } from './clientsStore.js';
import { randomToken, sha256 } from './hash.js';
import type { RedirectAllowlist } from './redirects.js';

export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_DAYS = 90;
export const CODE_TTL_SEC = 300;
export const PENDING_TTL_SEC = 600;
/** A rotated refresh token replayed this soon gets fresh tokens instead of revoking the grant (concurrent sessions). */
export const REFRESH_REUSE_GRACE_SEC = 15;
const LAST_USED_RESOLUTION_SEC = 60;
const SCOPE = 'memory';

interface PendingParams { redirectUri: string; codeChallenge: string; state?: string; resource?: string }
interface PendingRow { client_id: string; params: string }
interface CodeRow { grant_id: string; client_id: string; redirect_uri: string; resource: string | null; expires_at: string; used_at: string | null; grant_revoked_at: string | null }
interface TokenRow { grant_id: string; client_id: string; resource: string | null; expires_at: string; revoked_at: string | null; rotated_at: string | null; grant_revoked_at: string | null }
interface GrantRow {
  id: string; client_id: string; name: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null; access: Access; projects: string | null;
  setup_version: number | null; setup_seen_at: string | null; tool_names: string | null; tools_seen_at: string | null;
}

export interface PendingInfo {
  clientId: string; clientName: string; redirectUri: string;
  /** The access level to preselect on the consent page; null to make the owner choose. */
  suggestedAccess: Access | null;
}
/** `projects`: what a read-only grant (access 'projects') may read; empty for other access levels. */
export interface GrantInfo {
  id: string; clientId: string; clientName: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; access: Access; projects: string[];
  /** Guided setup (§17b): the setup text version it last reported through load_profile, and when. */
  setupVersion: number | null; setupSeenAt: string | null;
  /** The tool names it got from its last tools/list (sorted), and when; null before its first. */
  toolNames: string[] | null; toolsSeenAt: string | null;
}

const isAccess = (v: unknown): v is Access => v === 'full' || v === 'discussions' || v === 'projects';
/** More projects than anyone would tick; keeps the stored list small. */
const MAX_GRANT_PROJECTS = 100;

/**
 * The projects column for a grant: the list as JSON for read-only access, which needs at least one valid project
 * name; NULL for other access levels, whatever was passed.
 */
function projectsColumn(access: Access, projects: readonly string[] | undefined): string | null {
  if (access !== 'projects') return null;
  const list = [...new Set(projects ?? [])];
  if (list.length === 0 || list.length > MAX_GRANT_PROJECTS || !list.every((p) => typeof p === 'string' && PROJECT_RE.test(p))) {
    throw new InvalidRequestError('Read-only access needs at least one project');
  }
  return JSON.stringify(list);
}
const parseProjects = (column: string | null): string[] => (column === null ? [] : JSON.parse(column) as string[]);

/** As the SDK's bearerAuth compares resources: serialized, without fragment and one trailing slash. */
function comparableResource(u: URL): string {
  const text = u.href;
  const hash = text.indexOf('#');
  return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, '');
}

/** A grant-level failure computed inside a transaction; thrown only after it commits so revocations stick. */
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Longest accepted OAuth state and PKCE challenge (an S256 challenge is 43 characters). */
const MAX_STATE = 1024;
const MAX_CODE_CHALLENGE = 128;

export class MemoryOAuthProvider implements OAuthServerProvider {
  readonly ACCESS_TTL_SEC = ACCESS_TTL_SEC;
  readonly REFRESH_TTL_DAYS = REFRESH_TTL_DAYS;
  readonly CODE_TTL_SEC = CODE_TTL_SEC;
  readonly PENDING_TTL_SEC = PENDING_TTL_SEC;

  constructor(
    private readonly db: DB,
    private readonly clients: ClientsStore,
    private readonly allowlist: RedirectAllowlist,
    private readonly now: Clock,
    /** The MCP endpoint every token is bound to; requireBearerAuth checks it as expectedResource. */
    private readonly resourceUrl: URL,
  ) {}

  get clientsStore(): ClientsStore {
    return this.clients;
  }

  /** A second MCP endpoint served at the same time (the desktop app's public address, D4), or none. */
  private extraResource: () => URL | null = () => null;
  setExtraResource(get: () => URL | null): void {
    this.extraResource = get;
  }

  /** The endpoints a grant may be bound to: this server's own, and the public one while it is on. */
  private resources(): URL[] {
    const extra = this.extraResource();
    return extra ? [this.resourceUrl, extra] : [this.resourceUrl];
  }

  /** The issuer of the address a grant was made at (its root URL); sent as `iss` on every callback (RFC 9207). */
  private issuerOf(resource: string | undefined): string {
    return new URL('/', resource ?? this.resourceUrl).href;
  }

  private iso(offsetSec = 0): string {
    return new Date(this.now().getTime() + offsetSec * 1000).toISOString();
  }

  // ---- Authorization and consent ----

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Stored for ten minutes per request: bounded, so anonymous requests can't fill the database.
    if ((params.state?.length ?? 0) > MAX_STATE || params.codeChallenge.length > MAX_CODE_CHALLENGE) {
      throw new InvalidRequestError('state or code_challenge is too long');
    }
    if (!this.allowlist.isAllowed(params.redirectUri)) {
      throw new InvalidRequestError(`Redirect URI ${params.redirectUri} is not on this server's allowlist`);
    }
    // Bind every grant to the MCP endpoint, so tokens are only usable there (a missing resource defaults to it).
    const resource = params.resource ?? this.resourceUrl;
    if (!this.resources().some((r) => comparableResource(r) === comparableResource(resource))) {
      throw new InvalidRequestError(`Unknown resource ${resource.href}; this server only serves ${this.resources().map((r) => r.href).join(' and ')}`);
    }
    const stored: PendingParams = {
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      resource: resource.href,
    };
    const id = randomToken();
    this.db.prepare('DELETE FROM oauth_pending WHERE expires_at <= ?').run(this.iso());
    this.db.prepare('INSERT INTO oauth_pending(id, client_id, params, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, client.client_id, JSON.stringify(stored), this.iso(PENDING_TTL_SEC));
    res.redirect(302, '/consent/' + id);
  }

  private pendingRow(id: string): { clientId: string; params: PendingParams } | undefined {
    const row = this.db.prepare('SELECT client_id, params FROM oauth_pending WHERE id = ? AND expires_at > ?')
      .get(id, this.iso()) as PendingRow | undefined;
    return row && { clientId: row.client_id, params: JSON.parse(row.params) as PendingParams };
  }

  getPending(id: string): PendingInfo | undefined {
    const p = this.pendingRow(id);
    return p && {
      clientId: p.clientId, clientName: this.clients.clientName(p.clientId), redirectUri: p.params.redirectUri,
      suggestedAccess: this.lastAccessForRegisteredName(p.clientId),
    };
  }

  /**
   * The access level to preselect from the grants (revoked ones included) to clients registered under the same
   * client_name as this one: 'full' if there are none; their shared level if it is a limited one; otherwise null, so
   * the owner chooses. Apps like OpenCode and Grok Build register afresh on every reconnect, so a "Discussions only"
   * choice is offered again instead of being undone by a quick click. An app already connected with full access may
   * be a second account of it (a work ChatGPT next to the personal one), which must not get Full by a quick click
   * either. The registered name is compared, not the display name the owner chose.
   */
  private lastAccessForRegisteredName(clientId: string): Access | null {
    const levels = this.db.prepare(
      `SELECT DISTINCT g.access FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
       WHERE c.client_name = (SELECT client_name FROM oauth_clients WHERE client_id = ?)`,
    ).all(clientId) as { access: Access }[];
    if (levels.length === 0) return 'full';
    return levels.length === 1 && levels[0]!.access !== 'full' ? levels[0]!.access : null;
  }

  async approvePending(id: string, opts: { name?: string; access?: Access; projects?: string[] } = {}): Promise<string> {
    const access = opts.access ?? 'full';
    if (!isAccess(access)) throw new InvalidRequestError('Unknown access level');
    const projects = projectsColumn(access, opts.projects);
    // Validate the name before anything is consumed, so a bad name leaves the request open to retry.
    const name = opts.name === undefined ? undefined : validateDisplayName(opts.name);
    const pending = this.pendingRow(id);
    if (!pending) throw new InvalidRequestError('Authorization request not found or expired');
    // Re-check the client and redirect at approval time: either may have been removed since authorize().
    const client = await this.clients.getClient(pending.clientId);
    const { redirectUri } = pending.params;
    // Match registered URIs exactly as the SDK's /authorize did (a loopback URI may use any port, RFC 8252 §7.3).
    // The code keeps the requested URI, so the redirect_uri check at /token compares against what the client used.
    const registered = client?.redirect_uris.map(String).some((r) => redirectUriMatches(redirectUri, r));
    if (!client || !registered || !this.allowlist.isAllowed(redirectUri)) {
      throw new InvalidRequestError('Client or redirect URI is no longer allowed');
    }
    const code = randomToken();
    this.db.transaction(() => {
      const nowIso = this.iso();
      // Consume the pending row atomically; a concurrent approve/deny of the same id loses here.
      const consumed = this.db.prepare('DELETE FROM oauth_pending WHERE id = ? AND expires_at > ?').run(id, nowIso);
      if (consumed.changes !== 1) throw new InvalidRequestError('Authorization request not found or expired');
      const grantId = randomUUID();
      // The connection keeps its own name; the app's display name is only what its next consent suggests.
      const grantName = name ?? this.clients.clientName(pending.clientId);
      if (name !== undefined && name !== this.clients.clientName(pending.clientId)) {
        // A connection with no name of its own shows the app's: fix it first, so renaming the app does not rename it.
        this.db.prepare('UPDATE oauth_grants SET name = ? WHERE client_id = ? AND name IS NULL').run(this.clients.clientName(pending.clientId), pending.clientId);
        this.clients.setDisplayName(pending.clientId, name);
      }
      this.db.prepare('INSERT INTO oauth_grants(id, client_id, name, created_at, access, projects) VALUES (?, ?, ?, ?, ?, ?)').run(grantId, pending.clientId, grantName, nowIso, access, projects);
      this.db.prepare(
        `INSERT INTO oauth_codes(code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sha256(code), grantId, pending.clientId, pending.params.codeChallenge, redirectUri,
        pending.params.resource ?? null, this.iso(CODE_TTL_SEC));
    })();
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    url.searchParams.set('iss', this.issuerOf(pending.params.resource));
    return url.href;
  }

  denyPending(id: string): string {
    const pending = this.pendingRow(id);
    const deleted = this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(id);
    if (!pending || deleted.changes !== 1) throw new InvalidRequestError('Authorization request not found or expired');
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    url.searchParams.set('iss', this.issuerOf(pending.params.resource));
    return url.href;
  }

  // ---- Codes and tokens ----

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    // Used codes still answer here so a replay reaches exchangeAuthorizationCode, which revokes the grant.
    const row = this.db.prepare('SELECT code_challenge FROM oauth_codes WHERE code_hash = ? AND client_id = ?')
      .get(sha256(authorizationCode), client.client_id) as { code_challenge: string } | undefined;
    if (!row) throw new InvalidGrantError('Invalid authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = sha256(authorizationCode);
    const outcome = this.db.transaction((): Outcome<OAuthTokens> => {
      const nowIso = this.iso();
      const row = this.db.prepare(
        `SELECT c.grant_id, c.client_id, c.redirect_uri, c.resource, c.expires_at, c.used_at, g.revoked_at AS grant_revoked_at
         FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?`,
      ).get(codeHash) as CodeRow | undefined;
      if (!row || row.client_id !== client.client_id) return { ok: false, message: 'Invalid authorization code' };
      if (row.used_at !== null) {
        this.revokeGrantTx(row.grant_id, nowIso);
        return { ok: false, message: 'Authorization code already used; grant revoked' };
      }
      if (row.grant_revoked_at !== null) return { ok: false, message: 'Grant has been revoked' };
      if (row.expires_at <= nowIso) return { ok: false, message: 'Authorization code expired' };
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) return { ok: false, message: 'redirect_uri does not match' };
      if (resource && row.resource !== null && resource.href !== row.resource) return { ok: false, message: 'resource does not match' };
      const marked = this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(nowIso, codeHash);
      if (marked.changes !== 1) {
        this.revokeGrantTx(row.grant_id, nowIso);
        return { ok: false, message: 'Authorization code already used; grant revoked' };
      }
      return { ok: true, value: this.issueTokensTx(row.grant_id, row.resource) };
    })();
    if (!outcome.ok) throw new InvalidGrantError(outcome.message);
    return outcome.value;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const tokenHash = sha256(refreshToken);
    const outcome = this.db.transaction((): Outcome<OAuthTokens> => {
      const nowIso = this.iso();
      const row = this.tokenRow(tokenHash, 'refresh');
      if (!row || row.client_id !== client.client_id) return { ok: false, message: 'Invalid refresh token' };
      if (row.revoked_at !== null) {
        // Sessions of one app share a login and may refresh with the same token at once: forgive a replay just after
        // rotation. Anything later, or a token that was revoked rather than rotated, is treated as theft.
        const inGrace = row.rotated_at !== null && row.grant_revoked_at === null && row.rotated_at >= this.iso(-REFRESH_REUSE_GRACE_SEC);
        if (!inGrace) {
          this.revokeGrantTx(row.grant_id, nowIso);
          return { ok: false, message: 'Refresh token reused; grant revoked' };
        }
      }
      if (row.grant_revoked_at !== null) return { ok: false, message: 'Grant has been revoked' };
      if (row.expires_at <= nowIso) return { ok: false, message: 'Refresh token expired' };
      if (resource && row.resource !== null && resource.href !== row.resource) return { ok: false, message: 'resource does not match' };
      if (row.revoked_at === null) {
        const rotated = this.db.prepare('UPDATE oauth_tokens SET revoked_at = ?, rotated_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
          .run(nowIso, nowIso, tokenHash);
        if (rotated.changes !== 1) {
          this.revokeGrantTx(row.grant_id, nowIso);
          return { ok: false, message: 'Refresh token reused; grant revoked' };
        }
      }
      return { ok: true, value: this.issueTokensTx(row.grant_id, row.resource) };
    })();
    if (!outcome.ok) throw new InvalidGrantError(outcome.message);
    return outcome.value;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.tokenRow(sha256(token), 'access');
    const nowIso = this.iso();
    if (!row || row.revoked_at !== null || row.grant_revoked_at !== null || row.expires_at <= nowIso) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    this.db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)')
      .run(nowIso, row.grant_id, this.iso(-LAST_USED_RESOLUTION_SEC));
    return {
      token,
      clientId: row.client_id,
      scopes: [SCOPE],
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
      ...(row.resource !== null ? { resource: new URL(row.resource) } : {}),
      extra: { grantId: row.grant_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Only the client the token was issued to may revoke it (RFC 7009 §2.1); anything else is a silent no-op.
    // Revoking a refresh token ends the whole grant (RFC 7009 §2.1 allows it), so no earlier rotated token of the
    // grant can still use the reuse grace period after a logout.
    const tokenHash = sha256(request.token);
    this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT t.grant_id, t.type FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND g.client_id = ?`,
      ).get(tokenHash, client.client_id) as { grant_id: string; type: 'access' | 'refresh' } | undefined;
      if (!row) return;
      const nowIso = this.iso();
      if (row.type === 'refresh') this.revokeGrantTx(row.grant_id, nowIso);
      else this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(nowIso, tokenHash);
    })();
  }

  // ---- Grants (owner-facing) ----

  listGrants(): GrantInfo[] {
    const rows = this.db.prepare('SELECT id, client_id, name, created_at, last_used_at, revoked_at, access, projects, setup_version, setup_seen_at, tool_names, tools_seen_at FROM oauth_grants ORDER BY created_at DESC, id')
      .all() as GrantRow[];
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: r.name ?? this.clients.clientName(r.client_id),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      access: r.access,
      projects: parseProjects(r.projects),
      setupVersion: r.setup_version, setupSeenAt: r.setup_seen_at,
      toolNames: r.tool_names === null ? null : JSON.parse(r.tool_names) as string[], toolsSeenAt: r.tools_seen_at,
    }));
  }

  /** Guided setup (§17b): the setup text version a connection reported through load_profile. */
  setGrantSetup(grantId: string, version: number): void {
    this.db.prepare('UPDATE oauth_grants SET setup_version = ?, setup_seen_at = ? WHERE id = ?').run(version, this.iso(), grantId);
  }

  /** Guided setup (§17b): the tools a connection got from tools/list, so Settings can say when its list is stale. */
  recordTools(grantId: string, names: readonly string[]): void {
    this.db.prepare('UPDATE oauth_grants SET tool_names = ?, tools_seen_at = ? WHERE id = ?').run(JSON.stringify([...names].sort()), this.iso(), grantId);
  }

  /** A connection's own name: what its saves are signed with and what Settings shows. */
  grantName(grantId: string): string {
    const r = this.db.prepare('SELECT client_id, name FROM oauth_grants WHERE id = ?').get(grantId) as { client_id: string; name: string | null } | undefined;
    if (!r) return 'Unknown client';
    return r.name ?? this.clients.clientName(r.client_id);
  }

  /** Renames one connection; other connections of the same app keep their names. */
  setGrantName(grantId: string, name: string): void {
    const r = this.db.prepare('UPDATE oauth_grants SET name = ? WHERE id = ?').run(validateDisplayName(name), grantId);
    if (r.changes !== 1) throw new Error(`Unknown grant ${grantId}`);
  }

  /** Changes what a connection may reach (`projects`: for read-only access). Takes effect on its next request. */
  setGrantAccess(grantId: string, access: Access, projects?: string[]): void {
    if (!isAccess(access)) throw new Error(`Unknown access level ${String(access)}`);
    const r = this.db.prepare('UPDATE oauth_grants SET access = ?, projects = ? WHERE id = ?').run(access, projectsColumn(access, projects), grantId);
    if (r.changes !== 1) throw new Error(`Unknown grant ${grantId}`);
  }

  /** The projects a read-only grant may read; empty for any other grant, or an unknown one. */
  grantProjects(grantId: string): string[] {
    const r = this.db.prepare("SELECT projects FROM oauth_grants WHERE id = ? AND access = 'projects'").get(grantId) as { projects: string | null } | undefined;
    return parseProjects(r?.projects ?? null);
  }

  /** Whether a grant exists and is not revoked (an upload link is checked again when it is used). */
  grantLive(grantId: string): boolean {
    return this.db.prepare('SELECT 1 FROM oauth_grants WHERE id = ? AND revoked_at IS NULL').get(grantId) !== undefined;
  }

  /** The access level of a grant. Fails closed: an unknown id gets 'discussions' (grants made before access levels got 'full' from migration 7). */
  grantAccess(grantId: string): Access {
    const r = this.db.prepare('SELECT access FROM oauth_grants WHERE id = ?').get(grantId) as { access: Access } | undefined;
    return r?.access ?? 'discussions';
  }

  /**
   * Names of connections used within `days` (or connected within it, if never used); one per name, the most
   * permissive access wins. Read-only connections are left out: they cannot take part in discussions.
   */
  activeConnections(days = 30): { name: string; access: Access }[] {
    const rows = this.db.prepare(
      "SELECT client_id, name, access FROM oauth_grants WHERE revoked_at IS NULL AND access != 'projects' AND COALESCE(last_used_at, created_at) >= ?",
    ).all(this.iso(-days * 86400)) as { client_id: string; name: string | null; access: Access }[];
    const byName = new Map<string, Access>();
    for (const r of rows) {
      const name = r.name ?? this.clients.clientName(r.client_id);
      if (byName.get(name) !== 'full') byName.set(name, r.access);
    }
    return [...byName].map(([name, access]) => ({ name, access }));
  }

  revokeGrant(id: string): void {
    this.db.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM oauth_grants WHERE id = ?').get(id);
      if (!exists) throw new Error(`Unknown grant ${id}`);
      this.revokeGrantTx(id, this.iso());
    })();
  }

  // ---- Internals (callers hold a transaction) ----

  private tokenRow(tokenHash: string, type: 'access' | 'refresh'): TokenRow | undefined {
    return this.db.prepare(
      `SELECT t.grant_id, g.client_id, t.resource, t.expires_at, t.revoked_at, t.rotated_at, g.revoked_at AS grant_revoked_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.type = ?`,
    ).get(tokenHash, type) as TokenRow | undefined;
  }

  private revokeGrantTx(grantId: string, nowIso: string): void {
    this.db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso, grantId);
    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(nowIso, grantId);
  }

  private issueTokensTx(grantId: string, resource: string | null): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    const insert = this.db.prepare('INSERT INTO oauth_tokens(token_hash, grant_id, type, resource, expires_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(sha256(access), grantId, 'access', resource, this.iso(ACCESS_TTL_SEC));
    insert.run(sha256(refresh), grantId, 'refresh', resource, this.iso(REFRESH_TTL_DAYS * 86400));
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: SCOPE };
  }
}
