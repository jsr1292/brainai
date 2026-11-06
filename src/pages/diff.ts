import { diffLines } from 'diff';
import { splitSections } from './markdown.js';

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string } | { kind: 'skipped'; count: number };

const withEnd = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

/**
 * The most line changes worked out one by one. The line diff costs about lines × changes on the request thread, so a
 * version that rewrote most of a long list (thousands of lines) would hold up every other request for most of a second;
 * capped here it gives up in tens of milliseconds and the version is shown as replaced instead.
 */
const MAX_CHANGES = 1000;

type Part = { added?: boolean; removed?: boolean; value: string };

/** Too many changes to show one by one: the unchanged first and last lines, and the rest as removed, then added. */
function replaced(before: string, after: string): Part[] {
  const was = before.split('\n');
  const now = after.split('\n');
  let head = 0;
  while (head < was.length - 1 && head < now.length - 1 && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - 1 - head && tail < now.length - 1 - head && was[was.length - 2 - tail] === now[now.length - 2 - tail]) tail++;
  const join = (xs: string[]) => xs.map((x) => `${x}\n`).join('');
  const parts: Part[] = [
    { value: join(was.slice(0, head)) },
    { removed: true, value: join(was.slice(head, was.length - 1 - tail)) },
    { added: true, value: join(now.slice(head, now.length - 1 - tail)) },
    { value: join(was.slice(was.length - 1 - tail, was.length - 1)) },
  ];
  return parts.filter((p) => p.value !== '');
}

/** Line changes from one version to the next; long unchanged stretches keep `context` lines each side. */
export function diffBodies(before: string, after: string, context = 2): DiffLine[] {
  const lines: DiffLine[] = [];
  const [a, b] = [withEnd(before), withEnd(after)];
  for (const part of diffLines(a, b, { maxEditLength: MAX_CHANGES }) ?? replaced(a, b)) {
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'same';
    for (const text of part.value.replace(/\n$/, '').split('\n')) lines.push({ kind, text });
  }
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'same') { out.push(lines[i++]!); continue; }
    let j = i;
    while (j < lines.length && lines[j]!.kind === 'same') j++;
    const run = lines.slice(i, j);
    if (run.length > 2 * context) out.push(...run.slice(0, context), { kind: 'skipped', count: run.length - 2 * context }, ...run.slice(-context));
    else out.push(...run);
    i = j;
  }
  return out;
}

const SHOWN = 3;
const name = (heading: string) => heading || 'Introduction';

/** One line on what a version changed, by section: "Stack changed · Run added". "created" when there was nothing before. */
export function changedSections(before: string, after: string): string {
  if (before === '') return 'created';
  const was = splitSections(before);
  const now = splitSections(after);
  const old = new Map(was.map((s, i) => [s.anchor, { s, i }]));
  const events: { pos: number; order: number; text: string }[] = [];
  now.forEach((s, i) => {
    const o = old.get(s.anchor);
    if (!o) events.push({ pos: i, order: 1, text: `${name(s.heading)} added` });
    else if (o.s.text.trim() !== s.text.trim() || o.s.heading !== s.heading) events.push({ pos: i, order: 1, text: `${name(s.heading)} changed` });
  });
  const kept = new Set(now.map((s) => s.anchor));
  was.forEach((s, i) => { if (!kept.has(s.anchor)) events.push({ pos: i, order: 0, text: `${name(s.heading)} removed` }); });
  if (events.length === 0) return 'no text changes';
  events.sort((a, b) => a.pos - b.pos || a.order - b.order);
  const shown = events.slice(0, SHOWN).map((e) => e.text);
  return events.length > SHOWN ? `${shown.join(' · ')} · +${events.length - SHOWN} more` : shown.join(' · ');
}
