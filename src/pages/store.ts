import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { findLinks, imageIdsIn } from './markdown.js';
import { PageError, type CaughtUp, type CaughtUpHow, type Page, type PageArea, type PageHeader, type PageVersion } from './types.js';

export type StoredSection = { anchor: string; position: number; heading: string; level: number; text: string; embedding: Float32Array; instructionLike: boolean };
export type StoredLink = { kind: 'page' | 'project' | 'fact'; target: string };
type Fields = { title: string; project: string | null; area: PageArea | null; body: string; by: string };

interface PageRow {
  id: string; title: string; title_key: string; project: string | null; area: PageArea | null; body: string; version: number;
  created_at: string; created_by: string; updated_at: string; updated_by: string; deleted_at: string | null;
  caught_up_at: string | null; caught_up_how: CaughtUpHow | null; caught_up_by: string | null;
}
interface VersionRow { page_id: string; version: number; title: string; project: string | null; area: PageArea | null; body: string; saved_at: string; saved_by: string; caught_up_at: string | null }
interface SectionRow { anchor: string; position: number; heading: string; level: number; text: string; embedding: Buffer; instruction_like: number }

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** A NULL column (a row written before migration 23 filled it) falls back to the last save. */
const caughtOf = (r: Omit<PageRow, 'body' | 'title_key'>): CaughtUp => ({
  at: r.caught_up_at ?? r.updated_at, how: r.caught_up_how ?? 'migrated', by: r.caught_up_by ?? r.updated_by,
});
const toPage = (r: PageRow): Page => ({
  id: r.id, title: r.title, project: r.project, area: r.area, body: r.body, version: r.version,
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by, deletedAt: r.deleted_at,
  caughtUp: caughtOf(r),
});
const HEADER_COLUMNS = 'id, title, project, area, version, created_at, created_by, updated_at, updated_by, deleted_at, caught_up_at, caught_up_how, caught_up_by';
const toHeader = (r: Omit<PageRow, 'body' | 'title_key'>): PageHeader => ({
  id: r.id, title: r.title, project: r.project, area: r.area, version: r.version,
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by, deletedAt: r.deleted_at,
  caughtUp: caughtOf(r),
});
const toVersion = (r: VersionRow): PageVersion => ({
  pageId: r.page_id, version: r.version, title: r.title, project: r.project, area: r.area, body: r.body, savedAt: r.saved_at, savedBy: r.saved_by,
  caughtUpAt: r.caught_up_at,
});

const taken = (title: string) => new PageError('invalid', `A page called “${title.trim()}” already exists`);

/** Pages, their versions, sections and links (migration 15). Checks live in PageService; this reads and writes. */
export class PageStore {
  constructor(private db: DB, private now: Clock) {}

  /** What makes two titles the same: trimmed, Unicode NFC, lowercase. */
  static titleKey(title: string): string {
    return title.trim().normalize('NFC').toLowerCase();
  }

  private ts(): string {
    return this.now().toISOString();
  }

  /** The versions of a page whose text shows a picture (by its address), oldest first. */
  versionsShowing(pageId: string, imageId: string): number[] {
    return (this.db.prepare("SELECT version FROM page_versions WHERE page_id = ? AND instr(body, ?) > 0 ORDER BY version")
      .all(pageId, `/images/${imageId}.`) as { version: number }[]).map((r) => r.version);
  }

  /** The page whose history first showed a picture (the earliest version that has its address), if any. */
  firstPageShowing(imageId: string): string | undefined {
    const r = this.db.prepare("SELECT page_id FROM page_versions WHERE instr(body, ?) > 0 ORDER BY saved_at, page_id LIMIT 1")
      .get(`/images/${imageId}.`) as { page_id: string } | undefined;
    return r?.page_id;
  }

  private must(id: string): Page {
    const p = this.get(id);
    if (!p) throw new PageError('not_found', `No page with id ${id}`);
    return p;
  }

