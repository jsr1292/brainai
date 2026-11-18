import { createHash } from 'node:crypto';
import { cosine } from './embedder.js';
import { replaceableKind, type Replaceable } from './supersessions.js';
import type { Memory } from './types.js';

/**
 * B2: the cheap, deterministic half of an assistant-run tidy session. For one project, the current decisions and
 * statuses (never a roadmap or profile fact) are grouped by closeness in meaning, so an assistant the owner started
 * can look at a few facts at a time. Pure: the caller supplies the facts, their vectors and the cut-offs.
 *
 * Cut-offs (the embedding profile, src/memory/embeddingProfile.ts):
 * - facts are "related" at or above profile.related (e5 0.88, Gemma 0.46). That is the profile's own "related" value,
 *   calibrated as the top ~8% of page × decision pairs; closeFacts (0.86 / 0.48) is looser: it put 54% of
 *   same-project, same-kind pairs in its band, which would make one giant group of a busy project.
 * - at or above profile.duplicate (0.93 / 0.78) a pair is a near-duplicate; related but below it, with different
 *   dates, a likely conflict.
 */
export const MAX_CLUSTER = 8;

export type ClusterWhy = 'old_statuses' | 'duplicates' | 'conflict' | 'related';
const WHY_ORDER: ClusterWhy[] = ['old_statuses', 'duplicates', 'conflict', 'related'];

export interface ClusterFact { memory: Memory; embedding: Float32Array }
export interface TidyCluster {
  /** Stable for the same facts: a hash of the sorted ids. */
  id: string;
  project: string;
  why: ClusterWhy;
  /** Plain-language reason, for the assistant and the owner. */
  because: string;
  /** Fact ids: for old_statuses the newest status first, else oldest first. */
  ids: string[];
  /** Only for old_statuses: the status that is the current one. */
  newestStatusId?: string;
}

const day = (m: Memory): string => m.createdAt.slice(0, 10);
const clusterId = (ids: string[]): string => `c${createHash('sha1').update([...ids].sort().join('|')).digest('hex').slice(0, 10)}`;

export interface ClusterOptions {
  project: string;
  related: number;
  duplicate: number;
  /** Facts left out entirely (waiting in a proposal). */
  excluded: (m: Memory) => boolean;
  /** Facts the owner already looked at and that did not change since: a group made only of these is not offered. */
  looked: (m: Memory) => boolean;
  /** The owner said these two statuses are all still current. */
  dismissed: (a: Memory, b: Memory) => boolean;
}

