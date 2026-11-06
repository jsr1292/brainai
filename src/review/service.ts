import { performance } from 'node:perf_hooks';
import type { Clock } from '../clock.js';
import type { GrowthService } from '../growth/service.js';
import { shiftWeek, weekContaining, weekOf } from '../memory/digest.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { TidySummary } from '../memory/tidy.js';
import type { FolderSource } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { buildReview, liveWindow, windowFor, type BuildSources } from './build.js';
import { presentReview, type ReviewKind, type ReviewView, type Scope } from './present.js';
import type { ReviewStore } from './store.js';
import type { ReviewBody, StoredReview } from './types.js';

export interface ReviewDeps {
  store: ReviewStore;
  memories: MemoryStore;
  service: MemoryService;
  registry: ProjectStore;
  folders: FolderSource;
  pages: { get(id: string): { deletedAt: string | null } | undefined };
  /** Null in work mode, which has no Growth. */
  growth: GrowthService | null;
  grants: () => { clientName: string; createdAt: string }[];
  tidy?: () => TidySummary;
}

/** Where a date's review is: a stored week (redirect when the date wasn't its Monday), this week so far, or nowhere. */
export type Located = { to: 'week'; monday: string; redirect: boolean } | { to: 'now'; redirect: boolean } | { to: 'none' };

/** All weeks builds at most this many missing weeks per request; the rest are built on later visits or when opened. */
export const MAX_BUILDS_PER_LIST = 12;

/**
 * Weekly reviews: which week is which, each finished week built once on the first request that needs it, and the
 * owner's two marks. Nothing here runs in the background, and reading never marks anything.
 */
export class ReviewService {
  constructor(private deps: ReviewDeps, private now: Clock, private log: (line: string) => void = console.log) {}

  private sources(): BuildSources {
    const d = this.deps;
    return { reviews: d.store, memories: d.memories, registry: d.registry, folders: d.folders, grants: d.grants, growth: d.growth !== null };
  }

  /** The Monday of the last finished week. */
  lastMonday(): string {
    return shiftWeek(weekOf(this.now()).monday, -1);
  }

  /** The week holding the first memory, or null in an empty brain. */
  earliestMonday(): string | null {
    const first = this.deps.store.earliestMemory();
    return first === null ? null : weekOf(new Date(first)).monday;
  }

  locate(date: string): Located {
    const week = weekContaining(date);
    if (!week) return { to: 'none' };
    const current = weekOf(this.now()).monday;
    if (week.monday === current) return { to: 'now', redirect: true };
    const earliest = this.earliestMonday();
    if (week.monday > current || earliest === null || week.monday < earliest) return { to: 'none' };
    return { to: 'week', monday: week.monday, redirect: date !== week.monday };
  }

  /** The stored week, built now if it isn't yet (one transaction: a failed build stores nothing). */
  ensure(monday: string, by: string): StoredReview | undefined {
    const earliest = this.earliestMonday();
    const week = weekContaining(monday);
    if (!week || week.monday !== monday || earliest === null || monday < earliest || monday > this.lastMonday()) return undefined;
    const stored = this.deps.store.get(monday);
    if (stored) return stored;
    const started = performance.now();
    this.deps.store.atomic(() => {
      const body = buildReview(this.sources(), windowFor(monday));
      if (this.deps.tidy && monday === this.lastMonday()) body.tidy = null;
      this.deps.store.insert({ monday, body, builtAt: this.now().toISOString(), builtBy: by });
    });
    this.log(`weekly review ${monday} built in ${Math.round(performance.now() - started)} ms`);
    return this.deps.store.get(monday);
  }

  /** Fill last week's pending summary on the owner's visit, with slow checks outside the write transaction. */
  withTidy(r: StoredReview): StoredReview {
    if (r.monday !== this.lastMonday() || r.body.tidy !== null || !this.deps.tidy) return r;
    const summary = this.deps.tidy();
    this.deps.store.setTidy(r.monday, summary);
    return this.deps.store.get(r.monday)!;
  }

  /** This week so far: built on every call, never stored. */
  soFar(): { monday: string; body: ReviewBody; builtAt: string } {
    const now = this.now();
    const w = liveWindow(now);
    return { monday: w.monday, body: buildReview(this.sources(), w), builtAt: now.toISOString() };
  }

  /** Every week from last week back to the first, newest first, building at most MAX_BUILDS_PER_LIST missing ones. */
  all(by: string): { monday: string; review: StoredReview | undefined }[] {
    const earliest = this.earliestMonday();
    if (earliest === null) return [];
    const out: { monday: string; review: StoredReview | undefined }[] = [];
    let builds = 0;
    for (let monday = this.lastMonday(); monday >= earliest; monday = shiftWeek(monday, -1)) {
      let review = this.deps.store.get(monday);
      if (!review && builds < MAX_BUILDS_PER_LIST) {
        review = this.ensure(monday, by);
        builds++;
      }
      out.push({ monday, review });
    }
    return out;
  }

  /** Read it. */
  open(monday: string): boolean {
    return this.deps.store.markOpened(monday, this.now().toISOString());
  }

  /** Not now. */
  dismiss(monday: string): boolean {
    return this.deps.store.markDismissed(monday, this.now().toISOString());
  }

  present(r: { monday: string; body: ReviewBody; builtAt: string }, kind: ReviewKind, scope: Scope): ReviewView {
    const d = this.deps;
    return presentReview(r, kind, scope, {
      registry: d.registry, service: d.service, memories: d.memories, pages: d.pages, growth: d.growth, reviews: d.store, now: this.now(),
    });
  }
}
