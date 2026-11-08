import { isStatus, projectBrief, type Brief } from './brief.js';
import { cosine, type Embedder } from './embedder.js';
import { findSimilar, hybridSearch, type SearchHit } from './search.js';
import { RERANK_POOL, type Reranker } from './reranker.js';
import { looksLikeInstruction } from './instructionLike.js';
import { checkRoadmap, keepTicked, parseRoadmap, type Roadmap, type WaitingItem } from './roadmap.js';
import { looksLikeSecret } from './secrets.js';
import { words } from './words.js';
import type { MemoryStore, ReplacedFilter } from './store.js';
import type { ProjectStateName } from '../projects/types.js';
import { actorLabel, KINDS, OWNER_LABEL as OWNER, type Actor, type Kind, type Memory, type Suggestion } from './types.js';
import type { MeaningHook } from '../graph/threads.js';
import { MAX_WHY, type Disagreement } from './disagreements.js';
import { MAX_SUPERSEDES, replaceableKind, type Replaceable, type Supersession } from './supersessions.js';
import { STOPWORDS } from './stopwords.js';

export const MAX_CONTENT = 1000;
/** A roadmap lists a whole project's remaining work, so it may be longer than other memories. */
export const MAX_ROADMAP = 1500;
/** A project with no change for this long counts as quiet (a label only; it stays open). */
export const QUIET_DAYS = 14;
export const MAX_TAGS = 10;
export const STALE_DAYS = 180;
export const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** Other phrasings recall searches with a question (B4): at most this many, each cut to this many characters. */
const MAX_PHRASINGS = 2;
const MAX_PHRASING = 300;

/** Words that say nothing about which part of a project a question is about (B7, widened after review). */
const GENERIC_WORDS = new Set([
  'project', 'proyecto', 'app', 'aplicacion', 'thing', 'things', 'cosa', 'cosas', 'hacer', 'falta', 'actual', 'actualmente',
  'current', 'currently', 'overall', 'general', 'todo', 'all', 'everything', 'now', 'ahora', 'hoy', 'today', 'lately',
  'ultimamente', 'far', 'week', 'semana', 'give', 'dame', 'show', 'muestrame', 'update', 'summary', 'resumen', 'news',
  'quick', 'tal', 'so',
]);

/**
 * Whether a "how is it going" question is about a whole project (B7): once its how-is-it-going phrases, the project's
 * `names`, filler words and GENERIC_WORDS are taken out, no word of two or more letters is left. "What's the latest on
 * X's label printer?" is not: it asks about one part.
 */
export function isWholeProjectQuestion(query: string, names: readonly string[]): boolean {
  let rest = words(query);
  // The project's names first, longest first ("cove podcast" before "cove"; "roadmap tool" before the phrase "roadmap").
  for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(words(n)).join(' ');
  // "how is X's export going": the words of "how is ... going" go one by one, so what sits between them stays.
  rest = rest.replace(/ (how|is|are|s|going) /g, '  ').replace(/ (how|is|are|s|going) /g, '  ');
  const phrases = new RegExp(ASKS_HOW_IT_IS_GOING.source, 'g');
  for (let before = ''; before !== rest;) { before = rest; rest = rest.replace(phrases, ' '); }
  return rest.split(' ').every((w) => w.length < 2 || STOPWORDS.has(w) || GENERIC_WORDS.has(w));
}

/**
 * The other phrasings recall searches with the question: trimmed, blank ones and ones equal to the question or to
 * each other dropped, each cut to MAX_PHRASING characters, at most MAX_PHRASINGS. Never an error: recall still answers.
 */
function otherPhrasings(query: string, alt: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const raw of alt ?? []) {
    const text = String(raw).trim().slice(0, MAX_PHRASING);
    if (text === '' || same(text, query) || out.some((o) => same(o, text))) continue;
    if (out.length === MAX_PHRASINGS) break;
    out.push(text);
  }
  return out;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSEST_PROJECTS = 3;
/**
 * Pending suggestions (held memories and profile changes) at which further ones are refused, so a misled assistant
 * cannot flood the approvals.
 */
export const MAX_HELD_PENDING = 20;
/** recent_work returns at most this many decisions, newest first, so a long window still fits in one tool result. */
export const MAX_RECENT_DECISIONS = 50;
/** The owner's picker shows at most this many facts, most alike first ("Show all" lists the rest). */
export const PICKER_CHOICES = 10;

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Why an owner's change was refused because someone changed the list meanwhile. */
export const LIST_CHANGED = 'This list changed: reload';

export class MemoryError extends Error {
  /** `current`: for 'changed', the memory as it is now, for the writer to merge its change into. */
  constructor(public code: 'not_found' | 'invalid' | 'secret_detected' | 'changed', message: string, public current?: Memory) {
    super(message);
    this.name = 'MemoryError';
  }
}

/** A save based on an older version of the memory than the one stored: nothing is saved. */
const changedSince = (m: Memory) => new MemoryError('changed',
  `Not saved: this ${m.kind === 'summary' ? 'status' : m.kind} changed since you read it (updated ${m.updatedAt} by ${m.updatedBy}). `
  + `Merge your change into its current text below, keeping what the other save added, and save again with base_updated_at ${m.updatedAt}.`, m);

type Similar = { memory: Memory; similarity: number }[];

export type RememberResult =
  | { status: 'saved'; memory: Memory; replaced: Memory[] }
  /** An assistant re-saved a fact that was replaced: the current fact of its chain, and when it was replaced. */
  | { status: 'was_replaced'; replaced: Memory; current: Memory; at: string }
  | { status: 'similar_exists'; similar: Similar }
  | { status: 'status_exists'; statuses: Memory[] }
  | { status: 'new_project'; project: string; candidates: string[] }
  | { status: 'roadmap_updated'; memory: Memory }
  | { status: 'suggested'; suggestion: Suggestion; similar: Similar }
  | { status: 'already_suggested'; suggestion: Suggestion };

const notFound = (id: string) => new MemoryError('not_found', `No memory with id ${id}`);

/** Section 16's check 5, for a pair of facts of two kinds (also when an edit would change a linked fact's kind). */
export const SAME_KIND_ONLY = 'A decision can only replace a decision, and a status a status.';
const NEVER_REPLACED = 'Profile facts and roadmaps can\'t be replaced. Change the profile through the owner; save a roadmap again to replace it.';
const day = (iso: string) => iso.slice(0, 10);

function checkKind(kind: unknown): Kind {
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw new MemoryError('invalid', `kind must be one of: ${KINDS.join(', ')}`);
  }
  return kind as Kind;
}

function checkContent(content: unknown, max = MAX_CONTENT): string {
  if (typeof content !== 'string') throw new MemoryError('invalid', `content must be text of 1 to ${max} characters`);
  // Browsers send form text with CRLF line endings: stored text always uses plain newlines.
  const c = content.replace(/\r\n?/g, '\n').trim();
  if (c.length < 1) throw new MemoryError('invalid', `content must be 1 to ${max} characters (got ${c.length})`);
  if (c.length > max) {
    // A project has one roadmap and saving it again replaces it, so a split roadmap would lose its first half.
    const split = max === MAX_ROADMAP ? '' : ' or split it into separate memories';
    throw new MemoryError('invalid', `content is ${c.length} characters; the limit is ${max}. Shorten it (drop detail that is finished or already in the project's files)${split}, then save again now.`);
  }
  const reason = looksLikeSecret(c);
  if (reason) throw new MemoryError('secret_detected', `This looks like a secret (${reason}). Secrets are never stored in memory.`);
  return c;
}

function checkTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) throw new MemoryError('invalid', `tags: at most ${MAX_TAGS} tags`);
  for (const t of tags) {
    if (typeof t !== 'string' || !TAG_RE.test(t)) {
      throw new MemoryError('invalid', `tags: each tag must match ${TAG_RE.source} (lowercase letters, digits, hyphens, max 40 characters)`);
    }
  }
  return [...new Set(tags as string[])];
}

export function checkProject(project: unknown): string | null {
  if (project === undefined || project === null) return null;
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) {
    throw new MemoryError('invalid', `project must match ${PROJECT_RE.source} (lowercase letters, digits, hyphens, max 63 characters)`);
  }
  return project;
}

