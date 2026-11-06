import { cosine } from '../memory/embedder.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import { replaceableKind } from '../memory/supersessions.js';
import type { HistoryEntry, Memory } from '../memory/types.js';
import type { ProjectStore } from '../projects/store.js';
import { isKeyDecisions } from './markdown.js';
import { PageStore, type StoredSection } from './store.js';
import type { CaughtUp, Page, PageHeader } from './types.js';

/**
 * "May be out of date" (round 2 section 13). Nothing about the flag is stored: it is worked out from the facts each
 * time a page, a page list or a tool asks, against the page's caught-up time. Code constants, not settings.
 */
/** A page is flagged at this many decisions of its project saved or changed since it was last brought up to date. */
export const NEWER_DECISIONS = 3;
/** ...or at this many facts it links to changed, replaced or removed since. */
export const LINKED_CHANGES = 1;
/**
 * How close in meaning a decision must be to one of a page's sections to count for a page other than the main one, and
 * to name a section on the main page; null turns meaning matching off (only the main page counts decisions, no hints).
 */
// From the dry run on 2026-11-04: 219 pairs, 77.6% at or above, median margin 0.016.
export const SECTION_MATCH: number | null = null;

export interface NewerDecision { id: string; why: 'new' | 'changed'; at: string; createdAt: string; by: string; text: string; nearSection: string | null }
export interface LinkedChange { id: string; why: 'changed' | 'replaced' | 'removed'; at: string; text: string; isDecision: boolean; replacedBy: string | null }
/** Each list oldest event first. */
export interface Reasons { decisions: NewerDecision[]; linked: LinkedChange[] }
export interface Flag extends Reasons { pageId: string; project: string | null; main: boolean; caughtUp: CaughtUp; since: string }
/** `canRead`: what the connection asking may read (reasons are filtered before the thresholds). `hints`: name sections. */
export interface FreshScope { canRead?: (m: Memory) => boolean; hints?: boolean }

const byEvent = <T extends { at: string; id: string }>(a: T, b: T) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/** The flag for these reasons, or null under both thresholds. `since` is when the first threshold was reached. */
export function flagOf(p: PageHeader, r: Reasons, main: boolean, project: string | null): Flag | null {
  const times = [
    r.decisions.length >= NEWER_DECISIONS ? r.decisions[NEWER_DECISIONS - 1]!.at : null,
    r.linked.length >= LINKED_CHANGES ? r.linked[LINKED_CHANGES - 1]!.at : null,
  ].filter((t): t is string => t !== null).sort();
  if (times.length === 0) return null;
  return { pageId: p.id, project, main, caughtUp: p.caughtUp, since: times[0]!, decisions: r.decisions, linked: r.linked };
}

interface ProjectFacts { real: string; main: string | null; decisions: Memory[]; history: Map<string, HistoryEntry[]>; vectors?: Map<string, Float32Array> }

export class Freshness {
  readonly sectionMatch: number | null;

  constructor(private d: { store: PageStore; memoryStore: MemoryStore; memories: MemoryService; registry: ProjectStore; forProject: (name: string) => Page[]; sectionMatch: number | null }) {
    this.sectionMatch = d.sectionMatch;
  }

  private names(real: string): string[] {
    return [real, ...this.d.memories.aliases().filter((a) => a.project === real).map((a) => a.alias)];
  }

  /**
   * The project's main page: the oldest page titled "<project or alias> — …" that has a Key decisions section; else
   * its only page; else none.
   */
  mainPage(project: string): string | null {
    return this.mainPageHow(project).id;
  }

