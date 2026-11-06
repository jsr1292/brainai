import { createHash } from 'node:crypto';
import { cosine } from '../memory/embedder.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import { replaceableKind } from '../memory/supersessions.js';
import { LINKED_CHANGES, NEWER_DECISIONS, type Flag, type Reasons } from './freshness.js';
import { findLinks, isKeyDecisions } from './markdown.js';
import type { PageService } from './service.js';
import type { Page } from './types.js';

/**
 * The "may be out of date" dry run (round 2 section 13, Task 11): how many pages would be flagged, the spread of
 * closeness between decisions and page sections that SECTION_MATCH is chosen from, and how long a page view and the
 * Pages tab take. It prints counts, ids, hashes and timings only; titles only with `names` (for the owner).
 */

export interface SpreadPair { nearest: number; second: number | null; main: boolean }

const FLOORS = [0.88, 0.89, 0.9];
const pct = (n: number, of: number) => `${of === 0 ? '0.0' : ((100 * n) / of).toFixed(1)}%`;
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** What the verdict reads at one floor. */
function atFloor(spread: SpreadPair[], v: number) {
  const above = spread.filter((p) => p.nearest >= v);
  const margins = above.filter((p) => p.second !== null).map((p) => p.nearest - p.second!);
  return { share: spread.length === 0 ? 0 : above.length / spread.length, above: above.length, margin: median(margins), near: spread.filter((p) => Math.abs(p.nearest - v) <= 0.005).length };
}

/**
 * Mechanical, so the call is reproducible, and calm wins every tie (off): the lowest floor where at most a quarter of
 * the pairs reach it, those that do clear the second-nearest section by a median 0.01, and fewer than 5% sit within
 * 0.005 of the line. Under 30 pairs there is no data.
 */
export function sectionVerdict(spread: SpreadPair[]): { value: number | null; why: string } {
  const m = spread.filter((p) => p.main).length;
  const o = spread.length - m;
  const counts = `${spread.length} pairs (main ${m}, other ${o})`;
  const noOther = o === 0 ? '; other pages: no data' : '';
  if (spread.length < 30) return { value: null, why: `no data: ${counts}${noOther}` };
  for (const v of FLOORS) {
    const f = atFloor(spread, v);
    if (f.share <= 0.25 && (f.margin === null || f.margin >= 0.01) && f.near / spread.length < 0.05) {
      return { value: v, why: `${counts}, ${pct(f.above, spread.length)} at or above, median margin ${f.margin === null ? 'none' : f.margin.toFixed(3)}${noOther}` };
    }
  }
  return { value: null, why: `no gap: ${counts}${noOther}` };
}

const hash8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

function histogram(xs: number[]): string {
  const buckets: [string, number][] = [['<0.80', 0]];
  for (let i = 80; i < 95; i++) buckets.push([(i / 100).toFixed(2), 0]);
  buckets.push(['≥0.95', 0]);
  for (const x of xs) {
    const i = x < 0.8 ? 0 : x >= 0.95 ? buckets.length - 1 : 1 + Math.floor(Math.round(x * 10000) / 100) - 80;
    buckets[Math.max(0, Math.min(buckets.length - 1, i))]![1]++;
  }
  return buckets.map(([k, n]) => `${k} ${n}`).join(' | ');
}

function spreadBlock(name: string, pairs: SpreadPair[]): string[] {
  if (pairs.length === 0) return [`spread ${name}: pairs 0`];
  const out = [`spread ${name}: pairs ${pairs.length}`, `  nearest: ${histogram(pairs.map((p) => p.nearest))}`, `  second:  ${histogram(pairs.filter((p) => p.second !== null).map((p) => p.second!))}`];
  for (const v of FLOORS) {
    const f = atFloor(pairs, v);
    out.push(`  nearest ≥ ${v.toFixed(2)}: ${pct(f.above, pairs.length)} · median margin where nearest ≥ ${v.toFixed(2)}: ${f.margin === null ? 'none' : f.margin.toFixed(3)} · within ±0.005 of ${v.toFixed(2)}: ${pct(f.near, pairs.length)}`);
  }
  return out;
}

function timed(fn: () => unknown): { median: number; max: number } {
  for (let i = 0; i < 3; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    fn();
    ms.push(performance.now() - t);
  }
  return { median: median(ms)!, max: Math.max(...ms) };
}

