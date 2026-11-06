import type { MemoryStore } from './store.js';
import type { Memory } from './types.js';

/** A briefing stays readable in one tool result; older decisions are still reachable through recall. */
export const MAX_DECISIONS = 40;
export const MAX_STATUSES = 5;
/** Kept even in a long project: the oldest decisions are usually the ones the project was founded on. */
export const FOUNDING_DECISIONS = 5;

/** AIs save a project's status either as a summary or as a memory tagged "status"; both count. */
/** A profile fact is never a status, whatever its tags: read-only connections see statuses, never the profile (audit F01). */
export const isStatus = (m: Memory): boolean => m.kind === 'summary' || (m.kind !== 'roadmap' && m.kind !== 'profile' && m.tags.includes('status'));

export interface Brief {
  project: string;
  /** What is left (one per project), or null when the project has none yet. */
  roadmap: Memory | null;
  /** Newest first: the first one is the latest word on the project. */
  statuses: Memory[];
  /** Oldest first, so the AI reads how the project got where it is. */
  decisions: Memory[];
  /** Statuses and decisions left out to keep the briefing short (the oldest statuses, the middle decisions). */
  omitted: number;
}

/** Everything active in one project, or undefined when it has no active memories. */
export function projectBrief(store: MemoryStore, project: string): Brief | undefined {
  const memories = store.list({ project });
  if (memories.length === 0) return undefined;
  const statuses = memories.filter(isStatus);
  const decisions = memories.filter((m) => m.kind === 'decision' && !isStatus(m))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const keptStatuses = statuses.slice(0, MAX_STATUSES);
  const keptDecisions = decisions.length <= MAX_DECISIONS
    ? decisions
    : [...decisions.slice(0, FOUNDING_DECISIONS), ...decisions.slice(-(MAX_DECISIONS - FOUNDING_DECISIONS))];
  return {
    project,
    roadmap: memories.find((m) => m.kind === 'roadmap') ?? null,
    statuses: keptStatuses,
    decisions: keptDecisions,
    omitted: statuses.length - keptStatuses.length + decisions.length - keptDecisions.length,
  };
}
