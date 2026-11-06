/**
 * The week in one sentence, from fixed patterns only: no AI writes it. Numbers are digits. Life areas are counted but
 * never named (`nameable: false`), and `quiet` holds only names that may be said.
 */
export interface SentenceFacts {
  steps: { project: string; n: number; nameable: boolean }[];
  late: number;
  /** Every dated waiting item, late or not: "Nothing is late." needs at least one. */
  dated: number;
  quiet: string[];
  /** Some other part of the week has something (chips, pages, items due after, decisions, growth, notes). */
  somethingElse: boolean;
}

/** A good week names a project only when steps span 2 or more projects and it did 3 or more; at most two names. */
const GOOD_WEEK_STEPS = 3;

export function weekSentence(f: SentenceFacts, opts: { lead: boolean; soFar: boolean }): string {
  const steps = f.steps.filter((s) => s.n > 0);
  const total = steps.reduce((a, s) => a + s.n, 0);
  if (total === 0 && f.late === 0 && f.quiet.length === 0 && !f.somethingElse) {
    return opts.soFar ? 'So far: nothing has moved yet.' : 'A quiet week. Nothing moved.';
  }

  let lead = '';
  if (opts.lead && !opts.soFar && steps.length >= 2) {
    const named = steps.filter((s) => s.nameable && s.n >= GOOD_WEEK_STEPS).sort((a, b) => b.n - a.n).slice(0, 2).map((s) => s.project);
    if (named.length > 0) lead = `A good week for ${named.join(' and ')}: `;
  }

  let done: string;
  if (total === 0) done = 'No roadmap steps were done.';
  else if (steps.length > 1) done = `${total} steps done across ${steps.length} projects.`;
  else {
    const only = steps[0]!;
    if (!only.nameable) done = total === 1 ? '1 step done.' : `${total} steps done.`;
    else done = total === 1 ? `1 step done, in ${only.project}.` : `${total} steps done, all in ${only.project}.`;
  }

  const late = f.late === 1 ? '1 thing is late' : f.late > 1 ? `${f.late} things are late` : f.dated > 0 ? 'Nothing is late' : '';
  const quiet = f.quiet.length === 1 ? `${f.quiet[0]} went quiet`
    : f.quiet.length === 2 ? `${f.quiet[0]} and ${f.quiet[1]} went quiet`
    : f.quiet.length > 2 ? `${f.quiet.length} projects went quiet` : '';
  const rest = late && quiet ? `${late}, and ${quiet}.` : late || quiet ? `${late || quiet}.` : '';

  const sentence = [`${lead}${done}`, rest].filter(Boolean).join(' ');
  return opts.soFar ? `So far: ${sentence}` : sentence;
}

// ---- Week dates: calendar days, so they are read in UTC ----

const DAY_MS = 86_400_000;
const parts = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  const month = d.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' });
  return {
    day: d.getUTCDate(), month, monthShort: month.slice(0, 3), year: d.getUTCFullYear(),
    weekday: d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long' }),
  };
};
const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function range(from: string, to: string, o: { long: boolean; year: 'needed' | 'always' }): string {
  const a = parts(from);
  const b = parts(to);
  const month = (p: ReturnType<typeof parts>) => (o.long ? p.month : p.monthShort);
  const day = (p: ReturnType<typeof parts>) => (o.long ? `${p.weekday} ${p.day}` : `${p.day}`);
  const endYear = o.year === 'always' ? ` ${b.year}` : '';
  if (from === to) return `${day(a)} ${month(a)}${endYear}`;
  if (a.year !== b.year) return `${day(a)} ${month(a)} ${a.year} – ${day(b)} ${month(b)} ${b.year}`;
  if (a.month !== b.month) return `${day(a)} ${month(a)} – ${day(b)} ${month(b)}${endYear}`;
  return `${day(a)} – ${day(b)} ${month(b)}${endYear}`;
}

/** "26 Oct – 1 Nov", "19 – 25 Oct", "29 Dec 2025 – 4 Jan 2026". */
export const weekRange = (monday: string): string => range(monday, plusDays(monday, 6), { long: false, year: 'needed' });
/** Always ends with the year, for text read months later: "26 Oct – 1 Nov 2026". */
export const weekRangeWithYear = (monday: string): string => range(monday, plusDays(monday, 6), { long: false, year: 'always' });
/** "Monday 26 October – Sunday 1 November 2026"; `lastDay` ends it early (this week so far). */
export const weekRangeLong = (monday: string, lastDay?: string): string => range(monday, lastDay ?? plusDays(monday, 6), { long: true, year: 'always' });
