import type { GrowthService } from '../growth/service.js';
import type { Observation } from '../growth/types.js';
import { itemKey, parseRoadmap } from '../memory/roadmap.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { TidySummary } from '../memory/tidy.js';
import { isLifeArea, nothingSet } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import type { Area } from '../projects/types.js';
import { shortDay } from '../timezone.js';
import { counts } from '../web/growthViews.js';
import { weekSentence, type SentenceFacts } from './sentence.js';
import type { ReviewStore } from './store.js';
import { CHIP_ORDER, type Chip, type ProjectWeek, type ReviewBody, type SafetyFlag } from './types.js';

export type ReviewKind = 'last' | 'older' | 'now';
/** Who is reading: the owner on the page, a Full connection, or a read-only one limited to some projects. */
export type Scope = { kind: 'owner' } | { kind: 'full' } | { kind: 'read'; projects: string[] };

export interface PresentContext {
  registry: ProjectStore;
  service: MemoryService;
  memories: MemoryStore;
  pages: { get(id: string): { deletedAt: string | null } | undefined };
  growth: GrowthService | null;
  reviews: ReviewStore;
  now: Date;
}

/** What became of a stored waiting item: still waiting (with the live index and text a tick needs), or not. */
export type WaitState = { live: true; index: number; text: string } | { live: false; state: 'done' | 'gone' | 'finished' };
export interface WaitRow { project: string; lifeArea: boolean; text: string; due: string; wait: WaitState }
/** The page shows `shown`, then folds `folded` under "N more". Counts never depend on the split. */
export interface Capped<T> { shown: T[]; folded: T[] }

export interface MovedCard {
  project: string;
  /** For the area dot. */
  area: Area | null;
  lifeArea: boolean;
  done: { text: string; date: string }[];
  moreSteps: number;
  progress: ProjectWeek['progress'];
  pagesUpdated: number;
  chips: Chip[];
  notPushed: ProjectWeek['notPushed'];
}

export interface ReviewView {
  monday: string;
  kind: ReviewKind;
  sentence: string;
  /** The sentence without its lead, for the Monday line. */
  lineSentence: string;
  empty: boolean;
  /** Projects with steps, pages or commits only on the Mac; at most CAPS.moved. */
  moved: MovedCard[];
  movedMore: string[];
  /** Every chip of the week, in project order (never capped: a project has at most two). */
  chips: { project: string; chip: Chip }[];
  waiting: { late: Capped<WaitRow>; after: Capped<WaitRow>; undated: number };
  quiet: Capped<{ project: string; area: Area | null; lastTouched: string; next: string | null; open: boolean; stateText: string | null }>;
  back: Capped<{ project: string; quietDays: number }>;
  /** `replaced`: replaced since (section 16), on the day of its replacement; `currentId` null when the chain ends in a deleted fact or a project the reader can't read. */
  decided: Capped<{ id: string; date: string; project: string | null; excerpt: string; by: string; voices: string[] | undefined; replaced: { on: string; currentId: string | null } | null }>;
  growth: { strength: Observation | null; improve: Observation | null; finished: number; started: number } | null;
  safety: Capped<SafetyFlag & { excerpt?: string }>;
  digest: ReviewBody['digest'] | null;
  tidy: TidySummary | null;
  builtAt: string;
  quietFromFactsOnly: boolean;
}

/** Hard caps on every list. The sentence and every number are counted before them. */
export const CAPS = { moved: 5, steps: 3, late: 5, after: 5, quiet: 5, back: 3, decided: 3, safety: 3 } as const;
export const EXCERPT = 120;

const cap = <T>(xs: T[], n: number): Capped<T> => ({ shown: xs.slice(0, n), folded: xs.slice(n) });
const excerpt = (s: string): string => (s.length > EXCERPT ? `${s.slice(0, EXCERPT).trimEnd()}…` : s);
const stepKey = (d: { text: string; date: string }) => `${itemKey(d.text)}\n${d.date}`;

