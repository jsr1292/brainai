import { notPushed } from '../folders/match.js';
import { isStatus } from '../memory/brief.js';
import { shiftWeek, weekContaining, weekOf, weeklyDigest } from '../memory/digest.js';
import { itemKey, parseRoadmap, type Roadmap } from '../memory/roadmap.js';
import type { MemoryStore } from '../memory/store.js';
import { SOON_DAYS, type FolderSource } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import type { Project } from '../projects/types.js';
import { QUIET_DAYS } from '../memory/service.js';
import { localDay } from '../timezone.js';
import { liveDuring, versionAt, versionsOf, type Version } from './history.js';
import type { ReviewStore } from './store.js';
import type { Chip, ProjectWeek, ReviewBody, ReviewWindow, SafetyFlag } from './types.js';

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** What a build reads. Always the whole brain: filtering happens when a week is shown. */
export interface BuildSources {
  reviews: ReviewStore;
  memories: MemoryStore;
  registry: ProjectStore;
  folders: FolderSource;
  grants: () => { clientName: string; createdAt: string }[];
  /** False in work mode, which has no Growth. */
  growth: boolean;
}

/** A finished week: late means due before the next Monday, "due after" runs to the Sunday after. */
export function windowFor(monday: string): ReviewWindow {
  const w = weekContaining(monday);
  if (!w || w.monday !== monday) throw new Error(`${monday} is not a Monday`);
  const next = shiftWeek(monday, 1);
  return { monday, start: w.start, end: w.end, today: next, dueUntil: addDays(next, 6), live: false };
}

/** This week so far: up to now, late means before today, "due after" the next SOON_DAYS days. */
export function liveWindow(now: Date): ReviewWindow {
  const w = weekOf(now);
  const today = localDay(now);
  return { monday: w.monday, start: w.start, end: now, today, dueUntil: addDays(today, SOON_DAYS), live: true };
}

/** How long after a week ends the Mac's report still counts for it: the normal Monday case. */
const REPORT_GRACE_MS = DAY_MS;

/**
 * A registry row migration 13 made copied a state nobody set that week: while its state_changed_at is still its
 * created_at, it has held that state since before any week.
 */
const heldSinceBefore = (p: Project): boolean => p.createdBy === 'migration' && p.stateChangedAt === p.createdAt;
/** The owner set this project's current state inside [start, end). */
const stateSetIn = (p: Project, start: string, end: string): boolean => !heldSinceBefore(p) && p.stateChangedAt >= start && p.stateChangedAt < end;
/** Done or archived before the week ended: never quiet, never back. */
const finishedBy = (p: Project | undefined, end: string): boolean =>
  p !== undefined && (p.state === 'done' || p.state === 'archived') && (heldSinceBefore(p) || p.stateChangedAt < end);
const isNewIn = (p: Project, start: string, end: string): boolean => p.createdBy !== 'migration' && p.createdAt >= start && p.createdAt < end;

const blank = (project: string): ProjectWeek => ({
  project, done: [], progress: null, pages: [], chips: [], waiting: [], dated: 0, undated: 0, quiet: null, back: null, notPushed: null,
});
const hasAnything = (p: ProjectWeek): boolean => p.done.length > 0 || p.progress !== null || p.pages.length > 0 || p.chips.length > 0
  || p.waiting.length > 0 || p.quiet !== null || p.back !== null || p.notPushed !== null;

/** A project's roadmap as it stood at a moment, from the versions of every roadmap memory (names already folded). */
function roadmapAt(roadmaps: { versions: Version[] }[], project: string, at: string, fold: (n: string) => string): Roadmap | null {
  let found: Version | undefined;
  for (const r of roadmaps) {
    const v = versionAt(r.versions, at);
    if (v && v.project !== null && fold(v.project) === project) found = v;
  }
  return found ? parseRoadmap(found.content) : null;
}

