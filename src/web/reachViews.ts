/** Settings › Reach from phone and web (D4). */
import { html, raw, type SafeHtml } from './html.js';

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
  const done = html`<span class="ok">Done ✓</span>`;
  const password = v.hasPassword ? html`<p>${done} Browsers now ask for it; the app's window stays signed in.</p>`
    : html`<p>Anyone who reaches BrainAI from the internet needs it, so it comes first. At least 12 characters.</p>
<form method="post" action="/settings/reach/password" class="stack">
  <label for="pw">Password</label><input id="pw" name="password" type="password" minlength="12" autocomplete="new-password" required>
  <label for="pw2">The same again</label><input id="pw2" name="again" type="password" minlength="12" autocomplete="new-password" required>
  <p><button type="submit" class="primary">Set the password</button></p>
</form>`;
  const authenticator = !v.hasPassword ? html`<p class="meta">After the password.</p>`
    : v.hasAuthenticator ? html`<p>${done}</p>`
    : v.pending ? html`<p>Scan this with your authenticator app (or type the code under it), then enter the 6-digit code it shows.</p>
<div class="qr">${raw(v.pending.svg)}</div>
<p><code data-secret="${v.pending.secret}">${v.pending.secret}</code></p>
<form method="post" action="/settings/reach/authenticator/confirm" class="stack">
  <label for="code">Code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required>
  <p><button type="submit" class="primary">Confirm</button></p>
</form>`
    : html`<p>A second check when you sign in from a browser: a 6-digit code from an app such as 1Password, Google Authenticator or the iPhone's Passwords.</p>
<form method="post" action="/settings/reach/authenticator/start" class="stack">
  <label for="current">Your password</label><input id="current" name="current" type="password" autocomplete="current-password" required>
  <p><button type="submit" class="primary">Show the QR code</button></p>
</form>`;
  return html`<div class="narrow">
<h1>Reach from phone and web</h1>
<p class="lede">Use this BrainAI from Claude, ChatGPT and Grok on the web and your phone, keeping every memory and every tool you connected.</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
<ol class="setup-steps">
<li><h2>Set a password</h2>${password}</li>
<li><h2>Add BrainAI to your authenticator</h2>${authenticator}</li>
<li><h2>Turn it on</h2>${v.reach ?? html`<p class="meta">After the two steps above.</p>`}</li>
</ol>
</div>`;
}

/** Step 3: the switch, once the password and the authenticator are set: Tailscale (no domain) or Cloudflare (yours). */
export function reachSwitch(v: {
  on: URL | null;
  via: 'tailscale' | 'cloudflare';
  tailscale: { installed: boolean; running: boolean; host: string | null };
  /** signingIn: Cloudflare's page while a sign-in waits ('' until cloudflared prints it), else null. */
  cloudflare: { installed: boolean; signedIn: boolean; signingIn: string | null };
}): SafeHtml {
  if (v.on) {
    return html`<p><span class="ok">On ✓</span> BrainAI answers at <code>${v.on.origin}</code>${v.via === 'cloudflare' ? ' (through Cloudflare)' : ''}</p>
<p>Phone and web reach BrainAI only while this Mac is on and awake. The tools on this Mac keep using it directly. Need it always on? <a href="/settings/move">Move it to a server</a>.</p>
<p>Connect each app with the address on its page: <a href="/settings/setup/claude">Claude</a> · <a href="/settings/setup/chatgpt">ChatGPT</a> · <a href="/settings/setup/grok">Grok</a></p>
<form method="post" action="/settings/reach/off"><button type="submit" class="secondary">Turn off</button></form>`;
  }
  const tailscale = !v.tailscale.installed
    ? html`<p>Free, and no domain needed. <a href="https://tailscale.com/download/mac">Install Tailscale</a>, sign in, then come back here.</p>`
    : !v.tailscale.running ? html`<p>Open Tailscale and sign in, then come back here.</p>`
    : html`<p>This Mac's public address will be <code>https://${v.tailscale.host}</code>. Tailscale may ask you to allow Funnel the first time.</p>
<form method="post" action="/settings/reach/on"><button type="submit" class="primary">Turn on</button></form>`;
  const cf = v.cloudflare;
  const cloudflare = !cf.installed
    ? html`<p>For a domain you already have on Cloudflare. <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/">Install cloudflared</a> (or <code>brew install cloudflared</code>), then come back here.</p>`
    : cf.signingIn !== null
      ? html`<meta http-equiv="refresh" content="3">
<p>Waiting for you to sign in to Cloudflare and choose your domain in the browser.${cf.signingIn ? html` If no page opened, <a href="${cf.signingIn}" target="_blank" rel="noopener">open Cloudflare's page</a>.` : ''}</p>`
    : !cf.signedIn
      ? html`<p>For a domain you already have on Cloudflare. Cloudflare's page opens in your browser: sign in and choose the domain.</p>
<form method="post" action="/settings/reach/cloudflare/signin"><button type="submit" class="secondary">Sign in to Cloudflare</button></form>`
      : html`<p>Choose the name BrainAI answers at, under your domain. BrainAI adds it in Cloudflare and never replaces a name you already use.</p>
<form method="post" action="/settings/reach/cloudflare/on" class="stack">
  <label for="hostname">Name</label><input id="hostname" name="hostname" placeholder="brain.example.com" autocapitalize="none" spellcheck="false" required>
  <p><button type="submit" class="primary">Turn on</button></p>
</form>
<form method="post" action="/settings/reach/cloudflare/another"><button type="submit" class="secondary">Use another Cloudflare domain</button></form>`;
  return html`<h3>Without a domain: Tailscale</h3>
${tailscale}
<h3>With your own domain: Cloudflare</h3>
${cloudflare}`;
}
