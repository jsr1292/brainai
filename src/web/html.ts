import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Back, Tab } from './back.js';
import { sideStatus } from './sideStatus.js';

/** HTML that is already escaped (or deliberately trusted) and is inserted verbatim. */
export class SafeHtml {
  constructor(readonly value: string) {}
}

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

/** Set once per app by createApp: work mode renames the dashboard. */
let workMode = false;
export function setPageMode(mode: 'personal' | 'work'): void {
  workMode = mode === 'work';
}
export const memoryName = (): string => (workMode ? 'Work brain' : 'BrainAI');
/** How a pasted or asked request names this memory. It matches the setup texts' wording ("a shared memory"), on purpose not the
 * MCP server's name (brainai), so assistants set up with those texts recognise it. */
export const memoryServerName = (): string => (workMode ? 'work-memory' : 'shared-memory');

/** The main destinations, as in the approved mockups. */
const TABS = [
  { href: '/', label: 'Projects', tab: 'projects' },
  { href: '/pages', label: 'Pages', tab: 'pages' },
  { href: '/review', label: 'Week', tab: 'week' },
  { href: '/graph', label: 'Graph', tab: 'graph' },
];

/** A part of a place, lit in the desktop sidebar under its place: Pages has All pages and Facts, Week has three. */
export type Section = 'pages' | 'facts' | 'last' | 'now' | 'growth';

/** The desktop sidebar's places, each with its sections (desktop design §3). Growth is not in work mode. */
const PLACES: { href: string; label: string; tab: Tab; subs: { href: string; label: string; section: Section }[] }[] = [
  { href: '/', label: 'Projects', tab: 'projects', subs: [] },
  { href: '/pages', label: 'Pages', tab: 'pages', subs: [{ href: '/pages', label: 'All pages', section: 'pages' }, { href: '/facts', label: 'Facts', section: 'facts' }] },
  { href: '/review', label: 'Week', tab: 'week', subs: [{ href: '/review', label: 'Last week', section: 'last' }, { href: '/review/now', label: 'So far', section: 'now' }, { href: '/growth', label: 'Growth', section: 'growth' }] },
  { href: '/graph', label: 'Graph', tab: 'graph', subs: [] },
];

/**
 * The desktop sidebar: brand, search, the places with their sections, Settings at the foot. It keeps `hidden` at every
 * width: below 1100 px the browser hides it and no style.css rule touches it; desk.css displays it on wide screens (and
 * so exposes it). It never shows a number: Projects gets one orange dot when something needs the owner, and Settings
 * an amber "Backup late" only when the backup check fails.
 */
function sidebar(opts: { tab?: Tab | null; section?: Section; query?: string }): SafeHtml {
  const status = sideStatus();
  const section = opts.tab === 'pages' ? opts.section ?? 'pages' : opts.section;
  const place = (p: (typeof PLACES)[number]) => {
    const here = opts.tab === p.tab;
    const subs = workMode ? p.subs.filter((x) => x.section !== 'growth') : p.subs;
    const lit = here ? subs.find((x) => x.section === section) : undefined;
    const need = p.tab === 'projects' && status.needsYou ? html`<span class="side-need" aria-hidden="true"></span><span class="visually-hidden">, something needs you</span>` : '';
    return html`<li><a class="side-place" href="${p.href}"${here ? raw(` aria-current="${lit ? 'true' : 'page'}"`) : ''}>${p.label}${need}</a>${subs.length > 0 ? html`<ul class="side-subs">${subs.map((x) => html`<li><a class="side-sub" href="${x.href}"${x === lit ? raw(' aria-current="page"') : ''}>${x.label}</a></li>`)}</ul>` : ''}</li>`;
  };
  const warn = status.backupLate ? html`<span class="side-warn"><span class="dot attention" aria-hidden="true"></span>Backup late</span>` : '';
  return html`<nav class="side" hidden aria-label="Main">
<a class="brand" href="/"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></a>
<form class="side-find" method="get" action="/search" role="search"><svg class="side-find-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input name="q" type="search" placeholder="Search" aria-label="Search" aria-keyshortcuts="Meta+K Control+K" value="${opts.query ?? ''}"><kbd>⌘K</kbd></form>
<ul class="side-places">${PLACES.map(place)}</ul>
<a class="side-place side-settings" href="/settings"${opts.tab === 'settings' ? raw(' aria-current="page"') : ''}>Settings${warn}</a>
</nav>
`;
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

export function page(title: string, body: SafeHtml, opts: { nav?: boolean; query?: string; tab?: Tab | null; section?: Section; back?: Pick<Back, 'href' | 'label'>; crumb?: boolean } = {}): string {
  const brand = html`<a class="brand" href="/"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></a>`;
  const link = (t: { href: string; label: string; tab: string }) =>
    html`<a href="${t.href}"${opts.tab === t.tab ? raw(' aria-current="page"') : ''}>${t.label}</a>`;
  const settings = html`<a class="settings-link" href="/settings"${opts.tab === 'settings' ? raw(' aria-current="page"') : ''}><span class="settings-word">Settings</span><svg class="cog" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>`;
  const header = opts.nav
    ? html`<header class="top">${brand}${opts.back ? html`<a class="top-back" href="${opts.back.href}"><span>${opts.back.label}</span></a>` : ''}
<nav class="tabs" aria-label="Main">${TABS.map(link)}</nav>
<form class="find" method="get" action="/search" role="search"><input name="q" type="search" placeholder="Search the brain" aria-label="Search" aria-keyshortcuts="Meta+K Control+K" title="Search (⌘K)" value="${opts.query ?? ''}"><button type="button" class="find-cancel">Cancel</button><div class="find-hints"><a href="/review/now#latest">Latest changes</a><a href="/facts">All facts</a><p>Or type: projects, facts and page sections.</p></div></form>
${settings}
</header>`
    : html`<header class="top solo">${brand}</header>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title === 'Shared memory' ? memoryName() : title}</title>
<link rel="manifest" href="${asset('manifest.webmanifest')}">
<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1320" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="${asset('apple-touch-icon.png')}">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="stylesheet" href="${asset('style.css')}">
<link rel="stylesheet" href="${asset('desk.css')}" media="screen and (min-width: 1100px)">
<script src="${asset('app.js')}" defer></script>
</head>
<body class="${opts.nav ? 'app' : 'auth'}"${opts.nav ? html` data-desk="${asset('desk.js')}"` : ''}>
${header}${opts.nav ? sidebar(opts) : ''}<main>
${(() => { const to = opts.nav ? movedTo() : null; return to ? html`<p class="notice" role="status">This brain now lives at <a href="${to.origin}">${to.origin}</a>. Changes made here are not copied there.</p>
` : ''; })()}${opts.nav && opts.back && opts.crumb !== false ? html`<p class="crumb back"><a href="${opts.back.href}">‹ ${opts.back.label}</a></p>` : ''}
${body}
</main>
</body>
</html>
`.value;
}