  private writeDerived(id: string, version: number, f: Fields, at: string, sections: StoredSection[], links: StoredLink[]): void {
    // The version keeps the page's caught-up time after this write, so a restore can go back to it.
    this.db.prepare(`INSERT INTO page_versions(page_id, version, title, project, area, body, saved_at, saved_by, caught_up_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT caught_up_at FROM pages WHERE id = ?))`)
      .run(id, version, f.title, f.project, f.area, f.body, at, f.by, id);
    this.db.prepare('DELETE FROM page_sections WHERE page_id = ?').run(id);
    this.db.prepare('DELETE FROM page_sections_fts WHERE page_id = ?').run(id);
    this.db.prepare('DELETE FROM page_links WHERE from_page = ?').run(id);
    const sec = this.db.prepare('INSERT INTO page_sections(page_id, anchor, position, heading, level, text, embedding, instruction_like) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const fts = this.db.prepare('INSERT INTO page_sections_fts(page_id, anchor, heading, text) VALUES (?, ?, ?, ?)');
    for (const s of sections) {
      sec.run(id, s.anchor, s.position, s.heading, s.level, s.text, toBlob(s.embedding), s.instructionLike ? 1 : 0);
      fts.run(id, s.anchor, s.heading, s.text);
    }
    const link = this.db.prepare('INSERT OR IGNORE INTO page_links(from_page, kind, target) VALUES (?, ?, ?)');
    for (const l of links) link.run(id, l.kind, l.target);
    // The current version's pictures, so "no current page shows it" is one lookup (round 2 section 12).
    this.db.prepare('DELETE FROM page_images WHERE page_id = ?').run(id);
    const pic = this.db.prepare('INSERT INTO page_images(page_id, image_id) VALUES (?, ?)');
    for (const imageId of imageIdsIn(f.body)) pic.run(id, imageId);
  }

  private unique<T>(title: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed: pages\.title_key/.test(e.message)) throw taken(title);
      throw e;
    }
  }

  /** A new page; `caught` is when it counts as brought up to date (PageService's writer decides). */
  insert(f: Fields, sections: StoredSection[], links: StoredLink[], caught: CaughtUp): Page {
    const id = randomUUID();
    const t = this.ts();
    this.unique(f.title, () => this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by, caught_up_at, caught_up_how, caught_up_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, f.title, PageStore.titleKey(f.title), f.project, f.area, f.body, t, f.by, t, f.by, caught.at, caught.how, caught.by);
      this.writeDerived(id, 1, f, t, sections, links);
    })());
    return this.must(id);
  }

  /**
   * A new version based on `base`; refused with `conflict` if the page has moved on, and with `not_found` if it was
   * deleted meanwhile, and then nothing is written. With `undelete`, the page must be deleted and comes back live
   * with this version, in the same transaction. With `caught`, the caught-up values change in that transaction too;
   * without it they keep their value.
   */
  update(id: string, base: number, f: Fields, sections: StoredSection[], links: StoredLink[], opts: { undelete?: boolean; caught?: CaughtUp } = {}): Page {
    const t = this.ts();
    const undelete = opts.undelete === true;
    this.unique(f.title, () => this.db.transaction(() => {
      const current = this.must(id);
      if (!undelete && current.deletedAt !== null) throw new PageError('not_found', `No page with id ${id}`);
      if (current.version !== base || (undelete && current.deletedAt === null)) throw new PageError('conflict', `This page changed since you opened it (now version ${current.version})`);
      const version = current.version + 1;
      this.db.prepare('UPDATE pages SET title = ?, title_key = ?, project = ?, area = ?, body = ?, version = ?, updated_at = ?, updated_by = ?, deleted_at = NULL WHERE id = ?')
        .run(f.title, PageStore.titleKey(f.title), f.project, f.area, f.body, version, t, f.by, id);
      if (opts.caught) {
        this.db.prepare('UPDATE pages SET caught_up_at = ?, caught_up_how = ?, caught_up_by = ? WHERE id = ?').run(opts.caught.at, opts.caught.how, opts.caught.by, id);
      }
      this.writeDerived(id, version, f, t, sections, links);
    })());
    return this.must(id);
  }

  get(id: string): Page | undefined {
    const r = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as PageRow | undefined;
    return r ? toPage(r) : undefined;
  }

  byTitle(title: string): Page | undefined {
    const r = this.db.prepare('SELECT * FROM pages WHERE title_key = ? AND deleted_at IS NULL').get(PageStore.titleKey(title)) as PageRow | undefined;
    return r ? toPage(r) : undefined;
  }

  /** Live pages, newest change first. */
  list(): Page[] {
    return (this.db.prepare('SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY updated_at DESC, title_key').all() as PageRow[]).map(toPage);
  }

  /** Live pages without their bodies, newest change first, as list() orders them. */
  headers(): PageHeader[] {
    return (this.db.prepare(`SELECT ${HEADER_COLUMNS} FROM pages WHERE deleted_at IS NULL ORDER BY updated_at DESC, title_key`).all() as PageRow[]).map(toHeader);
  }

  /** How many live pages there are. */
  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM pages WHERE deleted_at IS NULL').get() as { n: number }).n;
  }

  forProject(name: string): Page[] {
    return (this.db.prepare('SELECT * FROM pages WHERE project = ? AND deleted_at IS NULL ORDER BY title_key').all(name) as PageRow[]).map(toPage);
  }

  /** Every saved version, newest first. */
  versions(id: string): PageVersion[] {
    return (this.db.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY version DESC').all(id) as VersionRow[]).map(toVersion);
  }

  version(id: string, n: number): PageVersion | undefined {
    const r = this.db.prepare('SELECT * FROM page_versions WHERE page_id = ? AND version = ?').get(id, n) as VersionRow | undefined;
    return r ? toVersion(r) : undefined;
  }

  sections(id: string): StoredSection[] {
    return (this.db.prepare('SELECT * FROM page_sections WHERE page_id = ? ORDER BY position').all(id) as SectionRow[])
      .map((r) => ({ anchor: r.anchor, position: r.position, heading: r.heading, level: r.level, text: r.text, embedding: fromBlob(r.embedding), instructionLike: r.instruction_like === 1 }));
  }

  sectionEmbeddings(): { pageId: string; anchor: string; embedding: Float32Array }[] {
    return (this.db.prepare('SELECT s.page_id, s.anchor, s.embedding FROM page_sections s JOIN pages p ON p.id = s.page_id WHERE p.deleted_at IS NULL')
      .all() as { page_id: string; anchor: string; embedding: Buffer }[]).map((r) => ({ pageId: r.page_id, anchor: r.anchor, embedding: fromBlob(r.embedding) }));
  }

  /** Sections matching the keywords, best first; with `pageIds`, only sections of those pages. */
  ftsSections(ftsQuery: string, limit: number, pageIds?: string[]): { pageId: string; anchor: string }[] {
    const only = pageIds === undefined ? '' : 'AND f.page_id IN (SELECT value FROM json_each(?))';
    const args: unknown[] = pageIds === undefined ? [ftsQuery, limit] : [ftsQuery, JSON.stringify(pageIds), limit];
    return (this.db.prepare(
      `SELECT f.page_id, f.anchor FROM page_sections_fts f JOIN pages p ON p.id = f.page_id
       WHERE page_sections_fts MATCH ? AND p.deleted_at IS NULL ${only} ORDER BY bm25(page_sections_fts) LIMIT ?`,
    ).all(...args) as { page_id: string; anchor: string }[]).map((r) => ({ pageId: r.page_id, anchor: r.anchor }));
  }

  /** Replaces a page's resolved links (another page's title appeared or changed), without a new version. */
  setLinks(id: string, links: StoredLink[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM page_links WHERE from_page = ?').run(id);
      const link = this.db.prepare('INSERT OR IGNORE INTO page_links(from_page, kind, target) VALUES (?, ?, ?)');
      for (const l of links) link.run(id, l.kind, l.target);
    })();
  }

  /** Live pages, other than `except`, whose body has a [[link]] somewhere: the only ones a new title can concern. */
  withWikiLinks(except: string): { id: string; body: string }[] {
    return this.db.prepare("SELECT id, body FROM pages WHERE deleted_at IS NULL AND id != ? AND instr(body, '[[') > 0").all(except) as { id: string; body: string }[];
  }

  /** Live pages that link to a page, project or fact, by title. */
  linkedFrom(kind: StoredLink['kind'], target: string): Page[] {
    return (this.db.prepare(
      `SELECT p.* FROM page_links l JOIN pages p ON p.id = l.from_page WHERE l.kind = ? AND l.target = ? AND p.deleted_at IS NULL ORDER BY p.title_key`,
    ).all(kind, target) as PageRow[]).map(toPage);
  }

  /** Every page's id and body, deleted ones included. */
  bodies(): { id: string; body: string }[] {
    return this.db.prepare('SELECT id, body FROM pages').all() as { id: string; body: string }[];
  }

  /** Renames section anchors of one page (from → to) in its sections, their search index and its notes. */
  renameAnchors(id: string, renames: [string, string][]): void {
    this.db.transaction(() => {
      // Through a temporary name first, so a new anchor equal to another section's old one never collides.
      for (const table of ['page_sections', 'page_sections_fts', 'notes']) {
        const set = this.db.prepare(`UPDATE ${table} SET anchor = ? WHERE page_id = ? AND anchor = ?`);
        renames.forEach(([from], i) => set.run(`\u0000${i}`, id, from));
        renames.forEach(([, to], i) => set.run(to, id, `\u0000${i}`));
      }
    })();
  }

  /**
   * The owner's "Still true": the page counts as brought up to date now, and the values before are kept for one Undo.
   * Two taps in the same millisecond leave one check.
   */
  markStillTrue(id: string): CaughtUp {
    const t = this.ts();
    return this.db.transaction(() => {
      const p = this.must(id);
      if (p.caughtUp.how === 'still_true' && p.caughtUp.at === t) return p.caughtUp;
      this.db.prepare('INSERT OR IGNORE INTO page_checks(page_id, checked_at, prev_at, prev_how, prev_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, t, p.caughtUp.at, p.caughtUp.how, p.caughtUp.by);
      this.db.prepare("UPDATE pages SET caught_up_at = ?, caught_up_how = 'still_true', caught_up_by = 'owner' WHERE id = ?").run(t, id);
      return { at: t, how: 'still_true' as const, by: 'owner' };
    })();
  }

  /**
   * Undoes the page's newest "Still true", only while nothing else has brought the page up to date since and that
   * check is not undone yet; an older check is never undone. Returns whether it did.
   */
  undoStillTrue(id: string): boolean {
    const t = this.ts();
    return this.db.transaction(() => {
      const p = this.must(id);
      const c = this.db.prepare('SELECT checked_at, prev_at, prev_how, prev_by, undone_at FROM page_checks WHERE page_id = ? ORDER BY checked_at DESC LIMIT 1')
        .get(id) as { checked_at: string; prev_at: string; prev_how: CaughtUpHow; prev_by: string; undone_at: string | null } | undefined;
      if (!c || c.undone_at !== null || p.caughtUp.how !== 'still_true' || p.caughtUp.at !== c.checked_at) return false;
      this.db.prepare('UPDATE pages SET caught_up_at = ?, caught_up_how = ?, caught_up_by = ? WHERE id = ?').run(c.prev_at, c.prev_how, c.prev_by, id);
      this.db.prepare('UPDATE page_checks SET undone_at = ? WHERE page_id = ? AND checked_at = ?').run(t, id, c.checked_at);
      return true;
    })();
  }

  /**
   * Each page's linked facts, parsed from its current body (distinct, in body order). Never from page_links, which
   * drops a link to a deleted fact at the page's next save.
   */
  factLinks(ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = this.db.prepare('SELECT id, body FROM pages WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: string; body: string }[];
    for (const r of rows) out.set(r.id, [...new Set(findLinks(r.body).filter((l) => l.kind === 'fact').map((l) => l.target))]);
    return out;
  }

  /** Each page's section anchors and headings, in order, without their vectors. */
  headings(ids: string[]): Map<string, { anchor: string; heading: string }[]> {
    const out = new Map<string, { anchor: string; heading: string }[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = this.db.prepare('SELECT page_id, anchor, heading FROM page_sections WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY page_id, position')
      .all(JSON.stringify(ids)) as { page_id: string; anchor: string; heading: string }[];
    for (const r of rows) out.get(r.page_id)?.push({ anchor: r.anchor, heading: r.heading });
    return out;
  }

  /** Deleting hides a page and frees its title; undeleting fails if a live page has taken the title since. */
  setDeleted(id: string, deleted: boolean, by: string): Page {
    const p = this.must(id);
    const t = this.ts();
    this.unique(p.title, () => this.db.prepare('UPDATE pages SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(deleted ? t : null, t, by, id));
    return this.must(id);
  }
}