export function buildClusters(all: ClusterFact[], o: ClusterOptions): { clusters: TidyCluster[]; total: number } {
  const facts = all
    .filter((f) => (f.memory.kind === 'decision' || f.memory.kind === 'summary') && replaceableKind(f.memory) !== null)
    .sort((a, b) => a.memory.id.localeCompare(b.memory.id));
  const out: TidyCluster[] = [];
  const claimed = new Set<string>();

  // Old statuses: more than the newest one. The newest stays out of the old ones' way (it is the keeper).
  const statuses = facts.filter((f) => replaceableKind(f.memory) === 'status')
    .sort((a, b) => b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const newest = statuses[0]?.memory;
  if (newest) {
    const olds = statuses.slice(1).map((f) => f.memory)
      .filter((m) => !o.excluded(m) && !o.dismissed(newest, m))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    for (let i = 0; i < olds.length; i += MAX_CLUSTER - 1) {
      const chunk = olds.slice(i, i + MAX_CLUSTER - 1);
      for (const m of chunk) claimed.add(m.id);
      if (chunk.every(o.looked)) continue;
      const ids = [newest.id, ...chunk.map((m) => m.id)];
      out.push({
        id: clusterId(ids), project: o.project, why: 'old_statuses', ids, newestStatusId: newest.id,
        because: `${chunk.length} older ${chunk.length === 1 ? 'status' : 'statuses'} besides the newest (${newest.id}, ${day(newest)}): only the newest says where the project stands now.`,
      });
    }
  }

  // Meaning: decisions with decisions, statuses with statuses, closeness at or above the profile's related cut-off.
  for (const cls of ['decision', 'status'] as Replaceable[]) {
    const pool = facts.filter((f) => replaceableKind(f.memory) === cls && !claimed.has(f.memory.id) && !o.excluded(f.memory));
    const n = pool.length;
    const sim = new Map<string, number>();
    const adj: Map<number, { j: number; s: number }[]> = new Map();
    const parent = pool.map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = cosine(pool[i]!.embedding, pool[j]!.embedding);
        if (s < o.related) continue;
        sim.set(`${i}:${j}`, s);
        (adj.get(i) ?? adj.set(i, []).get(i)!).push({ j, s });
        (adj.get(j) ?? adj.set(j, []).get(j)!).push({ j: i, s });
        parent[find(i)] = find(j);
      }
    }
    const comps = new Map<number, number[]>();
    for (let i = 0; i < n; i++) if (adj.has(i)) comps.set(find(i), [...(comps.get(find(i)) ?? []), i]);
    const groups: number[][] = [];
    for (const members of [...comps.values()].sort((a, b) => a[0]! - b[0]!)) {
      if (members.length <= MAX_CLUSTER) { groups.push(members); continue; }
      // Too big: seeds in order of most links, each taking its closest unassigned neighbours up to the cap.
      const left = new Set(members);
      const byLinks = [...members].sort((a, b) => adj.get(b)!.length - adj.get(a)!.length || a - b);
      for (const seed of byLinks) {
        if (!left.has(seed)) continue;
        const near = (adj.get(seed) ?? []).filter((e) => left.has(e.j)).sort((a, b) => b.s - a.s || a.j - b.j).slice(0, MAX_CLUSTER - 1);
        left.delete(seed);
        for (const e of near) left.delete(e.j);
        if (near.length > 0) groups.push([seed, ...near.map((e) => e.j)].sort((a, b) => a - b));
      }
    }
    for (const g of groups) {
      const ms = g.map((i) => pool[i]!.memory).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (ms.every(o.looked)) continue;
      const scores = g.flatMap((i, x) => g.slice(x + 1).map((j) => sim.get(`${Math.min(i, j)}:${Math.max(i, j)}`))).filter((s): s is number => s !== undefined);
      const top = Math.max(...scores);
      const days = [...new Set(ms.map(day))];
      // "Nearly the same" only when every fact has a duplicate-close partner (or the group is exactly one pair); a pair chained with looser neighbours is mixed.
      const dupe = top >= o.duplicate;
      const every = g.every((i) => g.some((j) => j !== i && (sim.get(`${Math.min(i, j)}:${Math.max(i, j)}`) ?? 0) >= o.duplicate));
      const mixed = dupe && !every;
      // Close but not the same fact, saved on different days: the later one may have changed the answer.
      const conflict = !dupe && days.length > 1;
      const why: ClusterWhy = dupe ? 'duplicates' : conflict ? 'conflict' : 'related';
      const ids = ms.map((m) => m.id);
      out.push({
        id: clusterId(ids), project: o.project, why, ids,
        because: mixed ? `${ms.length} ${cls === 'status' ? 'statuses' : 'decisions'} look related (two of them say nearly the same thing; closest pair ${top.toFixed(2)}).`
          : dupe ? `${ms.length} ${cls === 'status' ? 'statuses' : 'decisions'} say nearly the same thing (closest pair ${top.toFixed(2)}).`
          : conflict ? `${ms.length} ${cls === 'status' ? 'statuses' : 'decisions'} look related, and were saved on different days (${days.join(', ')}): a later one may have changed the answer.`
          : `${ms.length} ${cls === 'status' ? 'statuses' : 'decisions'} look related.`,
      });
    }
  }

  out.sort((a, b) => WHY_ORDER.indexOf(a.why) - WHY_ORDER.indexOf(b.why) || b.ids.length - a.ids.length || a.id.localeCompare(b.id));
  // Every group stays reachable one at a time through the session's cursor: nothing is cut off, so `total` is what can be reached.
  return { clusters: out, total: out.length };
}