/** A folder's name as a project name, the way the Claude Code start hook makes one: "Casa Azul" → "casa-azul". */
function folderName(folder: string): string {
  const last = folder.split('/').filter(Boolean).pop() ?? '';
  return last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Names that contain each other once hyphens are ignored: "wild-log" and "wildlog", "docs" and "documents". */
function sameName(a: string, b: string): boolean {
  const x = a.replace(/-/g, '');
  const y = b.replace(/-/g, '');
  return x !== '' && y !== '' && (x.includes(y) || y.includes(x));
}

/** AI-chosen project names and tags are labels everyone reads; one that reads like an instruction is refused. */
function checkAiLabels(project: string | null, tags: string[]): void {
  const reason = project === null ? null : looksLikeInstruction(project.replace(/-/g, ' '));
  if (reason) throw new MemoryError('invalid', `The project name reads like an instruction to AI assistants (${reason}). Use a plain project name.`);
  for (const t of tags) {
    const r = looksLikeInstruction(t.replace(/-/g, ' '));
    if (r) throw new MemoryError('invalid', `The tag "${t}" reads like an instruction to AI assistants (${r}). Use plain tags.`);
  }
}

/**
 * Asks how something is going (English or Spanish). With a project named in the same question, that project's
 * roadmap and newest status come first: search alone ranks the current status first only about 1 time in 10.
 */
// Matched against words(query): lowercase, no accents or punctuation ("¿cómo va?" → " como va ", "what's" → "what s").
const ASKS_HOW_IT_IS_GOING = / (latest|status|progress|where are we|where did we|what s left|left to do|pending|next steps?|how s it going|how is .* going|how are .* going|roadmap|update on|estado|como va|como van|que queda|pendiente|siguiente|avance|progreso|novedad|novedades|ultimo|ultima|en que punto|donde estamos|donde nos quedamos) /;

const maxFor = (kind: Kind): number => (kind === 'roadmap' ? MAX_ROADMAP : MAX_CONTENT);

function checkRoadmapContent(content: string): void {
  const problem = checkRoadmap(content);
  if (problem) throw new MemoryError('invalid', problem);
}

/**
 * Where a project stands, as the owner set it in the projects registry. A project with no change for QUIET_DAYS is
 * "quiet": a label only, it stays open.
 */
export type ProjectState = ProjectStateName;
/** Done and archived projects have nothing left: they stay out of What's left and the waiting items. */
const isFinished = (state: ProjectState): boolean => state === 'done' || state === 'archived';
export interface ProjectLeft { project: string; roadmap: Memory; parsed: Roadmap; lastActivity: string; quiet: boolean; state: ProjectState }

/** The held reason for a save close to a deleted fact (§17a): "is close to a fact you deleted on 2 Nov 2026". */
export function deletedReason(m: Pick<Memory, 'deletedAt'>): string {
  return `is close to a fact you deleted on ${deletedDay(m.deletedAt ?? '')}`;
}
/** "2 Nov 2026", in UTC, for the held reason and the MCP reply. */
export function deletedDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
}

export class MemoryService {
  private meaning: MeaningHook | undefined;

  /** The graph's meaning index, told about every fact whose vector or project changed, right after the write commits. */
  setMeaningHook(hook: MeaningHook): void {
    this.meaning = hook;
  }

  /** A failed index step is logged and never fails the save (the startup catch-up re-indexes it). */
  private indexFacts(ids: readonly string[]): void {
    if (ids.length > 0) this.indexStep((m) => m.factsChanged(ids));
  }

