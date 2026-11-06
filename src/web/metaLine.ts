import { html, SafeHtml } from './html.js';

/**
 * A meta line ("you · yesterday · 2 versions") as a list, one item per part and no whitespace between tags. Each part
 * carries its own dot (CSS), and the first part on each line has its dot clipped, so a wrapped line never starts with
 * "·" and an empty part leaves no stray separator.
 */
export function metaLine(parts: Array<SafeHtml | string | null | undefined | false>, opts: { big?: boolean } = {}): SafeHtml {
  const shown = parts.filter((p): p is SafeHtml | string => (p instanceof SafeHtml ? p.value !== '' : typeof p === 'string' && p !== ''));
  if (shown.length === 0) return html``;
  return html`<ul class="meta-line${opts.big ? ' big' : ''}">${shown.map((p) => html`<li>${p}</li>`)}</ul>`;
}
