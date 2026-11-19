import { t } from '../i18n/index.js';
import { splitSections } from '../pages/markdown.js';

/** Activity: what a page edit changed, in a few words: the section it happened in and the first changed line. */
export interface PageEditSummary { heading: string | null; line: string | null }

const SHORT = 110;
const trim = (s: string): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > SHORT ? `${t.slice(0, SHORT).replace(/\s+\S*$/, '')}…` : t; };

/** Compares two versions of a page body line by line from the top; null when the text is the same. */
export function pageEditSummary(before: string, after: string): PageEditSummary | null {
  const a = before.split('\n'), b = after.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= a.length && i >= b.length) return null;
  // Past the end of the new text the edit removed lines: name the section they were in.
  const inNew = i < b.length;
  const lines = inNew ? b : a;
  let at = Math.min(i, lines.length - 1);
  if (inNew) while (at < lines.length - 1 && lines[at]!.trim() === '') at++;
  let heading: string | null = null;
  for (let j = at; j >= 0; j--) {
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(lines[j]!);
    if (h?.[1]) { heading = h[1].replace(/[*_`]/g, '').trim(); break; }
  }
  const isHeading = (l: string) => /^ {0,3}#{1,6}[ \t]/.test(l);
  const changed = inNew ? lines.slice(i).find((l) => l.trim() !== '' && !isHeading(l)) : undefined;
  return { heading: heading ? trim(heading) : null, line: inNew ? (changed ? trim(changed) : null) : t('pages.editSummary.removed') };
}

const CHANGE_SHOWN = 3;

/**
 * One line on what a version changed, by section, in the owner's language: "Stack changed · Run added", "created" when there
 * was nothing before. The same facts as `changedSections` in pages/diff.ts (which stays English for assistants and tests),
 * worded through the catalog because it is only ever shown on a screen.
 */
export function changeLine(before: string, after: string): string {
  if (before === '') return t('pages.change.created');
  const name = (heading: string): string => heading || t('pages.ed.introduction');
  const was = splitSections(before);
  const now = splitSections(after);
  const old = new Map(was.map((s, i) => [s.anchor, { s, i }]));
  const events: { pos: number; order: number; text: string }[] = [];
  now.forEach((s, i) => {
    const o = old.get(s.anchor);
    if (!o) events.push({ pos: i, order: 1, text: t('pages.change.added', { name: name(s.heading) }) });
    else if (o.s.text.trim() !== s.text.trim() || o.s.heading !== s.heading) events.push({ pos: i, order: 1, text: t('pages.change.changed', { name: name(s.heading) }) });
  });
  const kept = new Set(now.map((s) => s.anchor));
  was.forEach((s, i) => { if (!kept.has(s.anchor)) events.push({ pos: i, order: 0, text: t('pages.change.removed', { name: name(s.heading) }) }); });
  if (events.length === 0) return t('pages.change.none');
  events.sort((a, b) => a.pos - b.pos || a.order - b.order);
  const shown = events.slice(0, CHANGE_SHOWN).map((e) => e.text);
  return events.length > CHANGE_SHOWN ? `${shown.join(' · ')} · ${t('pages.change.more', { count: events.length - CHANGE_SHOWN })}` : shown.join(' · ');
}
