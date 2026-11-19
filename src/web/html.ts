import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { backLabel, type Back, type BackTarget, type Tab } from './back.js';
import { sideStatus } from './sideStatus.js';
import { t, tKey, currentLanguage, type Key } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { clientJson } from '../i18n/client.js';

import { SafeHtml } from '../safeHtml.js';
export { SafeHtml };

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Template tag: escapes every interpolated value that isn't SafeHtml; arrays are joined. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => { out += render(v) + strings[i + 1]!; });
  return new SafeHtml(out);
}

export const raw = (s: string): SafeHtml => new SafeHtml(s);

const fingerprints = new Map<string, string>();

/**
 * URL of a file in ./static with a fingerprint of its contents. Cloudflare tells browsers to keep static files for
 * hours, so without it a deploy could pair new pages with an old stylesheet or script.
 */
export function asset(file: string): string {
  let v = fingerprints.get(file);
  if (v === undefined) {
    v = createHash('sha256').update(readFileSync(new URL(`./static/${file}`, import.meta.url))).digest('hex').slice(0, 10);
    fingerprints.set(file, v);
  }
  return `/static/${file}?v=${v}`;
}

export const memoryName = (): string => 'BrainAI';
/** How a pasted or asked request names this memory. It matches the setup texts' wording ("a shared memory"), on purpose not the
 * MCP server's name (brainai), so assistants set up with those texts recognise it. */
export const memoryServerName = (): string => 'shared-memory';

/** The main destinations, as in the approved mockups. */
const TABS: { href: string; label: Key; tab: Tab }[] = [
  { href: '/', label: 'shell.nav.projects', tab: 'projects' },
  { href: '/pages', label: 'shell.nav.pages', tab: 'pages' },
  { href: '/approvals', label: 'shell.nav.inbox', tab: 'inbox' },
  { href: '/review', label: 'shell.nav.week', tab: 'week' },
];

/**
 * The phone bar's four places are Projects, Pages, Inbox and Week. Facts sits under Pages, and the Graph (no longer in the
 * bar; it is a link at the foot of Projects) under Projects. Everything the desktop files under its Inbox (approvals, facts
 * that disagree, Tidy up) lights the Inbox tab: see `phoneTabOf`.
 */
const PHONE_PLACE: Partial<Record<Tab, Tab>> = { facts: 'pages', graph: 'projects' };
const phoneTabOf = (tab: Tab | null | undefined, sideTab: Tab | null | undefined): Tab | null | undefined =>
  sideTab === 'inbox' ? 'inbox' : tab == null ? tab : PHONE_PLACE[tab] ?? tab;

/** A part of a place, lit in the desktop sidebar under its place: Week has three. */
export type Section = 'last' | 'now' | 'growth' | 'activity' | 'skills';

/** The desktop sidebar's places, each with its sections (desktop design §3). */
const PLACES: { href: string; label: Key; tab: Tab; subs: { href: string; label: Key; section: Section }[] }[] = [
  { href: '/', label: 'shell.nav.projects', tab: 'projects', subs: [] },
  { href: '/pages', label: 'shell.nav.pages', tab: 'pages', subs: [{ href: '/skills', label: 'shell.nav.skills', section: 'skills' }] },
  { href: '/facts', label: 'shell.nav.facts', tab: 'facts', subs: [] },
  { href: '/approvals', label: 'shell.nav.inbox', tab: 'inbox', subs: [] },
  { href: '/review', label: 'shell.nav.week', tab: 'week', subs: [{ href: '/review', label: 'shell.nav.lastWeek', section: 'last' }, { href: '/review/now', label: 'shell.nav.soFar', section: 'now' }, { href: '/growth', label: 'shell.nav.growth', section: 'growth' }, { href: '/activity', label: 'shell.nav.activity', section: 'activity' }] },
  { href: '/graph', label: 'shell.nav.graph', tab: 'graph', subs: [] },
];

/**
 * The desktop sidebar: brand, search, the places with their sections, Settings at the foot. It keeps `hidden` at every
 * width: below 1100 px the browser hides it and no style.css rule touches it; desk.css displays it on wide screens (and
 * so exposes it). Inbox counts what waits for the owner, and Settings warns only when the backup check fails.
 */
