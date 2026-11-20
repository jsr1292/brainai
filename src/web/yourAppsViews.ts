/** The welcome's "Your apps" step and what follows from it: the two screens, Connect's internet row and the Home card. */
import { html, raw, type SafeHtml } from './html.js';
import { currentLocale, pseudoWrap, t, tKey, type Key } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { INTERNET_APPS, LOCAL_APPS, isInternetApp, type AppId, type InternetAppId, type Outcome, type Way } from '../desktop/yourApps.js';
import type { ToolId } from '../desktop/tools.js';

/** Brand names stay as they are; the two that have no single product name are catalog keys. */
const BRAND: Partial<Record<AppId, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', opencode: 'OpenCode', chatgpt: 'ChatGPT', grok: 'Grok' };
export const appName = (id: AppId): string => BRAND[id] ?? tKey(`setup.apps.name.${id as 'claude-desktop' | 'claude-web'}` as Key);
const MONO: Record<AppId, string> = { 'claude-code': 'C', 'claude-desktop': 'C', codex: 'X', cursor: 'Cu', gemini: 'G', opencode: 'O', chatgpt: 'G', 'claude-web': 'C', grok: 'Gk' };

/** "A, B and C" in the page's language (the pseudo-locale reads as English). */
export function listOf(names: string[]): string {
  const lang = currentLocale() === 'es' ? 'es' : 'en';
  // The joining words are text a translator owns: under the pseudo-locale they are marked like any catalog string.
  return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).formatToParts(names)
    .map((p) => (p.type === 'literal' && /\p{L}/u.test(p.value) ? pseudoWrap(p.value) : p.value)).join('');
}
export const namesOf = (ids: readonly AppId[]): string => listOf(ids.map(appName));

/** The coloured initial: drawn by the style sheet from data-m, so it is a picture, not text to translate. */
const mono = (id: AppId, small = false) => html`<span class="app-mono app-c-${id}${small ? raw(' sm') : raw('')}" data-m="${MONO[id]}" aria-hidden="true"></span>`;

/** Screen 1: tick the apps. Found apps start ticked unless an answer is stored. */
export function appsPick(v: { ticked: readonly AppId[]; found: ReadonlySet<ToolId> }): SafeHtml {
  const tile = (id: AppId) => {
    const found = !isInternetApp(id) && v.found.has(id);
    return html`<label class="app-tile"><input type="checkbox" name="app" value="${id}"${v.ticked.includes(id) ? raw(' checked') : raw('')}>
    ${mono(id)}<span class="app-nm">${appName(id)}</span><span class="app-sb">${tKey(`setup.apps.sub.${id}` as Key)}${id === 'gemini' ? html` · ${t('setup.apps.untested')}` : ''}</span>
    ${isInternetApp(id) ? html`<span class="app-need">${t('setup.apps.extra')}</span>` : found ? html`<span class="app-found">${t('setup.apps.found')}</span>` : ''}
    <span class="app-tick" aria-hidden="true">✓</span></label>`;
  };
  return html`<h1>${t('setup.apps.title')}</h1>
<p class="lede">${t('setup.apps.lede')}</p>
<form method="post" action="/welcome/apps" class="apps-form">
  <h2 class="apps-group">${t('setup.apps.groupHere')} <span class="meta">· ${t('setup.apps.groupHereHint')}</span></h2>
  <div class="apps-tiles">${LOCAL_APPS.map(tile)}</div>
  <h2 class="apps-group">${t('setup.apps.groupNet')}</h2>
  <p class="meta apps-netline">${t('setup.apps.netLine')}</p>
  <div class="apps-tiles">${INTERNET_APPS.map(tile)}</div>
  <p class="setup-actions"><button type="submit" class="primary">${t('setup.apps.see')}</button><span class="meta apps-skip"><button type="submit" name="skip" value="1" formnovalidate>${t('setup.apps.skip')}</button></span></p>
</form>`;
}

const wayCard = (way: Way, checked: boolean, suggested: boolean): SafeHtml => {
  const k = (s: string) => `setup.apps.way.${way}.${s}` as Key;
  const items: [string, boolean][] = way === 'reach' ? [['p1', true], ['p2', true], ['m1', false]]
    : way === 'server' ? [['p1', true], ['m1', false], ['m2', false]] : [['p1', true], ['m1', false], ['p2', true]];
  return html`<label class="app-way"><input type="radio" name="way" value="${way}"${checked ? raw(' checked') : raw('')}>
  ${suggested ? html`<span class="app-rec">${t('setup.apps.suggested')}</span>` : ''}<b>${tKey(k('title'))}</b><span class="app-tag">${tKey(k('tag'))}</span>
  <ul>${items.map(([s, good]) => html`<li class="${good ? 'p' : 'm'}">${tKey(k(s))}</li>`)}</ul></label>`;
};