  private indexStep(step: (m: MeaningHook) => void): void {
    if (!this.meaning) return;
    try {
      step(this.meaning);
    } catch (e) {
      console.error(`meaning index failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private opts: {
      duplicateThreshold: number; minRecallSimilarity: number; recallConfidentSimilarity: number; recallWindow?: number; reranker?: Reranker;
    },
  ) {}

  get(id: string): Memory | undefined {
    return this.store.get(id);
  }

  /** Whether the project's newest memory is older than QUIET_DAYS (false when it has none). */
  isQuiet(project: string): boolean {
    const newest = this.store.list({ project, limit: 1 })[0];
    return newest !== undefined && newest.updatedAt < new Date(this.store.nowDate().getTime() - QUIET_DAYS * DAY_MS).toISOString();
  }

  loadProfile(): Memory[] {
    return this.store.list({ kind: 'profile' });
  }

  /** The real project for a name that is an alias of one; any other name unchanged. */
  private canonical(project: string): string {
    return this.store.aliasTarget(project) ?? project;
  }

  /**
   * Like canonical, but when no project has that name, the project whose folder has it (the Claude Code start hook
   * names a session after its folder: ~/Projects/Bramble asks for "bramble", which lives in wildlog's folder). Only for
   * saving, briefing and reading: an owner's move, rename or alias goes to exactly the name typed.
   */
  private lookup(project: string): string {
    const alias = this.store.aliasTarget(project);
    if (alias !== undefined) return alias;
    if (this.projectExists(project)) return project;
    return this.store.registryProjects().find((p) => p.folder !== null && p.name !== project && folderName(p.folder) === project)?.name ?? project;
  }

  /** A project name given with a save or an edit, as lookup resolves it. */
  private resolveProject(project: unknown): string | null {
    const p = checkProject(project);
    return p === null ? null : this.lookup(p);
  }

  /** A project with memories, or with a row in the projects registry (an idea added on the home screen, an adopted folder). */
  private projectExists(project: string): boolean {
    return this.store.list({ project, limit: 1, replaced: 'include' }).length > 0 || this.store.projectState(project) !== undefined;
  }

  /**
   * For a status that is not its project's newest, the newest one (statuses are ordered by updated_at); otherwise
   * undefined. Lets search results say which status is current without reordering them.
   */
  newerStatus(m: Memory): Memory | undefined {
    if (m.project === null || !isStatus(m)) return undefined;
    const statuses = this.store.list({ project: m.project }).filter(isStatus);
    // Newer ones come first. Statuses kept as separate work, or confirmed as all current, are not "newer" than each other.
    for (const s of statuses) {
      if (s.id === m.id) return undefined;
      if (!this.store.isDismissed(s.id, m.id)) return s;
    }
    return undefined;
  }

  /**
   * `touch: false` searches without marking anything as recalled. `projects` limits the search to exactly those
   * project names (a read-only connection's), never following an alias: a project merged into another must not open
   * the other one up. Nothing else is searched, pinned or returned, and never a profile memory.
   */
  /**
   * `vector` is the query already embedded (the header search and recall embed once for facts and pages).
   * `replaced: 'include'` appends replaced facts after the current ones (see hybridSearch): `limit` applies to the
   * current part only (pinned facts and current hits), so neither the limit nor a pin ever cuts a replaced hit.
   * With a reranker (and `rerank` not false), the search's first RERANK_POOL current hits are reordered by it and
   * `limit` of them kept; only those kept are marked recalled. Replaced hits are never reordered; pinned facts only when the question is about one part of the project (B7).
   */
  async recall(q: {
    query: string; kind?: Kind; project?: string; projects?: string[]; limit?: number; touch?: boolean; vector?: Float32Array;
    replaced?: 'hide' | 'include'; replacedLimit?: number; replacedCut?: 'follow' | 'joint-top'; rerank?: boolean;
    /** Other phrasings written by the asking assistant (an English version, the project's real name): see otherPhrasings. */
    alt?: string[];
    /** Told once the reranker's best score over all phrasings, or null when it did not run (off, skipped or failed). */
    report?: (r: { bestScore: number | null }) => void;
  }): Promise<{ memory: Memory; score: number; replaced?: true }[]> {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const project = q.project === undefined ? undefined : this.lookup(q.project);
    const projects = q.projects;
    if (projects && ((project !== undefined && !projects.includes(project)) || q.kind === 'profile')) return [];
    const vector = q.vector ?? await this.embedder.embed(q.query, 'query');
    // A question naming a project by a nickname or alias is also asked with the project's real name (B4), so the
    // search and the reranker see the name its facts use. A project filter has already chosen the project; a
    // read-only grant limits the names that count.
    // It comes first and counts toward the MAX_PHRASINGS, and is left out when the question or a given phrasing
    // already uses the real name (each phrasing is one more reranker pass).
    const given = otherPhrasings(q.query, q.alt);
    const named = project === undefined ? this.namedProjects([q.query, ...given].join(' \n '), projects, false) : [];
    const unnamed = named.filter((p) => ![q.query, ...given].some((t) => words(t).includes(words(p))));
    const alt = [...(unnamed.length > 0 ? [`${q.query} (${unnamed.join(', ')})`] : []), ...given].slice(0, MAX_PHRASINGS);
    const variants = [];
    for (const text of alt) variants.push({ text, vector: await this.embedder.embed(text, 'query') });
    const rerank = this.opts.reranker !== undefined && q.rerank !== false;
    const found = hybridSearch(this.store, {
      vector, text: q.query, kind: q.kind, project, projects, limit, touch: rerank ? false : q.touch, variants,
      pool: rerank ? RERANK_POOL : undefined,
      minSimilarity: this.opts.minRecallSimilarity, confidentSimilarity: this.opts.recallConfidentSimilarity, window: this.opts.recallWindow,
      replaced: q.replaced, replacedLimit: q.replacedLimit, replacedCut: q.replacedCut,
    });
    let current = found.filter((r) => !r.replaced);
    let bestScore: number | null = null;
    let pinned = q.kind === undefined ? this.currentWordOn(q.query, project, projects) : [];
    let competing: Memory[] = [];
    if (rerank && pinned.length > 0 && !isWholeProjectQuestion(q.query, this.namesOf(project !== undefined ? [project] : this.namedProjects(q.query, projects)))) {
      // B7: "what's the latest on X's <one thing>?" — the project's roadmap and status join the reranked pool
      // instead of going on top; the fact about that one thing usually wins.
      const inPool = new Set(current.map((h) => h.memory.id));
      current = [...current, ...pinned.filter((m) => !inPool.has(m.id)).map((memory) => ({ memory, score: 0, sure: true }))];
      competing = pinned;
      pinned = [];
    }
    if (rerank) {
      const reordered = await this.reordered([q.query, ...alt], current);
      bestScore = reordered.best;
      // A reranker that failed leaves the search's order, where the added facts would sit last: pin them as before.
      if (reordered.best === null && competing.length > 0) pinned = competing;
      current = reordered.hits.slice(0, limit);
      if (q.touch !== false) this.store.markRecalled(current.filter((r) => r.sure).map((r) => r.memory.id));
    }
    const plain = ({ memory, score, replaced }: SearchHit) => (replaced ? { memory, score, replaced } : { memory, score });
    const results = current.map(plain);
    const replaced = found.filter((r) => r.replaced).map(plain);
    // A question answered by its project's pinned status has no weak match to report (B6 review).
    q.report?.({ bestScore: pinned.length > 0 ? null : bestScore });
    if (pinned.length === 0) return [...results, ...replaced];
    if (q.touch !== false) this.store.markRecalled(pinned.map((m) => m.id));
    const top = (results[0]?.score ?? 0) + 1;
    const pinnedIds = new Set(pinned.map((m) => m.id));
    return [...[...pinned.map((memory) => ({ memory, score: top })), ...results.filter((r) => !pinnedIds.has(r.memory.id))].slice(0, limit), ...replaced];
  }

  /**
   * The hits in the reranker's order (ties keep the search's order); each phrasing is scored and a hit keeps its best
   * score; `best` is the highest score (null when the reranker did not run). On any reranker error, the search's order.
   */
  private async reordered(queries: string[], hits: SearchHit[]): Promise<{ hits: SearchHit[]; best: number | null }> {
    // A single hit is scored too (a few milliseconds): only its score tells whether it matches the question at all.
    if (hits.length === 0 || !this.opts.reranker) return { hits, best: null };
    try {
      const best = hits.map(() => -Infinity);
      for (const query of queries) {
        const scores = await this.opts.reranker.score(query, hits.map((h) => h.memory.content));
        if (scores.length !== hits.length || scores.some((x) => !Number.isFinite(x))) throw new Error(`${scores.length} scores for ${hits.length} facts`);
        scores.forEach((x, i) => { best[i] = Math.max(best[i]!, x); });
      }
      return { hits: hits.map((h, i) => ({ h, s: best[i]! })).sort((a, b) => b.s - a.s).map((x) => x.h), best: Math.max(...best) };
    } catch (e) {
      console.error(`reranker failed: ${e instanceof Error ? e.message : String(e)}`);
      return { hits, best: null };
    }
  }

  /**
   * The projects `text` names (at most two): a project counts as named when its name (hyphens as spaces), one of its
   * aliases or one of its nicknames appears as whole words. The longest names first, so a specific name ("gps
   * tracklog") wins over common words that are also project names ("work", "career"). Only `allowed` ones, when given.
   * `byName: false` counts only aliases and nicknames (recall's real-name phrasing: a question that already uses the
   * project's own name needs none, and plain names are often common words).
   */
  namedProjects(text: string, allowed?: readonly string[], byName = true): string[] {
    const q = words(text);
    const names = [
      ...(byName ? this.store.listProjects().map((p) => ({ name: words(p.project), project: p.project })) : []),
      ...this.store.aliases().map((a) => ({ name: words(a.alias), project: a.project })),
      ...this.store.nicknames().map((n) => ({ name: words(n.nickname), project: n.project })),
    ].filter((n) => n.name.trim() !== '' && q.includes(n.name) && (!allowed || allowed.includes(n.project))).sort((a, b) => b.name.length - a.name.length);
    const named: string[] = [];
    for (const { project } of names) if (named.length < 2 && !named.includes(project)) named.push(project);
    return named;
  }

  /** Every name these projects go by: the project names, their aliases and their nicknames. */
  private namesOf(named: readonly string[]): string[] {
    const projects = new Set(named);
    return [
      ...projects,
      ...this.store.aliases().filter((a) => projects.has(a.project)).map((a) => a.alias),
      ...this.store.nicknames().filter((n) => projects.has(n.project)).map((n) => n.nickname),
    ];
  }

  /**
   * For a question asking how a named project is going: that project's roadmap and newest status (at most two
   * projects named). A project counts as named when its name or one of its aliases appears as whole words
   * ("dossier-app" as "dossier app"); a project filter names it too. Only `allowed` projects count, when given.
   */
  private currentWordOn(query: string, filter: string | undefined, allowed?: string[]): Memory[] {
    if (!ASKS_HOW_IT_IS_GOING.test(words(query))) return [];
    const named = filter ? [filter] : this.namedProjects(query, allowed);
    if (named.length === 0) return [];
    return [...named].flatMap((p) => {
      const roadmap = this.roadmapOf(p);
      const status = this.store.list({ project: p }).find(isStatus);
      return [roadmap, status].filter((m): m is Memory => m !== undefined);
    });
  }

  /**
   * `newProject` confirms that a project name close to existing ones is really new. `separateWork` saves a status
   * for a project that already has one, for a separate stream of work (otherwise the existing ones come back).
   * `base`: for a roadmap, the updatedAt of the project's roadmap as the writer read it (see update).
   */
  async remember(
    input: { kind: Kind; content: string; project?: string; tags?: string[]; allowDuplicate?: boolean; newProject?: boolean; separateWork?: boolean; base?: string; supersedes?: string[];
      /** A save that can't wait for approval (closing a discussion): refuse a match with a deleted fact with this message. */
      refuseDeleted?: (day: string) => string },
    actor: Actor,
  ): Promise<RememberResult> {
    let kind = checkKind(input.kind);
    const content = checkContent(input.content, maxFor(kind));
    const tags = checkTags(input.tags);
    const project = this.resolveProject(input.project);
    if (kind === 'roadmap') {
      if (project === null) throw new MemoryError('invalid', 'A roadmap belongs to a project: give its project name.');
      checkRoadmapContent(content);
    }
    const by = actorLabel(actor);
    const fromAi = actor.type === 'ai';
    if (fromAi) {
      checkAiLabels(project, tags);
      // A status saved as a decision tagged "status" is a status: stored as one, it is checked and briefed as one.
      if (kind === 'decision' && tags.includes('status')) kind = 'summary';
      if (kind !== 'profile' && project !== null && !input.newProject && !this.projectExists(project)) {
        const candidates = this.sameNameProjects(project);
        if (candidates.length > 0) return { status: 'new_project', project, candidates };
      }
    }
    // The facts this save replaces (section 16), checked before anything is embedded or held.
    const ids = input.supersedes?.length ? this.checkSupersede(input.supersedes, { kind, tags, project }, 'remember') : [];
    const replacing = new Set(ids);
    // One roadmap per project: saving one again replaces it (the previous version stays in history).
    const roadmap = kind === 'roadmap' ? this.roadmapOf(project!) : undefined;
    if (roadmap) {
      // The project keeps the state the owner gave it: an assistant's new roadmap never reopens a parked project.
      const r = await this.update(roadmap.id, { content, tags: input.tags === undefined ? roadmap.tags : tags }, actor, { base: input.base });
      if (r.status === 'updated') return { status: 'roadmap_updated', memory: r.memory };
      if (r.status === 'suggested') return { status: 'suggested', suggestion: r.suggestion, similar: [] };
      throw new Error('unreachable: a roadmap update never changes its project');
    }
    const vector = await this.embedder.embed(content, 'passage');

    if (fromAi && kind === 'profile') {
      const pending = await this.matchingPendingSuggestion(vector, kind, null);
      if (pending) return { status: 'already_suggested', suggestion: pending };
      this.checkHeldRoom();
      const similar = findSimilar(this.store, vector, { kind }, this.opts.duplicateThreshold);
      const deleted = this.deletedMatch(vector, { kind, tags, project: null });
      const reason = looksLikeInstruction(content) ?? (deleted ? deletedReason(deleted) : null);
      const suggestion = this.store.addSuggestion({ action: 'add', memoryId: null, content, tags, reason, suggestedBy: by, deletedMatch: deleted?.id ?? null });
      return { status: 'suggested', suggestion, similar };
    }
    // Statuses this save replaces are not "the existing ones": they are being superseded by it.
    const statuses = fromAi && kind === 'summary' && project !== null ? this.store.list({ project }).filter((m) => isStatus(m) && !replacing.has(m.id)) : [];
    if (statuses.length > 0 && !input.separateWork) return { status: 'status_exists', statuses };
    // A status saved as separate work was just judged against that project's statuses; it would only match them again.
    if (actor.type === 'ai' && kind !== 'roadmap' && !input.allowDuplicate && !(input.separateWork && statuses.length > 0)) {
      // Other projects' memories are left out: look-alike facts of two projects are not duplicates, and the answer
      // says to update one of the matches, which would overwrite the other project's memory. Tidy compares them all.
      const similar = findSimilar(this.store, vector, { kind, project, exclude: replacing }, this.opts.duplicateThreshold);
      if (similar.length > 0) return { status: 'similar_exists', similar };
    }
    if (fromAi && !input.allowDuplicate) {
      const was = this.wasReplaced(vector, { kind, tags, project }, replacing);
      if (was) return was;
    }
    // Forgetting that sticks (§17a): a fact the owner deleted comes back only through the owner, allow_duplicate or not.
    const deleted = fromAi ? this.deletedMatch(vector, { kind, tags, project }) : undefined;
    if (deleted) {
      if (input.refuseDeleted) throw new MemoryError('invalid', input.refuseDeleted(deletedDay(deleted.deletedAt ?? '')));
      const pending = await this.matchingPendingSuggestion(vector, kind, project);
      if (pending) return { status: 'already_suggested', suggestion: pending };
      this.checkHeldRoom();
      const suggestion = this.store.addSuggestion({ action: 'add', memoryId: null, content, tags, kind, project, reason: looksLikeInstruction(content) ?? deletedReason(deleted), suggestedBy: by, supersedes: ids, deletedMatch: deleted.id });
      return { status: 'suggested', suggestion, similar: [] };
    }
    const reason = actor.type === 'ai' ? looksLikeInstruction(content) : null;
    if (reason) {
      const pending = await this.matchingPendingSuggestion(vector, kind, project);
      if (pending) return { status: 'already_suggested', suggestion: pending };
      this.checkHeldRoom();
      const suggestion = this.store.addSuggestion({ action: 'add', memoryId: null, content, tags, kind, project, reason, suggestedBy: by, supersedes: ids });
      return { status: 'suggested', suggestion, similar: [] };
    }
    let memory: Memory;
    try {
      memory = this.store.atomic(() => {
        const saved = this.store.insert({ kind, content, project, tags, embedding: vector, by });
        // Separate streams of work: neither status supersedes the other (newerStatus, the tidy page's status groups).
        for (const s of statuses) this.store.dismissPair(saved.id, s.id);
        if (ids.length > 0) {
          // Decided again with the saved fact, in the same transaction as the insert: a failure saves nothing.
          this.addSupersessions(this.checkSupersede(ids, saved, 'remember'), saved.id, by);
        }
        return saved;
      });
    } catch (e) {
      if (kind === 'roadmap' && e instanceof Error && /UNIQUE/.test(e.message)) {
        // The project was merged into one with its own roadmap while this was embedded: replacing that roadmap would
        // silently drop its plan, so the writer reads it and merges the two.
        const real = project === null ? null : this.canonical(project);
        if (real !== project) {
          throw new MemoryError('invalid', `Not saved: project ${project} was merged into ${real} while this roadmap was being saved, and ${real} has its own roadmap. Read it with project_brief and save one roadmap that keeps both.`);
        }
        // Another save created this project's roadmap meanwhile (one per project, a unique index): update that one.
        return this.remember(input, actor);
      }
      throw e;
    }
    this.indexFacts([memory.id]);
    return { status: 'saved', memory, replaced: this.memories(ids) };
  }

  private memories(ids: readonly string[]): Memory[] {
    return ids.map((id) => this.store.get(id)).filter((m): m is Memory => m !== undefined);
  }

  /**
   * An assistant's save that matches a replaced fact of the same kind and project as a duplicate would: the current fact
   * of its chain comes back instead, unless that fact is deleted or is one this save replaces.
   */
  private wasReplaced(vector: Float32Array, next: { kind: Kind; tags: string[]; project: string | null }, replacing: ReadonlySet<string>): RememberResult | undefined {
    const kind = replaceableKind(next);
    if (kind === null) return undefined;
    const project = next.project === null ? null : this.canonical(next.project);
    let best: { id: string; similarity: number } | undefined;
    for (const e of this.store.activeEmbeddings({ replaced: 'only' })) {
      const similarity = cosine(vector, e.embedding);
      if (similarity < this.opts.duplicateThreshold || (best && best.similarity >= similarity)) continue;
      const m = this.store.get(e.id);
      if (!m || replaceableKind(m) !== kind || (m.project === null ? null : this.canonical(m.project)) !== project) continue;
      best = { id: e.id, similarity };
    }
    if (!best) return undefined;
    const row = this.store.supersessions.liveFor(best.id);
    const end = this.store.get(this.store.supersessions.chainEnd(best.id).endId);
    if (!row || !end || end.deletedAt || replacing.has(end.id)) return undefined;
    return { status: 'was_replaced', replaced: this.store.get(best.id)!, current: end, at: row.createdAt };
  }

  /**
   * Forgetting that sticks (§17a): the fact deleted on purpose that this text is as close to as a duplicate, of the same
   * kind (replaceable kinds compared as such) and the same project, aliases followed. `exclude`: the fact being edited.
   */
  deletedMatch(vector: Float32Array, next: { kind: Kind; tags: string[]; project: string | null }, exclude?: string): Memory | undefined {
    // Roadmaps share one Done/Now/Next shape and are never duplicates of each other (as in duplicates() and remember).
    if (next.kind === 'roadmap') return undefined;
    const kindOf = (m: { kind: Kind; tags: string[] }) => replaceableKind(m) ?? m.kind;
    const want = kindOf(next);
    const project = next.project === null ? null : this.canonical(next.project);
    const inScope = (m: Memory) => kindOf(m) === want && (m.project === null ? null : this.canonical(m.project)) === project;
    const candidates: { m: Memory; embedding: Float32Array; similarity: number }[] = [];
    for (const e of this.store.deletedEmbeddings()) {
      if (e.id === exclude) continue;
      const similarity = cosine(vector, e.embedding);
      if (similarity < this.opts.duplicateThreshold) continue;
      const m = this.store.get(e.id);
      if (m && inScope(m)) candidates.push({ m, embedding: e.embedding, similarity });
    }
    if (candidates.length === 0) return undefined;
    // A deleted fact that a live one already says (a held save the owner approved, the twin a merge kept) no longer
    // holds anything: its content is back by the owner's own choice. The fact being edited counts as live.
    const live = this.store.activeEmbeddings({ replaced: 'include' }).filter((e) => {
      const m = this.store.get(e.id);
      return m !== undefined && inScope(m);
    });
    const covered = (c: { embedding: Float32Array }) => live.some((e) => cosine(c.embedding, e.embedding) >= this.opts.duplicateThreshold);
    return candidates.sort((a, b) => b.similarity - a.similarity).find((c) => !covered(c))?.m;
  }

  /**
   * Section 16's check 5 on later edits: a fact linked by a live replacement (as the old or the new fact) keeps its
   * replaceable kind, so a status can't end up having "replaced" a decision. The owner is told to undo first.
   */
  private checkKindKept(current: Memory, nextTags: string[], actor: Actor): void {
    if (replaceableKind(current) === replaceableKind({ kind: current.kind, tags: nextTags })) return;
    const linked = this.store.supersessions.liveFor(current.id) !== undefined || this.store.supersessions.liveBy(current.id).length > 0;
    if (!linked) return;
    throw new MemoryError('invalid', actor.type === 'owner' ? `${SAME_KIND_ONLY} Undo the replacement on this page first.` : SAME_KIND_ONLY);
  }

  /** `freed`: waiting ones this save replaces. Every waiting suggestion counts: all of them wait for the owner. */
  private checkHeldRoom(freed = 0): void {
    if (this.store.listSuggestions('pending').length - freed >= MAX_HELD_PENDING) {
      throw new MemoryError('invalid', `Not saved: ${MAX_HELD_PENDING} memories are already waiting for the owner's approval. Tell the owner to review them on the memory dashboard.`);
    }
  }

  /**
   * A pending suggestion of the same kind and project whose text is as similar as a duplicate, so the same fact does
   * not pile up for approval. Look-alike rules of two projects are two facts: each must reach the owner.
   */
  private async matchingPendingSuggestion(vector: Float32Array, kind: Kind, project: string | null): Promise<Suggestion | undefined> {
    for (const s of this.store.listSuggestions('pending')) {
      if (s.content === null || s.kind !== kind) continue;
      if (kind !== 'profile' && this.suggestedProject(s) !== project) continue;
      if (cosine(vector, await this.embedder.embed(s.content, 'passage')) >= this.opts.duplicateThreshold) return s;
    }
    return undefined;
  }

  /** The project a waiting suggestion would be saved under: the one it names, or else its memory's (an alias followed). */
  private suggestedProject(s: Suggestion): string | null {
    const p = s.project ?? (s.memoryId ? this.store.get(s.memoryId)?.project ?? null : null);
    return p === null ? null : this.canonical(p);
  }

  private activeMemory(id: string): Memory {
    const m = this.store.get(id);
    if (!m || m.deletedAt) throw notFound(id);
    return m;
  }

  /**
   * `expectContent`: save only if the memory still has this text once the new text is embedded, otherwise refuse with
   * "This list changed: reload" (an owner's tick must not overwrite a change made while it was being saved).
   * `base`: the updatedAt of the memory as the writer read it. When it has changed since, nothing is saved and a
   * 'changed' error carries the current memory: a save from an older copy must not wipe a newer one.
   */
  async update(
    id: string,
    input: { content: string; project?: string | null; tags?: string[]; newProject?: boolean; supersedes?: string[] },
    actor: Actor,
    opts: { expectContent?: string; base?: string } = {},
  ): Promise<
    | { status: 'updated'; memory: Memory; replaced: Memory[] }
    | { status: 'suggested'; suggestion: Suggestion }
    | { status: 'new_project'; project: string; candidates: string[] }
  > {
    const current = this.activeMemory(id);
    // An assistant changes course by replacing the newer fact, never by editing a replaced one (the owner still can).
    if (actor.type === 'ai' && this.store.supersessions.liveFor(id)) {
      throw new MemoryError('invalid', `This fact was replaced by ${this.store.supersessions.chainEnd(id).endId}. Update that one.`);
    }
    if (opts.base !== undefined && current.updatedAt !== opts.base) throw changedSince(current);
    const content = checkContent(input.content, maxFor(current.kind));
    const tags = input.tags === undefined ? current.tags : checkTags(input.tags);
    this.checkKindKept(current, tags, actor);
    const project = input.project === undefined ? current.project : this.resolveProject(input.project);
    const by = actorLabel(actor);
    if (current.kind === 'roadmap' && actor.type === 'ai' && content !== current.content && checkRoadmap(content) === null && checkRoadmap(current.content) === null) {
      // An assistant writing from an older copy must not put back what the owner has ticked off since.
      const merged = keepTicked(current.content, content);
      if (merged !== content) return this.update(id, { ...input, content: merged }, actor, opts);
    }
    if (current.kind === 'roadmap') {
      // Only new text must have the roadmap shape: a label change (Mark done) works on whatever is stored.
      if (content !== current.content) checkRoadmapContent(content);
      if (project === null) throw new MemoryError('invalid', 'A roadmap belongs to a project: give its project name.');
      if (project !== current.project && this.roadmapOf(project)) {
        throw new MemoryError('invalid', `Project ${project} already has a roadmap: update that one, or forget one of them.`);
      }
    }
    // The facts this edit replaces, checked against the fact as it will be after the edit (new tags can change its kind).
    const next = { id, kind: current.kind, tags, project };
    const ids = input.supersedes?.length ? this.checkSupersede(input.supersedes, next, 'update') : [];

    if (actor.type === 'ai') {
      checkAiLabels(input.project === undefined ? null : project, input.tags === undefined ? [] : tags);
      if (project !== null && project !== current.project && !input.newProject && !this.projectExists(project)) {
        const candidates = this.sameNameProjects(project);
        if (candidates.length > 0) return { status: 'new_project', project, candidates };
      }
    }
    if (actor.type === 'ai' && current.kind === 'profile') {
      const reason = looksLikeInstruction(content);
      // Its newer edit of a profile memory replaces its own edit still waiting, so re-saves don't pile up.
      const superseded = this.store.listSuggestions('pending')
        .filter((s) => s.action === 'update' && s.memoryId === id && s.suggestedBy === by);
      this.checkHeldRoom(superseded.length);
      for (const s of superseded) this.store.resolveSuggestion(s.id, 'rejected');
      const suggestion = this.store.addSuggestion({ action: 'update', memoryId: id, content, tags, reason, suggestedBy: by });
      return { status: 'suggested', suggestion };
    }
    /** Adds the replacement rows in the caller's transaction, decided again on the fact as it is now. */
    const replaceIn = (): void => {
      if (ids.length === 0) return;
      const now = this.activeMemory(id);
      this.addSupersessions(this.checkSupersede(ids, { id, kind: now.kind, tags: now.tags, project: now.project }, 'update'), id, by);
    };
    if (content === current.content) {
      // Same text: only the labels change, and the memory keeps its date (moving a status must not make it the latest).
      const same = project === current.project && tags.length === current.tags.length && tags.every((t, i) => t === current.tags[i]);
      if (same) {
        if (ids.length > 0) this.store.atomic(replaceIn);
        return { status: 'updated', memory: current, replaced: this.memories(ids) };
      }
      const relabelled = this.store.atomic(() => {
        this.checkKindKept(this.activeMemory(id), tags, actor);
        const m = this.store.relabel(id, { project, tags, by });
        replaceIn();
        return m;
      });
      this.indexFacts([id]);
      return { status: 'updated', memory: relabelled, replaced: this.memories(ids) };
    }
    const holdUpdate = (reason: string, deletedMatch: string | null = null): { status: 'suggested'; suggestion: Suggestion } => {
      // An assistant's newer held edit of a memory replaces its own edit still waiting, so re-saves don't pile up.
      const superseded = this.store.listSuggestions('pending')
        .filter((s) => s.action === 'update' && s.memoryId === id && s.reason !== null && s.suggestedBy === by);
      this.checkHeldRoom(superseded.length);
      for (const s of superseded) this.store.resolveSuggestion(s.id, 'rejected');
      // Only a project the AI chose is recorded: approval otherwise keeps whatever project the memory has by then.
      const chosen = input.project === undefined ? null : project;
      const suggestion = this.store.addSuggestion({ action: 'update', memoryId: id, content, tags, kind: current.kind, project: chosen, reason, suggestedBy: by, supersedes: ids, deletedMatch });
      return { status: 'suggested', suggestion };
    };
    const reason = actor.type === 'ai' ? looksLikeInstruction(content) : null;
    if (reason) return holdUpdate(reason);
    const embedding = await this.embedder.embed(content, 'passage');
    // Forgetting that sticks (§17a): an assistant can't rewrite a fact into one the owner deleted.
    const deleted = actor.type === 'ai' ? this.deletedMatch(embedding, { kind: current.kind, tags, project }, id) : undefined;
    if (deleted) return holdUpdate(deletedReason(deleted), deleted.id);
    // Other requests ran while the text was embedded. Nothing awaits between these checks and the write.
    const result = this.store.atomic((): Memory | 'changed' => {
      const latest = this.store.get(id);
      if (!latest || latest.deletedAt) throw notFound(id);
      if (opts.expectContent !== undefined && latest.content !== opts.expectContent) {
        throw new MemoryError('invalid', LIST_CHANGED);
      }
      // Changed meanwhile: start again from what is there now (an assistant's roadmap then keeps a tick made meanwhile).
      if (latest.content !== current.content || latest.project !== current.project || JSON.stringify(latest.tags) !== JSON.stringify(current.tags)) {
        return 'changed';
      }
      this.checkKindKept(latest, tags, actor);
      const memory = this.store.update(id, { content, project, tags, embedding, by });
      // Rewritten, the fact may no longer disagree with anything: its open pairs end (a new flag opens one again).
      if (content !== latest.content) this.store.disagreements.settleFor(id, 'changed', by);
      replaceIn();
      return memory;
    });
    if (result === 'changed') return this.update(id, input, actor, opts);
    this.indexFacts([id]);
    return { status: 'updated', memory: result, replaced: this.memories(ids) };
  }

  forget(id: string, actor: Actor): { status: 'deleted' } | { status: 'suggested'; suggestion: Suggestion } {
    const current = this.activeMemory(id);
    const by = actorLabel(actor);
    if (actor.type === 'ai' && current.kind === 'profile') {
      // A deletion already waiting for this memory is the same request, whoever asked first.
      const waiting = this.store.listSuggestions('pending').find((s) => s.action === 'delete' && s.memoryId === id);
      if (waiting) return { status: 'suggested', suggestion: waiting };
      this.checkHeldRoom();
      const suggestion = this.store.addSuggestion({ action: 'delete', memoryId: id, content: null, tags: [], suggestedBy: by });
      return { status: 'suggested', suggestion };
    }
    this.store.softDelete(id, by);
    return { status: 'deleted' };
  }

  async undo(historyId: number, actor: Actor): Promise<Memory> {
    if (actor.type !== 'owner') throw new MemoryError('invalid', 'Only the owner can undo changes');
    const h = this.store.historyEntry(historyId);
    if (!h) throw new MemoryError('not_found', `No history entry with id ${historyId}`);
    const current = this.store.get(h.memoryId);
    if (!current) throw notFound(h.memoryId);
    // The memory goes back into the real project when its name has since become an alias (a merge).
    if (h.action === 'delete') {
      if (!current.deletedAt) throw new MemoryError('invalid', 'This memory is not deleted');
      const project = current.project === null ? null : this.canonical(current.project);
      if (current.kind === 'roadmap' && project !== null && this.roadmapOf(project)) {
        throw new MemoryError('invalid', `Project ${project} already has a roadmap: delete that one first to bring this one back.`);
      }
      const restored = this.store.restore(historyId, 'owner', null);
      this.indexFacts([h.memoryId]);
      return restored;
    }
    if (current.deletedAt) throw new MemoryError('invalid', 'This memory is deleted; undo the deletion first');
    const project = h.project === null ? null : this.canonical(h.project);
    if (current.kind === 'roadmap' && project !== null && project !== current.project && this.roadmapOf(project)) {
      throw new MemoryError('invalid', `Project ${project} already has a roadmap: delete that one first to move this one back.`);
    }
    // An older version's tags must not change the kind of a fact linked by a replacement.
    this.checkKindKept(current, h.tags, actor);
    const embedding = await this.embedder.embed(h.content, 'passage');
    const restored = this.store.atomic(() => {
      this.checkKindKept(this.store.get(h.memoryId)!, h.tags, actor);
      return this.store.restore(historyId, 'owner', embedding);
    });
    this.indexFacts([h.memoryId]);
    return restored;
  }

  /**
   * Project names with their memory counts and their other names (aliases); `withoutProfile` counts no profile memory.
   * Replaced facts are not counted unless `replaced` is 'include'.
   */
  listProjects(opts: { withoutProfile?: boolean; replaced?: ReplacedFilter } = {}): { project: string; count: number; aliases: string[] }[] {
    const aliases = this.store.aliases();
    return this.store.listProjects(opts).map((p) => ({ ...p, aliases: aliases.filter((a) => a.project === p.project).map((a) => a.alias) }));
  }

  /** The project's roadmap, if it has one. */
  roadmapOf(project: string): Memory | undefined {
    return this.store.list({ project, kind: 'roadmap' })[0];
  }

  /** How close by meaning a match must be to count, as recall uses it (pages use the same floor). */
  recallFloor(): number {
    return this.opts.minRecallSimilarity;
  }

  /** The real project for a name that may be an alias of one. */
  projectNamed(name: string): string {
    return this.lookup(name);
  }

  /** Every project with a roadmap, newest activity first, each with its state. */
  roadmapProjects(now: Date): ProjectLeft[] {
    const cutoff = new Date(now.getTime() - QUIET_DAYS * DAY_MS).toISOString();
    return this.store.list({ kind: 'roadmap' })
      .filter((m) => m.project !== null)
      .map((roadmap): ProjectLeft => {
        const lastActivity = this.store.list({ project: roadmap.project!, limit: 1 })[0]!.updatedAt;
        const quiet = lastActivity < cutoff;
        const state: ProjectState = this.store.projectState(roadmap.project!) ?? 'open';
        return { project: roadmap.project!, roadmap, parsed: parseRoadmap(roadmap.content), lastActivity, quiet, state };
      })
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  /**
   * The items waiting on the owner in these projects' roadmaps (done ones left out): dated ones first (soonest
   * first), then the oldest roadmaps' items first.
   */
  waitingOf(projects: ProjectLeft[]): (WaitingItem & { project: string; since: string })[] {
    return projects
      .filter((p) => !isFinished(p.state))
      .flatMap((p) => p.parsed.waiting.map((w) => ({ ...w, project: p.project, since: p.roadmap.updatedAt })))
      .sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.since.localeCompare(b.since)));
  }