function sidebar(opts: { tab?: Tab | null; section?: Section; query?: string }): SafeHtml {
  const status = sideStatus();
  const section = opts.section;
  const place = (p: (typeof PLACES)[number]) => {
    const here = opts.tab === p.tab;
    const subs = p.subs;
    const lit = here ? subs.find((x) => x.section === section) : undefined;
    const count = p.tab === 'inbox' && status.needsYouCount > 0 ? html`<span class="side-count" aria-label="${t('shell.waiting', { count: status.needsYouCount })}">${status.needsYouCount}</span>` : '';
    return html`<li><a class="side-place" href="${p.href}"${here ? raw(` aria-current="${lit ? 'true' : 'page'}"`) : ''}>${tKey(p.label)}${count}</a>${subs.length > 0 ? html`<ul class="side-subs">${subs.map((x) => html`<li><a class="side-sub" href="${x.href}"${x === lit ? raw(' aria-current="page"') : ''}>${tKey(x.label)}</a></li>`)}</ul>` : ''}</li>`;
  };
  const warn = status.backupLate ? html`<span class="side-warn"><span class="dot attention" aria-hidden="true"></span>${t('shell.backupLate')}</span>` : '';
  return html`<nav class="side" hidden aria-label="${t('shell.nav.main')}">
<a class="brand" href="/"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></a>
<form class="side-find" method="get" action="/search" role="search"><svg class="side-find-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input name="q" type="search" placeholder="${t('shell.search.placeholder')}" aria-label="${t('shell.search.label')}" aria-keyshortcuts="Meta+K Control+K" value="${opts.query ?? ''}"><kbd><span class="k-mac">⌘K</span><span class="k-pc">Ctrl K</span></kbd></form>
<ul class="side-places">${PLACES.map(place)}</ul>
<a class="side-place side-settings" href="/settings"${opts.tab === 'settings' ? raw(' aria-current="page"') : ''}>${t('shell.nav.settings')}${warn}</a>
</nav>
`;
}

/**
 * The place the desktop sidebar lights: every page under Settings lights Settings (they all go back to it), and the pages that
 * belong to the Inbox light the Inbox (Tidy up, Facts that disagree). The phone's bar is not touched by this.
 */
