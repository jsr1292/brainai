import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { STOPWORDS } from '../memory/stopwords.js';
import type { MemoryService } from '../memory/service.js';
import type { PageService } from '../pages/service.js';
import { placeLabel } from '../projects/places.js';
import { isLifeArea, type ProjectCard, type ProjectsService } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { AREA_LABELS, AREAS, type Area } from '../projects/types.js';
import { localDay } from '../timezone.js';
import { memoByKey } from '../web/memo.js';
import { currentFactCounts, graphCacheKey, newestCurrentDecisions } from './current.js';
import { topThreads, type MeaningIndex, type ThreadPair } from './threads.js';
import { normalWords } from './words.js';

/** What the Graph tab sends (round 2 section 15): built from the same project cards as the Projects home. */
export interface GraphProject {
  name: string; area: Area | null; state: 'idea' | 'open' | 'parked'; onTheGo: boolean; unlabelled: boolean;
  oneLiner: string | null; next: string | null; facts: number; pages: string[]; waiting: number; late: number; days: number; runsOn: string[];
}
export interface GraphThread { a: number; b: number; strength: number; links: number; words: string[] }
export interface GraphOverview { projects: GraphProject[]; threads: GraphThread[]; profileFacts: number; places: { id: string; label: string }[] }
/** unlabelled: an unpinned Personal project; its words are then [] so nothing Personal shows through the thread. */
export interface GraphRelated { name: string; words: string[]; unlabelled: boolean }
export interface GraphProjectDetail { name: string; decisions: { id: string; text: string }[]; pages: { id: string; title: string }[]; related: GraphRelated[] }
export interface GraphFind { q: string; projects: { name: string; hits: number }[] }
export interface GraphListRow {
  name: string; state: GraphProject['state']; onTheGo: boolean; oneLiner: string | null; next: string | null;
  waiting: number; late: number; days: number;
  /** Place labels. */
  runsOn: string[];
  /** Related project names; an unpinned Personal end is left out of every row outside the Personal fold. */
  related: string[];
}
export interface GraphList {
  areas: { area: Area | null; label: string; rows: GraphListRow[] }[];
  personal: GraphListRow[];
  done: { name: string; state: 'done' | 'archived' }[];
  summary: { projects: number; areas: number; facts: number; pages: number; threads: number; waiting: number };
}

export const ONE_LINER_CHARS = 80, NEXT_CHARS = 90, DECISIONS = 5, DECISION_CHARS = 90, FIND_PROJECTS = 12, MAX_PLACES_DRAWN = 8, MAX_QUERY = 200;