  /** What is left: every roadmap not marked done, newest activity first, and the items waiting on the owner. */
  whatsLeft(now: Date): { waiting: (WaitingItem & { project: string; since: string })[]; projects: ProjectLeft[] } {
    const projects = this.roadmapProjects(now).filter((p) => !isFinished(p.state));
    return { waiting: this.waitingOf(projects), projects };
  }

  /**
   * The newest status of each project changed in the last `days` days (newest first), and the newest decisions created
   * then (at most MAX_RECENT_DECISIONS; `omitted` counts the rest). `visible` limits both to the projects a connection
   * may read, before the cap.
   */
  recentWork(days: number, visible: (project: string | null) => boolean = () => true): { statuses: Memory[]; decisions: Memory[]; omitted: number } {
    const cutoff = new Date(this.store.nowDate().getTime() - days * DAY_MS).toISOString();
    const seen = new Set<string>();
    const statuses: Memory[] = [];
    for (const m of this.store.list({})) {
      if (m.updatedAt < cutoff) break;
      if (m.project === null || !isStatus(m) || seen.has(m.project) || !visible(m.project)) continue;
      seen.add(m.project);
      statuses.push(m);
    }
    const decisions = this.store.list({ kind: 'decision' })
      .filter((m) => m.createdAt >= cutoff && !isStatus(m) && visible(m.project))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { statuses, decisions: decisions.slice(0, MAX_RECENT_DECISIONS), omitted: Math.max(0, decisions.length - MAX_RECENT_DECISIONS) };
  }

