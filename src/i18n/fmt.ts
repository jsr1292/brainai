/** Dates, numbers and sizes in the request's locale (en-GB / es-ES). Dates read in the owner's time zone. */
import { ownerTimeZone } from '../timezone.js';
import { currentLanguage, pseudoWrap } from './core.js';

const intlTag = (): string => (currentLanguage() === 'es' ? 'es-ES' : 'en-GB');
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();
function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(key: string, make: () => T): T {
  let f = cache.get(key);
  if (f === undefined) { f = make(); cache.set(key, f); }
  return f as T;
}
const cachedNumber = (max: number, min: number, grouping = true): Intl.NumberFormat => {
  const tag = intlTag();
  return cached(`n ${tag} ${max} ${min} ${grouping}`, () => new Intl.NumberFormat(tag, { maximumFractionDigits: max, minimumFractionDigits: min, useGrouping: grouping }));
};
const asDate = (v: string | number | Date): Date => (v instanceof Date ? v : new Date(v));

export const fmt = {
  /** "19 Nov 2026" / "19 nov 2026". */
  date(v: string | number | Date): string {
    const tag = intlTag(), zone = ownerTimeZone();
    return pseudoWrap(cached(`d ${tag} ${zone}`, () => new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone })).format(asDate(v)));
  },
  /** "19 Nov 2026, 14:30" / "19 nov 2026, 14:30". */
  dateTime(v: string | number | Date): string {
    const tag = intlTag(), zone = ownerTimeZone();
    return pseudoWrap(cached(`dt ${tag} ${zone}`, () => new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone })).format(asDate(v)));
  },
  /** "1,234.5" / "1234,5" (Spanish writes no separator in four digits). */
  number(n: number, maxFractionDigits = 1, minFractionDigits = 0): string {
    return pseudoWrap(cachedNumber(maxFractionDigits, minFractionDigits).format(n));
  },
  /**
   * "812 KB", "1.2 MB" / "1,2 MB": the Settings sizes. English is byte-for-byte what BrainAI always printed: whole KB under
   * 1 MB, otherwise MB with one decimal ("1536.0 MB", never GB, no thousands separator in sizes). Spanish only swaps the decimal comma.
   */
  size(bytes: number): string {
    if (bytes < 1024 * 1024) return pseudoWrap(`${cachedNumber(0, 0, false).format(Math.round(bytes / 1024))} KB`);
    const mb = (bytes / 1048576).toFixed(1);
    return pseudoWrap(`${currentLanguage() === 'es' ? mb.replace('.', ',') : mb} MB`);
  },
};
