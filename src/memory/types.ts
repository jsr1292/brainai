export type Kind = 'profile' | 'decision' | 'summary' | 'roadmap';
export const KINDS: readonly Kind[] = ['profile', 'decision', 'summary', 'roadmap'];

/** A2: where a fact came from. Older facts have none. */
export const SOURCES = ['owner_said', 'inferred', 'imported', 'from_file'] as const;
export type Source = (typeof SOURCES)[number];

/** A1 and A2: the optional fields a fact may carry; null when not set. Never embedded, never in the keyword index. */
export interface FactMeta { validUntil: string | null; source: Source | null; sourceNote: string | null; sourceBy: string | null }

export type Actor = { type: 'ai'; name: string } | { type: 'owner' };

/** How the owner appears in the audit trail; no AI client may use it as its name. */
export const OWNER_LABEL = 'owner';

export function actorLabel(a: Actor): string {
  return a.type === 'owner' ? OWNER_LABEL : a.name;
}

/** Names that read as the owner: the audit-trail label, and the words the views use for the owner ("You", "you"). */
const OWNER_NAMES = new Set([OWNER_LABEL, 'you', 'yourself', 'me']);

/**
 * True when a client name would read as the owner in the audit trail or the views: compared case-insensitively, after
 * Unicode normalisation and with spaces and invisible characters (zero-width, format, control) removed.
 */
export function posesAsOwner(name: unknown): boolean {
  return typeof name === 'string' && OWNER_NAMES.has(name.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Z}\s]/gu, '').toLowerCase());
}

/** The name of BrainAI's own built-in voice (the skills it ships): no connection, device or grant may carry it. */
export const BRAINAI_NAME = 'BrainAI';

/** True when a name would read as BrainAI itself: trimmed, case-insensitive, spaces and invisible characters ignored. */
export function posesAsBrainAI(name: unknown): boolean {
  return typeof name === 'string' && name.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Z}\s]/gu, '').toLowerCase() === BRAINAI_NAME.toLowerCase();
}

export interface Memory {
  id: string;
  kind: Kind;
  content: string;
  project: string | null;
  tags: string[];
  /** B9: search words recall matches but results never show ('' for none). */
  keys: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastRecalledAt: string | null;
  deletedAt: string | null;
  /** "<page> › <section>" when this fact was retired because its decision moved onto a page; null otherwise. */
  movedTo?: string | null;
  /** A1: YYYY-MM-DD the fact stops being true; null for none. */
  validUntil?: string | null;
  /** A2; sourceBy is who set the source: 'owner', or the assistant's app name as updatedBy records it. */
  source?: Source | null;
  sourceNote?: string | null;
  sourceBy?: string | null;
}

export interface HistoryEntry {
  id: number;
  memoryId: string;
  action: 'update' | 'delete' | 'restore';
  content: string;
  project: string | null;
  tags: string[];
  changedAt: string;
  changedBy: string;
  /** The fact's A1/A2 fields in this version (null for none, and for versions saved before they existed). */
  validUntil?: string | null;
  source?: Source | null;
  sourceNote?: string | null;
  sourceBy?: string | null;
}

export interface Suggestion {
  id: string;
  action: 'add' | 'update' | 'delete';
  memoryId: string | null;
  content: string | null;
  tags: string[];
  /** The kind and project the memory is saved under on approval ('profile' and null for profile changes). */
  kind: Kind;
  project: string | null;
  /** Why a non-profile memory was held, e.g. 'asks to ignore instructions'; null for profile changes. */
  reason: string | null;
  suggestedAt: string;
  suggestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  /** For a held 'add' or 'update': the ids of older facts it replaces once approved (section 16); [] otherwise. */
  supersedes: string[];
  /** Forgetting that sticks (§17a): the fact the owner deleted that this save is close to; null otherwise. */
  deletedMatch: string | null;
  /** B9: the search words the save carries; null keeps the fact's own (an update that gave none). */
  keys: string | null;
  /** A held save's A1/A2 fields: null = none given; '' = clear (an update). */
  validUntil?: string | null;
  source?: Source | "" | null;
  sourceNote?: string | null;
  /** Who gave the source (the assistant that held the save); null when none was given. */
  sourceBy?: string | null;
  /** B1: set when an assistant harvested this from a session (suggest_memories): the call's id and the session label. */
  harvest?: { batch: string; label: string } | null;
  /** B1: the existing fact a harvested near-duplicate is close to (shown on its card); null otherwise. */
  similarId?: string | null;
}
