import { timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { totpAt } from './totp.js';

const MIN_PASSWORD_LENGTH = 12;
const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id (const enum, so spelled out)

interface OwnerRow { password_hash: string | null; totp_secret: string | null; totp_last_step: number | null }

export class OwnerAuth {
  constructor(private db: DB, private now: Clock) {}

  private row(): OwnerRow | undefined {
    return this.db.prepare('SELECT password_hash, totp_secret, totp_last_step FROM owner WHERE id = 1').get() as OwnerRow | undefined;
  }

  isConfigured(): boolean {
    const r = this.row();
    return !!r?.password_hash && !!r?.totp_secret;
  }

  async setPassword(pw: string): Promise<void> {
    if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const h = await hash(pw, { algorithm: ARGON2ID });
    this.db.prepare(
      'INSERT INTO owner(id, password_hash) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash',
    ).run(h);
    this.forgetSignIns();
  }

  /**
   * A new sign-in secret signs every browser out (a stolen session cookie stops working) and forgets the browsers
   * that skipped the shared login limit.
   */
  private forgetSignIns(): void {
    this.db.prepare('DELETE FROM sessions').run();
    this.db.prepare('DELETE FROM known_devices').run();
  }

  async verifyPassword(pw: string): Promise<boolean> {
    const h = this.row()?.password_hash;
    if (!h) return false;
    try { return await verify(h, pw); } catch { return false; }
  }

  setTotpSecret(secretB32: string): void {
    this.db.prepare(
      `INSERT INTO owner(id, totp_secret, totp_last_step) VALUES(1, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET totp_secret = excluded.totp_secret, totp_last_step = NULL`,
    ).run(secretB32);
    this.forgetSignIns();
  }

  verifyTotp(code: string): boolean {
    if (!/^[0-9]{6}$/.test(code)) return false;
    const r = this.row();
    if (!r?.totp_secret) return false;
    const nowStep = Math.floor(this.now().getTime() / 1000 / 30);
    const given = Buffer.from(code);
    let accepted: number | undefined;
    // Check every candidate step (no early exit) so timing doesn't reveal which matched.
    for (const step of [nowStep - 1, nowStep, nowStep + 1]) {
      const match = timingSafeEqual(given, Buffer.from(totpAt(r.totp_secret, step)));
      if (match && (r.totp_last_step === null || step > r.totp_last_step) && (accepted === undefined || step > accepted)) accepted = step;
    }
    if (accepted === undefined) return false;
    // Conditional update makes the replay check atomic against concurrent verifies.
    const res = this.db.prepare(
      'UPDATE owner SET totp_last_step = ? WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)',
    ).run(accepted, accepted);
    return res.changes === 1;
  }
}
