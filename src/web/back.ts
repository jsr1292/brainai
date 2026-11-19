/**
 * Where an action may return to after a form sent from a page or a review: a page, or one of the review's own
 * addresses. Anything else is ignored. On an error the page gets only a fixed line picked by code, never URL text.
 */
import { KINDS } from '../memory/types.js';
import { currentLanguage, tKey, type Key } from '../i18n/core.js';

export type Tab = 'projects' | 'pages' | 'facts' | 'inbox' | 'week' | 'graph' | 'settings';
/**
 * Where a page's back link goes and what it says. The label is `labelKey` (a catalog key, with `labelParams`), translated
 * when the page is rendered by `backLabel`, or `label`, plain text that is not translated (a project's or a page's own name).
 */
export interface BackTarget { href: string; labelKey?: Key; labelParams?: Params | (() => Params); label?: string;
  /** Written as `data-back` on the link, so a script can tell where it goes without reading its (translated) words: `discussions` = the list. */
  mark?: 'discussions' }
type Params = Record<string, string | number>;
export interface Back extends BackTarget { tab: Tab | null }
/** The back link's words in the request's language. Never call this at module scope. */
export const backLabel = (b: BackTarget): string => (b.labelKey !== undefined ? tKey(b.labelKey, typeof b.labelParams === 'function' ? b.labelParams() : b.labelParams) : b.label ?? '');
export interface BackLookups {
  pageTitle(id: string): string | undefined;
  projectName(name: string): string | undefined;
  discussionTitle(id: string): string | undefined;
}

export const SUGGESTION_BACK = /^\/(approvals)?$/;
export const suggestionBack = (v: unknown): '/' | '/approvals' => v === '/approvals' ? '/approvals' : '/';
/** The Inbox item to open after an answer ("kind:id", as the Inbox model keys it) as its address; null for anything else. */
export function nextHref(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 400) return null;
  const at = v.indexOf(':');
  const kind = v.slice(0, at);
  const id = encodeURIComponent(v.slice(at + 1));
  if (at < 0 || id === '') return null;
  return kind === 'suggestion' ? `/approvals?id=${id}` : kind === 'proposal' ? `/approvals?proposal=${id}`
    : kind === 'batch' ? `/approvals?batch=${id}` : kind === 'disagree' ? `/disagreements?id=${id}` : kind === 'tidy' ? `/facts/tidy?item=${id}` : null;
}
const UUID = /^[0-9a-f-]{36}$/;
const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/;
const factsBack = (): Back => ({ href: '/facts', labelKey: 'shell.nav.facts', tab: 'facts' });
const simple = (href: string, labelKey: Key, tab: Tab | null): Back => ({ href, labelKey, tab });
/** A back link named after a record (a project or page name): plain text. */
const named = (href: string, label: string, tab: Tab | null): Back => ({ href, label, tab });

