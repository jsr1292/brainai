import type { MemoryService } from './service.js';
import type { Memory } from './types.js';

/**
 * A question an assistant might ask, and the memories (any of them) that should answer it. `tags` group questions by
 * the kind of miss they test (nickname, spanish, ...); `alt` are the other phrasings an assistant would send with it.
 */
export interface RecallCase { q: string; expect: string[]; project?: string; tags?: string[]; alt?: string[] }
export interface CaseResult { q: string; tags: string[]; expected: Memory[]; got: Memory[]; /** 1-based; null when missed. */ rank: number | null }
export interface Summary { cases: number; first: number; top3: number; found: number; missed: number; mrr: number }
export interface RecallReport {
  limit: number;
  results: CaseResult[];
  /** Questions whose expected memories are all deleted or unknown: not scored. */
  stale: { q: string; ids: string[] }[];
  summary: Summary;
  byTag: Record<string, Summary>;
}

/**
 * Two runs of the same questions compared one by one: the ids found within `k` in `after` but not in `before`
 * (gained) and the reverse (lost). Questions in only one run are left out.
 */
export function comparePaired(before: { id: string; rank: number | null }[], after: { id: string; rank: number | null }[], k: number): { gained: string[]; lost: string[] } {
  const was = new Map(before.map((r) => [r.id, r.rank]));
  const within = (rank: number | null | undefined) => rank !== null && rank !== undefined && rank <= k;
  const gained: string[] = [];
  const lost: string[] = [];
  for (const r of after) {
    if (!was.has(r.id)) continue;
    const old = within(was.get(r.id));
    if (within(r.rank) && !old) gained.push(r.id);
    else if (!within(r.rank) && old) lost.push(r.id);
  }
  return { gained, lost };
}

/** Reads the question file: [{ "q": "...", "expect": ["<memory id>", ...], "project"?: "..." }, ...]. */
export function parseCases(json: string): RecallCase[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('The question file is not valid JSON'); }
  if (!Array.isArray(data)) throw new Error('The question file must be a JSON list of questions');
  return data.map((c: unknown, i): RecallCase => {
    const o = (c ?? {}) as Record<string, unknown>;
    const bad = (field: string) => new Error(`Question ${i + 1} needs ${field}`);
    if (typeof o.q !== 'string' || o.q.trim() === '') throw bad('a non-empty "q"');
    if (!Array.isArray(o.expect) || o.expect.length === 0 || !o.expect.every((x) => typeof x === 'string')) throw bad('an "expect" list of memory ids');
    if (o.project !== undefined && typeof o.project !== 'string') throw bad('"project" to be text');
    const texts = (x: unknown) => Array.isArray(x) && x.every((t) => typeof t === 'string');
    if (o.tags !== undefined && !texts(o.tags)) throw bad('"tags" to be a list of text');
    if (o.alt !== undefined && !texts(o.alt)) throw bad('"alt" to be a list of text');
    return {
      q: o.q, expect: o.expect as string[], ...(o.project !== undefined ? { project: o.project as string } : {}),
      ...(o.tags !== undefined ? { tags: o.tags as string[] } : {}), ...(o.alt !== undefined ? { alt: o.alt as string[] } : {}),
    };
  });
}

const EXCERPT = 90;
const excerpt = (s: string) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + '…' : s);
const pct = (n: number, of: number) => `${Math.round((n / Math.max(of, 1)) * 100)}%`;

/**
 * Runs each question through recall as an assistant would, with its other phrasings unless `alt` is false, without
 * marking anything as recalled.
 */
export async function runRecallTest(service: MemoryService, cases: RecallCase[], limit: number, opts: { alt?: boolean } = {}): Promise<RecallReport> {
  const results: CaseResult[] = [];
  const stale: RecallReport['stale'] = [];
  for (const c of cases) {
    const expected = c.expect.map((id) => service.get(id)).filter((m): m is Memory => m !== undefined && !m.deletedAt);
    if (expected.length === 0) { stale.push({ q: c.q, ids: c.expect }); continue; }
    const got = (await service.recall({ query: c.q, project: c.project, limit, touch: false, readTime: true, alt: opts.alt === false ? undefined : c.alt })).map((r) => r.memory);
    const i = got.findIndex((m) => expected.some((e) => e.id === m.id));
    results.push({ q: c.q, tags: c.tags ?? [], expected, got, rank: i === -1 ? null : i + 1 });
  }
  const byTag: Record<string, Summary> = {};
  for (const tag of [...new Set(results.flatMap((r) => r.tags))].sort()) byTag[tag] = summarise(results.filter((r) => r.tags.includes(tag)));
  return { limit, results, stale, summary: summarise(results), byTag };
}

function summarise(results: CaseResult[]): Summary {
  const ranks = results.map((r) => r.rank);
  const found = ranks.filter((r) => r !== null).length;
  return {
    cases: results.length,
    first: ranks.filter((r) => r === 1).length,
    top3: ranks.filter((r) => r !== null && r <= 3).length,
    found,
    missed: results.length - found,
    mrr: results.length === 0 ? 0 : ranks.reduce((s: number, r) => s + (r === null ? 0 : 1 / r), 0) / results.length,
  };
}

/** Plain-text report: the scores, then every question not answered first, with what came back instead. */
export function formatReport(r: RecallReport): string {
  const { cases, first, top3, found, missed, mrr } = r.summary;
  const lines = [
    `Recall test: ${cases} questions, top ${r.limit} results each`,
    `  Found first:      ${first} (${pct(first, cases)})`,
    `  Found in top 3:   ${top3} (${pct(top3, cases)})`,
    `  Found in top ${r.limit}:   ${found} (${pct(found, cases)})`,
    `  Missed:           ${missed}`,
    `  Mean reciprocal rank: ${mrr.toFixed(2)}`,
  ];
  const tags = Object.entries(r.byTag);
  if (tags.length > 0) {
    lines.push('', 'By type:');
    for (const [tag, s] of tags) {
      lines.push(`  ${tag}: ${s.cases} ${s.cases === 1 ? 'question' : 'questions'}, first ${pct(s.first, s.cases)}, top 3 ${pct(s.top3, s.cases)}, top ${r.limit} ${pct(s.found, s.cases)}`);
    }
  }
  const late = r.results.filter((x) => x.rank !== 1);
  if (late.length > 0) {
    lines.push('', 'Not found first:');
    for (const x of late) {
      lines.push(`  ${x.rank === null ? 'MISSED' : `#${x.rank}`} "${x.q}"`, `      expected: ${excerpt(x.expected[0]!.content)}`);
      x.got.slice(0, 3).forEach((m, i) => lines.push(`      got ${i + 1}: ${excerpt(m.content)}`));
    }
  }
  if (r.stale.length > 0) {
    lines.push('', `Expected memories no longer exist for ${r.stale.length === 1 ? '1 question' : `${r.stale.length} questions`}:`);
    for (const s of r.stale) lines.push(`  "${s.q}" (${s.ids.join(', ')})`);
  }
  return lines.join('\n');
}
