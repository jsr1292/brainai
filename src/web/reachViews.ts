/** Settings › Reach from phone and web (D4). */
import { html, raw, type SafeHtml } from './html.js';
import { computerName } from '../desktop/computer.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';

export interface ReachView {
  said: string | null;
  hasPassword: boolean;
  hasAuthenticator: boolean;
  /** A QR code waiting to be confirmed: the SVG and its secret. */
  pending: { svg: string; secret: string } | null;
  /** Step 3 (Task 3): the switch, or null while the steps above are not done. */
  reach: SafeHtml | null;
}

export function reachPage(v: ReachView): SafeHtml {
  const done = html`<span class="ok">${t('setup.reach.done')}</span>`;
  const password = v.hasPassword ? html`<p>${done} ${t('setup.reach.pwDone')}</p>`
    : html`<p>${t('setup.reach.pwWhy')}</p>
<form method="post" action="/settings/reach/password" class="stack">
  <label for="pw">${t('setup.reach.password')}</label><input id="pw" name="password" type="password" minlength="12" autocomplete="new-password" required>
  <label for="pw2">${t('setup.reach.again')}</label><input id="pw2" name="again" type="password" minlength="12" autocomplete="new-password" required>
  <p><button type="submit" class="primary">${t('setup.reach.setPassword')}</button></p>
</form>`;
  const authenticator = !v.hasPassword ? html`<p class="meta">${t('setup.reach.afterPassword')}</p>`
    : v.hasAuthenticator ? html`<p>${done}</p>`
    : v.pending ? html`<p>${t('setup.reach.scan')}</p>
<div class="qr">${raw(v.pending.svg)}</div>
<p><code data-secret="${v.pending.secret}">${v.pending.secret}</code></p>
<form method="post" action="/settings/reach/authenticator/confirm" class="stack">
  <label for="code">${t('setup.reach.code')}</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required>
  <p><button type="submit" class="primary">${t('setup.reach.confirm')}</button></p>
</form>`
    : html`<p>${t('setup.reach.secondCheck')}</p>
<form method="post" action="/settings/reach/authenticator/start" class="stack">
  <label for="current">${t('setup.reach.yourPassword')}</label><input id="current" name="current" type="password" autocomplete="current-password" required>
  <p><button type="submit" class="primary">${t('setup.reach.showQr')}</button></p>
</form>`;
  return html`<div class="narrow">
<h1>${t('setup.reach.title')}</h1>
<p class="lede">${t('setup.reach.lede')}</p>
<p class="meta">${tHtml('setup.reach.awake', { computer: computerName(), link: html`<a href="/settings/move">${t('setup.reach.moveLink')}</a>` })}</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
<ol class="setup-steps">
<li><h2>${t('setup.reach.step1')}</h2>${password}</li>
<li><h2>${t('setup.reach.step2')}</h2>${authenticator}</li>
<li><h2>${t('setup.reach.step3')}</h2>${v.reach ?? html`<p class="meta">${t('setup.reach.afterTwo')}</p>`}</li>
</ol>
</div>`;
}

