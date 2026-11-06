/**
 * One-use upload links for assistants with a shell (round 2 section 12, "Two upload routes"). begin_image_upload
 * makes one, tied to the connection's grant and to one page; the assistant sends the file with curl. The token is 32
 * random bytes, stored only as its SHA-256, used once and gone after 10 minutes; a backup strips the table.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';

export const UPLOAD_LINK_MINUTES = 10;

export interface UploadLink { tokenHash: string; grantId: string; pageId: string; alt: string; title: string | null; by: string }

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class UploadLinks {
  constructor(private readonly db: DB, private readonly now: Clock) {}

  /** A new link's token (shown once, never stored). */
  create(o: { grantId: string; pageId: string; alt: string; title: string | null; by: string }): string {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    this.db.prepare(`INSERT INTO image_upload_links(token_hash, grant_id, page_id, alt, title, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(token), o.grantId, o.pageId, o.alt, o.title, o.by, at.toISOString(), new Date(at.getTime() + UPLOAD_LINK_MINUTES * 60_000).toISOString());
    return token;
  }

  /** The link a token names, while it is unused and unexpired. */
  take(token: string): UploadLink | undefined {
    const r = this.db.prepare(`SELECT token_hash, grant_id, page_id, alt, title, created_by FROM image_upload_links
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).get(hash(token), this.now().toISOString()) as
      { token_hash: string; grant_id: string; page_id: string; alt: string; title: string | null; created_by: string } | undefined;
    return r && { tokenHash: r.token_hash, grantId: r.grant_id, pageId: r.page_id, alt: r.alt, title: r.title, by: r.created_by };
  }

  /**
   * Claims an unused, unexpired link for one upload, at the moment its file is stored: of two uploads racing on one
   * link, only one gets it. False when it is used up or expired.
   */
  claim(tokenHash: string): boolean {
    return this.db.prepare('UPDATE image_upload_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(this.now().toISOString(), tokenHash, this.now().toISOString()).changes === 1;
  }

  /** Gives a claimed link back (its file was refused), so the assistant can send a proper one within its ten minutes. */
  release(tokenHash: string): void {
    this.db.prepare('UPDATE image_upload_links SET used_at = NULL WHERE token_hash = ? AND image_id IS NULL').run(tokenHash);
  }

  /** Records the picture a claimed link stored. */
  markUsed(tokenHash: string, imageId: string): void {
    this.db.prepare('UPDATE image_upload_links SET used_at = COALESCE(used_at, ?), image_id = ? WHERE token_hash = ?').run(this.now().toISOString(), imageId, tokenHash);
  }
}
