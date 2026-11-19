/**
 * The strings the browser scripts need. Every page embeds the whole client catalog (a few KB) as
 * `<script type="application/json" id="i18n">`, a data block the strict CSP leaves alone; static/i18n.js reads it and defines
 * the global `T(key, englishFallback)` that every script uses. A client key is any catalog key that starts with `client.`
 * (area file `src/i18n/en/client.ts`) or `copy.`; there is no list to keep.
 */
import { currentLanguage, currentLocale, t, catalogOf, type Key } from './core.js';

const isClientKey = (k: string): boolean => k.startsWith('client.') || k.startsWith('copy.');
/** The client keys, in catalog order. */
export const clientKeys = (): Key[] => (Object.keys(catalogOf('en')) as Key[]).filter(isClientKey);

/** JSON that cannot end its <script> element or an HTML comment: < > & and the line separators are \u-escaped. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The block's JSON text per language: the client catalog is static (no params, no dates), so it is built once for `en` and once for `es`. */
const jsonByLanguage = new Map<string, string>();

/** The block's JSON text: every client key in the request's language. The pseudo-locale (tests) is never cached. */
export function clientJson(): string {
  const locale = currentLocale();
  const lang = currentLanguage();
  const cacheable = locale === 'en' || locale === 'es';
  const cached = cacheable ? jsonByLanguage.get(locale) : undefined;
  if (cached !== undefined) return cached;
  const texts: Record<string, string> = {};
  for (const k of clientKeys()) texts[k] = (t as (k: Key) => string)(k);
  const json = jsonForScript({ lang, t: texts });
  if (cacheable) jsonByLanguage.set(locale, json);
  return json;
}
