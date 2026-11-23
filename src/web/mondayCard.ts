/**
 * The Monday card: last week in one sentence and three numbers, at the top of Projects until Read it or Not now.
 * `weekCandidate` is the one decision of whether it shows (no numbers); the page draws `mondayCard` and `mondayNote`
 * words the same decision in one line for the desktop notification, so both always agree.
 */
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import { isRemoving } from '../desktop/removing.js';
import { t } from '../i18n/index.js';
import type { ReviewView } from '../review/present.js';
import type { AppDeps } from './app.js';
import { backupProblems } from './errorText.js';
import { lineSentenceOf, weekRange } from './reviewViews.js';

export interface MondayCard {
  monday: string;
  dates: string;
  text: string;
  /** Steps done last week, from the review. */
  done: number;
  /** Items waiting on the owner now: late or due within 3 days, over the open projects. */
  waiting: number;
  /** Open projects stuck now. */
  stuck: number;
  /** Projects whose "park it?" suggestion waits while the card already says they went quiet. */
  holdBackPark: Set<string>;
}
export interface WeekCandidate { monday: string; view: ReviewView }

/** The first backup problem, if any: the one banner on Projects, and a reason the Monday card waits. */
export function backupProblemOf(d: AppDeps): string | null {
  const backups = d.statusDir === undefined ? undefined : backupHealth(readBackupStatus(d.statusDir), d.now(), { offsite: !d.localMode, jobs: !d.localMode });
  return backups && !backups.ok ? backupProblems(backups)[0] ?? null : null;
}

/**
 * Last week's review, built here if it isn't stored yet (only previewed while the app is being removed), while neither
 * Read it nor Not now was pressed, the week had something in it and no backup warning shows. This is the whole visibility
 * decision. It is an optional nudge: a failed build is logged and the page renders without it (nothing was stored, so the
 * next load tries again).
 */
export function weekCandidate(d: AppDeps, backupProblem: string | null): WeekCandidate | null {
  if (backupProblem) return null;
  const monday = d.reviews.lastMonday();
  try {
    const stored = isRemoving() ? d.reviews.preview(monday, 'owner') : d.reviews.ensure(monday, 'owner');
    if (!stored || stored.openedAt !== null || stored.dismissedAt !== null) return null;
    const view = d.reviews.present(stored, 'last', { kind: 'owner' });
    return view.empty ? null : { monday, view };
  } catch (e) {
    console.error(`weekly review ${monday} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Projects whose "park it?" suggestion waits while the card already says they went quiet. */
export const holdBackParkOf = (c: WeekCandidate): Set<string> => new Set([...c.view.quiet.shown, ...c.view.quiet.folded].map((q) => q.project));

/** The card for a visible week. `counts`: the live numbers when the caller already has them (the home does); else worked out here. */
export function mondayCard(d: AppDeps, c: WeekCandidate, counts?: { waiting: number; stuck: number }): MondayCard | null {
  let live = counts;
  if (!live) {
    try {
      live = d.projects.healthCounts(d.now());
    } catch (e) {
      console.error(`Monday numbers failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  const { view } = c;
  return {
    monday: c.monday, dates: weekRange(c.monday), text: lineSentenceOf(view),
    done: view.sentenceFacts.steps.reduce((a, s) => a + s.n, 0), waiting: live.waiting, stuck: live.stuck,
    holdBackPark: holdBackParkOf(c),
  };
}

/** One line for the desktop notification, or null when the card would not show. */
export function mondayNote(d: AppDeps): { monday: string; text: string } | null {
  const c = weekCandidate(d, backupProblemOf(d));
  const card = c === null ? null : mondayCard(d, c);
  if (card === null) return null;
  return {
    monday: card.monday,
    text: t('projects.monday.note', {
      done: t('projects.monday.note.done', { count: card.done }), waiting: t('projects.monday.note.waiting', { count: card.waiting }), stuck: t('projects.monday.note.stuck', { count: card.stuck }),
    }),
  };
}
