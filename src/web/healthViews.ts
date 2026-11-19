import { topReasonOf, type Health, type Part, type Reason } from '../health/health.js';
import { t, tKey, fmt, tHtml, currentLanguage } from '../i18n/index.js';
import { pseudoWrap } from '../i18n/core.js';
import { html, type SafeHtml } from './html.js';
import { excerpt } from './dashboardViews.js';
import { backupProblems } from './errorText.js';

/** Under this, a part of brain health earns a row in For you. */
export const HEALTH_FOR_YOU = 70;

const PARTS = (h: Health): [string, Part, string][] => [
  [t('health.upToDate'), h.upToDate, t('health.upToDate.what')],
  [t('health.ready'), h.ready, t('health.ready.what')],
  [t('health.waiting'), h.waiting, t('health.waiting.what')],
];

/** A reason in the owner's language (its English `text` when it has no key). */
export function reasonLine(r: Reason): string {
  if (!r.say) return r.text;
  const params = { ...r.say.params };
  if (r.dueDay !== undefined) params.day = dayWords(r.dueDay);
  if (r.say.key === 'health.r.backups') params.problem = r.problemSay ? backupProblems({ problems: [''], say: [r.problemSay] })[0]! : params.problem === '' ? t('health.r.backupsDefault') : params.problem;
  return tKey(r.say.key, params);
}
/** A calendar day (YYYY-MM-DD) as "3 Nov" / "3 nov". */
const dayWords = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return currentLanguage() === 'es' ? pseudoWrap(d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\.$/, '')) : `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};

/** Settings › Backups and copies › Brain health (B1): each part's number on a meter, then its reasons as links. */
export function healthBlock(h: Health | undefined): SafeHtml {
  if (!h) return html``;
  return html`<ul class="health-parts">${PARTS(h).map(([label, p, what]) => html`<li>
    <div class="hp-head"><span class="hp-label">${label}</span><span class="hp-score">${p.score}</span></div>
    <p class="hp-what">${what}</p>
    <meter class="hp-bar" min="0" max="100" low="${HEALTH_FOR_YOU}" high="90" optimum="100" value="${p.score}" aria-label="${t('health.meter', { label, score: p.score })}"></meter>
    ${p.reasons.length === 0 ? html`<p class="quiet">${t('health.nothing')}</p>` : html`<ul class="hp-reasons">${p.reasons.map((r) => html`<li><a href="${r.href}">${reasonLine(r)}</a></li>`)}</ul>`}
  </li>`)}</ul>`;
}

/** Reasons For you already shows as rows of their own: approvals, disagreements, discussions waiting on the owner. */
const OWN_ROW = (href: string) => href === '/approvals' || href === '/disagreements' || href.startsWith('/discussions');

/** For you: while a part is under HEALTH_FOR_YOU, its first reason that For you doesn't already show; else nothing. */
export function healthRow(h: Health | undefined): SafeHtml | null {
  if (!h) return null;
  const top = topReasonOf(h, OWN_ROW, HEALTH_FOR_YOU);
  const text = top === null ? null : reasonLine(top);
  if (text === null) return null;
  return html`<a class="row" href="/settings#brain-health"><span class="dot muted" aria-hidden="true"></span><span class="txt"><b>${t('health.title')}</b>: ${text}</span><span class="chev"></span></a>`;
}

/**
 * Above this many words the profile gets a gentle note. load_profile sends every approved entry, in full, at the start
 * of every conversation of every assistant (about 1.3 tokens a word, plus a little JSON around each entry), so this
 * is 2,000-odd tokens paid each time. 1,500 words is also the budget recall gives a whole answer of up to 12 facts:
 * a profile bigger than that costs more than the search that follows it.
 */
export const PROFILE_LARGE_WORDS = 1500;

import type { QuietApp } from '../health/quietApps.js';
export interface ProfileHealth { entries: number; words: number; pairs: { a: { id: string; content: string }; b: { id: string; content: string } }[] }

/** Settings › Brain health: how big the profile is, and which entries say nearly the same thing. Nothing without entries. */
export function profileBlock(p: ProfileHealth | undefined): SafeHtml | null {
  if (!p || p.entries === 0) return null;
  const size = t('health.profile.size', { count: p.entries, words: fmt.number(p.words, 0) });
  return html`<div class="profile-health"><p class="hp-what">${size}${p.words > PROFILE_LARGE_WORDS ? ` ${t('health.profile.large')}` : ''}</p>${p.pairs.length === 0 ? '' : html`<p class="hp-what">${t('health.profile.pairs')}</p><ul class="hp-reasons">${p.pairs.map((x) => html`<li>${tHtml('health.profile.pair', { a: html`<a href="/memories/${x.a.id}">${excerpt(x.a.content)}</a>`, b: html`<a href="/memories/${x.b.id}">${excerpt(x.b.content)}</a>` })}</li>`)}</ul>`}</div>`;
}

/**
 * Brain health: one line for each connected app that used the memory a lot this week and saved nothing. On this computer the
 * line links to Settings › Tools (where Connect installs the reminders); on a server there is no such page.
 */
/** The apps whose tools have hooks that Connect can set up (Claude Code, Codex, Cursor). Others (Grok Build, OpenCode, the Claude desktop app) have none. */
const HOOK_APPS = /^(claude[ -]code|codex|cursor)\b/i;

export function quietAppsBlock(apps: QuietApp[] | undefined, local: boolean): SafeHtml | null {
  if (!apps || apps.length === 0) return null;
  const reminded = (app: string) => HOOK_APPS.test(app);
  const tail = (app: string): SafeHtml => (!reminded(app)
    ? html`${t('health.quiet.noReminders')}`
    : local ? tHtml('health.quiet.local', { link: html`<a href="/settings/tools">${t('health.quiet.toolsLink')}</a>` }) : html`${t('health.quiet.server')}`);
  return html`<ul class="hp-reasons quiet-apps">${apps.map((a) => html`<li>${tHtml('health.quiet.line', { app: a.app, reads: a.reads, tail: tail(a.app) })}</li>`)}</ul>`;
}