/** Screen 2: what works, what is not found, and the one choice for the internet apps. */
export function appsResult(v: { outcome: Outcome; ticked: readonly AppId[]; way: Way | null; windows: boolean }): SafeHtml {
  const o = v.outcome;
  const chips = (ids: readonly AppId[]) => html`<ul class="app-chips">${ids.map((id) => html`<li class="app-chip">${mono(id, true)}${appName(id)}</li>`)}</ul>`;
  const choice = o.ways.length > 0;
  const okInternet = o.internet.length > 0 && o.internetWorks;
  const allHere = o.internet.length === 0 && o.notFound.length === 0 && o.works.length > 0;
  const lede = choice ? t('setup.apps.ledeChoice') : okInternet ? t('setup.apps.ledeReach') : t('setup.apps.ledeLocal');
  const ok = o.works.length > 0 || okInternet
    ? html`<section class="apps-lane ok"><h2>${t('setup.apps.okTitle')}</h2>${chips([...o.works, ...(okInternet ? o.internet : [])])}
      ${o.works.length > 0 ? html`<p class="apps-why">${t('setup.apps.okNote')}</p>` : ''}
      ${okInternet ? html`<p class="apps-why">${t('setup.apps.okReach', { apps: namesOf(o.internet) })}</p>` : ''}</section>` : '';
  const chosen: Way = v.way && o.ways.includes(v.way) ? v.way : o.ways[0] ?? 'later';
  const wait = choice
    ? html`<section class="apps-lane wait"><h2>${t('setup.apps.waitTitle')}</h2>${chips(o.internet)}
      <p class="apps-why">${v.windows ? t('setup.apps.whyWindows') : t('setup.apps.why')}</p>
      <fieldset class="apps-ways"><legend class="visually-hidden">${t('setup.apps.wayLabel')}</legend>${o.ways.map((w) => wayCard(w, w === chosen, w === 'reach'))}</fieldset></section>` : '';
  const notFound = o.notFound.length > 0 ? html`<p class="meta apps-notfound">${t('setup.apps.notFound', { apps: namesOf(o.notFound) })}</p>` : '';
  const later = choice || okInternet
    ? html`<p class="meta apps-later">${v.windows ? t('setup.apps.changeLaterWindows') : t('setup.apps.changeLater', { reach: t('setup.reach.title') })}</p>` : '';
  const body = html`<div class="apps-lanes">${ok}${notFound}${wait}</div>${later}`;
  return html`<h1>${allHere ? t('setup.apps.allHereTitle') : t('setup.apps.resultTitle')}</h1>
<p class="lede">${lede}</p>
${choice
    ? html`<form method="post" action="/welcome/apps/way" class="apps-way-form">${body}<p class="setup-actions"><button type="submit" class="primary">${t('setup.apps.continue')}</button></p></form>`
    : html`${body}<p class="setup-actions"><a class="button primary" href="/welcome?step=3">${t('setup.apps.continue')}</a></p>`}`;
}

/** Connect's one row for the ticked internet apps, worded by what was chosen (Windows never hears about Reach). */
export function internetRow(apps: readonly InternetAppId[], way: Way | null, windows: boolean, reachOn = false): SafeHtml {
  const names = namesOf(apps);
  const next = reachOn ? t('setup.apps.net.on', { apps: names })
    : way === 'later' ? (windows
      ? tHtml('setup.apps.net.laterWindows', { apps: names, link: html`<a href="/settings/move">${t('setup.chatgpt.server')}</a>` })
      : tHtml('setup.apps.net.later', { apps: names, link: html`<a href="/settings/reach">${t('setup.apps.settingsReach')}</a>` }))
    : way === 'server' || windows ? tHtml('setup.apps.net.server', { apps: names, link: html`<a href="/settings/move">${t('setup.apps.net.serverLink')}</a>` })
      : tHtml('setup.apps.net.reach', { apps: names, link: html`<a href="/settings/reach">${t('setup.reach.title')}</a>` });
  return html`<li class="tool"><div><strong>${names}</strong><br><span class="meta note">${next}</span></div><div></div></li>`;
}

/** Home and the last welcome screen: the one next step, with Dismiss (for good, until the next answer). */
export function nextStepCard(card: 'reach' | 'server', apps: readonly InternetAppId[], inWelcome = false): SafeHtml {
  const names = namesOf(apps);
  return html`<div class="conn-setup next-card" role="status">
  <p><strong>${card === 'reach' ? t('setup.apps.next.reach', { apps: names }) : t('setup.apps.next.server', { apps: names })}</strong></p>
  <div class="update-actions">${inWelcome ? '' : html`<a class="button" href="${card === 'reach' ? '/settings/reach' : '/settings/move'}">${t('setup.apps.next.go')}</a>`}
  <form method="post" action="/welcome/next/dismiss" class="inline">${inWelcome ? html`<input type="hidden" name="back" value="welcome">` : ''}<button type="submit">${t('setup.apps.next.dismiss')}</button></form></div>
</div>`;
}
