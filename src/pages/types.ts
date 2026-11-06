import { AREA_LABELS, AREAS } from '../projects/types.js';

/** A page without a project sits in one of these; a project's page follows its project's area. */
export const PAGE_AREAS = ['start', ...AREAS] as const;
export type PageArea = (typeof PAGE_AREAS)[number];
export const PAGE_AREA_LABELS: Record<PageArea, string> = { start: 'Start here', ...AREA_LABELS };

/** Longest title, in characters (one line). */
export const MAX_TITLE = 140;
/** Longest page body, in characters of Markdown. */
export const MAX_BODY = 100_000;
/** How much of a section is embedded: its title, heading and the start of its text. */
export const EMBED_CHARS = 2000;

/** How a page was last brought up to date: the newer decisions and changed facts that flag a page count from then. */
export const CAUGHT_UP_HOWS = ['created', 'saved', 'key_decisions', 'still_true', 'restored', 'imported', 'migrated'] as const;
export type CaughtUpHow = (typeof CAUGHT_UP_HOWS)[number];
/** When, how and by whom ('owner' or the assistant's name) a page was last brought up to date. */
export interface CaughtUp { at: string; how: CaughtUpHow; by: string }

export interface Page {
  id: string;
  title: string;
  project: string | null;
  /** Only for a page without a project; a project's page is shown under its project's area. */
  area: PageArea | null;
  body: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt: string | null;
  caughtUp: CaughtUp;
}

/** A page without its body: enough to list, count, filter or link to it. */
export type PageHeader = Omit<Page, 'body'>;

/** A page as it was saved at one version (every version is kept, the current one included). */
export interface PageVersion {
  pageId: string;
  version: number;
  title: string;
  project: string | null;
  area: PageArea | null;
  body: string;
  savedAt: string;
  savedBy: string;
  /** The page's caught-up time as of this version; null for versions saved before migration 23. */
  caughtUpAt: string | null;
}

export class PageError extends Error {
  constructor(public code: 'invalid' | 'not_found' | 'conflict' | 'secret', message: string) {
    super(message);
    this.name = 'PageError';
  }
}
