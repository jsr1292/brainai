import { projectOverlaps, statusGroups, type TidySummary } from '../memory/tidy.js';
import type { AppDeps } from './app.js';
import type { TidyItems } from './dashboardViews.js';
import { memoByKey } from './memo.js';

/** One lazy set of Tidy checks, shared by the list and summary renderers. */
export function makeTidyItems(d: Pick<AppDeps, 'store' | 'service' | 'now'>): () => TidyItems {
  // The pair checks and the map compare every pair of memories (seconds of CPU at a few thousand, with every other
  // request waiting), so they are recomputed only when the memories changed: not on a recall, which nearly every
  // assistant session makes. The cheap stale list also follows recalls and the date.
  const pairChecks = memoByKey(() => d.store.memoryVersion(), () => ({
    duplicates: d.service.duplicates(), overlaps: projectOverlaps(d.store), statuses: statusGroups(d.store),
  }));
  const staleList = memoByKey(
    () => `${d.store.memoryVersion()}|${d.store.recallVersion()}|${d.now().toISOString().slice(0, 10)}`,
    () => d.service.stale(d.now()),
  );
  return (): TidyItems => {
    const checks = pairChecks();
    return {
      ...checks,
      // Worked out on each view (the cached pair checks stay as they are): cheap, and they follow the latest names.
      duplicates: checks.duplicates.map((x) => ({ ...x, replaceable: d.service.canReplacePair(x.a, x.b) })),
      stale: staleList(),
      gone: d.store.supersessions.gone().map((row) => ({
        row, old: d.store.get(row.oldId)!, newer: d.store.get(row.newId)!,
        deletion: d.store.history(row.newId).find((h) => h.action === 'delete'),
      })),
    };
  };
}

export function tidySummary(v: TidyItems): TidySummary {
  return {
    duplicates: v.duplicates.length,
    statuses: v.statuses.map(({ project, statuses }) => ({ project, old: statuses.length - 1 })),
    overlaps: v.overlaps.length,
    stale: v.stale.length,
    gone: v.gone?.length ?? 0,
  };
}

/** A plain sentence fragment; the caller supplies the full stop and link. */
export function tidySentence(s: TidySummary): string | null {
  const parts: string[] = [];
  if (s.duplicates) parts.push(s.duplicates === 1 ? '2 facts look like duplicates' : `${s.duplicates} pairs of facts look like duplicates`);
  if (s.statuses.length === 1) {
    const { project, old } = s.statuses[0]!;
    parts.push(`${project} has ${old} old ${old === 1 ? 'status' : 'statuses'}`);
  } else if (s.statuses.length) parts.push(`${s.statuses.length} projects have old statuses`);
  // Overlaps count pairs, as duplicates do.
  if (s.overlaps) parts.push(s.overlaps === 1 ? '2 project names look alike' : `${s.overlaps} pairs of project names look alike`);
  if (s.stale) parts.push(s.stale === 1 ? "1 fact hasn't been touched in six months" : `${s.stale} facts haven't been touched in six months`);
  if (s.gone) parts.push(s.gone === 1 ? '1 replaced fact lost its replacement' : `${s.gone} replaced facts lost their replacement`);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
