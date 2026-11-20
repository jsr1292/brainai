import { t } from '../i18n/index.js';
import { html, type SafeHtml } from './html.js';

/** What /growth and /map show while developer coaching is off: a short note and a link to the switch. The data is kept. */
export function coachingOffView(): SafeHtml {
  return html`<h1>${t('coaching.off.title')}</h1>
<p>${t('coaching.off.body')}</p>
<p><a href="/settings#coaching">${t('coaching.off.link')}</a></p>`;
}
