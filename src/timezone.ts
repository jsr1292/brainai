import { currentLanguage, pseudoWrap, tKey } from './i18n/core.js';

/**
 * The owner's time zone, the one source for weeks, "today", late items and quiet projects. It is read from
 * OWNER_TIMEZONE on every call (default: this machine's zone), so changing it changes new weeks; stored weeks keep their Mondays.
 */
/** This machine's zone (UTC in a Docker image without TZ): OWNER_TIMEZONE overrides it. */
export const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const ownerTimeZone = (): string => process.env.OWNER_TIMEZONE || DEFAULT_TIME_ZONE;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(kind: string, options: Intl.DateTimeFormatOptions, locale = 'en-GB'): Intl.DateTimeFormat {
  const zone = ownerTimeZone();
  const key = `${zone} ${kind} ${locale}`;
  let f = formats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formats.set(key, f);
  }
  return f;
}

/** Milliseconds the owner's zone is ahead of UTC at `at`. */
export function zoneOffsetMs(at: number): number {
  const p = Object.fromEntries(format('offset', {
    hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }, 'en-US').formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000;
}

/** YYYY-MM-DD of this moment in the owner's time zone. */
export const localDay = (d: Date): string => format('day', { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(d);

/** The parts of a moment as the owner's calendar and clock show them, in the request's language. */
export function localParts(iso: string): { weekday: string; weekdayShort: string; day: number; month: string; monthShort: string; year: number; time: string } {
  const locale = currentLanguage() === 'es' ? 'es-ES' : 'en-GB';
  const at = new Date(iso);
  const p = Object.fromEntries(format('parts', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }, locale).formatToParts(at).map((x) => [x.type, x.value]));
  const short = Object.fromEntries(format('short', { weekday: 'short', month: 'short' }, locale).formatToParts(at).map((x) => [x.type, x.value]));
  // English keeps its three letters ("Sept" in en-GB would change old output); Spanish takes Intl's own short forms ("sept", "mié").
  const abbr = (long: string, s: string | undefined): string => (locale === 'en-GB' ? long.slice(0, 3) : (s ?? long).replace(/\.$/, ''));
  return {
    weekday: pseudoWrap(p.weekday!), weekdayShort: pseudoWrap(abbr(p.weekday!, short.weekday)), day: Number(p.day), month: pseudoWrap(p.month!), monthShort: pseudoWrap(abbr(p.month!, short.month)),
    year: Number(p.year), time: `${p.hour}:${p.minute}`,
  };
}

/** A moment as a day in the owner's time zone, like "3 Nov", with the year only when it is not this year. */
export const shortDay = (iso: string, now: Date = new Date()): string => {
  const p = localParts(iso);
  return p.year === localParts(now.toISOString()).year ? `${p.day} ${p.monthShort}` : `${p.day} ${p.monthShort} ${p.year}`;
};

/** "Thursday 29 Oct". */
export const dayWithWeekday = (iso: string): string => {
  const p = localParts(iso);
  return `${p.weekday} ${p.day} ${p.monthShort}`;
};

/** "08:14" on the owner's clock. */
/** "Wednesday 4 November": the weekday, day and month of this moment on the owner's clock (the desktop home's date line). */
export const longDate = (d: Date): string => {
  const p = localParts(d.toISOString());
  return tKey('when.longDate', { weekday: p.weekday, day: p.day, month: p.month });
};
export const timeOfDay = (iso: string): string => localParts(iso).time;
