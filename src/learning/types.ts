/*
 * The five areas every project is checked against while the owner learns to work like a developer (spec
 * docs/superpowers/specs/2026-11-11-learning-layer-and-projects-page-design.md). CHECK_AREAS is also the order in
 * which they are brought up: work is safe first, then a clear finish line, then automation, alerts and upkeep.
 */
export const CHECK_AREAS = ['safe', 'finish', 'auto', 'alerts', 'upkeep'] as const;
export type CheckArea = (typeof CHECK_AREAS)[number];

/** done (green), look ("worth a look", amber), todo ("not started", grey), not_needed (a dash, always with a reason). */
export const CHECK_STATUSES = ['done', 'look', 'todo', 'not_needed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** What is shown: a stored or computed status, or unknown (work is safe with no folder report and no hand status). */
export type ShownStatus = CheckStatus | 'unknown';

export const CHECK_LABELS: Record<CheckArea, { name: string; term: string; why: string }> = {
  safe: {
    name: 'Work is safe', term: 'version control, remote backup',
    why: 'Everything you changed is saved as a commit and pushed to a second place, so a lost or broken Mac loses nothing.',
  },
  finish: {
    name: 'Clear finish line', term: 'scope, definition of done',
    why: "The current phase has a stated 'done', so you know when to stop polishing and move on.",
  },
  auto: {
    name: 'Runs by itself', term: 'CI/CD, automation',
    why: 'Tests (and for apps, the build or deploy) run by themselves on every change, so mistakes are caught before they reach you.',
  },
  alerts: {
    name: "You'd know if it broke", term: 'monitoring, alerts, tested restores',
    why: 'Something tells you when it is down, and a restore from backup has been tried once, so you find problems before others do.',
  },
  upkeep: {
    name: 'Kept up to date', term: 'dependency and image maintenance',
    why: "Libraries and images get updated on a routine, so known security holes don't sit there for months.",
  },
};

export const STATUS_LABELS: Record<ShownStatus, string> = {
  done: 'done', look: 'worth a look', todo: 'not started', not_needed: 'not needed', unknown: 'unknown',
};

export interface AreaState {
  area: CheckArea;
  status: ShownStatus;
  note: string | null;
  /** For upkeep: the routine runs by itself (Dependabot, a scheduled job), so it never goes stale. */
  automatic: boolean;
  setBy: string | null;
  setAt: string | null;
  /** report: computed from the Mac's folder report (work is safe); hand: set by an assistant or the owner. */
  source: 'report' | 'hand' | 'none';
  snoozedUntil: string | null;
}

export const LESSON_LEVELS = ['seen', 'helped', 'alone'] as const;
export type LessonLevel = (typeof LESSON_LEVELS)[number];

/** One topic of the owner's handbook: what they learned, how well, its page, and the projects it was applied on. */
export interface HandbookTopic { slug: string; title: string; level: LessonLevel; pageId: string | null; projects: string[]; updatedAt: string }

export const MAX_NOTE = 300;
export const MAX_TOPIC = 80;
/** "Not now" holds this long for a project's area. */
export const SNOOZE_DAYS = 14;
/** Upkeep set by hand reads as worth a look again after this long, unless the routine is automatic. */
export const UPKEEP_DAYS = 90;
