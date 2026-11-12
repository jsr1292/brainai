import type { Clock } from '../clock.js';
import { cosine, type Embedder } from '../memory/embedder.js';
import { looksLikeInstruction } from '../memory/instructionLike.js';
import { toFtsQuery } from '../memory/search.js';
import { findSecret } from '../memory/secrets.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { Memory } from '../memory/types.js';
import type { ProjectStore } from '../projects/store.js';
import { findLinks, isKeyDecisions, plainText, replaceSection, splitSections, type LinkResolver, imageIdsIn, type PictureLookup } from './markdown.js';
import type { ImageStore } from '../images/store.js';
import { Freshness, SECTION_MATCH } from './freshness.js';
import { PageStore, type StoredLink, type StoredSection } from './store.js';
import { passage } from './passage.js';
import { EMBED_CHARS, MAX_BODY, MAX_TITLE, PAGE_AREAS, PageError, type CaughtUp, type Page, type PageArea, type PageHeader, type PageVersion } from './types.js';
import type { MeaningHook } from '../graph/threads.js';

const CANDIDATES = 50;
const RRF_K = 60;
/** As in memory search: a keyword rank counts half as much as a rank by meaning. */
const KEYWORD_WEIGHT = 0.5;
const PROJECT_FACTS = 5;
const NEAREST_FACTS = 3;
const FACT_LABEL = 60;

const invalid = (message: string) => new PageError('invalid', message);
/** Browsers send typed text with CRLF line endings; pages store plain newlines. */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type SaveInput = { base: number; title?: string; project?: string | null; area?: string | null; body: string };
/** Why a page is written: decides whether it counts as brought up to date (round 2 section 13). */
type WriteReason = 'created' | 'saved' | { section: string; text: string } | { restored: number } | 'undeleted';

/** The owner's pages: every save a new version, sections embedded only when they change, links resolved at save. */
export class PageService {
  /** Which pages may be out of date, worked out from the facts when asked (round 2 section 13). */
  readonly freshness: Freshness;

  /** `sectionMatch`: undefined means the SECTION_MATCH constant, null turns meaning matching off. */
  constructor(
    private store: PageStore,
    private embedder: Embedder,
    private memories: MemoryService,
    private registry: ProjectStore,
    private memoryStore: MemoryStore,
    private now: Clock,
    opts: { sectionMatch?: number | null; keywordWeight?: number } = {},
  ) {
    this.keywordWeight = opts.keywordWeight ?? KEYWORD_WEIGHT;
    this.freshness = new Freshness({
      store, memoryStore, memories, registry, forProject: (name) => this.forProject(name),
      sectionMatch: opts.sectionMatch === undefined ? SECTION_MATCH : opts.sectionMatch,
    });
  }

  /** How much a keyword rank counts against a by-meaning rank (the embedding model's profile). */
  private readonly keywordWeight: number;

  private images: ImageStore | null = null;

  /** The picture store, so pages can show pictures at their real size (set once at start, like the meaning hook). */
  setPictureStore(images: ImageStore): void {
    this.images = images;
  }

  /** The pictures a body shows, looked up once for a render. */
  pictures(body: string): PictureLookup {
    const found = this.images ? this.images.many(imageIdsIn(body)) : new Map();
    return (id) => found.get(id);
  }

  /** The page whose history first showed a picture (the Review screen, for a picture added before its page was saved). */
  firstPageShowing(imageId: string): string | undefined {
    return this.store.firstPageShowing(imageId);
  }

  /** The versions of a page whose text shows a picture, oldest first (the Review screen). */
  versionsShowing(pageId: string, imageId: string): number[] {
    return this.store.versionsShowing(pageId, imageId);
  }

  // ---- Checks ----

  private checkTitle(title: string): string {
    const t = title.trim();
    if (t === '' || t.length > MAX_TITLE || /[\r\n]/.test(t)) throw invalid(`The title must be one line of 1 to ${MAX_TITLE} characters`);
    return t;
  }

