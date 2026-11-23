/** Guided setup (round 2 §17b): one app's page, three steps, and its check line. */
import type { GrantInfo } from '../auth/provider.js';
import { matchesKnownHosts, type Refused } from '../auth/refusedRedirects.js';
import { SETUP_VERSION, appOfGrant, type SetupApp } from '../setup/texts.js';
import { when } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { catalogOf, t, tKey, type Key, type PlainKey } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';

/** A box with text to copy; `aria` is the key of the button's spoken name ("Copy the address"). */
export const copyBox = (text: string, aria: PlainKey) =>
  html`<div class="copy-box"><pre>${text}</pre><button type="button" class="secondary" data-copy="${text}" aria-label="${tKey(aria)}">${t('setup.copy')}</button></div>`;

/** One app's own sentence (connect, where): a key per app, else the English text the app carries. */
function appText(kind: 'connect' | 'where', app: SetupApp, fallback: string, params: Record<string, string>): string {
  const key = `setup.${kind}.${app.slug}`;
  return catalogOf('en')[key] === undefined ? fallback : tKey(key as Key, params);
}

/** The check line: whether this app's connection reports the newest setup text. */
export function setupStatusLine(app: SetupApp, grants: readonly GrantInfo[], version = SETUP_VERSION): SafeHtml {
  if (app.reports === false) return html`<span class="ok">${t('setup.status.discussionsOnly', { app: app.name })}</span>`;
  const mine = grants.filter((g) => !g.revokedAt && appOfGrant(g.clientName) === app.slug)
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
  if (mine.length === 0) return html`<span class="attention">${t('setup.status.none', { app: app.name })}</span>`;
  const behind = mine.find((g) => g.setupVersion === null || g.setupVersion !== version);
  if (!behind) return html`<span class="ok">${t('setup.status.upToDate', { name: mine[0]!.clientName, version })}</span>`;
  return behind.setupVersion === null
    ? html`<span class="attention">${t('setup.status.noReport', { name: behind.clientName })}</span>`
    : html`<span class="attention">${tHtml('setup.status.behind', { name: behind.clientName, version: behind.setupVersion, when: when(behind.setupSeenAt!) })}</span>`;
}

/**
 * Step 1's allow part: an app whose sign-in address is not allowed from the start (ChatGPT, Grok, Codex) gets one
 * button for it; any address an app was refused lately is listed with its own Allow, so no terminal is needed.
 */
function allowBlock(app: SetupApp, a: { allowed: boolean; refused: readonly Refused[] }): SafeHtml {
  const own = !app.allow?.length ? html``
    : a.allowed ? html`<p class="ok">${t('setup.allow.ok', { app: app.name })}</p>`
    : html`<p>${t('setup.allow.only')}</p><form method="post" action="/settings/setup/${app.slug}/allow" class="inline"><button type="submit" class="primary">${t('setup.allow.button', { app: app.name })}</button></form>`;
  const form = (uri: string, label: string) => html`<form method="post" action="/settings/setup/${app.slug}/allow" class="inline"><input type="hidden" name="uri" value="${uri}"><button type="submit" class="secondary">${label}</button></form>`;
  // The caller chooses its own name, so an address is offered with it only on the page of the app whose known hosts it uses.
  const mine = a.refused.filter((r) => matchesKnownHosts(r.uri, app.allow));
  const unknown = a.refused.filter((r) => !matchesKnownHosts(r.uri, app.allow));
  const refused = mine.length === 0 ? html``
    : html`<div class="refused"><p><strong>${t('setup.refused.title')}</strong> ${t('setup.refused.note')}</p><ul>${mine.map((r) =>
      html`<li>${tHtml('setup.refused.item', { name: html`<bdi>${r.clientName}</bdi>`, host: html`<strong>${new URL(r.uri).host}</strong>` })} <code>${r.uri}</code> ${form(r.uri, t('setup.allow.short'))}</li>`)}</ul></div>`;
  const other = unknown.length === 0 ? html``
    : html`<details class="refused"><summary>${t('setup.refused.unknown.title')}</summary><p class="notice error" role="alert">${t('setup.refused.unknown.warning')}</p><ul>${unknown.map((r) =>
      html`<li>${tHtml('setup.refused.unknown.item', { host: html`<strong>${new URL(r.uri).host}</strong>` })} <code>${r.uri}</code> ${form(r.uri, t('setup.refused.unknown.allow'))}</li>`)}</ul></details>`;
  return html`<div id="allow">${own}${refused}${other}</div>`;
}

