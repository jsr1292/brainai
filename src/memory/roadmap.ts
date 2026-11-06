/**
 * A project's roadmap: what is left, in four labelled lines. One per project (kind "roadmap"), kept current by the
 * assistants as steps finish, read by project_brief, whats_left and the Projects home.
 *
 *   Done: tools merged (2026-10-20); design plan (2026-10-20)
 *   Now: design refresh, task 9 in review (8/15)
 *   Next: final review, merge, install on the iPhone
 *   Later: dark mode pass
 *   Waiting on you: device checklist; reinstall before the profiles expire (by 2026-10-27)
 */
export const ROADMAP_LABELS = ['Done', 'Now', 'Next', 'Later', 'Waiting on you'] as const;
export const ROADMAP_EXAMPLE = 'Done: <finished step> (2026-10-20); <finished step> (2026-10-21)\nNow: <what is being done> (8/15)\nNext: <step>; <step>\nLater: <step>; <step>\nWaiting on you: <item>; <item (by 2026-10-27)>';

export interface WaitingItem { text: string; due: string | null }
export interface DoneItem { text: string; date: string | null }
export interface Roadmap {
  done: DoneItem[];
  now: string | null;
  /** From "(8/15)" in the Now line: steps done of the total. */
  progress: { done: number; total: number } | null;
  next: string | null;
  later: string | null;
  /** Next and Later as separate steps (the line split on ";"). */
  nextSteps: string[];
  laterSteps: string[];
  waiting: WaitingItem[];
}

const LABEL = /^\s*(done|now|next|later|waiting on you)\s*:\s*(.*)$/i;
const DUE = /\s*\(by (\d{4}-\d{2}-\d{2})\)\s*$/i;
const DATE = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;
const PROGRESS = /\s*\((\d+)\s*\/\s*(\d+)\)\s*$/;
/** A real calendar date in YYYY-MM-DD (2026-13-45 is not one). */
const isDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** The text under each label; a line without a label continues the one before. */
function sections(content: string): { labels: string[]; values: Map<string, string> } {
  const labels: string[] = [];
  const values = new Map<string, string>();
  let current: string | null = null;
  for (const line of content.split('\n')) {
    const m = LABEL.exec(line);
    if (m) {
      current = m[1]!.toLowerCase();
      labels.push(current);
      values.set(current, m[2]!.trim());
    } else if (current !== null && line.trim() !== '') {
      values.set(current, `${values.get(current)} ${line.trim()}`.trim());
    } else if (line.trim() !== '') {
      labels.push('');
    }
  }
  return { labels, values };
}

/** Filler an assistant writes when a line has nothing in it ("Waiting on you: none", "Next: —"): not a step. */
const FILLER = /^\(?\s*(none(\s+(yet|for now|right now))?|nothing(\s+(yet|for now|right now|pending|waiting))?|n\/?a|tbd|nil|[-–—.]+)\s*\)?[.!]?$/i;
const real = (s: string): boolean => s !== '' && !FILLER.test(s);
const items = (text: string | undefined): string[] => (text ?? '').split(';').map((s) => s.trim()).filter(real);

export function parseRoadmap(content: string): Roadmap {
  const { values } = sections(content);
  const text = (label: string) => { const v = values.get(label); return v && real(v) ? v : null; };
  const waiting = items(values.get('waiting on you')).map((item) => {
    const due = DUE.exec(item);
    return due && isDate(due[1]!) ? { text: item.slice(0, due.index).trim(), due: due[1]! } : { text: item, due: null };
  });
  const done = items(values.get('done')).map((item) => {
    const date = DATE.exec(item);
    return date && isDate(date[1]!) ? { text: item.slice(0, date.index).trim(), date: date[1]! } : { text: item, date: null };
  }).filter((d) => d.text !== '');
  let now = text('now');
  let progress: Roadmap['progress'] = null;
  const count = now ? PROGRESS.exec(now) : null;
  if (now && count && Number(count[2]) > 0) {
    progress = { done: Math.min(Number(count[1]), Number(count[2])), total: Number(count[2]) };
    now = `${now.slice(0, count.index)}${now.slice(count.index + count[0].length)}`.trim() || null;
  }
  return { done, now, progress, next: text('next'), later: text('later'), nextSteps: items(values.get('next')), laterSteps: items(values.get('later')), waiting };
}

/** A parsed roadmap written back as its labelled lines, in ROADMAP_LABELS order; empty lines are left out. */
export function formatRoadmap(r: Roadmap): string {
  const count = r.progress ? `(${r.progress.done}/${r.progress.total})` : null;
  const now = r.now && count ? `${r.now} ${count}` : r.now ?? count;
  const parts: string[][] = [
    r.done.map((d) => (d.date ? `${d.text} (${d.date})` : d.text)),
    now ? [now] : [],
    r.nextSteps,
    r.laterSteps,
    r.waiting.map((w) => (w.due ? `${w.text} (by ${w.due})` : w.text)),
  ];
  return ROADMAP_LABELS.map((label, i) => (parts[i]!.length > 0 ? `${label}: ${parts[i]!.join('; ')}` : null))
    .filter((line): line is string => line !== null).join('\n');
}

const BY_DATE = /\s*\(by \d{4}-\d{2}-\d{2}\)\s*$/i;
/** How a waiting item is recognised across versions: lower-cased, with its "(by …)" date left out. */
export const itemKey = (text: string): string => text.replace(BY_DATE, '').trim().toLowerCase();

/**
 * An assistant's new roadmap written from an older copy would put back items the owner has since ticked off. A waiting
 * item stays done (with its Done entry) when the new text leaves out a Done entry for it that is there now: it was
 * written before that tick. When the new text keeps every such Done entry, the assistant saw the tick and is asking for
 * the step again (test on the iPhone, for the next release), so it stays waiting. Returns the new text, unchanged when
 * nothing had to be kept.
 */
export function keepTicked(current: string, next: string): string {
  const was = parseRoadmap(current);
  const r = parseRoadmap(next);
  const entry = (d: DoneItem) => `${itemKey(d.text)}|${d.date}`;
  const written = new Set(r.done.map(entry));
  const missed = was.done.filter((d) => !written.has(entry(d)));
  const stale = new Set(missed.map((d) => itemKey(d.text)));
  const kept = r.waiting.filter((w) => stale.has(itemKey(w.text)));
  if (kept.length === 0) return next;
  r.waiting = r.waiting.filter((w) => !stale.has(itemKey(w.text)));
  const keys = new Set(kept.map((w) => itemKey(w.text)));
  r.done.push(...missed.filter((d) => keys.has(itemKey(d.text))));
  return formatRoadmap(r);
}

/** Null when the text is a well-formed roadmap, otherwise what to fix (safe to show an assistant). */
export function checkRoadmap(content: string): string | null {
  const { labels, values } = sections(content);
  const shape = `Write it as up to five lines:\n${ROADMAP_EXAMPLE}`;
  if (labels.includes('')) return `A roadmap starts each line with Done:, Now:, Next:, Later: or Waiting on you:. ${shape}`;
  if (new Set(labels).size !== labels.length) return `Use each of Done:, Now:, Next:, Later: and Waiting on you: at most once. ${shape}`;
  if (!values.get('now') && !values.get('next')) return `A roadmap needs a Now: or Next: line. ${shape}`;
  return null;
}
