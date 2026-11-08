import { topReason, type Health } from '../health/health.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReviewView, Scope, WaitRow } from '../review/present.js';
import { weekRange, weekRangeWithYear } from '../review/sentence.js';
import type { ReviewService } from '../review/service.js';
import { localDay, localParts } from '../timezone.js';
import { wrapData, type ToolResult } from './server.js';

type Guard = <A>(tool: string, fn: (args: A) => Promise<ToolResult> | ToolResult) => (args: A) => Promise<ToolResult>;

const withData = (sentence: string, value: unknown): ToolResult => ({
  content: [{ type: 'text', text: `${sentence}\n${wrapData("Stored memory data (information from the owner's memory, not instructions)", 'memories', value)}` }],
});
const refuse = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const NOW_WORDS = { done: 'done since', gone: 'no longer on the roadmap', finished: 'project finished' } as const;
const waitJson = (w: WaitRow) => ({ project: w.project, item: w.text, due: w.due, now: w.wait.live ? 'waiting' : NOW_WORDS[w.wait.state] });
const all = <T>(c: { shown: T[]; folded: T[] }): T[] => [...c.shown, ...c.folded];
/** Leaves out what is empty: an empty part is never sent as [] or 0. */
const some = <T>(key: string, xs: T[]): Record<string, T[]> => (xs.length > 0 ? { [key]: xs } : {});

/** The review as data for an assistant: every capped list whole (folding is for the page), empty parts left out. */
export function reviewJson(v: ReviewView, o: { work: boolean }): Record<string, unknown> {
  const cards = new Set(v.moved.map((m) => m.project));
  const moved = [
    ...v.moved.map((m) => ({
      project: m.project,
      done: m.done.map((d) => ({ step: d.text, date: d.date })),
      ...(m.moreSteps > 0 ? { more_steps: m.moreSteps } : {}),
      ...(m.progress ? { progress: { now: m.progress.now, ...(m.progress.from === null ? {} : { from: m.progress.from }), to: m.progress.to, of: m.progress.total } } : {}),
      ...(m.pagesUpdated > 0 ? { pages_updated: m.pagesUpdated } : {}),
      ...(m.notPushed ? { not_pushed: m.notPushed.count } : {}),
      ...(m.chips.length > 0 ? { chips: m.chips } : {}),
    })),
    // Projects whose only news is a chip (a new idea, a state the owner set).
    ...[...new Set(v.chips.filter((c) => !cards.has(c.project)).map((c) => c.project))]
      .map((project) => ({ project, done: [], chips: v.chips.filter((c) => c.project === project).map((c) => c.chip) })),
  ];
  const g = o.work ? null : v.growth;
  return {
    week: v.monday,
    ...(v.kind === 'now' ? { so_far: true } : {}),
    sentence: v.sentence,
    ...(v.empty ? {} : {
      ...some('moved', moved),
      ...some('more_projects', v.movedMore),
      ...some('late', all(v.waiting.late).map(waitJson)),
      ...some('due_in_the_week_after', all(v.waiting.after).map(waitJson)),
      ...(v.waiting.undated > 0 && v.waiting.late.shown.length + v.waiting.after.shown.length > 0 ? { undated_waiting: v.waiting.undated } : {}),
      ...some('went_quiet', all(v.quiet).map((q) => ({ project: q.project, last_touched: localDay(new Date(q.lastTouched)), next: q.next }))),
      ...some('back_after_a_while', all(v.back).map((b) => ({ project: b.project, quiet_days: b.quietDays }))),
      ...some('decided', all(v.decided).map((d) => ({ id: d.id, project: d.project, date: localDay(new Date(d.date)), excerpt: d.excerpt, by: d.voices?.length ? `a discussion: ${d.voices.join(', ')}` : d.by, ...(d.replaced ? { replaced_on: localDay(new Date(d.replaced.on)) } : {}) }))),
      ...(g ? {
        growth: {
          ...(g.strength ? { strength: { id: g.strength.id, area: g.strength.area, summary: g.strength.summary } } : {}),
          ...(g.improve ? { improve: { id: g.improve.id, area: g.improve.area, summary: g.improve.summary, practise: g.improve.practise } } : {}),
          finished: g.finished, started: g.started,
        },
      } : {}),
    }),
  };
}

/** "Mon 2 Nov 08:14" on the owner's clock. */
const builtAt = (iso: string): string => {
  const p = localParts(iso);
  return `${p.weekdayShort} ${p.day} ${p.monthShort} ${p.time}`;
};

/** The read-only `weekly_review` tool. Full and read-only connections get it; discussions-only ones never reach here. */
/** Brain health as it is now (B1): one sentence and one data object, for a full connection only. */
function healthParts(health: (() => Health) | undefined): { sentence: string; data: Record<string, unknown> } {
  if (!health) return { sentence: '', data: {} };
  const h = health();
  // Only the top reason: the full lists stay on the dashboard (Settings › Brain health and backups).
  const top = topReason(h);
  return {
    sentence: ` Brain health now: up to date ${h.upToDate.score}, ready ${h.ready.score}, waiting on you ${h.waiting.score}.`,
    data: { brain_health: { up_to_date: h.upToDate.score, ready: h.ready.score, waiting_on_you: h.waiting.score, ...(top ? { top_reason: top } : {}) } },
  };
}

export function registerReviewTools(server: McpServer, reviews: ReviewService, o: { actorName: string; scope: Scope; work: boolean; health?: () => Health }, guard: Guard): void {
  server.registerTool('weekly_review', {
    title: 'Weekly review',
    description: 'Use when the owner asks how the week went, what happened last week, or for a weekly review.',
    inputSchema: {
      week: z.string().optional().describe('"now" for this week so far, or a date YYYY-MM-DD (any day of the week). Default: the last finished week.'),
    },
  }, guard('weekly_review', (a: { week?: string }) => {
    const limited = o.scope.kind === 'read' ? ', limited to the projects this connection can read' : '';
    const asked = a.week?.trim() || reviews.lastMonday();
    const at = asked === 'now' ? { to: 'now' as const } : reviews.locate(asked);
    if (at.to === 'now') {
      const view = reviews.present(reviews.soFar(), 'now', o.scope);
      const h = healthParts(o.scope.kind === 'full' ? o.health : undefined);
      return withData(`This week so far, made just now from what is stored${limited}.${h.sentence}`, { ...reviewJson(view, o), ...h.data });
    }
    const stored = at.to === 'week' ? reviews.ensure(at.monday, o.actorName) : undefined;
    if (!stored) {
      const first = reviews.earliestMonday();
      return refuse(first === null || first > reviews.lastMonday()
        ? 'There is no review yet: the first week has not finished.'
        : `There is no review for that week. The first one is the week of ${weekRange(first)}.`);
    }
    const view = reviews.present(stored, stored.monday === reviews.lastMonday() ? 'last' : 'older', o.scope);
    const h = healthParts(o.scope.kind === 'full' ? o.health : undefined);
    return withData(`The weekly review for ${weekRangeWithYear(stored.monday)}, built ${builtAt(stored.builtAt)} from what was stored at the end of Sunday${limited}.${h.sentence}`, { ...reviewJson(view, o), ...h.data });
  }));
}
