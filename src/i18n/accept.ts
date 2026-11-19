import type { Locale } from './core.js';

/**
 * The language an Accept-Language header asks for, among the two we have: the first of English and Spanish by q (ties by
 * position), any `es` or `es-*` counting as Spanish. q=0 means "not acceptable". Nothing usable: English.
 */
export function localeFromAcceptLanguage(header: string | undefined | null): Locale {
  if (!header) return 'en';
  const found: { locale: Locale; q: number; i: number }[] = [];
  header.split(',').forEach((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const lang = tag!.trim().toLowerCase().split('-')[0];
    if (lang !== 'en' && lang !== 'es') return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (Number.isFinite(q) && q > 0) found.push({ locale: lang, q, i });
  });
  found.sort((a, b) => b.q - a.q || a.i - b.i);
  return found[0]?.locale ?? 'en';
}