  /** Notes that an AI called a tool, for the weekly digest. */
  recordUse(actor: Actor, tool: string): void {
    this.store.logToolCall(actorLabel(actor), tool);
  }

  /**
   * One project's statuses and decisions. For a name with no memories, the closest project names instead:
   * names that contain it (or that it contains) first, then projects whose memories match it in meaning.
   */
  async brief(project: string): Promise<{ found: true; brief: Brief } | { found: false; closest: string[] }> {
    const brief = projectBrief(this.store, this.lookup(project));
    if (brief) {
      this.store.markRecalled([...(brief.roadmap ? [brief.roadmap] : []), ...brief.statuses, ...brief.decisions].map((m) => m.id));
      return { found: true, brief };
    }
    return { found: false, closest: await this.closestProjects(project) };
  }

  /**
   * Existing projects that are probably `project` under another name: names that contain it (or that it contains),
   * then projects whose memories mention it ("dossier-app" → memories saying "Dossier app"). By name only: by meaning,
   * almost any short name is close to some memory. Marks nothing as recalled.
   */
  private sameNameProjects(project: string): string[] {
    const found = this.knownNames().filter((name) => name !== project && sameName(name, project));
    const phrase = project.split('-').filter(Boolean).join(' ');
    for (const id of this.store.ftsSearch(`"${phrase}"`, {}, MAX_LIMIT)) {
      const p = this.store.get(id)?.project;
      if (p && p !== project && !found.includes(p)) found.push(p);
    }
    return found.slice(0, CLOSEST_PROJECTS);
  }