/** Step 3: the switch, once the password and the authenticator are set: Tailscale (no domain) or Cloudflare (yours). */
export function reachSwitch(v: {
  /** Reach is saved, but Funnel is off until Tailscale is ready: never shown as on. */
  waiting?: boolean;
  /** What Tailscale last said, while Reach waits. */
  reason?: string | null;
  on: URL | null;
  via: 'tailscale' | 'cloudflare';
  /** signingIn: Cloudflare's page while a sign-in waits ('' until cloudflared prints it), else null. */
  cloudflare: { installed: boolean; signedIn: boolean; signingIn: string | null };
}): SafeHtml {
  if (v.waiting) {
    return html`<p>${t('setup.reach.waiting')}</p>${v.reason ? html`<p class="meta">${t('setup.reach.tsSaid', { reason: v.reason })}</p>` : ''}
<form method="post" action="/settings/reach/off"><button type="submit" class="secondary">${t('setup.reach.turnOff')}</button></form>`;
  }
  if (v.on) {
    return html`<p><span class="ok">${t('setup.reach.on')}</span> ${tHtml('setup.reach.answersAt', { address: html`<code>${v.on.origin}</code>` })}${v.via === 'cloudflare' ? ` ${t('setup.reach.viaCloudflare')}` : ''}</p>
<p>${tHtml('setup.reach.onNote', { link: html`<a href="/settings/move">${t('setup.reach.moveItLink')}</a>` })}</p>
<p>${t('setup.reach.connectEach')} <a href="/settings/setup/claude">Claude</a> · <a href="/settings/setup/chatgpt">ChatGPT</a> · <a href="/settings/setup/grok">Grok</a></p>
<form method="post" action="/settings/reach/off"><button type="submit" class="secondary">${t('setup.reach.turnOff')}</button></form>`;
  }
  const cf = v.cloudflare;
  const cloudflare = !cf.installed
    ? html`<p>${tHtml('setup.reach.cfInstall', { computer: computerName(), link: html`<a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/">${t('setup.reach.getCloudflared')}</a>`, brew: html`<code>brew install cloudflared</code>` })}</p>`
    : cf.signingIn !== null
      ? html`<meta http-equiv="refresh" content="3">
<p>${t('setup.reach.cfWaiting')}${cf.signingIn ? html` ${tHtml('setup.reach.cfNoPage', { link: html`<a href="${cf.signingIn}" target="_blank" rel="noopener">${t('setup.reach.cfOpen')}</a>` })}` : ''}</p>`
    : !cf.signedIn
      ? html`<p>${t('setup.reach.cfDomain')} ${t('setup.reach.cfSignInNote')}</p>
<form method="post" action="/settings/reach/cloudflare/signin"><button type="submit" class="secondary">${t('setup.reach.cfSignIn')}</button></form>`
      : html`<p>${t('setup.reach.cfChoose')}</p>
<form method="post" action="/settings/reach/cloudflare/on" class="stack">
  <label for="hostname">${t('setup.reach.cfName')}</label><input id="hostname" name="hostname" placeholder="brain.example.com" autocapitalize="none" spellcheck="false" required>
  <p><button type="submit" class="primary">${t('setup.reach.turnOn')}</button></p>
</form>
<form method="post" action="/settings/reach/cloudflare/another"><button type="submit" class="secondary">${t('setup.reach.cfAnother')}</button></form>`;
  return html`<h3>${t('setup.reach.tsHead')}</h3>
<p>${t('setup.reach.tsGives', { computer: computerName() })}</p>
<ol>
<li>${tHtml('setup.reach.tsGet', { link: html`<a href="https://tailscale.com/download" target="_blank" rel="noopener">${t('setup.reach.tsGetLink')}</a>` })}</li>
<li>${t('setup.reach.tsPress')}</li>
</ol>
<div data-reach-tailscale="/settings/reach/tailscale" aria-live="polite"><p class="meta">${t('setup.reach.tsChecking')}</p></div>
<h3>${t('setup.reach.cfHead')}</h3>
${cloudflare}`;
}

/** What Tailscale's status check found, as the small request that fills step 3 returns it (no domain). */
export function tailscaleBox(ts: { installed: boolean; running: boolean; host: string | null; timedOut: boolean }): SafeHtml {
  const again = html`<p><button type="button" class="secondary" data-reach-recheck>${t('setup.reach.recheck')}</button></p>`;
  if (ts.timedOut) return html`<p role="status">${t('setup.reach.tsNoAnswer')}</p>${again}`;
  if (!ts.installed) return html`<p role="status">${t('setup.reach.tsNotInstalled')}</p>${again}`;
  if (!ts.running) return html`<p role="status">${t('setup.reach.tsOpen')}</p>${again}`;
  return html`<p>${tHtml('setup.reach.tsAddress', { computer: computerName(), address: html`<code>https://${ts.host}</code>` })}</p>
<form method="post" action="/settings/reach/on"><button type="submit" class="primary">${t('setup.reach.turnOn')}</button></form>`;
}
