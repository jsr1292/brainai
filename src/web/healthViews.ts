import { topReason, type Health, type Part } from '../health/health.js';
import { html, type SafeHtml } from './html.js';
import { excerpt } from './dashboardViews.js';

/** Under this, a part of brain health earns a row in For you. */
export const HEALTH_FOR_YOU = 70;

const PARTS = (h: Health): [string, Part, string][] => [
  ['Up to date', h.upToDate, 'How many projects have a status or roadmap from the last month.'],
  ['Ready', h.ready, 'How ready an assistant is to pick your projects up cold: each has a status and a roadmap, the apps run the newest setup text, backups work.'],
  ['Waiting on you', h.waiting, 'What needs you: approvals, facts that disagree, due dates, discussions. It drops by 10 for each.'],
];

/** Settings › Backups and copies › Brain health (B1): each part's number on a meter, then its reasons as links. */
export function healthBlock(h: Health | undefined): SafeHtml {
  if (!h) return html``;
  return html`<ul class="health-parts">${PARTS(h).map(([label, p, what]) => html`<li>
    <div class="hp-head"><span class="hp-label">${label}</span><span class="hp-score">${p.score}</span></div>
    <p class="hp-what">${what}</p>
    <meter class="hp-bar" min="0" max="100" low="${HEALTH_FOR_YOU}" high="90" optimum="100" value="${p.score}" aria-label="${label}: ${p.score} of 100"></meter>
    ${p.reasons.length === 0 ? html`<p class="quiet">Nothing to do</p>` : html`<ul class="hp-reasons">${p.reasons.map((r) => html`<li><a href="${r.href}">${r.text}</a></li>`)}</ul>`}
  </li>`)}</ul>`;
}

/** Reasons For you already shows as rows of their own: approvals, disagreements, discussions waiting on the owner. */
const OWN_ROW = (href: string) => href === '/approvals' || href === '/disagreements' || href.startsWith('/discussions');

/** For you: while a part is under HEALTH_FOR_YOU, its first reason that For you doesn't already show; else nothing. */
export function healthRow(h: Health | undefined): SafeHtml | null {
  if (!h) return null;
  const text = topReason(h, OWN_ROW, HEALTH_FOR_YOU);
  if (text === null) return null;
  return html`<a class="row" href="/settings#brain-health"><span class="dot muted" aria-hidden="true"></span><span class="txt"><b>Brain health</b>: ${text}</span><span class="chev"></span></a>`;
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
  const size = `Your profile: ${p.entries} ${p.entries === 1 ? 'entry' : 'entries'}, about ${p.words.toLocaleString('en-US')} words.`;
  return html`<div class="profile-health"><p class="hp-what">${size}${p.words > PROFILE_LARGE_WORDS ? ' That is large: every assistant reads all of this at the start of every conversation; consider merging or removing entries.' : ''}</p>${p.pairs.length === 0 ? '' : html`<p class="hp-what">Entries that say nearly the same thing:</p><ul class="hp-reasons">${p.pairs.map((x) => html`<li><a href="/memories/${x.a.id}">${excerpt(x.a.content)}</a> and <a href="/memories/${x.b.id}">${excerpt(x.b.content)}</a></li>`)}</ul>`}</div>`;
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
  const tail = (app: string) => (!reminded(app)
    ? 'It has no save reminders to set up: ask it to save as it works, or to run the harvest-session skill.'
    : local ? html`Its tool may not be reminding it: see <a href="/settings/tools">Tools on this computer</a>.` : html`Its tool may not be reminding it: set up its save reminders (docs/CLIENTS.md, Hooks).`);
  return html`<ul class="hp-reasons quiet-apps">${apps.map((a) => html`<li>${a.app} used your memory ${a.reads} times this week but saved nothing. ${tail(a.app)}</li>`)}</ul>`;
}
