/** The pages of a tool's sign-in in local mode while the owner account is not fully set up: the browser waits, BrainAI's window decides. */
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';
import { html, type SafeHtml } from './html.js';

/** What the tool's browser shows while the owner decides in BrainAI's window. It asks /consent/:id/wait and goes on by itself. */
export function waitingView(id: string, clientName: string, origin: string): SafeHtml {
  return html`<h1>${t('auth.sign.wants', { client: clientName })}</h1>
<section data-consent-wait="/consent/${encodeURIComponent(id)}/wait">
<p>${tHtml('auth.sign.open', { here: computerName() })}</p>
<p>${tHtml('auth.sign.back', { origin: html`<strong>${origin}</strong>` })}</p>
<p class="quiet" data-consent-status role="status"></p>
</section>`;
}

/** Shown in the window after Approve: the browser that waits finishes the connection. */
export function approvedView(clientName: string): SafeHtml {
  return html`<h1>${t('auth.consent.approved')}</h1>
<p>${t('auth.sign.approvedText', { client: clientName })}</p>
<p><a href="/">${t('auth.sign.backHome')}</a></p>`;
}

/** Shown in the window after Deny: the waiting browser is sent back to the tool with access_denied. */
export function deniedView(clientName: string): SafeHtml {
  return html`<h1>${t('auth.consent.denied')}</h1>
<p>${t('auth.sign.deniedText', { client: clientName })}</p>
<p><a href="/">${t('auth.sign.backHome')}</a></p>`;
}
