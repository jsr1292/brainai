/**
 * Picture files and their rows (round 2 section 12, "Picture files and naming"). A file is named by the first 24 hex
 * characters of the SHA-256 of its cleaned bytes, so the same picture is stored once and files never change. The
 * file is written to images/tmp, synced and renamed before its row is added: a crash leaves at most a stray file,
 * which the nightly check reports, never a row without a file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { cleanImage, EXT, type ImageType } from './clean.js';

export interface StoredImage {
  id: string; type: ImageType; ext: string; bytes: number; width: number; height: number; frames: number; alt: string;
  createdAt: string; createdBy: string; pageId: string | null; removedAt: string | null; removedBy: string | null;
}

interface Row {
  id: string; type: ImageType; bytes: number; width: number; height: number; frames: number; alt: string;
  created_at: string; created_by: string; page_id: string | null; removed_at: string | null; removed_by: string | null;
}

const fromRow = (r: Row): StoredImage => ({
  id: r.id, type: r.type, ext: EXT[r.type], bytes: r.bytes, width: r.width, height: r.height, frames: r.frames, alt: r.alt,
  createdAt: r.created_at, createdBy: r.created_by, pageId: r.page_id, removedAt: r.removed_at, removedBy: r.removed_by,
});

/**
 * Flushes a folder's entries (a rename in it) to disk. Best effort: Windows can open a folder but often refuses to
 * fsync it (EPERM), and an upload must never fail on that after its file is safely written.
 */
export function syncFolder(path: string, io: { openSync: typeof openSync; fsyncSync: typeof fsyncSync; closeSync: typeof closeSync } = { openSync, fsyncSync, closeSync }): void {
  let fd: number;
  try {
    fd = io.openSync(path, 'r');
  } catch {
    return;
  }
  try {
    io.fsyncSync(fd);
  } catch {
    /* not supported here (Windows): the file itself was synced */
  } finally {
    try { io.closeSync(fd); } catch { /* nothing to do */ }
  }
}

export class ImageStore {
  private readonly dir: string;

  /** `dir` is the data folder (DATA_DIR); a relative one is taken from where the process started. */
  constructor(private readonly db: DB, dir: string, private readonly now: Clock) {
    this.dir = resolve(dir);
  }

  /** The folder holding every picture file, absolute. */
  get root(): string {
    return join(this.dir, 'images');
  }

  /** A picture's file under `root`: `<first 2 hex>/<id>.<ext>`. */
  relPath(img: Pick<StoredImage, 'id' | 'ext'>): string {
    return `${img.id.slice(0, 2)}/${img.id}.${img.ext}`;
  }

  /** Cleans and stores a picture; the same bytes again return the existing row (brought back if deleted for good). */
  add(input: Buffer, o: { alt: string; by: string; pageId?: string | null }): StoredImage {
    const c = cleanImage(input);
    const id = createHash('sha256').update(c.bytes).digest('hex').slice(0, 24);
    const root = join(this.dir, 'images');
    const tmpDir = join(root, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(root, id.slice(0, 2)), { recursive: true });
    const tmp = join(tmpDir, `${id}.${randomBytes(6).toString('hex')}`);
    const folder = join(root, id.slice(0, 2));
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, c.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(folder, `${id}.${EXT[c.type]}`));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    // The folder too, so the new name survives a power cut before the row is committed.
    syncFolder(folder);
    this.db.prepare(`INSERT INTO images(id, type, bytes, width, height, frames, alt, created_at, created_by, page_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET removed_at = NULL, removed_by = NULL`)
      .run(id, c.type, c.bytes.length, c.width, c.height, c.frames, o.alt, this.now().toISOString(), o.by, o.pageId ?? null);
    return this.get(id)!;
  }

  get(id: string): StoredImage | undefined {
    const r = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as Row | undefined;
    return r && fromRow(r);
  }

  many(ids: string[]): Map<string, StoredImage> {
    const out = new Map<string, StoredImage>();
    for (const id of new Set(ids)) {
      const img = this.get(id);
      if (img) out.set(id, img);
    }
    return out;
  }

  path(img: Pick<StoredImage, 'id' | 'ext'>): string {
    return join(this.dir, 'images', img.id.slice(0, 2), `${img.id}.${img.ext}`);
  }

  /** Live pictures: how many, their total size, and how many no current page shows (no page_images row). */
  totals(): { count: number; bytes: number; unused: number } {
    return this.db.prepare(`SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes,
      sum(CASE WHEN NOT EXISTS (SELECT 1 FROM page_images p WHERE p.image_id = images.id) THEN 1 ELSE 0 END) AS unused
      FROM images WHERE removed_at IS NULL`).get() as { count: number; bytes: number; unused: number | null } as { count: number; bytes: number; unused: number };
  }

  /** Live pictures no current page shows (no page_images row), newest first: the Review screen's list. */
  unused(): StoredImage[] {
    return (this.db.prepare(`SELECT * FROM images WHERE removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM page_images p WHERE p.image_id = images.id) ORDER BY created_at DESC, id`).all() as Row[]).map(fromRow);
  }

  /**
   * Delete for good: the row is marked (old versions then say when it went) and the file leaves the brain now; the
   * nightly copies and the off-site copy drop it later. 'shown' when a current page shows it again, 'gone' when it is
   * unknown or already deleted.
   */
  deleteForGood(id: string, by: string): 'deleted' | 'shown' | 'gone' {
    const img = this.get(id);
    if (!img || img.removedAt !== null) return 'gone';
    if (this.pagesShowing(id).length > 0) return 'shown';
    // One transaction: if the file can't be removed, the mark rolls back and the picture stays live, so a second press
    // can finish the job instead of leaving a file that no row would ever clear.
    this.db.transaction(() => {
      this.markRemoved(id, by);
      rmSync(this.path(img), { force: true });
    })();
    return 'deleted';
  }

  /** The pages (live or not) whose current version shows this picture. */
  pagesShowing(id: string): string[] {
    return (this.db.prepare('SELECT page_id FROM page_images WHERE image_id = ? ORDER BY page_id').all(id) as { page_id: string }[]).map((r) => r.page_id);
  }

  /** Delete for good (the Review screen, batch I5): the row stays, so old versions can say when it went. */
  markRemoved(id: string, by: string): void {
    this.db.prepare('UPDATE images SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL').run(this.now().toISOString(), by, id);
  }
}