/** Stored rows that now resolve to one project (merged after the week was stored) become one. */
function mergeRows(rows: ProjectWeek[], current: string): ProjectWeek {
  if (rows.length === 1) return { ...rows[0]!, project: current };
  const done: ProjectWeek['done'] = [];
  const seen = new Set<string>();
  for (const d of rows.flatMap((r) => r.done)) if (!seen.has(stepKey(d))) { seen.add(stepKey(d)); done.push(d); }
  done.sort((a, b) => a.date.localeCompare(b.date));
  const progress = rows.map((r) => r.progress).filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => b.total - a.total || b.to - a.to)[0] ?? null;
  const waiting: ProjectWeek['waiting'] = [];
  const waits = new Set<string>();
  for (const x of rows.flatMap((r) => r.waiting)) if (!waits.has(itemKey(x.text))) { waits.add(itemKey(x.text)); waiting.push(x); }
  const notPushed = rows.map((r) => r.notPushed).filter((n): n is NonNullable<typeof n> => n !== null).sort((a, b) => b.count - a.count)[0] ?? null;
  const back = rows.map((r) => r.back).filter((b): b is NonNullable<typeof b> => b !== null).sort((a, b) => b.quietDays - a.quietDays)[0] ?? null;
  const moved = done.length > 0 || back !== null;
  const quiets = rows.filter((r) => r.quiet !== null);
  const quiet = moved || quiets.length === 0 ? null : {
    lastTouched: quiets.map((r) => r.quiet!.lastTouched).sort().at(-1)!,
    next: (quiets.find((r) => r.project === current) ?? quiets[0]!).quiet!.next,
  };
  const chips = CHIP_ORDER.filter((c) => rows.some((r) => r.chips.includes(c)));
  return {
    project: current, done, progress, pages: [...new Set(rows.flatMap((r) => r.pages))], chips, waiting,
    dated: rows.reduce((a, r) => a + r.dated, 0), undated: rows.reduce((a, r) => a + r.undated, 0), quiet, back, notPushed,
  };
}

/** Where a stored waiting item stands in the live roadmap, matched by itemKey. */
function waitState(ctx: PresentContext, project: string, text: string): WaitState {
  const state = ctx.registry.get(project)?.state;
  if (state === 'done' || state === 'archived') return { live: false, state: 'finished' };
  const m = ctx.service.roadmapOf(project);
  if (!m) return { live: false, state: 'gone' };
  const r = parseRoadmap(m.content);
  const key = itemKey(text);
  const index = r.waiting.findIndex((w) => itemKey(w.text) === key);
  if (index >= 0) return { live: true, index, text: r.waiting[index]!.text };
  if (r.done.some((d) => itemKey(d.text) === key)) return { live: false, state: 'done' };
  return { live: false, state: 'gone' };
}

/**
 * A stored week shown to someone: names resolved to today's projects, cut to what the reader may see, deleted things
 * dropped, the Personal rule applied, waiting items matched to the live roadmaps, then counted and worded, and only
 * then capped.
 */
