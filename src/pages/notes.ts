import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { looksLikeSecret } from '../memory/secrets.js';
import type { PageService } from './service.js';
import type { Page } from './types.js';

/** Longest note or reply, in characters. */
export const MAX_NOTE = 500;

/** A note from the owner on a page (or one of its sections) asking an assistant to update it. */
export interface Note {
  id: string;
  pageId: string;
  anchor: string | null;
  text: string;
  createdAt: string;
  status: 'open' | 'resolved' | 'withdrawn';
  reply: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export class NoteError extends Error {
  constructor(public code: 'invalid' | 'not_found', message: string) {
    super(message);
    this.name = 'NoteError';
  }
}

interface NoteRow { id: string; page_id: string; anchor: string | null; text: string; created_at: string; status: Note['status']; reply: string | null; resolved_at: string | null; resolved_by: string | null }
const toNote = (r: NoteRow): Note => ({
  id: r.id, pageId: r.page_id, anchor: r.anchor, text: r.text, createdAt: r.created_at, status: r.status, reply: r.reply, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
});
const invalid = (message: string) => new NoteError('invalid', message);

function checkText(label: string, value: string): string {
  const s = value.trim();
  if (s === '' || s.length > MAX_NOTE) throw invalid(`${label} is 1 to ${MAX_NOTE} characters`);
  const secret = looksLikeSecret(s);
  if (secret) throw invalid(`The ${label.toLowerCase().replace(/^an? /, '')} looks like it contains a secret (${secret}). Secrets are never stored.`);
  return s;
}

/** Notes for the AIs (migration 16): the owner writes them, an assistant resolves them with a reply. */
export class NoteService {
  constructor(private db: DB, private pages: PageService, private now: Clock) {}

  private livePage(pageId: string): Page {
    const p = this.pages.get(pageId);
    if (!p || p.deletedAt !== null) throw new NoteError('not_found', `No page with id ${pageId}`);
    return p;
  }

  private must(id: string): Note {
    const n = this.get(id);
    if (!n) throw new NoteError('not_found', `No note with id ${id}`);
    return n;
  }

  private mustOpen(id: string): Note {
    const n = this.must(id);
    if (n.status === 'resolved') throw invalid('This note is already resolved');
    if (n.status === 'withdrawn') throw invalid('This note was withdrawn');
    return n;
  }

  add(pageId: string, input: { text: string; anchor?: string }): Note {
    this.livePage(pageId);
    const anchor = input.anchor?.trim() || null;
    if (anchor !== null && !this.pages.sections(pageId).some((s) => s.anchor === anchor)) throw invalid(`No section ${anchor} on this page`);
    const text = checkText('A note', input.text);
    const id = randomUUID();
    this.db.prepare('INSERT INTO notes(id, page_id, anchor, text, created_at) VALUES (?, ?, ?, ?, ?)').run(id, pageId, anchor, text, this.now().toISOString());
    return this.must(id);
  }

  resolve(id: string, reply: string, by: string): Note {
    this.mustOpen(id);
    const text = checkText('A reply', reply);
    this.db.prepare("UPDATE notes SET status = 'resolved', reply = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'open'")
      .run(text, this.now().toISOString(), by, id);
    return this.must(id);
  }

  withdraw(id: string): Note {
    this.mustOpen(id);
    this.db.prepare("UPDATE notes SET status = 'withdrawn', resolved_at = ? WHERE id = ? AND status = 'open'").run(this.now().toISOString(), id);
    return this.must(id);
  }

  get(id: string): Note | undefined {
    const r = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return r ? toNote(r) : undefined;
  }

  /** A page's notes: open ones first, oldest first, then resolved ones, newest first. Withdrawn notes are not shown. */
  forPage(pageId: string): Note[] {
    return (this.db.prepare(
      `SELECT * FROM notes WHERE page_id = ? AND status != 'withdrawn'
       ORDER BY status = 'resolved', CASE WHEN status = 'open' THEN created_at END ASC, resolved_at DESC`,
    ).all(pageId) as NoteRow[]).map(toNote);
  }

  /** Which of these pages have an open note. */
  openOn(pageIds: string[]): Set<string> {
    if (pageIds.length === 0) return new Set();
    const rows = this.db.prepare("SELECT DISTINCT page_id FROM notes WHERE status = 'open' AND page_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(pageIds)) as { page_id: string }[];
    return new Set(rows.map((r) => r.page_id));
  }

  /** The open notes on live pages that have no project (Start here and area pages), oldest first. */
  openWithoutProject(): { note: Note; page: Page }[] {
    const rows = this.db.prepare(
      `SELECT n.* FROM notes n JOIN pages p ON p.id = n.page_id WHERE n.status = 'open' AND p.project IS NULL AND p.deleted_at IS NULL ORDER BY n.created_at`,
    ).all() as NoteRow[];
    return rows.map((r) => ({ note: toNote(r), page: this.pages.get(r.page_id)! }));
  }

  /** The open notes on a project's live pages (aliases followed), oldest first. */
  openForProject(project: string): { note: Note; page: Page }[] {
    const pages = this.pages.forProject(project);
    if (pages.length === 0) return [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    const rows = this.db.prepare(
      `SELECT * FROM notes WHERE status = 'open' AND page_id IN (${pages.map(() => '?').join(',')}) ORDER BY created_at`,
    ).all(...pages.map((p) => p.id)) as NoteRow[];
    return rows.map((r) => ({ note: toNote(r), page: byId.get(r.page_id)! }));
  }
}