function sideTabOf(opts: { tab?: Tab | null; sideTab?: Tab | null; back?: Pick<Back, 'href'> }): Tab | null | undefined {
  if (opts.sideTab !== undefined) return opts.sideTab;
  if (opts.tab == null && opts.back?.href.split(/[#?]/)[0]!.startsWith('/settings')) return 'settings';
  return opts.tab;
}

/**
 * `tab` marks a main tab current whatever the title (a page's title is its own, not "Pages"); `section` marks the part
 * of it in the desktop sidebar (on the Pages tab it defaults to All pages).
 */
let movedTo: () => URL | null = () => null;
/** Where this brain lives now, after a move (D5): every dashboard page says so. Set by createApp. */
export function setMovedBanner(fn: () => URL | null): void {
  movedTo = fn;
}

let savesPaused: () => string | null = () => null;
/** The banner never breaks a page: a database that is closing reads as not paused. */
const pausedSince = (): string | null => { try { return savesPaused(); } catch { return null; } };
/** C2: while the owner has paused every assistant save, every dashboard page says so, with Resume. Set by createApp. */
export function setPausedBanner(fn: () => string | null): void {
  savesPaused = fn;
}

/** Where the palette (Ctrl/⌘K) can jump besides the sidebar's places, for this brain's mode: set by createApp. */
/** `key` (and `params`) are translated when the page is rendered; `alias` is extra words the palette matches, kept as written. */
export interface GoTo { key: Key; params?: Record<string, string | number>; href: string; alias?: string }
let goTo: () => GoTo[] = () => [];
/** The palette's extra rows: a function, so labels are worked out in each request's language. */
export function setGoTo(list: GoTo[] | (() => GoTo[])): void {
  goTo = typeof list === 'function' ? list : () => list;
}

let serverMode = false;
/** A server (not the desktop app): desk.js names its two switches' place "This browser" (data-server on the body). Set by createApp. */
export function setServerMode(on: boolean): void {
  serverMode = on;
}

let consentPoller = false;
/** Local mode: owner pages ask for tool sign-ins waiting for approval (data-consents-waiting on the body). Set by createApp. */
export function setConsentPoller(on: boolean): void {
  consentPoller = on;
}

export function page(title: string, body: SafeHtml, opts: { nav?: boolean; /** Which place the desktop sidebar lights, when it is not `tab` (the phone bar keeps using `tab`). */ sideTab?: Tab | null; query?: string; tab?: Tab | null; section?: Section; back?: BackTarget; crumb?: boolean; /** The app's first-run setup: its own frame, with the brand in its step list. */ shell?: 'setup' } = {}): string {
  const brand = html`<a class="brand" href="/"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></a>`;
  const phoneTab = opts.nav ? phoneTabOf(opts.tab, sideTabOf(opts)) : null;
  const waiting = opts.nav ? sideStatus().needsYouCount : 0;
  const link = (tb: { href: string; label: Key; tab: Tab }) =>
    html`<a href="${tb.href}"${phoneTab === tb.tab ? raw(' aria-current="page"') : ''}>${tKey(tb.label)}${tb.tab === 'inbox' && waiting > 0 ? html`<span class="tab-count" aria-label="${t('shell.waiting', { count: waiting })}">${waiting}</span>` : ''}</a>`;
  const settings = html`<a class="settings-link" href="/settings"${opts.tab === 'settings' ? raw(' aria-current="page"') : ''} aria-label="${t('shell.nav.settings')}"><span class="settings-word">${t('shell.nav.settings')}</span><svg class="cog" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>`;
  const header = opts.nav
    ? html`<header class="top">${brand}${opts.back ? html`<a class="top-back" href="${opts.back.href}"><span>${backLabel(opts.back)}</span></a>` : ''}
<nav class="tabs" aria-label="${t('shell.nav.main')}">${TABS.map(link)}</nav>
<form class="find" method="get" action="/search" role="search"><input name="q" type="search" placeholder="${t('shell.search.placeholderTop')}" aria-label="${t('shell.search.label')}" aria-keyshortcuts="Meta+K Control+K" title="${t('shell.search.title')}" value="${opts.query ?? ''}"><button type="button" class="find-cancel">${t('shell.search.cancel')}</button><div class="find-hints"><a href="/review/now#latest">${t('shell.search.latest')}</a><a href="/facts">${t('shell.search.allFacts')}</a><p>${t('shell.search.hint')}</p></div></form>
${settings}
</header>`
    : opts.shell === 'setup' ? html`` : html`<header class="top solo">${brand}</header>`;
  return html`<!doctype html>
<html lang="${currentLanguage()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="manifest" href="${asset('manifest.webmanifest')}">
<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1320" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="${asset('apple-touch-icon.png')}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<script src="${asset('platform.js')}"></script>
<link rel="stylesheet" href="${asset('style.css')}">
<link rel="stylesheet" href="${asset('desk.css')}" media="screen and (min-width: 1100px)">
${raw(`<script type="application/json" id="i18n">${clientJson()}</script>`)}
<script src="${asset('i18n.js')}"></script>
<script src="${asset('app.js')}" defer></script>
</head>
<body class="${opts.nav ? 'app' : opts.shell === 'setup' ? 'setup' : 'auth'}"${opts.nav ? html` data-desk="${asset('desk.js')}"${goTo().length > 0 ? html` data-goto="${JSON.stringify(goTo().map((g) => ({ label: tKey(g.key, g.params), href: g.href, ...(g.alias ? { alias: g.alias } : {}) })))}"` : ''}` : ''}${opts.nav && serverMode ? raw(' data-server') : ''}${consentPoller ? raw(' data-consents-waiting="/consents/waiting"') : ''}>
${header}${opts.nav ? sidebar({ ...opts, tab: sideTabOf(opts) }) : ''}<main>
${(() => { const to = opts.nav ? movedTo() : null; return to ? html`<p class="notice" role="status">${tHtml('shell.moved', { address: html`<a href="${to.origin}">${to.origin}</a>` })}</p>
` : ''; })()}${(() => { const since = opts.nav ? pausedSince() : null; return since ? html`<div class="notice undo-line" role="status"><span>${t('shell.paused')}</span><form method="post" action="/settings/pause/resume"><button type="submit" class="linklike">${t('shell.resume')}</button></form></div>
` : ''; })()}${opts.nav && opts.back && opts.crumb !== false ? html`<p class="crumb back"><a href="${opts.back.href}"${opts.back.mark ? html` data-back="${opts.back.mark}"` : ''}>‹ ${backLabel(opts.back)}</a></p>` : ''}
${body}
</main>
</body>
</html>
`.value;
}
