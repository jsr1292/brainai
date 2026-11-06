import type { HistoryEntry, Memory } from '../memory/types.js';

/** One stretch of a memory's life: what it said, under which project, from one moment until the next change. */
export interface Version { content: string; project: string | null; live: boolean; from: string; to: string | null }

/**
 * A memory's versions, oldest first, from its history (oldest first). A history row holds what the memory said
 * before the change at its changed_at, so version k ends at row k. A version that starts right after a delete is not
 * live; the last version is the current text, live while the memory isn't deleted.
 */
export function versionsOf(m: Memory, history: HistoryEntry[]): Version[] {
  const out: Version[] = [];
  let from = m.createdAt;
  let live = true;
  for (const h of history) {
    out.push({ content: h.content, project: h.project, live, from, to: h.changedAt });
    from = h.changedAt;
    live = h.action !== 'delete';
  }
  out.push({ content: m.content, project: m.project, live: m.deletedAt === null, from, to: null });
  return out;
}

/** The live version at a moment: from <= at < to. */
export const versionAt = (vs: Version[], at: string): Version | undefined =>
  vs.find((v) => v.live && v.from <= at && (v.to === null || at < v.to));

/** The live versions that overlap [start, end). */
export const liveDuring = (vs: Version[], start: string, end: string): Version[] =>
  vs.filter((v) => v.live && v.from < end && (v.to === null || v.to > start));