  /** Projects with memories, and those in the registry with none yet (an idea, an adopted folder). */
  private knownNames(): string[] {
    return [...new Set([...this.store.listProjects().map((p) => p.project), ...this.store.registryProjects().map((p) => p.name)])];
  }

  /**
   * Null when `project` names a project (directly or as an alias, memories or a registry row); otherwise the closest
   * project names, for a search filtered by a name that would otherwise just find nothing.
   */
  async closestIfUnknown(project: string): Promise<string[] | null> {
    return this.projectExists(this.lookup(project)) ? null : this.closestProjects(project);
  }

  /** Existing project names close to `project`: names that contain it (or that it contains), then by meaning. */
  private async closestProjects(project: string): Promise<string[]> {
    const wanted = project.trim().toLowerCase();
    const inFolder = this.store.registryProjects().filter((p) => p.folder !== null && folderName(p.folder) === wanted).map((p) => p.name);
    const closest = [...inFolder, ...this.knownNames().filter((name) => wanted !== '' && !inFolder.includes(name) && sameName(name, wanted))];
    const vector = await this.embedder.embed(project, 'query');
    const matches = hybridSearch(this.store, {
      vector, text: project, limit: MAX_LIMIT, touch: false,
      minSimilarity: this.opts.minRecallSimilarity, confidentSimilarity: this.opts.recallConfidentSimilarity, window: this.opts.recallWindow,
    });
    for (const { memory } of matches) {
      if (memory.project !== null && !closest.includes(memory.project)) closest.push(memory.project);
    }
    return closest.slice(0, CLOSEST_PROJECTS);
  }

  /**
   * Moves every active memory of `from` into the project `to` and records `from` as another name of `to`, so later
   * saves and briefings under the old name land in the same place. Returns how many moved.
   */
  moveProject(from: string, to: string, actor: Actor): number {
    const source = checkProject(from);
    const named = checkProject(to);
    if (source === null || named === null) throw new MemoryError('invalid', 'Choose two different project names');
    // Moving back to a name that became this project's alias: the alias goes, and the move is a plain rename.
    const renamingBack = this.store.aliasTarget(named) === source;
    const target = renamingBack ? named : this.canonical(named);
    if (source === target) throw new MemoryError('invalid', 'Choose two different project names');
    this.checkOneRoadmap(source, target);
    // One transaction: a move that finds nothing to move throws, and the alias removal is rolled back with it.
    let moved: string[] = [];
    const n = this.store.atomic(() => {
      if (renamingBack) this.store.removeAlias(named);
      moved = this.store.list({ project: source, replaced: 'include' }).map((m) => m.id);
      const n = this.store.moveProject(source, target, actorLabel(actor));
      if (n === 0) throw new MemoryError('not_found', `No memories in project ${source}`);
      this.store.addAlias(source, target, actorLabel(actor));
      return n;
    });
    this.indexFacts(moved);
    // Pages and facts still filed under an old name now resolve to the target: they are re-indexed as its own.
    this.indexStep((m) => m.projectChanged(target));
    return n;
  }

  /** Owner only: makes `alias` another name of `project`, moving any memories filed under the alias; returns how many. */
  addAlias(alias: string, project: string, actor: Actor): number {
    if (actor.type !== 'owner') throw new MemoryError('invalid', 'Only the owner can add project aliases');
    const source = checkProject(alias);
    const named = checkProject(project);
    const target = named === null ? null : this.canonical(named);
    if (source === null || target === null || source === target) throw new MemoryError('invalid', 'Choose two different project names');
    if (!this.projectExists(target)) throw new MemoryError('not_found', `No project ${target}: an alias must point at an existing project`);
    this.checkOneRoadmap(source, target);
    let ids: string[] = [];
    const moved = this.store.atomic(() => {
      ids = this.store.list({ project: source, replaced: 'include' }).map((m) => m.id);
      const moved = this.store.moveProject(source, target, actorLabel(actor));
      this.store.addAlias(source, target, actorLabel(actor));
      return moved;
    });
    this.indexFacts(ids);
    this.indexStep((m) => m.projectChanged(target));
    return moved;
  }

  aliases(): { alias: string; project: string }[] {
    return this.store.aliases();
  }

  /**
   * Moving `source` into `target` must not leave two roadmaps in one project. A first roadmap waiting for approval
   * counts: approved after the merge, it would replace the other project's roadmap without saying so.
   */
  private checkOneRoadmap(source: string, target: string): void {
    const live = (p: string) => this.roadmapOf(p) !== undefined;
    const waiting = (p: string) => this.store.listSuggestions('pending')
      .some((s) => s.action === 'add' && s.kind === 'roadmap' && s.project !== null && this.canonical(s.project) === p);
    if ((live(source) || waiting(source)) && (live(target) || waiting(target))) {
      if (waiting(source) || waiting(target)) {
        throw new MemoryError('invalid', `${source} and ${target} both have a roadmap, and one of them is waiting for your approval: approve or reject it in Approvals first, then merge what is left into one of them.`);
      }
      throw new MemoryError('invalid', `${source} and ${target} both have a roadmap: merge what is left into one of them and delete the other first.`);
    }
  }

  removeAlias(alias: string): void {
    if (!this.store.removeAlias(alias)) throw new MemoryError('not_found', `No project alias ${alias}`);
  }

  pendingSuggestions(): Suggestion[] {
    return this.store.listSuggestions('pending');
  }

  private pendingSuggestion(id: string): Suggestion {
    const s = this.store.getSuggestion(id);
    if (!s) throw new MemoryError('not_found', `No suggestion with id ${id}`);
    if (s.status !== 'pending') throw new MemoryError('invalid', `Suggestion ${id} is already ${s.status}`);
    return s;
  }

  /** The live roadmap a waiting roadmap suggestion would replace: the one it edits, or its project's (an alias followed). */
  private roadmapReplacedBy(s: Suggestion): Memory | undefined {
    if (s.action === 'update') {
      const m = s.memoryId ? this.store.get(s.memoryId) : undefined;
      return m && !m.deletedAt && m.kind === 'roadmap' ? m : undefined;
    }
    return s.action === 'add' && s.kind === 'roadmap' && s.project !== null ? this.roadmapOf(this.canonical(s.project)) : undefined;
  }

  async approveSuggestion(id: string, editedContent?: string): Promise<Memory | null> {
    return (await this.approveSuggestionReport(id, editedContent)).memory;
  }