  private projectExists(name: string): boolean {
    return this.registry.get(name) !== undefined || this.memoryStore.list({ project: name, limit: 1, replaced: 'include' }).length > 0;
  }

  /** The real project for a name (aliases followed), or null for none; refused when there is no such project. */
  private project(name: string | null | undefined): string | null {
    const raw = name?.trim();
    if (!raw) return null;
    const real = this.memories.projectNamed(raw);
    if (!this.projectExists(real)) throw invalid(`No project named ${raw}`);
    return real;
  }

  private area(project: string | null, area: string | null | undefined): PageArea | null {
    if (project !== null) return null;
    if (!area || !(PAGE_AREAS as readonly string[]).includes(area)) throw invalid('A page without a project needs an area');
    return area as PageArea;
  }

  private check(id: string | null, f: { title: string; body: string }): void {
    if (f.body.length > MAX_BODY) throw invalid(`The page is ${f.body.length} characters; the limit is ${MAX_BODY}`);
    const other = this.store.byTitle(f.title);
    if (other && other.id !== id) throw invalid(`A page called “${f.title}” already exists`);
    // Where it matched, so the writer of a long page knows which line to reword.
    const inTitle = findSecret(f.title);
    const found = inTitle ?? findSecret(f.body);
    if (found) {
      const where = inTitle ? ' in the title' : f.body.includes('\n') ? ` on line ${found.line}, at “${found.excerpt}”` : '';
      throw new PageError('secret', `The page looks like it contains a secret (${found.reason})${where}. Secrets are never stored.`);
    }
  }

  // ---- Derived data ----

  /**
   * Sections with embeddings: those whose heading and text are unchanged keep their stored embedding, unless the title
   * changed, since every section's embedding includes the title.
   */
  private async sectionsFor(id: string | null, title: string, body: string): Promise<StoredSection[]> {
    const sameTitle = id !== null && this.store.get(id)?.title === title;
    const previous = new Map((sameTitle ? this.store.sections(id) : []).map((s) => [`${s.anchor}\n${s.heading}\n${s.text}`, s.embedding]));
    const out: StoredSection[] = [];
    for (const [position, s] of splitSections(body).entries()) {
      const key = `${s.anchor}\n${s.heading}\n${s.text}`;
      const embedding = previous.get(key) ?? await this.embedder.embed(`${title} — ${s.heading || title}\n${s.text}`.slice(0, EMBED_CHARS), 'passage');
      out.push({ anchor: s.anchor, position, heading: s.heading, level: s.level, text: s.text, embedding, instructionLike: looksLikeInstruction(`${s.anchor === 'top' ? `${title}\n` : ''}${s.heading}\n${s.text}`) !== null });
    }
    return out;
  }

  private linksFor(id: string | null, body: string): StoredLink[] {
    const out: StoredLink[] = [];
    for (const l of findLinks(body)) {
      if (l.kind === 'fact') {
        if (this.memoryStore.get(l.target)?.deletedAt === null) out.push({ kind: 'fact', target: l.target });
        continue;
      }
      const page = this.store.byTitle(l.target);
      if (page) { if (page.id !== id) out.push({ kind: 'page', target: page.id }); continue; }
      const real = this.memories.projectNamed(l.target);
      if (this.projectExists(real)) out.push({ kind: 'project', target: real });
    }
    return out;
  }

  /**
   * Links are resolved at save, so when a page appears under a title (created, renamed, restored, undeleted) or leaves
   * one, the pages that link to that title or to the page are resolved again: "Linked from" matches what links show.
   */
  private relinkAround(p: Page): void {
    const key = PageStore.titleKey(p.title);
    const ids = new Set(this.store.linkedFrom('page', p.id).map((x) => x.id));
    for (const x of this.store.withWikiLinks(p.id)) {
      // A cheap test first: the title must appear in the body for a [[link]] to name it.
      if (!x.body.normalize('NFC').toLowerCase().includes(key)) continue;
      if (findLinks(x.body).some((l) => l.kind === 'title' && PageStore.titleKey(l.target) === key)) ids.add(x.id);
    }
    for (const id of ids) {
      const x = this.store.get(id);
      if (x && x.deletedAt === null) this.store.setLinks(id, this.linksFor(id, x.body));
    }
  }