/** One week, built in memory from what was stored as of its edges. Wording is left to the presenter. */
export function buildReview(src: BuildSources, w: ReviewWindow): ReviewBody {
  const start = w.start.toISOString();
  const end = w.end.toISOString();
  const justBeforeEnd = new Date(w.end.getTime() - 1).toISOString();
  const lastDay = w.live ? localDay(w.end) : addDays(w.today, -1);
  const aliases = new Map(src.memories.aliases().map((a) => [a.alias, a.project]));
  const fold = (name: string): string => aliases.get(name) ?? name;

  const weeks = new Map<string, ProjectWeek>();
  const of = (name: string): ProjectWeek => weeks.get(name) ?? weeks.set(name, blank(name)).get(name)!;

  // What moved: Done steps dated inside the week, from every roadmap version live during it.
  const roadmaps = src.reviews.roadmapsBetween(start, end).map((r) => ({ versions: versionsOf(r.memory, r.history) }));
  const seen = new Set<string>();
  for (const r of roadmaps) {
    for (const v of liveDuring(r.versions, start, end)) {
      if (v.project === null) continue;
      const project = fold(v.project);
      for (const d of parseRoadmap(v.content).done) {
        if (d.date === null || d.date < w.monday || d.date > lastDay) continue;
        const key = `${project}\n${itemKey(d.text)}\n${d.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        of(project).done.push({ text: d.text, date: d.date });
      }
    }
  }
  for (const p of weeks.values()) p.done.sort((a, b) => a.date.localeCompare(b.date));

  // Progress and waiting: the roadmap at the start and just before the end.
  const projects = new Set<string>();
  for (const r of roadmaps) for (const v of r.versions) if (v.project !== null) projects.add(fold(v.project));
  for (const project of projects) {
    const atEnd = roadmapAt(roadmaps, project, justBeforeEnd, fold);
    if (!atEnd) continue;
    const atStart = roadmapAt(roadmaps, project, start, fold);
    if (atEnd.progress && atEnd.now) {
      const same = atStart?.progress && atStart.progress.total === atEnd.progress.total && atStart.now === atEnd.now;
      of(project).progress = { now: atEnd.now, from: same ? atStart!.progress!.done : null, to: atEnd.progress.done, total: atEnd.progress.total };
    }
    const state = src.registry.get(project)?.state;
    if (state === 'done' || state === 'archived') continue;
    const p = of(project);
    for (const item of atEnd.waiting) {
      if (item.due === null) { p.undated++; continue; }
      p.dated++;
      if (item.due < w.today) p.waiting.push({ text: item.text, due: item.due, when: 'late' });
      else if (item.due <= w.dueUntil) p.waiting.push({ text: item.text, due: item.due, when: 'after' });
    }
  }

  // Last touched as of a moment: facts (names folded), the row's own creation unless the migration made it, and
  // the Mac's last commit when its report is from this week or the day after.
  const touchedMap = (m: Map<string, string>, pick: (a: string, b: string) => string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of m) {
      const name = fold(k);
      const had = out.get(name);
      out.set(name, had === undefined ? v : pick(had, v));
    }
    return out;
  };
  const later = (a: string, b: string) => (a > b ? a : b);
  const earlier = (a: string, b: string) => (a < b ? a : b);
  const match = src.folders.match();
  const reportFits = match.receivedAt !== null && match.receivedAt >= start && Date.parse(match.receivedAt) < w.end.getTime() + REPORT_GRACE_MS;
  const registry = new Map(src.registry.list().map((p) => [p.name, p]));
  const touchedAt = (at: string): Map<string, string> => {
    const out = touchedMap(src.reviews.lastTouched(at), later);
    for (const p of registry.values()) {
      if (p.createdBy !== 'migration' && p.createdAt <= at) out.set(p.name, later(out.get(p.name) ?? '', p.createdAt));
    }
    if (reportFits) {
      for (const [name, f] of match.byProject) {
        if (!f.lastCommit) continue;
        const commit = new Date(f.lastCommit).toISOString();
        if (commit <= at) out.set(name, later(out.get(name) ?? '', commit));
      }
    }
    return out;
  };
  const atStart = touchedAt(start);
  const atEnd = touchedAt(end);
  const first = touchedMap(src.reviews.firstTouched(start, end), earlier);
  const quietLine = (iso: string) => new Date(Date.parse(iso) - QUIET_DAYS * DAY_MS).toISOString();

  for (const name of new Set([...atStart.keys(), ...registry.keys()])) {
    const before = atStart.get(name);
    if (before === undefined) continue;
    const row = registry.get(name);
    if (row?.state === 'idea' || finishedBy(row, end)) continue;
    const after = atEnd.get(name) ?? before;
    if (before > quietLine(start) && after <= quietLine(end)) {
      const r = roadmapAt(roadmaps, name, justBeforeEnd, fold);
      of(name).quiet = { lastTouched: after, next: r?.nextSteps[0] ?? r?.now ?? null };
    }
    const firstIn = first.get(name);
    if (firstIn !== undefined && Date.parse(firstIn) - Date.parse(before) >= QUIET_DAYS * DAY_MS) {
      of(name).back = { quietDays: Math.floor((Date.parse(firstIn) - Date.parse(before)) / DAY_MS) };
    }
  }

  // Chips and the growth signals, from the registry's latest state.
  let finished = 0;
  let started = 0;
  for (const p of registry.values()) {
    const chips: Chip[] = [];
    if (isNewIn(p, start, end)) { chips.push(p.state === 'idea' ? 'new-idea' : 'new-project'); started++; }
    if (stateSetIn(p, start, end)) {
      if (p.state === 'done') { chips.push('marked-done'); finished++; }
      else if (p.state === 'archived') { chips.push('archived'); finished++; }
      else if (p.state === 'parked') chips.push('parked');
    }
    if (chips.length > 0) of(p.name).chips = chips;
  }

  // Pages saved this week, each once per project.
  for (const s of src.reviews.pagesSaved(start, end)) {
    if (s.project === null) continue;
    const p = of(fold(s.project));
    if (!p.pages.includes(s.pageId)) p.pages.push(s.pageId);
  }

  // Work only on the Mac, from this week's report: the same rule as the project chip and "work is safe" (notPushed),
  // judged at the time of the report.
  if (reportFits) {
    for (const [name, f] of match.byProject) {
      if (!notPushed(f, new Date(match.receivedAt!))) continue;
      const count = f.unpushed ?? 0;
      of(name).notPushed = count > 0 ? { count, receivedAt: match.receivedAt! } : { count: 0, uncommitted: f.uncommitted ?? 0, receivedAt: match.receivedAt! };
    }
  }

  const decisions = src.memories.createdBetween(w.start, w.end).filter((m) => m.kind === 'decision' && !isStatus(m))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => m.id);

  let growth: ReviewBody['growth'] = null;
  if (src.growth) {
    const best = (kind: 'strength' | 'improve') => src.reviews.evidenceAdded(start, end).filter((e) => e.kind === kind)
      .sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest))[0]?.observationId ?? null;
    growth = { strength: best('strength'), improve: best('improve'), finished, started };
  }

  const digest = weeklyDigest(src.memories, { monday: w.monday, start: w.start, end: w.end }, { grants: src.grants(), waiting: 0 });
  const safety: SafetyFlag[] = digest.flags.flatMap((f): SafetyFlag[] => (f.kind === 'connected' ? [{ kind: 'connected', client: f.client, at: f.at }]
    : f.kind === 'deleted-by-ai' ? [{ kind: 'deleted-by-ai', by: f.by, at: f.at, memoryId: f.memory.id }]
      : f.kind === 'replaced-others' ? [{ kind: 'replaced-others', by: f.by, author: f.author, at: f.at, memoryId: f.memory.id }] : []));

  return {
    format: 1,
    monday: w.monday,
    projects: [...weeks.values()].filter((p) => hasAnything(p) || p.dated > 0 || p.undated > 0).sort((a, b) => a.project.localeCompare(b.project)),
    decisions,
    growth,
    digest: { totals: digest.totals, writers: digest.writers, lookupsSince: digest.lookupsSince },
    safety,
    quietFromFactsOnly: match.receivedAt !== null && !reportFits,
  };
}
