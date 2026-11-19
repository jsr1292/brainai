import { SafeHtml } from '../safeHtml.js';
import { currentLocale, templateFor } from './core.js';
import type { EntryNames, Key } from './core.js';
import type { en } from './en/index.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/**
 * A sentence with markup inside it: the catalog holds plain text with `{name}` placeholders, the template passes the
 * markup for each as SafeHtml (anything else is escaped). The catalog text itself is always escaped.
 * `tHtml('x.sentence', { link: html`<a href="/y">${t('x.link')}</a>` })`
 */
export function tHtml<K extends Key>(key: K, parts: { [N in EntryNames<(typeof en)[K]>]: SafeHtml | string | number }): SafeHtml {
  const count = (parts as Record<string, unknown>).count;
  const text = templateFor(key, typeof count === 'number' ? count : undefined);
  const pseudo = currentLocale() === 'xx';
  const out = text.split(/(\{\w+\})/).map((piece) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    // Under the pseudo-locale each run of catalog text is wrapped on its own, so markup passed in between stays outside the brackets.
    if (!m || !(m[1]! in parts)) return pseudo && piece !== '' ? `⟦${esc(piece)}⟧` : esc(piece);
    const v = (parts as Record<string, unknown>)[m[1]!];
    return v instanceof SafeHtml ? v.value : esc(String(v));
  });
  return new SafeHtml(out.join(''));
}