  private mustLive(id: string): Page {
    const p = this.store.get(id);
    if (!p || p.deletedAt !== null) throw new PageError('not_found', `No page with id ${id}`);
    return p;
  }

  // ---- Writes ----

  private meaning: MeaningHook | undefined;

  /** The graph's meaning index, told about every page written (by the one writer below). */
  setMeaningHook(hook: MeaningHook): void {
    this.meaning = hook;
  }

  /** Right after a page write commits; a failed index step is logged and never fails the save. */
  private indexPage(id: string): void {
    if (!this.meaning) return;
    try {
      this.meaning.pageChanged(id);
    } catch (e) {
      console.error(`meaning index failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * When the page counts as brought up to date after this write; undefined keeps the current values. A section edit
   * clears only when it touches Key decisions (its heading before, or any heading in the new text), or when the page
   * had no Key decisions to edit; a restore goes back to the earlier of the two times, never forward.
   */
  private caughtFor(current: Page | null, reason: WriteReason, by: string, importedAt?: string): CaughtUp | undefined {
    const at = this.now().toISOString();
    if (reason === 'created' && importedAt !== undefined) {
      // Outline writes whole seconds without milliseconds; stored as the app writes times, so comparisons are exact.
      const t = Date.parse(importedAt);
      return { at: Number.isNaN(t) ? at : new Date(t).toISOString(), how: 'imported', by };
    }
    if (reason === 'created') return { at, how: 'created', by };
    if (reason === 'saved') return { at, how: 'saved', by };
    if (reason === 'undeleted' || current === null) return undefined;
    if ('section' in reason) {
      const before = splitSections(current.body);
      if (!before.some((s) => isKeyDecisions(s.heading))) return { at, how: 'saved', by };
      const touched = isKeyDecisions(before.find((s) => s.anchor === reason.section)?.heading ?? '') || splitSections(reason.text).some((s) => isKeyDecisions(s.heading));
      return touched ? { at, how: 'key_decisions', by } : undefined;
    }
    const old = this.store.version(current.id, reason.restored);
    const then = old?.caughtUpAt ?? old?.savedAt;
    return then !== undefined && then < current.caughtUp.at ? { at: then, how: 'restored', by } : undefined;
  }

  /**
   * The one private writer: every new page and every new version goes through here, so the caught-up values, the
   * links of pages around it and the meaning index follow every save. With `current` null, a new page.
   */
  private async commit(current: Page | null, raw: SaveInput, by: string, reason: WriteReason, importedAt?: string): Promise<Page> {
    const id = current?.id ?? null;
    const input = { ...raw, body: lf(raw.body) };
    if (current && current.version !== input.base) throw new PageError('conflict', `This page changed since you opened it (now version ${current.version})`);
    const title = this.checkTitle(input.title ?? current?.title ?? '');
    const project = input.project === undefined ? (current?.project == null ? null : this.memories.projectNamed(current.project)) : this.project(input.project);
    const area = this.area(project, input.area === undefined ? (current?.area ?? null) : input.area);
    this.check(id, { title, body: input.body });
    const sections = await this.sectionsFor(id, title, input.body);
    const links = this.linksFor(id, input.body);
    const caught = this.caughtFor(current, reason, by, importedAt);
    const f = { title, project, area, body: input.body, by };
    const p = current === null
      ? this.store.insert(f, sections, links, caught!)
      : this.store.update(current.id, input.base, f, sections, links, { undelete: reason === 'undeleted', caught });
    if (current === null || reason === 'undeleted' || p.title !== current.title) this.relinkAround(p);
    this.indexPage(p.id);
    return p;
  }

  async create(raw: { title: string; project?: string; area?: string; body: string }, by: string, opts: { importedAt?: string } = {}): Promise<Page> {
    return this.commit(null, { base: 0, ...raw }, by, 'created', opts.importedAt);
  }

  /** Saves the whole page as a new version based on `base`; fields left out keep their value. */
  async save(id: string, raw: SaveInput, by: string): Promise<Page> {
    return this.commit(this.mustLive(id), raw, by, 'saved');
  }

  async saveSection(id: string, input: { base: number; anchor: string; text: string }, by: string): Promise<Page> {
    const current = this.mustLive(id);
    if (current.version !== input.base) throw new PageError('conflict', `This page changed since you opened it (now version ${current.version})`);
    const text = lf(input.text);
    const body = replaceSection(current.body, input.anchor, text);
    if (body === undefined) throw new PageError('not_found', `No section ${input.anchor} on this page`);
    return this.commit(current, { base: input.base, body }, by, { section: input.anchor, text });
  }

  /** Saves an old version's text as the newest version, so a restore is itself undoable. */
  async restore(id: string, version: number, by: string): Promise<Page> {
    const current = this.mustLive(id);
    const old = this.store.version(id, version);
    if (!old) throw new PageError('not_found', `No version ${version} of this page`);
    return this.commit(current, { base: current.version, title: old.title, project: old.project, area: old.area, body: old.body }, by, { restored: version });
  }

  /**
   * The owner's "Still true": the page counts as brought up to date now. A second tap while it already is, and is
   * not flagged, writes nothing.
   */
  stillTrue(id: string): Page {
    const p = this.mustLive(id);
    if (p.caughtUp.how === 'still_true' && this.freshness.forPage(p) === null) return p;
    this.store.markStillTrue(id);
    return this.mustLive(id);
  }

  /** Undoes the newest "Still true", only while nothing else has brought the page up to date since. */
  undoStillTrue(id: string): Page {
    this.mustLive(id);
    if (!this.store.undoStillTrue(id)) throw new PageError('conflict', 'Something else brought this page up to date since, so Undo is no longer available.');
    return this.mustLive(id);
  }

  remove(id: string, by: string): Page {
    this.mustLive(id);
    return this.store.setDeleted(id, true, by);
  }

  /** Brings a deleted page back, recorded as a new version. */
  async undelete(id: string, by: string): Promise<Page> {
    const p = this.store.get(id);
    if (!p) throw new PageError('not_found', `No page with id ${id}`);
    if (p.deletedAt === null) return p;
    return this.commit(p, { base: p.version, body: p.body }, by, 'undeleted');
  }

  // ---- Reads ----

  get(id: string): Page | undefined {
    return this.store.get(id);
  }

  list(): Page[] {
    return this.store.list();
  }

  /** Live pages without their bodies, newest change first: for lists and navigation. */
  headers(): PageHeader[] {
    return this.store.headers();
  }

  count(): number {
    return this.store.count();
  }

  /** A live page by title (case and spacing ignored). */
  byTitle(title: string): Page | undefined {
    return this.store.byTitle(title);
  }

  /** Live pages whose title holds the word, for the editor's [[ picker. */
  titlesMatching(q: string, limit: number): { id: string; title: string }[] {
    return this.store.titlesMatching(q, limit);
  }

  /** A project's live pages, including those filed under one of its aliases, by title. */
  forProject(name: string): Page[] {
    const real = this.memories.projectNamed(name);
    const names = [real, ...this.memories.aliases().filter((a) => a.project === real).map((a) => a.alias)];
    return names.flatMap((n) => this.store.forProject(n)).sort((a, b) => PageStore.titleKey(a.title).localeCompare(PageStore.titleKey(b.title)));
  }

  /** The pages among these that may be out of date, at full scope: for the owner's views and full connections only. */
  flaggedIds(ps: PageHeader[]): Set<string> {
    return new Set([...this.freshness.forPages(ps)].filter(([, f]) => f !== null).map(([id]) => id));
  }

  versions(id: string): PageVersion[] {
    return this.store.versions(id);
  }

  version(id: string, n: number): PageVersion | undefined {
    return this.store.version(id, n);
  }

  sections(id: string): StoredSection[] {
    return this.store.sections(id);
  }

  /**
   * Anchors are derived at save: this brings those saved under an older slug rule in line with the current one (notes
   * follow their section), so a page read and edited by anchor keeps working. Run at startup; returns the pages changed.
   */
  realignAnchors(): number {
    let changed = 0;
    for (const { id, body } of this.store.bodies()) {
      const now = splitSections(body);
      const stored = this.store.sections(id);
      if (stored.length !== now.length) continue;
      const renames = stored.flatMap((s, i): [string, string][] => (s.anchor === now[i]!.anchor ? [] : [[s.anchor, now[i]!.anchor]]));
      if (renames.length === 0) continue;
      this.store.renameAnchors(id, renames);
      changed++;
    }
    return changed;
  }

  /** The page's own area, or for a project's page its project's area (null: Unsorted). */
  areaOf(p: Pick<Page, 'project' | 'area'>): PageArea | null {
    return p.project === null ? p.area : (this.registry.get(this.memories.projectNamed(p.project))?.area ?? null);
  }

  /** How [[links]] render now: a page by title, then a project, then fact:<id>. */
  resolver(): LinkResolver {
    return (target) => {
      if (target.startsWith('fact:')) {
        const m = this.memoryStore.get(target.slice(5).trim());
        if (!m || m.deletedAt !== null) return null;
        // A replaced fact still links to its own page, with a marker to the fact that holds now (or to its own page,
        // where the deleted replacement is named, when the chain ends in a deleted fact).
        const rep = this.memories.replacement(m.id);
        const replaced = rep ? { replacedHref: `/memories/${rep.end ? rep.end.id : m.id}` } : {};
        return { href: `/memories/${m.id}`, label: cut(m.content, FACT_LABEL), ...replaced };
      }
      const page = this.store.byTitle(target);
      if (page) return { href: `/pages/${page.id}`, label: page.title };
      const real = this.memories.projectNamed(target);
      return this.projectExists(real) ? { href: `/?project=${encodeURIComponent(real)}#panel`, label: target } : null;
    };
  }

  /** Live pages whose saved links reach any of these facts, by id. */
  linkingFacts(ids: readonly string[]): Page[] {
    const byId = new Map<string, Page>();
    for (const id of ids) for (const p of this.store.linkedFrom('fact', id)) byId.set(p.id, p);
    return [...byId.values()];
  }

  /** Pages linking to this one, and, when it is its project's only page, those linking to the project. */
  linkedFrom(p: Page): Page[] {
    const byId = new Map(this.store.linkedFrom('page', p.id).map((x) => [x.id, x]));
    if (p.project !== null && this.forProject(p.project).length === 1) {
      // A link saved under a name that has since become an alias of the project still links to it.
      const real = this.memories.projectNamed(p.project);
      const names = [real, ...this.memories.aliases().filter((a) => a.project === real).map((a) => a.alias)];
      for (const name of names) for (const x of this.store.linkedFrom('project', name)) byId.set(x.id, x);
    }
    byId.delete(p.id);
    return [...byId.values()].sort((a, b) => PageStore.titleKey(a.title).localeCompare(PageStore.titleKey(b.title)));
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.embedder.embed(text, 'query');
  }

  /**
   * Page sections by keyword and by meaning, fused by rank as memory search is; only live pages. With `accept`, only
   * sections of the pages it accepts (a read-only grant, a project), chosen before the limit, so other pages never
   * crowd them out.
   */
  search(text: string, vector: Float32Array, limit: number, minSimilarity: number, accept?: (p: PageHeader) => boolean): { page: Page; anchor: string; heading: string; headingPath: string; snippet: string; instructionLike: boolean }[] {
    const key = (pageId: string, anchor: string) => `${pageId}\n${anchor}`;
    const scores = new Map<string, number>();
    const add = (k: string, weight: number, rank: number) => scores.set(k, (scores.get(k) ?? 0) + weight / (RRF_K + rank));
    const allowed = accept === undefined ? undefined : new Set(this.store.headers().filter(accept).map((p) => p.id));
    if (allowed?.size === 0) return [];
    const q = toFtsQuery(text);
    const fts = q ? this.store.ftsSections(q, CANDIDATES, allowed && [...allowed]) : [];
    fts.forEach((s, i) => add(key(s.pageId, s.anchor), this.keywordWeight, i + 1));
    this.store.sectionEmbeddings()
      .filter((e) => allowed === undefined || allowed.has(e.pageId))
      .map((e) => ({ k: key(e.pageId, e.anchor), sim: cosine(vector, e.embedding) }))
      .filter((e) => e.sim >= minSimilarity)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, CANDIDATES)
      .forEach((e, i) => add(e.k, 1, i + 1));
    const sections = new Map<string, StoredSection[]>();
    const out: { page: Page; anchor: string; heading: string; headingPath: string; snippet: string; instructionLike: boolean }[] = [];
    for (const [k] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
      if (out.length >= limit) break;
      const [pageId, anchor] = k.split('\n') as [string, string];
      const page = this.store.get(pageId);
      if (!page || page.deletedAt !== null) continue;
      if (!sections.has(pageId)) sections.set(pageId, this.store.sections(pageId));
      const all = sections.get(pageId)!;
      const i = all.findIndex((x) => x.anchor === anchor);
      const s = all[i];
      // B10: where the section sits (a subsection under its section) and the passage that matched.
      if (s) out.push({ page, anchor, heading: s.heading, headingPath: headingPath(all, i), snippet: passage(s.text, text), instructionLike: s.instructionLike });
    }
    return out;
  }

