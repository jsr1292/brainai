/**
 * "No English left" check: render a page under the pseudo-locale (every t() string comes back as ⟦…⟧) and list the visible
 * text that is NOT inside ⟦…⟧: words a translator never saw. Checked: text nodes (SVG <title> and <text> too), the text
 * attributes (placeholder, aria-label, title, alt), `value` on submit/button/reset inputs (not on <button>: there it is a code), text-bearing data-*
 * attributes (`data-goto` labels, names ending in label, title, text, placeholder, message, hint, confirm, tooltip, alt)
 * with double, single or no quotes. Skipped: script, style, code, comments and, unless `checkPre` is set, pre.
 * Brand and product names (ALLOWED_WORDS), numbers and punctuation are fine; fixture data (a project's name, a fact's text)
 * goes in `allow`. Reusable per area: `assertNoEnglishLeft(html, 'the inbox', { allow: [...] })` after rendering with
 * `runWithLocale('xx', …)`.
 */
import assert from 'node:assert/strict';
import { enablePseudoLocale } from '../i18n/core.js';
import { decodeEntities } from './entities.js';

export { decodeEntities };

/** Words (and multi-word names) that are the same in every language: product, brand and key names. A phrase is removed whole before the words are checked. */
export const ALLOWED_WORDS = new Set([
  'BrainAI', 'Claude', 'Claude Code', 'ChatGPT', 'Grok', 'Grok Build', 'Gemini', 'Gemini CLI', 'Codex', 'OpenCode', 'Cursor', 'OpenRouter', 'Hugging Face',
  'GitHub', 'Tailscale', 'Funnel', 'Cloudflare', 'Backblaze', 'B2', 'SQLite', 'Postgres', 'Docker', 'Outline', 'Mermaid', 'Markdown', 'iCloud', 'OneDrive',
  'Dropbox', 'Google Drive', 'Gemma Terms of Use', 'GLM', 'MiniMax', 'Gemma', 'npm', 'Node',
  'Mac', 'macOS', 'Windows', 'Linux', 'Android', 'iPhone', 'iPad', 'Pixel', 'Chrome', 'Safari', 'Firefox', 'Edge',
  'KB', 'MB', 'GB', 'TB', 'JSON', 'PDF', 'CSV', 'URL', 'MCP', 'OAuth', 'API', 'Ctrl', 'K', 'OK', 'AM', 'PM',
]);
const TEXT_ATTRS = new Set(['placeholder', 'aria-label', 'title', 'alt']);
const DATA_TEXT = /^data-(?:[a-z0-9-]*-)?(?:label|title|text|placeholder|message|hint|confirm|tooltip|alt)$/;

export interface CheckOptions {
  /** Fixture data shown as it is: a project's name, a fact's text. Removed from the text as a whole phrase before the words are checked; its single words are NOT allowed elsewhere. */
  allow?: readonly string[];
  /** Also check <pre> blocks (setup texts). Off by default: a <pre> is usually a command to copy. */
  checkPre?: boolean;
}

const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)))?/g;

/** The attribute pieces of a start tag that read as visible text. */
function tagTexts(tag: string): string[] {
  const out: string[] = [];
  const name = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]?.toLowerCase() ?? '';
  const attrs = new Map<string, string>();
  for (const m of tag.slice(1 + name.length).matchAll(ATTR)) attrs.set(m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  for (const [k, v] of attrs) {
    if (TEXT_ATTRS.has(k)) out.push(v);
    // `value` of a <button> is a code the server reads back, never shown; on <input type=submit|button|reset> it is the label.
    else if (k === 'value' && name === 'input' && ['submit', 'button', 'reset'].includes((attrs.get('type') ?? '').toLowerCase())) out.push(v);
    else if (k === 'data-goto') {
      try { for (const g of JSON.parse(v) as { label?: unknown }[]) if (typeof g.label === 'string') out.push(g.label); } catch { out.push(v); }
    } else if (DATA_TEXT.test(k)) out.push(v);
  }
  return out;
}

/** The pieces of visible text in a page that are not wrapped in ⟦…⟧ and hold a word that is not allowed. */
export function untranslatedText(page: string, opts: CheckOptions = {}): string[] {
  let doc = page.replace(/<!--[\s\S]*?-->/g, '');
  const strip = (tag: string): void => { doc = doc.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), ' '); };
  strip('script'); strip('style');
  if (opts.checkPre) doc = doc.replace(/<pre\b[\s\S]*?<\/pre>/gi, (pre) => pre.replace(/<\/?code\b[^>]*>/gi, ''));
  else strip('pre');
  strip('code');
  const pieces: string[] = [];
  for (const tag of doc.match(/<[a-zA-Z][^>]*>/g) ?? []) pieces.push(...tagTexts(tag));
  pieces.push(...decodeEntities(doc.replace(/<[^>]*>/g, '\n')).split('\n'));

  const phrases = [...ALLOWED_WORDS].filter((w) => w.includes(' ')).sort((a, b) => b.length - a.length);
  const fixtures = [...(opts.allow ?? [])].filter((a) => a.trim() !== '').sort((a, b) => b.length - a.length);
  const words = new Set([...ALLOWED_WORDS].filter((w) => !w.includes(' ')));

  const left: string[] = [];
  for (const piece of pieces) {
    let outside = piece.replace(/⟦[^⟧]*⟧/g, ' ');
    for (const f of fixtures) outside = outside.split(f).join(' ');
    for (const p of phrases) outside = outside.split(p).join(' ');
    // A word is a run of letters and digits; a number in front of a unit ("5GB") is dropped, a bare number is no word.
    if (outside.split(/[^\p{L}\p{N}]+/u).some((w) => { const x = w.replace(/^\p{N}+/u, ''); return x !== '' && !words.has(x); })) left.push(piece.trim());
  }
  return left;
}

/** Fails with the list of untranslated texts. */
export function assertNoEnglishLeft(page: string, what = 'page', opts: CheckOptions = {}): void {
  const left = untranslatedText(page, opts);
  assert.deepEqual(left, [], `${what}: visible text outside ⟦…⟧ (not translated):\n${left.map((x) => `  - ${x}`).join('\n')}`);
}

export { enablePseudoLocale };