  /** The main page and by which part of the rule it was chosen (for the dry run's report). */
  mainPageHow(project: string): { id: string | null; how: 'rule' | 'only' | 'none' } {
    const real = this.d.memories.projectNamed(project);
    const ps = this.d.forProject(real);
    if (ps.length === 0) return { id: null, how: 'none' };
    const prefixes = this.names(real).map((n) => `${PageStore.titleKey(n)} — `);
    const heads = this.d.store.headings(ps.map((p) => p.id));
    const main = ps
      .filter((p) => prefixes.some((x) => PageStore.titleKey(p.title).startsWith(x)) && (heads.get(p.id) ?? []).some((h) => isKeyDecisions(h.heading)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (main) return { id: main.id, how: 'rule' };
    return ps.length === 1 ? { id: ps[0]!.id, how: 'only' } : { id: null, how: 'none' };
  }

  reasons(p: PageHeader, scope: FreshScope = {}): Reasons {
    return this.work([p], scope).get(p.id)!.reasons;
  }

  forPage(p: PageHeader, scope: FreshScope = {}): Flag | null {
    return this.forPages([p], scope).get(p.id) ?? null;
  }

  forPages(ps: PageHeader[], scope: FreshScope = {}): Map<string, Flag | null> {
    const out = new Map<string, Flag | null>();
    for (const [id, w] of this.work(ps, scope)) out.set(id, w.page === null ? null : flagOf(w.page, w.reasons, w.main, w.project));
    return out;
  }

  /** Each page's reasons before the thresholds (null for deleted pages and pages of archived projects): for the dry run. */
  details(ps: PageHeader[], scope: FreshScope = {}): Map<string, { reasons: Reasons; main: boolean } | null> {
    return new Map([...this.work(ps, scope)].map(([id, w]) => [id, w.page === null ? null : { reasons: w.reasons, main: w.main }]));
  }

  /** Everything one call needs, loaded once per project in the call and filtered per page by its own caught-up time. */
  private work(ps: PageHeader[], scope: FreshScope): Map<string, { page: PageHeader | null; reasons: Reasons; main: boolean; project: string | null }> {
    const out = new Map<string, { page: PageHeader | null; reasons: Reasons; main: boolean; project: string | null }>();
    const live = ps.filter((p) => p.deletedAt === null);
    // Section vectors are read once per page per call, and only for pages that need them.
    const cache = new Map<string, StoredSection[]>();
    const sectionsOf = (id: string) => { if (!cache.has(id)) cache.set(id, this.d.store.sections(id)); return cache.get(id)!; };
    const links = this.d.store.factLinks(live.map((p) => p.id));
    const facts = new Map<string, ProjectFacts | null>();
    const projectFacts = (real: string, minT: string): ProjectFacts | null => {
      if (facts.has(real)) return facts.get(real)!;
      if (this.d.registry.get(real)?.state === 'archived') { facts.set(real, null); return null; }
      const decisions = this.d.memoryStore.decisionsTouchedAfter(this.names(real), minT).filter((m) => replaceableKind(m) === 'decision');
      const history = new Map<string, HistoryEntry[]>();
      for (const h of this.d.memoryStore.historyAfter(decisions.map((m) => m.id), minT)) history.set(h.memoryId, [...(history.get(h.memoryId) ?? []), h]);
      const f = { real, main: this.mainPage(real), decisions, history };
      facts.set(real, f);
      return f;
    };
    // The earliest caught-up time per project, so one query serves every page of it.
    const minT = new Map<string, string>();
    for (const p of live) {
      if (p.project === null) continue;
      const real = this.d.memories.projectNamed(p.project);
      const t = minT.get(real);
      if (t === undefined || p.caughtUp.at < t) minT.set(real, p.caughtUp.at);
    }
    const linkedFacts = this.linkedFacts(live, links);
    for (const p of ps) {
      if (p.deletedAt !== null) { out.set(p.id, { page: null, reasons: { decisions: [], linked: [] }, main: false, project: null }); continue; }
      const real = p.project === null ? null : this.d.memories.projectNamed(p.project);
      const pf = real === null ? null : projectFacts(real, minT.get(real)!);
      if (real !== null && pf === null) { out.set(p.id, { page: null, reasons: { decisions: [], linked: [] }, main: false, project: real }); continue; }
      const main = pf !== null && pf.main === p.id;
      const linked = new Set(links.get(p.id) ?? []);
      const decisions = pf === null || (!main && this.sectionMatch === null) ? [] : this.near(() => sectionsOf(p.id), main, pf, this.newer(p.caughtUp.at, pf, linked, scope), scope);
      out.set(p.id, { page: p, reasons: { decisions, linked: linkedFacts(p.caughtUp.at, [...linked], scope) }, main, project: real });
    }
    return out;
  }

  /**
   * What the facts the pages link to (any kind, any project) did after each page's time: removed (deleted now, after
   * it), else replaced (a live replacement made after it), else changed (the text differs from the text then). One
   * reason per fact; a fact the scope can't read gives none, and what replaced a fact is named only when readable.
   */
  private linkedFacts(live: PageHeader[], links: Map<string, string[]>): (t: string, ids: string[], scope: FreshScope) => LinkedChange[] {
    const withLinks = live.filter((p) => (links.get(p.id) ?? []).length > 0);
    if (withLinks.length === 0) return () => [];
    const ids = [...new Set(withLinks.flatMap((p) => links.get(p.id)!))];
    const minT = withLinks.map((p) => p.caughtUp.at).sort()[0]!;
    const facts = this.d.memoryStore.getMany(ids);
    const replaced = this.d.memoryStore.supersessions.liveForMany(ids);
    const history = new Map<string, HistoryEntry[]>();
    for (const h of this.d.memoryStore.historyAfter(ids, minT)) history.set(h.memoryId, [...(history.get(h.memoryId) ?? []), h]);
    const ends = new Map<string, Memory | null>();
    const endOf = (id: string): Memory | null => {
      if (!ends.has(id)) {
        const rep = this.d.memories.replacement(id);
        ends.set(id, rep === null ? null : rep.end ?? this.d.memoryStore.get(rep.row.newId) ?? null);
      }
      return ends.get(id)!;
    };
    return (t, pageIds, scope) => {
      const out: LinkedChange[] = [];
      for (const id of pageIds) {
        const m = facts.get(id);
        if (!m || (scope.canRead && !scope.canRead(m))) continue;
        const base = { id, text: m.content, isDecision: replaceableKind(m) === 'decision' };
        if (m.deletedAt !== null) {
          if (m.deletedAt > t) out.push({ ...base, why: 'removed', at: m.deletedAt, replacedBy: null });
          continue;
        }
        const row = replaced.get(id);
        if (row && row.createdAt > t) {
          const by = endOf(id);
          out.push({ ...base, why: 'replaced', at: row.createdAt, replacedBy: by && (!scope.canRead || scope.canRead(by)) ? by.id : null });
          continue;
        }
        const first = history.get(id)?.find((h) => h.changedAt > t);
        if (first && first.content !== m.content) out.push({ ...base, why: 'changed', at: first.changedAt, replacedBy: null });
      }
      return out.sort(byEvent);
    };
  }

  /**
   * Meaning matching, on stored vectors only: the main page counts every newer decision (its sections named only for
   * `hints`); another page counts one only when it is at least SECTION_MATCH close to one of its sections other than
   * Key decisions. The section named is the closest such one, never Key decisions and never the lead.
   */
  private near(pageSections: () => StoredSection[], main: boolean, pf: ProjectFacts, ds: NewerDecision[], scope: FreshScope): NewerDecision[] {
    const floor = this.sectionMatch;
    if (ds.length === 0 || floor === null || (main && !scope.hints)) return ds;
    pf.vectors ??= this.d.memoryStore.embeddingsOf(pf.decisions.map((m) => m.id));
    const sections = pageSections().filter((s) => !isKeyDecisions(s.heading));
    const out: NewerDecision[] = [];
    for (const d of ds) {
      const v = pf.vectors.get(d.id);
      const sims = v === undefined ? [] : sections.map((s) => ({ anchor: s.anchor, sim: cosine(v, s.embedding) })).filter((x) => x.sim >= floor);
      if (!main && sims.length === 0) continue;
      const best = sims.filter((x) => x.anchor !== 'top').sort((a, b) => b.sim - a.sim)[0];
      out.push({ ...d, nearSection: best?.anchor ?? null });
    }
    return out;
  }

  /** The project's decisions saved or changed after `t`, the ones the page links to left out. New wins over changed. */
  private newer(t: string, pf: ProjectFacts, linked: Set<string>, scope: FreshScope): NewerDecision[] {
    const out: NewerDecision[] = [];
    for (const m of pf.decisions) {
      if (linked.has(m.id) || (scope.canRead && !scope.canRead(m))) continue;
      if (m.createdAt > t) {
        out.push({ id: m.id, why: 'new', at: m.createdAt, createdAt: m.createdAt, by: m.createdBy, text: m.content, nearSection: null });
        continue;
      }
      // The text as of t is what the first change after t replaced; A→B→A, a relabel or a delete undone never differ.
      const first = pf.history.get(m.id)?.find((h) => h.changedAt > t);
      if (first && first.content !== m.content) out.push({ id: m.id, why: 'changed', at: first.changedAt, createdAt: m.createdAt, by: first.changedBy, text: m.content, nearSection: null });
    }
    return out.sort(byEvent);
  }
}
