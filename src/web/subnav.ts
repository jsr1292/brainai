import { html, type SafeHtml } from './html.js';

/** Quiet navigation within one place. */
export function subnav(label: string, items: { href: string; text: string }[], current: string | null, extra?: SafeHtml): SafeHtml {
  return html`<nav class="subnav" aria-label="${label}">${items.map((item) => html`<a href="${item.href}"${item.href === current ? html` aria-current="page"` : ''}>${item.text}</a>`)}${extra ? html`<span class="subnav-extra">${extra}</span>` : ''}</nav>`;
}

export function weekNav(current: 'last' | 'now' | 'growth' | null, work: boolean, extra?: SafeHtml): SafeHtml {
  const items = [{ href: '/review', text: 'Last week' }, { href: '/review/now', text: 'So far' }];
  if (!work) items.push({ href: '/growth', text: 'Growth' });
  return subnav('Week', items, current === 'last' ? '/review' : current === 'now' ? '/review/now' : current === 'growth' ? '/growth' : null, extra);
}