  /**
   * Approves a waiting suggestion. A held save's `supersedes` ids are checked again: those that no longer qualify (one
   * replaced, deleted or moved meanwhile) are skipped and named in `notReplaced`, while the fact is still saved.
   */
  async approveSuggestionReport(id: string, editedContent?: string): Promise<{ memory: Memory | null; notReplaced: { id: string; why: string }[] }> {
    const first = this.pendingSuggestion(id);
    let content: string | null = null;
    let embedding: Float32Array | null = null;
    let roadmap = false;
    let replaced: string | undefined;
    if (first.action !== 'delete') {
      content = checkContent(editedContent ?? first.content ?? '', maxFor(first.kind));
      const target = first.memoryId ? this.store.get(first.memoryId) : undefined;
      roadmap = (target?.kind ?? first.kind) === 'roadmap';
      if (roadmap) {
        checkRoadmapContent(content);
        // The suggestion was written before the owner ticked items off while it waited: those stay done.
        replaced = this.roadmapReplacedBy(first)?.content;
        if (replaced !== undefined && checkRoadmap(replaced) === null) content = keepTicked(replaced, content);
      }
      embedding = await this.embedder.embed(content, 'passage');
    }
    // Everything below is synchronous: re-check after the await, then apply and resolve atomically.
    const notReplaced: { id: string; why: string }[] = [];
    const result = this.store.atomic((): Memory | null | 'changed' => {
      const s = this.pendingSuggestion(id);
      // The roadmap changed while the text was embedded: start again from what is there now.
      if (roadmap && this.roadmapReplacedBy(s)?.content !== replaced) return 'changed';
      // A project merged into another while this waited: the memory goes to the project it was merged into.
      const chosen = s.project === null ? null : this.canonical(s.project);
      let applied: Memory | null;
      if (s.action === 'delete') {
        this.store.softDelete(this.activeMemory(s.memoryId ?? '').id, s.suggestedBy);
        applied = null;
      } else if (s.action === 'add') {
        // A roadmap saved meanwhile for the same project is the one this approval updates (one per project).
        const existing = s.kind === 'roadmap' && chosen !== null ? this.roadmapOf(chosen) : undefined;
        applied = existing
          ? this.store.update(existing.id, { content: content!, project: existing.project, tags: s.tags, embedding: embedding!, by: s.suggestedBy })
          : this.store.insert({ kind: s.kind, content: content!, project: chosen, tags: s.tags, embedding: embedding!, by: s.suggestedBy });
      } else {
        const target = this.activeMemory(s.memoryId ?? '');
        // The owner approves this: a fact linked by a replacement since it was held keeps its kind.
        this.checkKindKept(target, s.tags, { type: 'owner' });
        const project = s.kind === 'profile' ? target.project : (chosen ?? target.project);
        applied = this.store.update(target.id, { content: content!, project, tags: s.tags, embedding: embedding!, by: s.suggestedBy });
      }
      if (applied) {
        // Each id on its own: one that no longer qualifies is skipped and named, the others are still replaced.
        for (const old of [...new Set(s.supersedes)]) {
          try {
            this.addSupersessions(this.checkSupersede([old], applied, 'owner'), applied.id, s.suggestedBy);
          } catch (e) {
            if (!(e instanceof MemoryError)) throw e;
            notReplaced.push({ id: old, why: e.message });
          }
        }
      }
      this.store.resolveSuggestion(id, 'approved');
      return applied;
    });
    if (result === 'changed') return this.approveSuggestionReport(id, editedContent);
    if (result) this.indexFacts([result.id]);
    return { memory: result, notReplaced };
  }

  // ---- Superseded facts (section 16) ----

  /**
   * The seven checks before `oldIds` are replaced by `next` (the replacing fact as it will be saved; `id` unset for a
   * fact not saved yet). Throws MemoryError with the plain message of the first that fails; returns the ids, deduped.
   * Synchronous, so a caller runs it once before any await and again inside the block that writes.
   */
  private checkSupersede(
    oldIds: readonly string[],
    next: { id?: string; kind: Kind; tags: string[]; project: string | null },
    from: 'remember' | 'update' | 'owner',
  ): string[] {
    const ids = [...new Set(oldIds)];
    if (ids.length > MAX_SUPERSEDES) throw new MemoryError('invalid', `At most ${MAX_SUPERSEDES} facts can be replaced in one save.`);
    if (next.id !== undefined) {
      const live = this.store.supersessions.liveFor(next.id);
      if (live) {
        const end = this.store.supersessions.chainEnd(next.id).endId;
        throw new MemoryError('invalid', `This fact was replaced by ${end}. ${from === 'update' ? 'Update' : 'Use'} that one.`);
      }
    }
    const nextKind = replaceableKind(next);
    const nextProject = next.project === null ? null : this.canonical(next.project);
    for (const id of ids) {
      if (id === next.id) throw new MemoryError('invalid', 'A fact can\'t replace itself.');
      const old = this.store.get(id);
      if (!old || old.deletedAt) throw notFound(id);
      const live = this.store.supersessions.liveFor(id);
      if (live) throw new MemoryError('invalid', `Already replaced by ${live.newId} on ${day(live.createdAt)}. Replace that one instead.`);
      const oldKind = replaceableKind(old);
      if (oldKind === null || nextKind === null) throw new MemoryError('invalid', NEVER_REPLACED);
      if (oldKind !== nextKind) throw new MemoryError('invalid', SAME_KIND_ONLY);
      const oldProject = old.project === null ? null : this.canonical(old.project);
      if (oldProject !== nextProject) {
        throw new MemoryError('invalid', `Both facts must be in the same project (${oldProject ?? 'no project'} vs ${nextProject ?? 'no project'}).`);
      }
    }
    return ids;
  }

  /** Adds the rows inside the caller's synchronous block; a unique-index failure reads as check 2. */
  private addSupersessions(ids: readonly string[], newId: string, by: string): Supersession[] {
    return ids.map((id) => {
      try {
        return this.store.supersessions.add(id, newId, by);
      } catch (e) {
        const live = this.store.supersessions.liveFor(id);
        if (live && e instanceof Error && /UNIQUE constraint failed: supersessions/.test(e.message)) {
          throw new MemoryError('invalid', `Already replaced by ${live.newId} on ${day(live.createdAt)}. Replace that one instead.`);
        }
        throw e;
      }
    });
  }

  /** The stored replacing fact, as checkSupersede reads it. */
  private replacingFact(newId: string): { id: string; kind: Kind; tags: string[]; project: string | null } {
    const m = this.activeMemory(newId);
    return { id: m.id, kind: m.kind, tags: m.tags, project: m.project };
  }

  /**
   * `newId` replaces `oldIds` (the owner's picker, Tidy up, or an assistant through remember and update_memory). The
   * checks run once now and again in the same transaction as the insert. Nothing is re-indexed: the graph and search
   * read the supersessions table itself.
   */
  supersede(oldIds: readonly string[], newId: string, actor: Actor, from: 'remember' | 'update' | 'owner' = 'owner'): Supersession[] {
    this.checkSupersede(oldIds, this.replacingFact(newId), from);
    return this.store.atomic(() => {
      const ids = this.checkSupersede(oldIds, this.replacingFact(newId), from);
      return this.addSupersessions(ids, newId, actorLabel(actor));
    });
  }

  /**
   * An assistant (or the owner) says two live facts can't both be true (B1). Never a roadmap; the pair is stored
   * once. A pair the owner already called "both right" is not offered again.
   */
  flagDisagreement(a: string, b: string, why: string, actor: Actor): { status: 'flagged' | 'already_flagged' | 'dismissed_before'; disagreement: Disagreement } {
    const reason = why.trim();
    if (a === b) throw new MemoryError('invalid', 'A fact cannot disagree with itself: give two different ids.');
    if (reason === '') throw new MemoryError('invalid', 'Say in a few words why the two facts cannot both be true.');
    if (reason.length > MAX_WHY) throw new MemoryError('invalid', `The reason is too long: at most ${MAX_WHY} characters.`);
    // The reason reaches every assistant with the two facts: it gets the checks any text an assistant saves gets.
    const secret = looksLikeSecret(reason);
    if (secret) throw new MemoryError('secret_detected', `The reason looks like it holds a secret (${secret}): say only what the two facts disagree about.`);
    const instruction = actor.type === 'ai' ? looksLikeInstruction(reason) : null;
    if (instruction) throw new MemoryError('invalid', `The reason reads like an instruction to assistants (it ${instruction}): say only what the two facts disagree about.`);
    for (const id of [a, b]) {
      const m = this.activeMemory(id);
      if (m.kind === 'roadmap') throw new MemoryError('invalid', 'A roadmap cannot be flagged: update it instead.');
      if (this.store.supersessions.liveFor(id)) throw new MemoryError('invalid', `${id} was already replaced by a newer fact.`);
    }
    const by = actorLabel(actor);
    return this.store.atomic(() => {
      const known = this.store.disagreements.forPair(a, b);
      if (!known) return { status: 'flagged' as const, disagreement: this.store.disagreements.add(a, b, reason, by) };
      if (known.settledAt === null) return { status: 'already_flagged' as const, disagreement: known };
      if (known.settledHow === 'both') return { status: 'dismissed_before' as const, disagreement: known };
      return { status: 'flagged' as const, disagreement: this.store.disagreements.reopen(known.id, reason, by) };
    });
  }


