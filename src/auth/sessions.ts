import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { randomToken, sha256 } from './hash.js';
import { inDoorRequest } from '../desktop/publicDoor.js';

export const SESSION_DAYS = 30;
/**
 * A password login at the localhost address lasts this long (the app window's session and a login at the public address keep
 * SESSION_DAYS). That cookie is host-only for "localhost" but browsers send it to every localhost port, so another program
 * listening on one gets it: the shorter its life, the less that is worth. The window never loads other ports, and the public
 * address is its own host.
 */
export const LOCAL_LOGIN_DAYS = 7;

/**
 * Where a session was made. It is the first part of the token itself, so it cannot be changed without making the token
 * unknown (only the hash of the whole token is stored, and no database change is needed): 'app' the window's ticket,
 * 'local' a password login at localhost, 'door' a login at the public address. A token with no such start (made before
 * this was recorded) counts as 'local'.
 */
export type SessionOrigin = 'app' | 'local' | 'door';
/** Where a session token says it was made. */
export const originOf = (token: string): SessionOrigin => {
  const head = token.slice(0, token.indexOf('.'));
  return head === 'app' || head === 'door' ? head : 'local';
};
/** Days a session of this origin lasts. */
export const sessionDays = (origin: SessionOrigin): number => (origin === 'local' ? LOCAL_LOGIN_DAYS : SESSION_DAYS);
/** A known device unused this long stops counting as known (and its cookie, set for as long, has expired too). */
export const DEVICE_DAYS = 400;
const DAY_MS = 86_400_000;
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionInfo { id: string; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }

export class SessionStore {
  constructor(private db: DB, private now: Clock) {}

  /** A new known-device token (the browser keeps it in a cookie; only its hash is stored). */
  rememberDevice(): string {
    const token = randomToken();
    const t = this.now().toISOString();
    this.db.prepare('INSERT INTO known_devices(token_hash, created_at, last_used_at) VALUES (?, ?, ?)').run(sha256(token), t, t);
    return token;
  }

  isKnownDevice(token: string | undefined): boolean {
    if (!token) return false;
    return this.db.prepare('UPDATE known_devices SET last_used_at = ? WHERE token_hash = ?').run(this.now().toISOString(), sha256(token)).changes > 0;
  }

  /** A new session made at `origin`; the token says so. */
  create(userAgent: string | undefined, origin: SessionOrigin): string {
    const token = `${origin}.${randomToken()}`;
    const t = this.now();
    this.db.prepare(
      'INSERT INTO sessions(token_hash, id, user_agent, created_at, last_seen_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run(sha256(token), randomUUID(), userAgent ?? null, t.toISOString(), t.toISOString(),
      new Date(t.getTime() + sessionDays(origin) * DAY_MS).toISOString());
    return token;
  }

  /** Valid and, for a request through the public door, made at the door: sessions made on this computer stay on it. */
  isValid(token: string | undefined): boolean {
    if (!token) return false;
    if (inDoorRequest() && originOf(token) !== 'door') return false;
    const t = this.now();
    const row = this.db.prepare('SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?')
      .get(sha256(token)) as { last_seen_at: string; expires_at: string } | undefined;
    if (!row || row.expires_at <= t.toISOString()) return false;
    if (t.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(t.toISOString(), sha256(token));
    }
    return true;
  }

  idFor(token: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(sha256(token)) as { id: string } | undefined;
    return row?.id;
  }

  destroy(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  list(): SessionInfo[] {
    return this.db.prepare(
      `SELECT id, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
       FROM sessions WHERE expires_at > ? ORDER BY last_seen_at DESC`,
    ).all(this.now().toISOString()) as SessionInfo[];
  }

  revoke(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
