import type { Tally, WriterTally } from '../memory/digest.js';
import type { TidySummary } from '../memory/tidy.js';

/** The shape of a stored body. The renderer reads every format it has known; a new one never drops old rows. */
export const REVIEW_FORMAT = 1;
export const KNOWN_FORMATS: readonly number[] = [1];

export type Chip = 'new-idea' | 'new-project' | 'marked-done' | 'parked' | 'archived';
export const CHIP_ORDER: readonly Chip[] = ['new-idea', 'new-project', 'marked-done', 'parked', 'archived'];

/** One project's week, as facts: the wording is made when shown, after filtering. */
export interface ProjectWeek {
  /** The name at build time. */
  project: string;
  /** Done steps dated inside the week, in date order. */
  done: { text: string; date: string }[];
  progress: { now: string; from: number | null; to: number; total: number } | null;
  /** Page ids saved this week. */
  pages: string[];
  chips: Chip[];
  waiting: { text: string; due: string; when: 'late' | 'after' }[];
  /** Every dated waiting item, for "Nothing is late.". */
  dated: number;
  undated: number;
  quiet: { lastTouched: string; next: string | null } | null;
  back: { quietDays: number } | null;
  /** Commits only on the Mac (count), or when there are none, uncommitted changes older than a day (uncommitted files). */
  notPushed: { count: number; uncommitted?: number; receivedAt: string } | null;
}

/** 'replaced-others' came with section 16 (the union only grows, so REVIEW_FORMAT stays 1); weeks built before it rightly have none. */
export type SafetyFlag =
  | { kind: 'connected'; client: string; at: string }
  | { kind: 'deleted-by-ai'; by: string; at: string; memoryId: string }
  | { kind: 'replaced-others'; by: string; author: string; at: string; memoryId: string };

export interface ReviewBody {
  format: 1;
  monday: string;
  projects: ProjectWeek[];
  /** Memory ids, newest first. */
  decisions: string[];
  /** Null in work mode. */
  growth: { strength: string | null; improve: string | null; finished: number; started: number } | null;
  digest: { totals: Tally; writers: WriterTally[]; lookupsSince: string | null };
  safety: SafetyFlag[];
  /** A folder report exists but is not from this week, so quiet comes from saved facts only. */
  quietFromFactsOnly: boolean;
  /** Null while last week's summary awaits the owner's visit; absent on older or legacy weeks. */
  tidy?: TidySummary | null;
}

export interface StoredReview {
  monday: string; format: number; body: ReviewBody; builtAt: string; builtBy: string; openedAt: string | null; dismissedAt: string | null;
}

/** The moments a week is read between; `today` is the day "late" is measured against, `dueUntil` the last "due after" day. */
export interface ReviewWindow { monday: string; start: Date; end: Date; today: string; dueUntil: string; live: boolean }
