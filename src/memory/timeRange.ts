/*
 * B10: the time a question asks about ("last week", "en octubre", "hace 3 días"), read by rules, never by a model, as an
 * inclusive range of the owner's days (OWNER_TIMEZONE). Anything it does not recognise gives no range, and recall then
 * ranks as before. A wrong range is worse than none: a bare "3 may" or "en mar" is not read.
 */
import { localDay } from '../timezone.js';

export interface DayRange { from: string; to: string }

/** The start of every "before X" range: earlier than any fact the brain can hold. */
export const EPOCH = '1970-01-01';
/** "Recently" and its Spanish words: the last 14 days, today included. */
const RECENT_DAYS = 14;
/** "N days ago" is a little vague: two days either side. */
const AGO_SLACK = 2;

const EN: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
};
const MONTHS: Record<string, number> = { ...EN, ...ES };
const alt = (o: Record<string, number>) => `(${Object.keys(o).sort((a, b) => b.length - a.length).join('|')})`;
const MONTH = alt(MONTHS);
/** A year after a day or a month: "3 May 2025", "8 May, 2023", "3 de noviembre de 2025", "octubre de 2025". */
const YEAR = '(?:,? (?:de )?(\\d{4}))?';
/** English words that are also months, read as months only with a lead word or a year ("on 3 may", "3 may 2025"). */
const AMBIGUOUS = new Set(['may', 'mar']);

