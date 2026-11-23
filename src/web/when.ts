/**
 * One date language for every screen, in the owner's time zone: "due Fri", "4 days late", "12 min ago", "yesterday",
 * "26 Oct". Days are calendar days on the owner's clock, not 24-hour blocks, so the night the clocks change counts right.
 * ISO dates appear only in `datetime` and `title`; a date chip goes after the text, never inside the sentence.
 */
import { systemClock, type Clock } from '../clock.js';
import { localDay, localParts } from '../timezone.js';
import { html, type SafeHtml } from './html.js';
import { currentLanguage, pseudoWrap, t } from '../i18n/core.js';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let clock: Clock = systemClock;
/** Set once per app by createApp, so the views read the app's clock (the tests move it). */
export function setViewClock(c: Clock): void {
  clock = c;
}
export const viewNow = (): Date => clock();

/** Whole calendar days from one YYYY-MM-DD to another. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const esDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const esDayYear = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "26 oct" / "26 oct 2026": a calendar day has no zone, so it is formatted as UTC. */
const spanishDay = (y: number, m: number, d: number, withYear: boolean): string => (withYear ? esDayYear : esDay).format(new Date(Date.UTC(y, m - 1, d, 12)));

/** "26 Oct", with the year when it is not `thisYear`. */
export function calendar(ymd: string, thisYear: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  if (currentLanguage() === 'es') return pseudoWrap(spanishDay(y, m, d, y !== thisYear));
  return pseudoWrap(y === thisYear ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`);
}

/** A past moment: "just now", "12 min ago", "3 h ago" (same day), "yesterday", "4 days ago", then "26 Oct". */
export function pastLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const ms = now.getTime() - at.getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 60_000) return t('when.justNow');
  const thatDay = localDay(at), today = localDay(now);
  if (thatDay === today) return ms < 3_600_000 ? t('when.minAgo', { count: Math.floor(ms / 60_000) }) : t('when.hourAgo', { count: Math.floor(ms / 3_600_000) });
  const days = daysBetween(thatDay, today);
  if (days === 1) return t('when.yesterday');
  if (days < 7) return t('when.daysAgo', { count: days });
  return calendar(thatDay, Number(today.slice(0, 4)));
}

const esWeekday = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' });
const weekdayName = (ymd: string): string => {
  const at = new Date(`${ymd}T12:00:00Z`);
  return pseudoWrap(currentLanguage() === 'es' ? esWeekday.format(at).replace(/\.$/, '') : WEEKDAYS[at.getUTCDay()]!);
};

/** A due date (YYYY-MM-DD) against today: late in red, within a week amber, otherwise plain. */
export function dueLabel(due: string, today: string): { text: string; tone: 'late' | 'soon' | 'plain' } {
  const n = daysBetween(today, due);
  if (n < 0) return { text: t('when.dayLate', { count: -n }), tone: 'late' };
  if (n === 0) return { text: t('when.dueToday'), tone: 'soon' };
  if (n === 1) return { text: t('when.dueTomorrow'), tone: 'soon' };
  if (n < 7) return { text: t('when.dueDay', { day: weekdayName(due) }), tone: 'soon' };
  return { text: t('when.dueDate', { date: calendar(due, Number(today.slice(0, 4))) }), tone: n === 7 ? 'soon' : 'plain' };
}

/** A past moment as a <time>: the label in words, the full local date in the tooltip. */
export function timeAgo(iso: string, now: Date = viewNow()): SafeHtml {
  const p = localParts(iso);
  return html`<time datetime="${iso}" title="${t('when.full', { weekday: p.weekday, day: p.day, month: p.month, year: p.year, time: p.time })}">${pastLabel(iso, now)}</time>`;
}

/** A due date as a chip, to put after the text it belongs to. */
export function dueChip(due: string, today: string): SafeHtml {
  const d = dueLabel(due, today);
  return html`<span class="chip ${d.tone}"><time class="day" datetime="${due}">${d.text}</time></span>`;
}