const DAY_MS = 86_400_000;
const cut = (s: string | null, n: number): string | null => (s === null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Whole days between two YYYY-MM-DD days of the owner's calendar. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

interface Drawn {
  cards: ProjectCard[];
  done: ProjectCard[];
  index: Map<string, number>;
  threads: (ThreadPair & { strength: number })[];
}

export class GraphService {
  readonly meaning: MeaningIndex;
  private readonly pairs: () => ThreadPair[];

  constructor(private d: { db: DB; projects: ProjectsService; registry: ProjectStore; service: MemoryService; pages: PageService; meaning: MeaningIndex; now: Clock }) {
    this.meaning = d.meaning;
    // Only the grouping into threads and the words are cached; project cards are built fresh on every request.
    this.pairs = memoByKey(() => graphCacheKey(d.db), () => this.meaning.threadPairs());
  }

  /** On the go in pin order, then every other drawn project newest first (the ← → order); threads between them. */
  private drawn(): Drawn {
    const home = this.d.projects.home(this.d.now());
    const rest = [...home.open, ...home.quiet, ...home.personal, ...home.ideas, ...home.parked]
      .sort((a, b) => b.lastTouched.localeCompare(a.lastTouched));
    const cards = [...home.onTheGo, ...rest];
    const index = new Map(cards.map((c, i) => [c.project.name, i]));
    const threads = topThreads(this.pairs().filter((p) => index.has(p.a) && index.has(p.b)));
    return { cards, done: home.done, index, threads };
  }

  private project(c: ProjectCard, facts: Map<string, number>, today: string): GraphProject {
    const p = c.project;
    return {
      name: p.name, area: p.area, state: p.state as GraphProject['state'], onTheGo: p.state === 'open' && p.pinnedAt !== null,
      unlabelled: isLifeArea(p), oneLiner: cut(p.oneLiner, ONE_LINER_CHARS), next: cut(c.next, NEXT_CHARS),
      facts: facts.get(p.name) ?? 0, pages: this.d.pages.forProject(p.name).map((x) => x.title),
      waiting: c.waiting, late: c.late, days: Math.max(0, daysBetween(localDay(new Date(c.lastTouched)), today)), runsOn: p.runsOn,
    };
  }

  overview(): GraphOverview {
    const g = this.drawn();
    const counts = currentFactCounts(this.d.db);
    const today = localDay(this.d.now());
    const projects = g.cards.map((c) => this.project(c, counts.byProject, today));
    const used = new Map<string, number>();
    for (const p of projects) for (const r of p.runsOn) used.set(r, (used.get(r) ?? 0) + 1);
    const places = [...used.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_PLACES_DRAWN)
      .map(([id]) => ({ id, label: placeLabel(id) }));
    return {
      projects,
      threads: g.threads.map((t) => ({ a: g.index.get(t.a)!, b: g.index.get(t.b)!, strength: Math.round(t.strength * 1000) / 1000, links: t.links, words: t.words })),
      profileFacts: counts.profile,
      places,
    };
  }

  private related(g: Drawn, name: string): GraphRelated[] {
    return g.threads.filter((t) => t.a === name || t.b === name).map((t) => {
      const other = t.a === name ? t.b : t.a;
      const unlabelled = isLifeArea(g.cards[g.index.get(other)!]!.project);
      return { name: other, words: unlabelled ? [] : t.words, unlabelled };
    });
  }

  /** A drawn or finished project's card details; an alias answers for its project; undefined for anything else. */
  detail(name: string): GraphProjectDetail | undefined {
    const real = this.d.service.projectNamed(name);
    const p = this.d.registry.get(real);
    if (!p) return undefined;
    const g = this.drawn();
    const finished = g.done.some((c) => c.project.name === real);
    if (!g.index.has(real) && !finished) return undefined;
    const names = [real, ...this.d.service.aliases().filter((a) => a.project === real).map((a) => a.alias)];
    return {
      name: real,
      decisions: newestCurrentDecisions(this.d.db, names, DECISIONS).map((m) => ({ id: m.id, text: cut(m.content, DECISION_CHARS)! })),
      pages: this.d.pages.forProject(real).map((x) => ({ id: x.id, title: x.title })),
      related: g.index.has(real) ? this.related(g, real) : [],
    };
  }

  /** The real name of a drawn project (an alias resolves), else undefined: the deep link then opens the overview. */
  focusName(name: string | undefined): string | undefined {
    if (name === undefined || name.trim() === '') return undefined;
    const real = this.d.service.projectNamed(name.trim());
    return this.drawn().index.has(real) ? real : undefined;
  }

  /** Projects whose facts or page sections match `q` by meaning or words, most hits first; marks nothing recalled. */
  async find(raw: string): Promise<GraphFind> {
    const q = raw.trim().slice(0, MAX_QUERY);
    const words = normalWords(q).split(' ').filter(Boolean);
    if (words.length === 0 || words.every((w) => STOPWORDS.has(w))) return { q, projects: [] };
    const vector = await this.d.pages.embedQuery(q);
    const hits = new Map<string, number>();
    const count = (project: string | null) => {
      if (project === null) return;
      const real = this.d.service.projectNamed(project);
      if (!this.d.registry.get(real)) return;
      hits.set(real, (hits.get(real) ?? 0) + 1);
    };
    for (const r of await this.d.service.recall({ query: q, limit: 20, touch: false, vector, rerank: false })) count(r.memory.project);
    for (const s of this.d.pages.search(q, vector, 10, this.d.service.recallFloor())) count(s.page.project);
    const projects = [...hits.entries()].map(([name, n]) => ({ name, hits: n }))
      .sort((a, b) => b.hits - a.hits || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, FIND_PROJECTS);
    return { q, projects };
  }

  /** The same data as plain rows: by area then Unsorted, unpinned Personal projects in their own fold, finished ones last. */
  list(): GraphList {
    const g = this.drawn();
    const counts = currentFactCounts(this.d.db);
    const today = localDay(this.d.now());
    const projects = g.cards.map((c) => this.project(c, counts.byProject, today));
    const row = (p: GraphProject, inFold: boolean): GraphListRow => ({
      name: p.name, state: p.state, onTheGo: p.onTheGo, oneLiner: p.oneLiner, next: p.next, waiting: p.waiting, late: p.late, days: p.days,
      runsOn: p.runsOn.map(placeLabel),
      related: this.related(g, p.name).filter((r) => inFold || !r.unlabelled).map((r) => r.name),
    });
    const groups: (Area | null)[] = [...AREAS, null];
    const personal = projects.filter((p) => p.unlabelled).map((p) => row(p, true));
    // Personal keeps its place when only its fold has projects: the list shows one Personal section, never two.
    const areas = groups.map((area) => ({
      area, label: area === null ? 'Unsorted' : AREA_LABELS[area],
      rows: projects.filter((p) => p.area === area && !p.unlabelled).map((p) => row(p, false)),
    })).filter((a) => a.rows.length > 0 || (a.area === 'personal' && personal.length > 0));
    return {
      areas,
      personal,
      done: g.done.map((c) => ({ name: c.project.name, state: c.project.state as 'done' | 'archived' })),
      summary: {
        projects: projects.length,
        // Each area with a drawn project; Unsorted has its own orbit but is not an area.
        areas: new Set(projects.flatMap((p) => (p.area === null ? [] : [p.area]))).size,
        facts: projects.reduce((n, p) => n + p.facts, 0),
        pages: projects.reduce((n, p) => n + p.pages.length, 0),
        threads: g.threads.length,
        waiting: projects.reduce((n, p) => n + p.waiting, 0),
      },
    };
  }
}
