/** Guided setup (round 2 §17b): one app's page, three steps, and its check line. */
import type { GrantInfo } from '../auth/provider.js';
import type { Refused } from '../auth/refusedRedirects.js';
import { SETUP_VERSION, appOfGrant, type SetupApp } from '../setup/texts.js';
import { when } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';

const copyBox = (text: string, label: string) =>
  html`<div class="copy-box"><pre>${text}</pre><button type="button" class="secondary" data-copy="${text}" aria-label="Copy ${label}">Copy</button></div>`;

/** The check line: whether this app's connection reports the newest setup text. */
export function setupStatusLine(app: SetupApp, grants: readonly GrantInfo[], version = SETUP_VERSION): SafeHtml {
  if (app.reports === false) return html`<span class="ok">Discussions only: ${app.name} has no setup number to report. Ask it to join a discussion to check it works.</span>`;
  const mine = grants.filter((g) => !g.revokedAt && appOfGrant(g.clientName) === app.slug)
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
  if (mine.length === 0) return html`<span class="attention">No ${app.name} connection yet: do step 1 first.</span>`;
  const behind = mine.find((g) => g.setupVersion === null || g.setupVersion !== version);
  if (!behind) return html`<span class="ok">${mine[0]!.clientName} reports setup text ${version} · up to date ✓</span>`;
  return behind.setupVersion === null
    ? html`<span class="attention">Waiting: ${behind.clientName} hasn’t reported a setup text yet.</span>`
    : html`<span class="attention">Waiting: ${behind.clientName} last reported setup text ${behind.setupVersion}, ${when(behind.setupSeenAt!)}.</span>`;
}

/**
 * Step 1's allow part: an app whose sign-in address is not allowed from the start (ChatGPT, Grok, Codex) gets one
 * button for it; any address an app was refused lately is listed with its own Allow, so no terminal is needed.
 */
function allowBlock(app: SetupApp, a: { allowed: boolean; refused: readonly Refused[] }): SafeHtml {
  const own = !app.allow?.length ? html``
    : a.allowed ? html`<p class="ok">${app.name} may sign in ✓</p>`
    : html`<p>BrainAI only accepts sign-ins from apps you allow.</p><form method="post" action="/settings/setup/${app.slug}/allow" class="inline"><button type="submit" class="primary">Allow ${app.name} to sign in</button></form>`;
  const refused = a.refused.length === 0 ? html``
    : html`<div class="refused"><p><strong>Refused lately.</strong> Allow only an address you recognise from an app you are connecting.</p><ul>${a.refused.map((r) =>
      html`<li>An app calling itself “<bdi>${r.clientName}</bdi>” tried to sign in from <strong>${new URL(r.uri).host}</strong> <code>${r.uri}</code> <form method="post" action="/settings/setup/${app.slug}/allow" class="inline"><input type="hidden" name="uri" value="${r.uri}"><button type="submit" class="secondary">Allow</button></form></li>`)}</ul></div>`;
  return html`<div id="allow">${own}${refused}</div>`;
}

export function setupPage(app: SetupApp, text: string, mcpUrl: string, status: SafeHtml, version = SETUP_VERSION, allow: { allowed: boolean; refused: readonly Refused[] } = { allowed: true, refused: [] }): SafeHtml {
  return html`<div class="narrow">
<h1>Set up ${app.name}</h1>
<p class="lede">Three steps. This page knows when ${app.name} runs the newest setup text.</p>
<ol class="setup-steps">
<li><h2>Connect</h2>${allowBlock(app, allow)}<p>${app.connect.replace('ADDRESS', mcpUrl)}</p>
${copyBox(mcpUrl, 'the address')}
<p class="meta">You sign in with your brain password and code, then pick its access.</p></li>
<li><h2>Paste the setup text</h2><p>${app.where}</p>
${copyBox(text, 'the setup text')}
<p class="meta">Setup text ${version}. It holds no profile facts and no secrets.</p></li>
<li><h2>Check</h2><p>Start a new chat or session and say <em>load my profile</em>.</p>
<p class="conn-setup" data-setup-status="/settings/setup/${app.slug}/status">${status}</p>
<p class="meta">This line updates by itself while the page is open.</p></li>
</ol>
</div>`;
}
