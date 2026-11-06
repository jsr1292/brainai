import { isStatus } from './brief.js';
import { cosine } from './embedder.js';
import type { MemoryStore } from './store.js';
import type { Memory } from './types.js';

/**
 * How closely a project's memories must match another project's to be offered as the same project. Calibrated with
 * multilingual-e5-small q8 on a real brain: one project split in two scored 0.907, related but separate projects 0.897
 * and 0.906 (accepted: one click on "Different projects"), all others 0.86 or less.
 */
export const SAME_PROJECT_FLOOR = 0.88;

export interface ProjectCount { project: string; count: number }
export interface Overlap { smaller: ProjectCount; larger: ProjectCount; similarity: number }
export interface TidySummary { duplicates: number; statuses: { project: string; old: number }[]; overlaps: number; stale: number; gone: number }

const pairs = <T>(xs: T[]): [T, T][] => xs.flatMap((x, i) => xs.slice(i + 1).map((y): [T, T] => [x, y]));

function statusesByProject(store: MemoryStore): Map<string, Memory[]> {
  const by = new Map<string, Memory[]>();
  for (const m of store.list({})) {
    if (m.project === null || !isStatus(m)) continue;
    by.set(m.project, [...(by.get(m.project) ?? []), m]);
  }
  return by;
}

/** Projects with more than one status, statuses newest first, unless the owner said they are all current. */
export function statusGroups(store: MemoryStore): { project: string; statuses: Memory[] }[] {
  return [...statusesByProject(store)]
    .filter(([, ms]) => pairs(ms).some(([a, b]) => !store.isDismissed(a.id, b.id)))
    .map(([project, statuses]) => ({ project, statuses }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

/** "All still current": the project's statuses stop showing until a new one is added. */
export function keepStatuses(store: MemoryStore, project: string): void {
  for (const [a, b] of pairs(statusesByProject(store).get(project) ?? [])) store.dismissPair(a.id, b.id);
}

/**
 * Pairs of projects that look like one project under two names: on average, each memory of the smaller project
 * has a very close match in the larger one.
 */
export function projectOverlaps(store: MemoryStore): Overlap[] {
  const projectOf = new Map(store.list({}).map((m) => [m.id, m.project]));
  const vectors = new Map<string, Float32Array[]>();
  for (const e of store.activeEmbeddings({})) {
    const p = projectOf.get(e.id);
    if (p) vectors.set(p, [...(vectors.get(p) ?? []), e.embedding]);
  }
  const found: Overlap[] = [];
  for (const [x, y] of pairs([...vectors.keys()].sort())) {
    if (store.isProjectPairDismissed(x, y)) continue;
    const [small, large] = vectors.get(x)!.length <= vectors.get(y)!.length ? [x, y] : [y, x];
    const others = vectors.get(large)!;
    const mine = vectors.get(small)!;
    const similarity = mine.reduce((s, v) => s + Math.max(...others.map((o) => cosine(v, o))), 0) / mine.length;
    if (similarity < SAME_PROJECT_FLOOR) continue;
    found.push({
      smaller: { project: small, count: mine.length },
      larger: { project: large, count: others.length },
      similarity: Math.min(similarity, 1),
    });
  }
  return found.sort((a, b) => b.similarity - a.similarity);
}