  /** The project's newest decisions, then the decisions nearest to the page by meaning, never repeating one. */
  relatedFacts(p: Page, minSimilarity: number): Memory[] {
    const own = p.project === null ? [] : this.memoryStore.list({ project: this.memories.projectNamed(p.project), kind: 'decision', limit: PROJECT_FACTS });
    const seen = new Set(own.map((m) => m.id));
    const vectors = this.store.sections(p.id).map((s) => s.embedding);
    if (vectors.length === 0) return own;
    const mean = new Float32Array(vectors[0]!.length);
    for (const v of vectors) v.forEach((x, i) => { mean[i]! += x; });
    const norm = Math.hypot(...mean) || 1;
    mean.forEach((x, i) => { mean[i] = x / norm; });
    const nearest = this.memoryStore.activeEmbeddings({ kind: 'decision' })
      .filter((e) => !seen.has(e.id))
      .map((e) => ({ id: e.id, sim: cosine(mean, e.embedding) }))
      .filter((e) => e.sim >= minSimilarity)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, NEAREST_FACTS)
      .map((e) => this.memoryStore.get(e.id))
      .filter((m): m is Memory => m !== undefined);
    return [...own, ...nearest];
  }

  /** Open projects with at least one fact and no live page yet, by name. */
  withoutPage(): string[] {
    return this.registry.list()
      .filter((p) => p.state === 'open' && this.memoryStore.list({ project: p.name, limit: 1 }).some((m) => m.kind !== 'profile'))
      .filter((p) => this.forProject(p.name).length === 0)
      .map((p) => p.name)
      .sort();
  }
}

/** B10: a section's place in its page: "Section › Subsection" for a subsection, its own heading otherwise. */
export function headingPath(sections: StoredSection[], i: number): string {
  const s = sections[i]!;
  if (s.level < 3) return s.heading;
  for (let j = i - 1; j >= 0; j--) if (sections[j]!.level === 2) return `${sections[j]!.heading} › ${s.heading}`;
  return s.heading;
}
