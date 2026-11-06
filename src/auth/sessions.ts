import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { randomToken, sha256 } from './hash.js';

export const SESSION_DAYS = 30;
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

  create(userAgent: string | undefined): string {
    const token = randomToken();
    const t = this.now();
    this.db.prepare(
      'INSERT INTO sessions(token_hash, id, user_agent, created_at, last_seen_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run(sha256(token), randomUUID(), userAgent ?? null, t.toISOString(), t.toISOString(),
      new Date(t.getTime() + SESSION_DAYS * DAY_MS).toISOString());
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
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