function paramsAllowed(u: URL, allowed: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of u.searchParams.keys()) {
    if (!allowed.includes(key) || key === 'from' || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** A checked, one-step return address with labels fixed here or looked up from live records. */
export function backFrom(from: unknown, look: BackLookups): Back | undefined {
  if (typeof from !== 'string' || from.length > 600 || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return undefined;
  let u: URL;
  try { u = new URL(from, 'http://brain.invalid'); } catch { return undefined; }
  if (u.host !== 'brain.invalid' || u.hash || u.username || u.password) return undefined;
  const path = u.pathname;
  if (path === '/facts') {
    if (!paramsAllowed(u, ['q', 'kind', 'project', 'show', 'page'])) return undefined;
    const p = u.searchParams;
    const kind = p.get('kind'), project = p.get('project'), show = p.get('show'), q = p.get('q'), page = p.get('page');
    if (kind !== null && !KINDS.includes(kind as (typeof KINDS)[number])) return undefined;
    if (project !== null && project.length > 63) return undefined;
    if (show !== null && show !== 'replaced' && show !== 'everything') return undefined;
    if (q !== null && q.length > 200) return undefined;
    if (page !== null && !/^\d{1,4}$/.test(page)) return undefined;
    const out = new URLSearchParams();
    for (const key of ['q', 'kind', 'project', 'show', 'page'] as const) if (p.has(key)) out.set(key, p.get(key)!);
    return simple('/facts' + (out.size ? '?' + out : ''), kind === 'profile' ? 'shell.back.aboutYou' : 'shell.nav.facts', 'facts');
  }
  if (path === '/' && paramsAllowed(u, ['project'])) {
    const project = u.searchParams.get('project');
    if (project === null) return simple('/', 'shell.nav.projects', 'projects');
    if (project.length > 63) return undefined;
    const name = look.projectName(project);
    return name ? named('/?project=' + encodeURIComponent(name) + '#panel', name, 'projects') : undefined;
  }
  if (path === '/graph' && paramsAllowed(u, ['project', 'view'])) {
    const project = u.searchParams.get('project'), view = u.searchParams.get('view');
    if (view !== null && view !== 'list' && view !== '3d') return undefined;
    const name = project === null ? null : look.projectName(project);
    if (project !== null && !name) return undefined;
    const out = new URLSearchParams();
    if (name) out.set('project', name);
    if (view !== null) out.set('view', view);
    return simple('/graph' + (out.size ? '?' + out : ''), 'shell.nav.graph', 'graph');
  }
  if (path === '/search' && paramsAllowed(u, ['q'])) {
    const q = u.searchParams.get('q');
    return simple('/search' + (q === null ? '' : '?q=' + encodeURIComponent(q.slice(0, 200))), 'shell.back.search', null);
  }
  if (!paramsAllowed(u, [])) return undefined;
  if (path === '/facts/tidy') return simple(path, 'shell.back.tidy', 'facts');
  if (path === '/pages') return simple(path, 'shell.nav.pages', 'pages');
  if (path.startsWith('/pages/') && UUID.test(path.slice(7))) {
    const title = look.pageTitle(path.slice(7));
    return title ? named(path, title, 'pages') : undefined;
  }
  if (path.startsWith('/memories/') && UUID.test(path.slice(10))) return simple(path, 'shell.back.fact', 'facts');
  if (path.startsWith('/discussions/') && look.discussionTitle(path.slice(13))) return simple(path, 'shell.back.discussion', 'projects');
  if (path === '/approvals') return simple(path, 'shell.nav.inbox', 'inbox');
  if (path === '/review') return simple(path, 'shell.nav.lastWeek', 'week');
  if (path === '/review/now') return simple(path, 'shell.nav.soFar', 'week');
  if (path.startsWith('/review/') && REVIEW_DATE.test(path.slice(8))) {
    const date = path.slice(8);
    const d = new Date(date + 'T12:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return undefined;
    // The month is worked out when the label is drawn, in that request's language.
    const labelParams = (): Params => ({ day: d.getUTCDate(), month: d.toLocaleString(currentLanguage() === 'es' ? 'es-ES' : 'en-GB', { month: 'short', timeZone: 'UTC' }).replace(/\.$/, '') });
    return { href: path, labelKey: 'shell.back.weekOf', labelParams, tab: 'week' };
  }
  return undefined;
}

export function factBackDefault(m: { project: string | null }, look: BackLookups): Back {
  const name = m.project === null ? undefined : look.projectName(m.project);
  return name ? named('/?project=' + encodeURIComponent(name) + '#panel', name, 'projects') : factsBack();
}

/** Add an origin before a fragment, replacing an existing origin if needed. */
export function withFrom(href: string, from: string | undefined): string {
  if (from === undefined) return href;
  const hashAt = href.indexOf('#');
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const before = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = before.indexOf('?');
  const path = queryAt < 0 ? before : before.slice(0, queryAt);
  const q = new URLSearchParams(queryAt < 0 ? '' : before.slice(queryAt + 1));
  q.set('from', from);
  return path + '?' + q.toString() + hash;
}

export const SAFE_BACK = /^\/(pages\/[0-9a-f-]{36}|review(\/(\d{4}-\d{2}-\d{2}|now))?)$/;

export const safeBack = (v: unknown): string | undefined => (typeof v === 'string' && SAFE_BACK.test(v) ? v : undefined);

export type BackError = 'changed' | 'failed';
export const BACK_ERRORS: Record<BackError, string> = {
  changed: 'That changed since this page was made. This is how it stands now.',
  failed: "That couldn't be saved from here. Open the project to see why.",
};

/** The fixed line for `?error=changed` or `?error=failed`, in the owner's language; anything else shows nothing. (`BACK_ERRORS` is the English text.) */
export const backError = (q: unknown): string | undefined => (q === 'changed' ? tKey('err.back.changed') : q === 'failed' ? tKey('err.back.failed') : undefined);

export const withBackError = (back: string, e: BackError): string => `${back}?error=${e}`;
