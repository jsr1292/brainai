/*
 * B9: recall's default answer to an assistant is up to 12 facts, but never more text than an assistant can use well:
 * the facts stop when their text would pass the budget (from Hindsight's token-budget packing), never below `min`.
 */

/** The rows in order while their running size stays within `budget`; always the first `min` (or all there are). */
export function packByBudget<T>(rows: T[], size: (row: T) => number, opts: { budget: number; min: number }): T[] {
  let total = 0;
  let n = 0;
  for (const row of rows) {
    total += size(row);
    if (total > opts.budget && n >= opts.min) break;
    n += 1;
  }
  return rows.slice(0, n);
}

/*
 * project_brief: the whole text returned (sentence, envelope and data) stays within BRIEF_BUDGET characters, so a
 * client can show it inline.
 *
 * Priority, highest first (lower parts give way first when the text does not fit):
 *   1. the floor, always in full whatever its size: the roadmap, the latest status, the newest 3 decisions and the first
 *      BRIEF_FLOOR_NOTES open owner notes (they ask the assistant to act, so they never give way to older history);
 *   2. one-line excerpts of the other statuses and decisions (80 characters when 160 do not fit; then the older
 *      decisions are left out, counted, oldest non-founding first, the founding ones last);
 *   3. open notes, other projects' handbook topics, then pages (a share of the budget, most relevant first, the rest counted with a pointer);
 *   4. more decisions in full (newest first), then the founding decisions, then the other statuses in full;
 *   5. any further notes and pages that still fit.
 */
export const BRIEF_BUDGET = 16_000;
/** An open owner note on a page asks the assistant to act, so it is kept, but each note's text is cut to this. */
export const BRIEF_NOTE_MAX = 300;
/** This many open owner notes are part of the floor (each cut to BRIEF_NOTE_MAX); any more are listed if they fit. */
export const BRIEF_FLOOR_NOTES = 5;
/** The notes and pages shown before the decisions and statuses are upgraded to full text: at most this many characters. */
export const BRIEF_PAGES_SHARE = 3_000;

/** One-line excerpts in a brief: this many characters, down to the shorter one when even the excerpts do not fit. */
export const BRIEF_EXCERPT = 160;
export const BRIEF_EXCERPT_SHORT = 80;
/** The newest decisions are shown in full before older ones get excerpts: at least this many when there are that many. */
export const BRIEF_MIN_FULL_DECISIONS = 3;

/**
 * What the brief shows in full; everything else is a one-line excerpt. Index 0 of statuses (the latest) is always full.
 * `dropped`: decision indexes not listed at all (only counted) when even short excerpts do not fit.
 * `pages`, `notes`, `topics`: how many of the (relevance-sorted) pages, open notes and other projects' handbook topics
 * are listed; the rest are only counted.
 */
export interface BriefFit { fullStatuses: Set<number>; fullDecisions: Set<number>; excerptLen: number; dropped: Set<number>; pages: number; notes: number; topics: number }

/**
 * Starts with the floor (see the priority above) and everything else as excerpts, then upgrades while the rendered
 * text still fits `limit`. `decisions` is oldest first, as shown; the first `founding` of them are the ones the brief
 * keeps from the project's start. `render` returns the final text for a state, so the measure is exactly what is sent.
 * Upgrading stops at the first one that does not fit, so the full decisions are always the newest.
 * `everything`: the owner asked for all decisions: every decision and status is full, and only the pages and notes are
 * limited (to the share).
 */
export function fitBrief(opts: {
  limit: number; statuses: number; decisions: number; founding: number; pages: number; notes: number; topics: number; everything?: boolean;
  render: (fit: BriefFit) => string;
}): BriefFit {
  const n = opts.decisions;
  const want = Math.min(BRIEF_MIN_FULL_DECISIONS, n);
  const fit: BriefFit = { fullStatuses: new Set(opts.statuses > 0 ? [0] : []), fullDecisions: new Set(), excerptLen: BRIEF_EXCERPT, dropped: new Set(), pages: 0, notes: Math.min(BRIEF_FLOOR_NOTES, opts.notes), topics: 0 };
  const len = () => opts.render(fit).length;
  const fits = () => opts.everything === true || len() <= opts.limit;
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const newestWant = range(n - want, n).reverse();
  // Left out first: the oldest decisions after the founding ones, then the founding ones; never the newest few.
  const droppable = [...range(opts.founding, n - want), ...range(0, Math.min(opts.founding, n - want))];
  const setDropped = (k: number) => { fit.dropped = new Set(droppable.slice(0, k)); };
  const tryWant = () => { fit.fullDecisions = new Set(newestWant); const ok = fits(); if (!ok) fit.fullDecisions = new Set(); return ok; };
  if (opts.everything === true) {
    fit.fullDecisions = new Set(range(0, n));
    fit.fullStatuses = new Set(range(0, opts.statuses));
  } else if (!tryWant()) {
    fit.excerptLen = BRIEF_EXCERPT_SHORT;
    let k = 0;
    while (!tryWant() && k < droppable.length) { k += 1; setDropped(k); }
    // Even the floor alone is over the limit: it stays anyway.
    if (fit.fullDecisions.size === 0) fit.fullDecisions = new Set(newestWant);
  }
  const base = len();
  const grow = (key: 'notes' | 'pages' | 'topics', total: number, share?: number) => {
    while (fit[key] < total) {
      fit[key] += 1;
      if (!fits() || (share !== undefined && len() - base > share)) { fit[key] -= 1; return; }
    }
  };
  grow('notes', opts.notes, BRIEF_PAGES_SHARE);
  grow('topics', opts.topics, BRIEF_PAGES_SHARE);
  grow('pages', opts.pages, BRIEF_PAGES_SHARE);
  if (opts.everything === true) return fit;
  const upgrade = (set: Set<number>, order: number[]) => {
    for (const i of order.filter((j) => !set.has(j))) {
      set.add(i);
      if (!fits()) { set.delete(i); return; }
    }
  };
  upgrade(fit.fullDecisions, range(0, n).reverse().filter((i) => !fit.dropped.has(i)));
  upgrade(fit.fullDecisions, range(0, opts.founding).filter((i) => !fit.dropped.has(i)));
  upgrade(fit.fullStatuses, range(1, opts.statuses));
  grow('notes', opts.notes);
  grow('topics', opts.topics);
  grow('pages', opts.pages);
  return fit;
}
