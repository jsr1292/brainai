/**
 * What the owner's browser saw when it drew each diagram (round 2 section 12, "Errors"). The server never trusts the
 * browser's copy of a diagram: it hashes the stored block itself, so a report only counts while that exact text is
 * still the page's. Nothing runs in the background; a check is recorded only when the owner views the page.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { diagramBlocks } from './markdown.js';
import type { Page } from './types.js';

export const MAX_CHECK_ERROR = 300;

export class DiagramCheckError extends Error {
  constructor(readonly code: 'version' | 'block', message: string) {
    super(message);
  }
}

export interface DiagramProblem { block: number; error: string; seenAt: string }

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class DiagramChecks {
  constructor(private readonly db: DB, private readonly now: Clock) {}

  /** Records what drawing block `block` of version `version` gave: an error sentence, or null when it drew. */
  record(page: Page, version: number, block: number, error: string | null): void {
    if (version !== page.version) throw new DiagramCheckError('version', `This page is now version ${page.version}: the report was for an older version.`);
    const b = diagramBlocks(page.body)[block];
    if (!Number.isInteger(block) || !b) throw new DiagramCheckError('block', `This page has no diagram block ${block}.`);
    this.db.prepare(`INSERT INTO diagram_checks(page_id, block, version, source_hash, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, block) DO UPDATE SET version = excluded.version, source_hash = excluded.source_hash, error = excluded.error, checked_at = excluded.checked_at`)
      .run(page.id, block, version, hash(b.text), error === null ? null : error.slice(0, MAX_CHECK_ERROR), this.now().toISOString());
  }

  /** The page's diagrams that couldn't be drawn, as long as each one's text is still exactly what was checked. */
  problems(page: Page): DiagramProblem[] {
    const blocks = diagramBlocks(page.body);
    const rows = this.db.prepare('SELECT block, source_hash, error, checked_at FROM diagram_checks WHERE page_id = ? AND error IS NOT NULL ORDER BY block')
      .all(page.id) as { block: number; source_hash: string; error: string; checked_at: string }[];
    return rows.filter((r) => blocks[r.block] !== undefined && hash(blocks[r.block]!.text) === r.source_hash)
      .map((r) => ({ block: r.block, error: r.error, seenAt: r.checked_at }));
  }
}