export function freshnessReport(
  d: { pages: PageService; memoryStore: MemoryStore; memories: MemoryService },
  opts: { names?: boolean; time?: boolean; render?: { page(p: Page, flag: Flag | null): unknown; home(all: Page[], flags: Map<string, Flag | null>): unknown } },
): string[] {
  const { pages, memoryStore, memories } = d;
  const out: string[] = [];
  const live = pages.list();
  const withProject = live.filter((p) => p.project !== null);
  out.push(`schema ${memoryStore.schemaVersion()}; pages ${live.length} (${withProject.length} with a project); unsaved imports ${live.filter((p) => p.caughtUp.how === 'imported').length}`);

  // 1. The main page of each project with pages.
  const projects = [...new Set(withProject.map((p) => memories.projectNamed(p.project!)))].sort();
  const mains = projects.map((name) => ({ name, ...pages.freshness.mainPageHow(name) }));
  const count = (how: string) => mains.filter((m) => m.how === how).length;
  out.push(`main page: by rule ${count('rule')}, only page ${count('only')}, none ${count('none')}`);
  const titleOf = new Map(live.map((p) => [p.id, p.title]));
  for (const m of mains) {
    out.push(opts.names
      ? `${m.name} → ${m.id === null ? 'none' : titleOf.get(m.id)} (${m.how})`
      : `${hash8(m.name)} → ${m.id ?? 'none'} (${m.how})`);
  }

  // 2. How many would be flagged, at the owner's thresholds and around them.
  const details = pages.freshness.details(live);
  const rows = live.map((p) => ({ p, d: details.get(p.id) ?? null })).filter((x): x is { p: Page; d: { reasons: Reasons; main: boolean } } => x.d !== null);
  const flagLine = (k: number) => {
    const flagged = rows.filter((r) => r.d.reasons.decisions.length >= k || r.d.reasons.linked.length >= LINKED_CHANGES);
    const byD = (r: (typeof rows)[number]) => r.d.reasons.decisions.length >= k;
    const byL = (r: (typeof rows)[number]) => r.d.reasons.linked.length >= LINKED_CHANGES;
    return {
      flagged,
      line: `would flag ${flagged.length} of ${live.length} (main ${flagged.filter((r) => r.d.main).length}, other ${flagged.filter((r) => !r.d.main).length}); decisions only ${flagged.filter((r) => byD(r) && !byL(r)).length}, linked only ${flagged.filter((r) => !byD(r) && byL(r)).length}, both ${flagged.filter((r) => byD(r) && byL(r)).length}`,
    };
  };
  const at3 = flagLine(NEWER_DECISIONS);
  out.push(at3.line);
  const all = at3.flagged.map((r) => r.d.reasons);
  const n = (f: (r: Reasons) => number) => all.reduce((s, r) => s + f(r), 0);
  out.push(`reasons: new ${n((r) => r.decisions.filter((x) => x.why === 'new').length)}, changed ${n((r) => r.decisions.filter((x) => x.why === 'changed').length)}; linked changed ${n((r) => r.linked.filter((x) => x.why === 'changed').length)}, replaced ${n((r) => r.linked.filter((x) => x.why === 'replaced').length)}, removed ${n((r) => r.linked.filter((x) => x.why === 'removed').length)}`);
  for (const k of [2, 4, 5]) out.push(`at ${k} / ${LINKED_CHANGES}: ${flagLine(k).line}`);

  // 3. The spread: every current decision × every page of its project, against the sections the floor is used on.
  const spread: SpreadPair[] = [];
  for (const m of mains) {
    const names = [m.name, ...memories.aliases().filter((a) => a.project === m.name).map((a) => a.alias)];
    const decisions = names.flatMap((name) => memoryStore.list({ project: name, kind: 'decision' })).filter((x) => replaceableKind(x) === 'decision');
    if (decisions.length === 0) continue;
    const vectors = memoryStore.embeddingsOf(decisions.map((x) => x.id));
    for (const p of pages.forProject(m.name)) {
      const main = p.id === m.id;
      const linked = new Set(findLinks(p.body).filter((l) => l.kind === 'fact').map((l) => l.target));
      const sections = pages.sections(p.id).filter((s) => !isKeyDecisions(s.heading) && (!main || s.anchor !== 'top'));
      if (sections.length === 0) continue;
      for (const x of decisions) {
        const v = vectors.get(x.id);
        if (!v || linked.has(x.id)) continue;
        const sims = sections.map((s) => cosine(v, s.embedding)).sort((a, b) => b - a);
        spread.push({ nearest: sims[0]!, second: sims[1] ?? null, main });
      }
    }
  }
  out.push(...spreadBlock('main', spread.filter((p) => p.main)), ...spreadBlock('other', spread.filter((p) => !p.main)), ...spreadBlock('combined', spread));
  const verdict = sectionVerdict(spread);
  out.push(`SECTION_MATCH verdict: ${verdict.value === null ? 'off' : verdict.value.toFixed(2)} (${verdict.why})`);

  // 4. Timings: the main page with the most counted decisions, and the Pages tab.
  if (opts.time && opts.render) {
    const render = opts.render;
    const busiest = rows.filter((r) => r.d.main).sort((a, b) => b.d.reasons.decisions.length - a.d.reasons.decisions.length)[0]?.p ?? live[0];
    if (busiest) {
      const t = timed(() => render.page(busiest, pages.freshness.forPage(busiest, { hints: true })));
      out.push(`page view: median ${t.median.toFixed(2)} ms, max ${t.max.toFixed(2)} ms`);
    }
    const h = timed(() => { const ps = pages.list(); render.home(ps, pages.freshness.forPages(ps)); });
    out.push(`Pages tab: median ${h.median.toFixed(2)} ms, max ${h.max.toFixed(2)} ms`);
  }
  return out;
}