/** How the owner signs in: password and code when both are set; otherwise (local mode) BrainAI's window approves. */
export interface SetupContext { needsReach: boolean; signIn: 'password' | 'window'; local?: boolean }

/** The terminal tools that Tools on this Mac connects in one click; their manual steps are for another computer. */
const TOOLS_APPS = new Set(['claude-code', 'codex', 'opencode', 'gemini-cli']);
export const toolsOnThisComputer = (app: SetupApp, ctx: SetupContext): boolean => !!ctx.local && TOOLS_APPS.has(app.slug);

const toolsBox = () => html`<p class="notice">${tHtml('setup.toolsBox', { link: html`<a href="/settings/tools">${t('setup.toolsOn', { computer: computerName() })}</a>` })}</p>`;

/** A cloud app on a brain with no public address: no localhost address, no steps, just the way to Reach. */
function needsReachPage(app: SetupApp): SafeHtml {
  const note = app.withoutReach?.split('TOOLS') ?? [];
  const link = html`<a href="/settings/tools">${t('setup.toolsOn', { computer: computerName() })}</a>`;
  return html`<div class="narrow">
<h1>${t('setup.title', { app: app.name })}</h1>
<p>${app.name === 'Claude' ? t('setup.needsReach.claude', { computer: computerName() }) : t('setup.needsReach.app', { app: app.name, computer: computerName() })}</p>
<p><a class="button primary" href="/settings/reach">${t('setup.turnOnReach')}</a></p>
${app.slug === 'claude' && note.length === 2 ? html`<p class="meta">${tHtml('setup.withoutReach.claude', { link })}</p>` : note.length === 2 ? html`<p class="meta">${note[0]}${link}${note[1]}</p>` : ''}
</div>`;
}

export function setupPage(app: SetupApp, text: string, mcpUrl: string, status: SafeHtml, version = SETUP_VERSION, allow: { allowed: boolean; refused: readonly Refused[] } = { allowed: true, refused: [] }, ctx: SetupContext = { needsReach: false, signIn: 'password' }): SafeHtml {
  if (app.cloud && ctx.needsReach) return needsReachPage(app);
  const tools = toolsOnThisComputer(app, ctx);
  if (tools && ctx.needsReach) return html`<div class="narrow">
<h1>${t('setup.title', { app: app.name })}</h1>
${toolsBox()}
<p>${t('setup.toolsNeedReach')}</p>
<p><a class="button primary" href="/settings/reach">${t('setup.turnOnReach')}</a></p>
</div>`;
  // A local brain is named brainai in the tools, as Tools on this Mac names it; elsewhere the assistants' own habit, memory.
  const name = ctx.local ? 'brainai' : 'memory';
  const connect = appText('connect', app, app.connect.replaceAll('NAME', name).replace('ADDRESS', mcpUrl), { name, address: mcpUrl });
  return html`<div class="narrow">
<h1>${t('setup.title', { app: app.name })}</h1>
${tools ? toolsBox() : ''}
<p class="lede">${t('setup.lede', { app: app.name })}</p>
<ol class="setup-steps">
<li><h2>${t('setup.step.connect')}</h2>${allowBlock(app, allow)}<p>${connect}</p>
${copyBox(mcpUrl, 'setup.copy.address')}
<p class="meta">${ctx.signIn === 'password' ? t('setup.signIn.password') : t('setup.signIn.window')}</p></li>
<li><h2>${t('setup.step.paste')}</h2><p>${appText('where', app, app.where, {})}</p>
${copyBox(text, 'setup.copy.setupText')}
<p class="meta">${t('setup.version', { version })}</p></li>
<li><h2>${t('setup.step.check')}</h2><p>${tHtml('setup.checkSay', { phrase: html`<em>${t('setup.checkPhrase')}</em>` })}</p>
<p class="conn-setup" data-setup-status="/settings/setup/${app.slug}/status">${status}</p>
<p class="meta">${t('setup.updates')}</p></li>
</ol>
</div>`;
}