/** A calendar day as numbers, worked on in UTC so no clock change can shift it. */
type Day = { y: number; m: number; d: number };
const toUtc = (x: Day) => Date.UTC(x.y, x.m - 1, x.d);
const fromUtc = (t: number): Day => { const d = new Date(t); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const addDays = (x: Day, n: number): Day => fromUtc(toUtc(x) + n * 86_400_000);
const iso = (x: Day) => `${String(x.y).padStart(4, '0')}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
const lastOfMonth = (y: number, m: number): Day => fromUtc(Date.UTC(y, m, 0));
const before = (a: Day, b: Day) => toUtc(a) < toUtc(b);
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= lastOfMonth(y, m).d;

/** The owner's calendar day of an instant (OWNER_TIMEZONE, as everywhere in the app). */
function dayOf(t: Date): Day {
  const [y, m, d] = localDay(t).split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** Lower case, accents gone ("últimamente" → "ultimamente"), so one rule reads both spellings. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** A month with no year: the most recent one that is not in the future. */
const monthYear = (m: number, today: Day) => (m <= today.m ? today.y : today.y - 1);
/** A day with no year: the most recent one that is not in the future. */
function dayYear(m: number, d: number, today: Day): number {
  return before({ y: today.y, m, d }, addDays(today, 1)) ? today.y : today.y - 1;
}

/** "3 May", "3 de mayo", with an optional year: the day, or null when it doesn't exist. */
function namedDay(d: number, month: string, year: string | undefined, today: Day): Day | null {
  const m = MONTHS[month]!;
  const y = year ? +year : dayYear(m, d, today);
  return valid(y, m, d) ? { y, m, d } : null;
}

/** A point named in a "since" or "before": a date (its day) or a month (its first day). */
function point(text: string, today: Day): Day | null {
  const isoM = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoM) { const [y, m, d] = [+isoM[1]!, +isoM[2]!, +isoM[3]!]; return valid(y, m, d) ? { y, m, d } : null; }
  const dayM = new RegExp(`^(\\d{1,2})(?: de)? ${MONTH}\\b${YEAR}`).exec(text);
  if (dayM) return namedDay(+dayM[1]!, dayM[2]!, dayM[3], today);
  const monthM = new RegExp(`^${MONTH}\\b${YEAR}`).exec(text);
  if (monthM) { const m = MONTHS[monthM[1]!]!; return { y: monthM[2] ? +monthM[2] : monthYear(m, today), m, d: 1 }; }
  return null;
}

/** The relative times: today, yesterday, the day before, this or last week or month, the last 7 or 30 days, recently. */
function relative(q: string, today: Day): { from: Day; to: Day } | null {
  if (/ (anteayer|antes de ayer|day before yesterday) /.test(q)) { const d = addDays(today, -2); return { from: d, to: d }; }
  if (/ (today|hoy) /.test(q)) return { from: today, to: today };
  if (/ (yesterday|ayer) /.test(q)) { const y = addDays(today, -1); return { from: y, to: y }; }
  // "in the last week", "the past month": the days up to today, not the calendar week or month before.
  const rolling = / the (?:last|past) (week|month) /.exec(q);
  if (rolling) return { from: addDays(today, rolling[1] === 'week' ? -6 : -29), to: today };
  const monday = addDays(today, -((new Date(toUtc(today)).getUTCDay() + 6) % 7));
  if (/ (last week|la semana pasada) /.test(q)) return { from: addDays(monday, -7), to: addDays(monday, -1) };
  if (/ (this week|esta semana) /.test(q)) return { from: monday, to: today };
  if (/ (last month|el mes pasado) /.test(q)) {
    const m = today.m === 1 ? 12 : today.m - 1; const y = today.m === 1 ? today.y - 1 : today.y;
    return { from: { y, m, d: 1 }, to: lastOfMonth(y, m) };
  }
  if (/ (this month|este mes) /.test(q)) return { from: { y: today.y, m: today.m, d: 1 }, to: today };
  if (/ (recently|lately|ultimamente|recientemente) /.test(q)) return { from: addDays(today, -(RECENT_DAYS - 1)), to: today };
  return null;
}

/** The days a question asks about, or null when it names no time this reader knows. The first rule that matches wins. */
export function parseTimeRange(query: string, now: Date): DayRange | null {
  const q = ` ${fold(query).replace(/[¿?¡!.;:()"]/g, ' ').replace(/,(?! \d{4})/g, ' ').replace(/\s+/g, ' ').trim()} `
    // "Nowadays" is not today.
    .replace(/ hoy (?:en dia|dia|por hoy) /g, ' ');
  const today = dayOf(now);
  const out = (from: Day, to: Day): DayRange => ({ from: iso(from), to: iso(before(today, to) ? today : to) });

  // Since / before a date, a month or a relative time: they carry their own time, so they come first.
  const since = / (?:since|desde) ((?:el |la )?(.+))$/.exec(q);
  if (since) {
    const p = point(since[2]!.trim(), today);
    if (p) return out(p, today);
    // The article stays for the relative words ("desde la semana pasada").
    const rel = relative(` ${since[1]!.trim()} `, today);
    if (rel) return out(rel.from, today);
  }
  const prior = / (?:before|antes de) (?:el |la )?(.+)$/.exec(q);
  if (prior && !/^ayer\b/.test(prior[1]!)) { const p = point(prior[1]!.trim(), today); if (p) return { from: EPOCH, to: iso(addDays(p, -1)) }; }

  // N days or weeks ago, give or take two days.
  const ago = / (\d{1,3}) (days?|weeks?) ago | hace (\d{1,3}) (dias?|semanas?) /.exec(q);
  if (ago) {
    const n = Number(ago[1] ?? ago[3]);
    const unit = ago[2] ?? ago[4]!;
    const at = addDays(today, -n * (/^(week|semana)/.test(unit) ? 7 : 1));
    return out(addDays(at, -AGO_SLACK), addDays(at, AGO_SLACK));
  }

  // A single day: ISO; "3 Nov" or "3 de noviembre" with a lead word ("on", "el") or a year.
  const isoDay = / (\d{4})-(\d{2})-(\d{2}) /.exec(q);
  if (isoDay) { const [y, m, d] = [+isoDay[1]!, +isoDay[2]!, +isoDay[3]!]; if (valid(y, m, d)) return { from: iso({ y, m, d }), to: iso({ y, m, d }) }; }
  for (const x of q.matchAll(new RegExp(` (?:(on|el|del|until|hasta|by) )?(\\d{1,2})( de)? ${MONTH}${YEAR}(?= )`, 'g'))) {
    const [, lead, d, de, month, year] = x;
    // "3 de noviembre" reads as a day; "the 3 may need" and "the top 5 mar scores" do not.
    const spanish = de !== undefined && month! in ES;
    if (!lead && !year && !spanish) continue;
    if (!lead && !year && AMBIGUOUS.has(month!)) continue;
    const day = namedDay(+d!, month!, year, today);
    if (day) return { from: iso(day), to: iso(day) };
  }

  const rel = relative(q, today);
  if (rel) return out(rel.from, rel.to);

  // In a month, with or without its year: English after "in", Spanish after "en".
  const inMonth = new RegExp(` (?:(?:in|during) ${alt(EN)}|(?:en|durante) ${alt(ES)})${YEAR} `).exec(q);
  if (inMonth) {
    const m = MONTHS[inMonth[1] ?? inMonth[2]!]!; const y = inMonth[3] ? +inMonth[3] : monthYear(m, today);
    return out({ y, m, d: 1 }, lastOfMonth(y, m));
  }
  return null;
}

/** The days a fact belongs to: the day it was saved, and every valid ISO date written in its text or its keys. */
export function factDates(m: { createdAt: string; content: string; keys: string }): string[] {
  const days = new Set([iso(dayOf(new Date(m.createdAt)))]);
  for (const x of `${m.content} ${m.keys}`.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    if (valid(+x[1]!, +x[2]!, +x[3]!)) days.add(x[0]);
  }
  return [...days];
}

/** Today for the owner, as YYYY-MM-DD. */
export function todayIn(now: Date): string {
  return iso(dayOf(now));
}

/** A real calendar day written YYYY-MM-DD (no 30 February). */
export function isDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m !== null && valid(+m[1]!, +m[2]!, +m[3]!);
}
