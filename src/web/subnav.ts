import { coachingShown } from './sideStatus.js';
import { t } from '../i18n/core.js';
import { html, type SafeHtml } from './html.js';

/** Quiet navigation within one place. */
export function subnav(label: string, items: { href: string; text: string }[], current: string | null, extra?: SafeHtml): SafeHtml {
  return html`<nav class="subnav" aria-label="${label}">${items.map((item) => html`<a href="${item.href}"${item.href === current ? html` aria-current="page"` : ''}>${item.text}</a>`)}${extra ? html`<span class="subnav-extra">${extra}</span>` : ''}</nav>`;
}

export function weekNav(current: 'last' | 'now' | 'growth' | 'activity' | null, extra?: SafeHtml): SafeHtml {
  const items = [{ href: '/review', text: t('shell.nav.lastWeek') }, { href: '/review/now', text: t('shell.nav.soFar') }, ...(coachingShown() ? [{ href: '/growth', text: t('shell.nav.growth') }] : []), { href: '/activity', text: t('shell.nav.activity') }];
  return subnav(t('shell.nav.week'), items, current === 'last' ? '/review' : current === 'now' ? '/review/now' : current === 'growth' ? '/growth' : current === 'activity' ? '/activity' : null, extra);
}
