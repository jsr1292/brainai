/**
 * The translation core: the request's locale (AsyncLocalStorage), `t()` and plurals. No dependency on the web layer, so
 * html.ts, when.ts and timezone.ts can use it. See docs/I18N.md.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { en } from './en/index.js';
import { es } from './es/index.js';

export type Locale = 'en' | 'es';
/** `xx` is the pseudo-locale: every translated string comes back wrapped in ⟦…⟧. Only reachable after enablePseudoLocale(). */
export type AnyLocale = Locale | 'xx';
export const LOCALES: readonly Locale[] = ['en', 'es'];

/** A string with `{name}` placeholders, or its plural forms (Intl.PluralRules categories; `other` is the fallback). */
export type Plural = { one: string; other: string; zero?: string; two?: string; few?: string; many?: string };
export type Entry = string | Plural;
export type Catalog = Record<string, Entry>;

type Names<S extends string> = S extends `${string}{${infer N}}${infer R}` ? N | Names<R> : never;
export type EntryNames<E> = E extends string ? Names<E> : E extends { one: infer O extends string; other: infer P extends string } ? Names<O> | Names<P> : never;
type EN = typeof en;
export type Key = keyof EN;
/** Keys whose text has no `{placeholders}`: safe for a table of labels, a back link or a palette row. */
export type PlainKey = { [K in Key]: [EntryNames<EN[K]>] extends [never] ? K : never }[Key];
export type Params<K extends Key> = { [N in EntryNames<EN[K]>]: string | number };

const store = new AsyncLocalStorage<AnyLocale>();
let pseudo = false;

/** Tests only: lets the pseudo-locale `xx` be chosen. Never called by the app. */
export function enablePseudoLocale(on: boolean): void {
  pseudo = on;
}
export const pseudoEnabled = (): boolean => pseudo;

/** The locale of the request being served; English outside a request (tests, background work). */
export const currentLocale = (): AnyLocale => store.getStore() ?? 'en';
/** The language of the text: the pseudo-locale reads as English. */
export const currentLanguage = (): Locale => { const l = currentLocale(); return l === 'xx' ? 'en' : l; };
export function runWithLocale<T>(locale: AnyLocale, fn: () => T): T {
  return store.run(locale === 'xx' && !pseudo ? 'en' : locale, fn);
}

const catalogs: Record<Locale, Record<string, Entry>> = { en, es };

const rules: Partial<Record<Locale, Intl.PluralRules>> = {};
const pluralRules = (locale: Locale): Intl.PluralRules => (rules[locale] ??= new Intl.PluralRules(locale === 'es' ? 'es-ES' : 'en-GB'));

function pick(entry: Entry, count: number | undefined, locale: Locale): string {
  if (typeof entry === 'string') return entry;
  const cat = pluralRules(locale).select(count ?? 0);
  return entry[cat] ?? entry.other;
}

function fill(text: string, params: Record<string, string | number> | undefined): string {
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (m, n: string) => (n in params ? String(params[n]) : m));
}

const unwrapParams = (params: Record<string, string | number> | undefined): Record<string, string | number> | undefined =>
  params === undefined ? undefined : Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/[⟦⟧]/g, '') : v]));

/** The raw template for a key in a language: English when the language has none (never throws). */
function template(key: string, locale: Locale, count: number | undefined): string | undefined {
  const entry = catalogs[locale][key] ?? catalogs.en[key];
  return entry === undefined ? undefined : pick(entry, count, catalogs[locale][key] === undefined ? 'en' : locale);
}

/** The template of a key in the current language (never pseudo-wrapped: tHtml wraps each text piece itself). */
export function templateFor(key: string, count?: number): string {
  return template(key, currentLanguage(), count) ?? key;
}

/**
 * Text that is built from locale data rather than from a catalog key (a date, a weekday, a size) comes back as ⟦…⟧ under
 * the pseudo-locale, so the "no English left" check treats it as handled by the locale. Identity in the real languages.
 */
export const pseudoWrap = (text: string): string => (currentLocale() === 'xx' ? `⟦${text}⟧` : text);

/** Translates a key into the request's language. A missing Spanish key falls back to English; an unknown key reads as itself. */
export function t<K extends Key>(key: K, ...args: [EntryNames<EN[K]>] extends [never] ? [] : [params: Params<K>]): string {
  const params = args[0] as Record<string, string | number> | undefined;
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const l = currentLocale();
  const text = template(key, l === 'xx' ? 'en' : l, count);
  if (text === undefined) return key;
  // Under the pseudo-locale a param that is itself a translation (⟦…⟧) loses its own brackets, so they never nest.
  const out = fill(text, l === 'xx' ? unwrapParams(params) : params);
  return l === 'xx' ? `⟦${out}⟧` : out;
}

/** The text of a key in a given language, for the checks and the browser JSON (no pseudo wrapping, no request needed). */
export function tIn<K extends Key>(locale: Locale, key: K, ...args: [EntryNames<EN[K]>] extends [never] ? [] : [params: Params<K>]): string {
  return runWithLocale(locale, () => t(key, ...args));
}

export const catalogOf = (locale: Locale): Record<string, Entry> => catalogs[locale];

/** `t` for a key held in a variable (a table of labels): the key's params, if it has any, are not checked. */
export const tKey = t as (key: Key, params?: Record<string, string | number>) => string;