export function presentReview(r: { monday: string; body: ReviewBody; builtAt: string }, kind: ReviewKind, scope: Scope, ctx: PresentContext): ReviewView {
  const body = r.body;
  // 1. Today's names, merging rows that now resolve to one project.
  const grouped = new Map<string, ProjectWeek[]>();
  for (const p of body.projects) {
    const name = ctx.service.projectNamed(p.project);
    grouped.set(name, [...(grouped.get(name) ?? []), p]);
  }
  // 2. What the reader may see.
  // Exactly as granted, as the MCP server reads it: a granted name merged into another project since reads nothing.
  const readable = scope.kind === 'read' ? new Set(scope.projects) : undefined;
  const visible = (project: string | null): boolean => readable === undefined || (project !== null && readable.has(project));
  const rows = [...grouped].filter(([name]) => visible(name)).map(([name, rs]) => mergeRows(rs, name));
  const life = new Map(rows.map((p) => [p.project, isLifeArea(ctx.registry.get(p.project))]));
  const lifeOf = (name: string | null) => name !== null && (life.get(name) ?? isLifeArea(ctx.registry.get(name)));
  const lifeLast = <T>(name: (x: T) => string | null) => (a: T, b: T) => Number(lifeOf(name(a))) - Number(lifeOf(name(b)));

  /** A decision replaced since it was made: when, and the current fact the reader may open. */
  const replacedSince = (id: string): { on: string; currentId: string | null } | null => {
    const rep = ctx.service.replacement(id);
    if (!rep) return null;
    const end = rep.end;
    const readable = end !== null && visible(end.project === null ? null : ctx.service.projectNamed(end.project));
    return { on: rep.row.createdAt, currentId: readable ? end.id : null };
  };
  // 3. Deleted pages, decisions and observations drop out.
  const livePage = (id: string) => { const p = ctx.pages.get(id); return p !== undefined && p.deletedAt === null; };
  const decisions = body.decisions.map((id) => ctx.memories.get(id)).filter((m) => m !== undefined && m.deletedAt === null)
    .map((m) => ({ m: m!, project: m!.project === null ? null : ctx.service.projectNamed(m!.project) }))
    .filter((d) => visible(d.project));
  const observation = (id: string | null): Observation | null => {
    if (id === null || ctx.growth === null) return null;
    const o = ctx.growth.get(id);
    return o && counts(o) ? o : null;
  };
  const growthBody = scope.kind === 'read' ? null : body.growth;
  const strength = growthBody ? observation(growthBody.strength) : null;
  const improve = growthBody ? observation(growthBody.improve) : null;

  // 4. Cards, the Personal rule, and 5. waiting items against the live roadmaps.
  const cards: MovedCard[] = rows.map((p) => ({
    project: p.project, area: ctx.registry.get(p.project)?.area ?? null, lifeArea: life.get(p.project)!, done: p.done, moreSteps: 0, progress: p.progress,
    pagesUpdated: p.pages.filter(livePage).length, chips: p.chips, notPushed: p.notPushed,
  })).filter((c) => c.done.length > 0 || c.pagesUpdated > 0 || c.notPushed !== null || c.chips.length > 0)
    .sort((a, b) => Number(a.lifeArea) - Number(b.lifeArea) || b.done.length - a.done.length || a.project.localeCompare(b.project));
  const chips = cards.flatMap((c) => c.chips.map((chip) => ({ project: c.project, chip })))
    .sort((a, b) => CHIP_ORDER.indexOf(a.chip) - CHIP_ORDER.indexOf(b.chip) || a.project.localeCompare(b.project));
  const shownCards = cards.filter((c) => c.done.length > 0 || c.pagesUpdated > 0 || c.notPushed !== null);
  const waits: (WaitRow & { when: 'late' | 'after' })[] = rows.flatMap((p) => p.waiting.map((x) => ({
    project: p.project, lifeArea: life.get(p.project)!, text: x.text, due: x.due, when: x.when, wait: waitState(ctx, p.project, x.text),
  // What can still be ticked first, then what became of the rest; life areas after the others.
  }))).sort((a, b) => Number(a.lifeArea) - Number(b.lifeArea) || Number(!a.wait.live) - Number(!b.wait.live)
    || a.due.localeCompare(b.due) || a.project.localeCompare(b.project));
  const late = waits.filter((x) => x.when === 'late').map(({ when: _w, ...x }) => x);
  const after = waits.filter((x) => x.when === 'after').map(({ when: _w, ...x }) => x);
  // A project emptied since (its facts moved to another project or deleted, or a typo name) is hidden on the home, so
  // it is never quiet or back here either: its history alone keeps a last-touched time. Same rule as the home's.
  const emptied = (name: string) => nothingSet(ctx.registry.get(name)) && ctx.memories.list({ project: name, limit: 1, replaced: 'include' }).length === 0;
  const quiet = rows.filter((p) => p.quiet !== null && !life.get(p.project) && !emptied(p.project))
    .sort((a, b) => a.quiet!.lastTouched.localeCompare(b.quiet!.lastTouched) || a.project.localeCompare(b.project))
    .map((p) => {
      const row = ctx.registry.get(p.project);
      const open = row === undefined || row.state === 'open';
      return { project: p.project, area: row?.area ?? null, lastTouched: p.quiet!.lastTouched, next: p.quiet!.next, open, stateText: open ? null : `${row!.state} since ${shortDay(row!.stateChangedAt, ctx.now)}` };
    });
  const back = rows.filter((p) => p.back !== null && !life.get(p.project) && !emptied(p.project))
    .sort((a, b) => b.back!.quietDays - a.back!.quietDays || a.project.localeCompare(b.project))
    .map((p) => ({ project: p.project, quietDays: p.back!.quietDays }));
  const decided = decisions.sort((a, b) => lifeLast<typeof a>((d) => d.project)(a, b) || b.m.createdAt.localeCompare(a.m.createdAt))
    .map(({ m, project }) => ({ id: m.id, date: m.createdAt, project, excerpt: excerpt(m.content), by: m.createdBy, voices: ctx.reviews.discussionVoices(m.id), replaced: replacedSince(m.id) }));
  // A replacement undone since the review was built is no longer a note: its page has nothing left to undo.
  const safety = scope.kind !== 'owner' ? [] : body.safety
    .filter((f) => f.kind !== 'replaced-others' || ctx.memories.supersessions.liveFor(f.memoryId) !== undefined)
    .map((f) => (f.kind === 'deleted-by-ai' || f.kind === 'replaced-others'
    ? { ...f, excerpt: excerpt(ctx.memories.get(f.memoryId)?.content ?? '') } : f));
  const growth = growthBody && (strength || improve) ? { strength, improve, finished: growthBody.finished, started: growthBody.started } : null;

  // 6. The sentence and every count, from the full filtered set.
  const facts: SentenceFacts = {
    steps: cards.filter((c) => c.done.length > 0).map((c) => ({ project: c.project, n: c.done.length, nameable: !c.lifeArea })),
    late: late.length,
    dated: rows.reduce((a, p) => a + p.dated, 0),
    quiet: quiet.map((q) => q.project),
    somethingElse: cards.length > 0 || after.length > 0 || back.length > 0 || decided.length > 0 || growth !== null || safety.length > 0,
  };
  const soFar = kind === 'now';
  const sentence = weekSentence(facts, { lead: true, soFar });
  const empty = facts.steps.length === 0 && facts.late === 0 && facts.quiet.length === 0 && !facts.somethingElse;

  // 7. Only now the caps.
  return {
    monday: r.monday,
    kind,
    sentence,
    lineSentence: weekSentence(facts, { lead: false, soFar }),
    empty,
    moved: shownCards.slice(0, CAPS.moved).map((c) => ({ ...c, done: c.done.slice(0, CAPS.steps), moreSteps: Math.max(0, c.done.length - CAPS.steps) })),
    movedMore: shownCards.slice(CAPS.moved).map((c) => c.project),
    chips,
    waiting: { late: cap(late, CAPS.late), after: cap(after, CAPS.after), undated: rows.reduce((a, p) => a + p.undated, 0) },
    quiet: cap(quiet, CAPS.quiet),
    back: cap(back, CAPS.back),
    decided: cap(decided, CAPS.decided),
    growth,
    safety: cap(safety, CAPS.safety),
    digest: scope.kind === 'owner' ? body.digest : null,
    tidy: scope.kind === 'owner' && kind === 'last' ? body.tidy ?? null : null,
    builtAt: r.builtAt,
    quietFromFactsOnly: body.quietFromFactsOnly,
  };
}
