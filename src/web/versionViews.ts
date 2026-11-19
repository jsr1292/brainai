/** Settings › Version: what is running, when the last update check went well, and a "Check for updates" button. */
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { html, type SafeHtml } from './html.js';
import { when } from './dashboardViews.js';
import { updateLine, type UpdateCheck, type UpdateFile } from '../desktop/updateState.js';
import { RELEASE_PAGE_URL, type ReleaseResult } from '../desktop/releaseCheck.js';

/** A good check this recent is enough to say "you have the latest version" (the app looks once a day). */
const RECENT_S = 3 * 86_400;
/** The button rests this long after a check (the app and the server ignore a press sooner). */
export const CHECK_GAP_S = 30;

export interface VersionPanelInput {
  brain: string;
  database: number;
  now: Date;
  /** The app: update-check.json, the failing-check warning (updateCheckProblem), and update.json when an update is known. */
  desktop?: { check: UpdateCheck | null; problem: { since: string; error?: string } | null; update: UpdateFile | null };
  /** A server: the answer of the last press of Check for updates, kept in memory (none = not pressed yet). */
  server?: { at: string; result: ReleaseResult } | null;
  /** A server: set when the owner pressed too soon (the page says to wait). */
  tooSoon?: boolean;
}

const iso = (s: number) => new Date(s * 1000).toISOString();
/** The newest check of any kind, in unix seconds (0 = none). The page polls for this to grow. */
export const lastAttempt = (c: UpdateCheck | null): number => Math.max(c?.lastOkAt ?? 0, c?.lastFailAt ?? 0);

function desktopBody(v: VersionPanelInput, d: NonNullable<VersionPanelInput['desktop']>): SafeHtml {
  const nowS = Math.floor(v.now.getTime() / 1000);
  const since = lastAttempt(d.check);
  const failing = d.check?.failingSince !== undefined;
  const recentOk = d.check?.lastOkAt !== undefined && nowS - d.check.lastOkAt < RECENT_S && !failing;
  const lastOk = d.check?.lastOkAt !== undefined ? html`<p class="meta"><span>${tHtml('settings.ver.lastChecked', { when: when(iso(d.check.lastOkAt)) })}</span></p>` : html`<p class="meta"><span>${t('settings.ver.never')}</span></p>`;
  const problem = d.problem
    ? html`<p class="attention">${tHtml('settings.ver.problem', { since: d.problem.since })}</p>${d.problem.error ? html`<p class="meta">${d.problem.error}</p>` : ''}<p class="meta">${t('settings.ver.proxy')}</p>`
    : '';
  let status: SafeHtml;
  if (d.update) {
    const line = updateLine(d.update);
    const action = line.busy ? html`<p class="meta">${line.text}</p>`
      : d.update.state === 'blocked' ? html`<p class="meta">${line.text}</p><p><a class="button" href="${RELEASE_PAGE_URL}">${t('settings.ver.download', { version: d.update.version })}</a></p>`
      : html`${line.failed ? html`<p class="meta">${line.text}</p>` : ''}<p><a class="button" href="/app/update">${d.update.state === 'failed' ? t('settings.ver.tryAgain') : t('settings.ver.update')}</a></p>`;
    status = html`<p class="notice" role="status"><strong>${t('settings.ver.available', { version: d.update.version })}</strong></p>${action}`;
  } else {
    status = recentOk ? html`<p class="notice" role="status">${t('settings.ver.latest')}</p>` : html``;
  }
  // The button is a link the app's window takes itself (like Show in Finder): it runs the normal check now. The page
  // then asks /settings/version/state until a newer check shows up. In an ordinary browser tab the link lands on a note.
  const rest = since > 0 && nowS - since < CHECK_GAP_S;
  const button = rest
    ? html`<p class="meta"><span>${t('settings.ver.justNow')}</span></p>`
    : html`<div data-check-updates="/settings/version/state" data-since="${since}"><p><a class="button secondary" href="/app/check-updates" data-check-link data-desk-native>${t('settings.ver.check')}</a></p><p class="meta" role="status" data-check-status hidden>${t('settings.ver.checking')}</p></div>`;
  return html`${lastOk}${problem}${status}${button}`;
}

function serverBody(v: VersionPanelInput): SafeHtml {
  const r = v.server;
  let said: SafeHtml = html`<p class="meta">${t('settings.ver.manual')}</p>`;
  if (r) {
    const res = r.result;
    if (!res.ok) said = html`<p class="error" role="alert">${tHtml('settings.ver.failed', { error: res.error })}</p><p class="meta"><span>${tHtml('settings.ver.lastTried', { when: when(r.at) })}</span></p>`;
    else if (res.newer) said = html`<p class="notice" role="status">${tHtml('settings.ver.serverNew', { title: html`<strong>${t('settings.ver.available', { version: res.version })}</strong>`, dir: html`<code>~/memory</code>`, cmd: html`<code>git pull &amp;&amp; docker compose up -d --build</code>` })}</p><p><a href="${res.url}" target="_blank" rel="noopener">${tHtml('settings.ver.whatsIn', { version: res.version })}</a></p><p class="meta"><span>${tHtml('settings.ver.checkedAt', { when: when(r.at) })}</span></p>`;
    else said = html`<p class="notice" role="status">${t('settings.ver.latest')}</p><p class="meta"><span>${tHtml('settings.ver.checkedAt', { when: when(r.at) })}</span></p>`;
  }
  return html`${said}${v.tooSoon ? html`<p class="meta" role="status">${t('settings.ver.wait')}</p>` : ''}<form method="post" action="/settings/version/check"><button type="submit" class="secondary">${t('settings.ver.check')}</button></form>`;
}

export function versionPanel(v: VersionPanelInput): SafeHtml {
  return html`<section id="version" class="panel">
  <div class="panel-head"><h2>${t('settings.sec.version')}</h2></div>
  <p class="meta"><span>${t('settings.ver.what', { version: v.brain, schema: v.database })}</span></p>
  ${v.desktop ? desktopBody(v, v.desktop) : serverBody(v)}
</section>`;
}