  /** Open pairs, newest first, both facts live (a pair whose fact went away is settled as "gone" here); one project's when given. */
  openDisagreements(project?: string): (Disagreement & { factA: Memory; factB: Memory })[] {
    const out: (Disagreement & { factA: Memory; factB: Memory })[] = [];
    const wanted = project === undefined ? undefined : this.canonical(project);
    // Pairs whose fact went away are settled in one statement; the rest are open with both facts live.
    this.store.settleGoneDisagreements();
    for (const d of this.store.disagreements.open()) {
      const factA = this.store.get(d.a);
      const factB = this.store.get(d.b);
      if (!factA || !factB) continue;
      const projects = [factA.project, factB.project].map((p) => (p === null ? null : this.canonical(p)));
      if (wanted !== undefined && !projects.includes(wanted)) continue;
      out.push({ ...d, factA, factB });
    }
    return out;
  }

  /** The live facts this one disagrees with, in open pairs. */
  disagreesWith(id: string): { id: string; memory: Memory; why: string }[] {
    return this.openDisagreements()
      .filter((d) => d.a === id || d.b === id)
      .map((d) => ({ id: d.id, memory: d.a === id ? d.factB : d.factA, why: d.why }));
  }

  /**
   * After a save (B1): up to `limit` live facts of the same kind and project that are close to this one but not the
   * same fact (between the recall-confident floor and the duplicate threshold), closest first. Never statuses or
   * roadmaps, never a pair already flagged; the saving assistant judges whether one of them disagrees.
   */
  closeFacts(id: string, limit = 3): { memory: Memory; similarity: number }[] {
    const m = this.store.get(id);
    if (!m || m.deletedAt || m.kind === 'roadmap' || isStatus(m)) return [];
    const project = (x: Memory) => (x.project === null ? null : this.canonical(x.project));
    const mine = project(m);
    // Only the fact's own project (its aliases included) is read; a fact with no project compares with its kind's.
    const names = mine === null ? undefined : [mine, ...this.aliases().filter((a) => a.project === mine).map((a) => a.alias)];
    // The projects filter leaves out profile facts, so a profile fact filed under a project reads its kind and filters below.
    const all = this.store.activeEmbeddings(names === undefined || m.kind === 'profile' ? { kind: m.kind } : { kind: m.kind, projects: names });
    const self = all.find((e) => e.id === id);
    if (!self) return [];
    return all
      .filter((e) => e.id !== id)
      .map((e) => ({ id: e.id, similarity: cosine(self.embedding, e.embedding) }))
      .filter((x) => x.similarity >= this.opts.recallConfidentSimilarity && x.similarity < this.opts.duplicateThreshold)
      .sort((x, y) => y.similarity - x.similarity)
      .map((x) => ({ memory: this.store.get(x.id)!, similarity: x.similarity }))
      .filter((x) => x.memory && !isStatus(x.memory) && project(x.memory) === mine && !this.store.disagreements.forPair(id, x.memory.id))
      .slice(0, limit);
  }

  /** Every fact in an open disagreement, with the facts it disagrees with (and their projects, to check visibility). */
  disagreementIndex(): Map<string, { id: string; why: string; project: string | null }[]> {
    const index = new Map<string, { id: string; why: string; project: string | null }[]>();
    const add = (id: string, other: Memory, why: string) => index.set(id, [...(index.get(id) ?? []), { id: other.id, why, project: other.project === null ? null : this.canonical(other.project) }]);
    for (const d of this.openDisagreements()) { add(d.a, d.factB, d.why); add(d.b, d.factA, d.why); }
    return index;
  }

  /**
   * Owner only. 'a' or 'b': that fact is right, and the other is replaced by it (or deleted, when the two can't
   * replace each other: profile facts, different projects or kinds). 'both': dismissed for good.
   */
  settleDisagreement(id: string, how: 'a' | 'b' | 'both', actor: Actor): Disagreement {
    if (actor.type !== 'owner') throw new MemoryError('invalid', 'Only the owner can settle a disagreement.');
    const d = this.store.disagreements.get(id);
    if (!d) throw new MemoryError('not_found', `No disagreement with id ${id}`);
    const open = this.openDisagreements().find((x) => x.id === id);
    if (!open) throw new MemoryError('invalid', 'This disagreement was already settled.');
    // One change: the replacement (or deletion) and the settle land together or not at all.
    return this.store.atomic(() => {
      if (how !== 'both') {
        const [right, wrong] = how === 'a' ? [open.factA, open.factB] : [open.factB, open.factA];
        if (this.canReplacePair(right, wrong)) this.supersede([wrong.id], right.id, actor);
        else this.store.softDelete(wrong.id, actorLabel(actor));
      }
      this.store.disagreements.settle(id, how, actorLabel(actor));
      return this.store.disagreements.get(id)!;
    });
  }

  /** Owner only: the replaced fact comes back (its row gets undone_at). Returns the fact brought back. */
  undoSupersession(rowId: number, actor: Actor): Memory {
    if (actor.type !== 'owner') throw new MemoryError('invalid', 'Only the owner can bring a replaced fact back.');
    const row = this.store.atomic(() => {
      const r = this.store.supersessions.get(rowId);
      if (!r) throw new MemoryError('not_found', `No replacement with id ${rowId}`);
      if (r.undoneAt !== null) throw new MemoryError('invalid', 'This was already brought back.');
      this.store.supersessions.undo(r.id, OWNER);
      return r;
    });
    // Its vector did not change, so only a forced re-index puts it back into the graph's threads.
    this.indexStep((m) => m.factsBroughtBack([row.oldId]));
    return this.store.get(row.oldId)!;
  }

  /** The facts this one replaced directly: live rows, not deleted, oldest first. */
  replacesOf(id: string): Memory[] {
    return this.store.supersessions.liveBy(id)
      .map((r) => this.store.get(r.oldId))
      .filter((m): m is Memory => m !== undefined && m.deletedAt === null);
  }

  /** What replaced a fact: its live row and the end of its chain (`end` null when that fact is deleted); null when current. */
  replacement(id: string): { row: Supersession; endId: string; end: Memory | null; steps: number } | null {
    const row = this.store.supersessions.liveFor(id);
    if (!row) return null;
    const { endId, steps } = this.store.supersessions.chainEnd(id);
    const end = this.store.get(endId);
    return { row, endId, end: end && !end.deletedAt ? end : null, steps };
  }

  /** Whether one of two facts can replace the other (Tidy up): the same replaceable kind in the same real project. */
  canReplacePair(a: Memory, b: Memory): boolean {
    const kind = replaceableKind(a);
    const project = (m: Memory) => (m.project === null ? null : this.canonical(m.project));
    return kind !== null && kind === replaceableKind(b) && project(a) === project(b);
  }

  /**
   * The owner's picker on a current fact's page: current facts of the same replaceable kind under the same real project
   * (its aliases included), the fact itself left out. At most 10, most alike first by one cosine pass; `all`: every
   * one, newest first. Null when the fact is deleted, replaced or can't be replaced.
   */
  pickerChoices(id: string, all: boolean): { choices: Memory[]; total: number; kind: Replaceable; project: string | null } | null {
    const m = this.store.get(id);
    const kind = m ? replaceableKind(m) : null;
    if (!m || m.deletedAt || kind === null || this.store.supersessions.liveFor(id)) return null;
    const project = m.project === null ? null : this.canonical(m.project);
    // Only this project's names are read, and embeddings only for the facts scored: the cost follows the project.
    const names = project === null ? null : [project, ...this.store.aliases().filter((x) => x.project === project).map((x) => x.alias)];
    const same = this.store.currentDecisionsAndStatuses(names).filter((x) => x.id !== id && replaceableKind(x) === kind);
    if (all) return { choices: [...same].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), total: same.length, kind, project };
    const vectors = this.store.embeddingsOf([id, ...same.map((x) => x.id)]);
    const mine = vectors.get(id);
    const scored = same.map((x) => ({ x, sim: mine && vectors.has(x.id) ? cosine(mine, vectors.get(x.id)!) : -1 }))
      .sort((a, b) => b.sim - a.sim || b.x.createdAt.localeCompare(a.x.createdAt));
    return { choices: scored.slice(0, PICKER_CHOICES).map((s) => s.x), total: same.length, kind, project };
  }

  rejectSuggestion(id: string): void {
    this.pendingSuggestion(id);
    this.store.resolveSuggestion(id, 'rejected');
  }

  needsALook(now: Date): { duplicates: { a: Memory; b: Memory; similarity: number }[]; stale: Memory[] } {
    return { duplicates: this.duplicates(), stale: this.stale(now) };
  }

  /** Pairs of memories of one kind that say nearly the same thing, closest first: compares every pair, so it is slow. */
  duplicates(): { a: Memory; b: Memory; similarity: number }[] {
    const duplicates: { a: Memory; b: Memory; similarity: number }[] = [];
    // Roadmaps are one per project and share their four-line shape, so they are never duplicates of each other.
    for (const kind of KINDS.filter((k) => k !== 'roadmap')) {
      const es = this.store.activeEmbeddings({ kind });
      for (let i = 0; i < es.length; i++) {
        for (let j = i + 1; j < es.length; j++) {
          const similarity = cosine(es[i]!.embedding, es[j]!.embedding);
          if (similarity < this.opts.duplicateThreshold) continue;
          if (this.store.isDismissed(es[i]!.id, es[j]!.id)) continue;
          const a = this.store.get(es[i]!.id);
          const b = this.store.get(es[j]!.id);
          if (a && b) duplicates.push({ a, b, similarity });
        }
      }
    }
    return duplicates.sort((x, y) => y.similarity - x.similarity);
  }

  /** Memories neither edited nor recalled for STALE_DAYS. */
  stale(now: Date): Memory[] {
    const cutoff = now.getTime() - STALE_DAYS * DAY_MS;
    return this.store.list({}).filter((m) =>
      Date.parse(m.updatedAt) < cutoff && Date.parse(m.lastRecalledAt ?? m.createdAt) < cutoff);
  }
}
