import type { MemoryStore } from './store.js';
import type { Supersession } from './supersessions.js';
import type { HistoryEntry, Memory } from './types.js';

/** One line of a fact's History: an edit (with "Undo to this"), a replacement (Undo while live), or its undo. */
export type FactEvent =
  | { type: 'edit'; at: string; entry: HistoryEntry }
  | { type: 'replaced'; at: string; row: Supersession }
  | { type: 'brought-back'; at: string; row: Supersession };

/** A fact on the timeline of its chain: `replacedAt` when a live row replaced it, `current` for the end (not deleted). */
export interface ChainStep { memory: Memory; replacedAt: string | null; current: boolean; here: boolean }

/** Everything a fact's own page says about replacements (section 16), as plain data. */
export interface FactStory {
  /** What replaced it, and the end of its chain (`end` null when that fact is deleted); null while it is current. */
  replacedBy: { row: Supersession; end: Memory | null; endId: string; steps: number } | null;
  /** The facts it replaced directly: live rows, old fact not deleted, oldest first. */
  replaces: { row: Supersession; old: Memory }[];
  /** Every fact linked into the end of its chain, oldest first; empty when the fact stands alone. */
  chain: ChainStep[];
  /** Edits, replacements and undos, newest first. */
  events: FactEvent[];
}

export function factStory(store: MemoryStore, id: string): FactStory {
  const ss = store.supersessions;
  const live = ss.liveFor(id);
  const { endId, steps } = ss.chainEnd(id);
  const endMemory = store.get(endId);
  const end = endMemory && endMemory.deletedAt === null ? endMemory : null;
  const replacedBy = live ? { row: live, end, endId, steps } : null;
  const replaces = ss.liveBy(id)
    .map((row) => ({ row, old: store.get(row.oldId) }))
    .filter((r): r is { row: Supersession; old: Memory } => r.old !== undefined && r.old.deletedAt === null);
  const ids = ss.chain(id);
  const chain = ids.length < 2 ? [] : ids.map((mid) => store.get(mid)).filter((m): m is Memory => m !== undefined).map((m): ChainStep => ({
    memory: m, replacedAt: ss.liveFor(m.id)?.createdAt ?? null, current: m.id === endId && m.deletedAt === null, here: m.id === id,
  }));
  const events: FactEvent[] = [
    ...store.history(id).map((entry): FactEvent => ({ type: 'edit', at: entry.changedAt, entry })),
    ...ss.allFor(id).flatMap((row): FactEvent[] => [
      { type: 'replaced', at: row.createdAt, row },
      ...(row.undoneAt !== null ? [{ type: 'brought-back' as const, at: row.undoneAt, row }] : []),
    ]),
  ];
  // Newest first; at the same moment, the later write (a replacement after an edit, an undo after its row) first.
  const order = (e: FactEvent) => (e.type === 'edit' ? 0 : e.type === 'replaced' ? 1 : 2);
  events.sort((a, b) => b.at.localeCompare(a.at) || order(b) - order(a));
  return { replacedBy, replaces, chain, events };
}
