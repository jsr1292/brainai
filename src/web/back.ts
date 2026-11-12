/**
 * Where an action may return to after a form sent from a page or a review: a page, or one of the review's own
 * addresses. Anything else is ignored. On an error the page gets only a fixed line picked by code, never URL text.
 */
import { KINDS } from '../memory/types.js';

export type Tab = 'projects' | 'pages' | 'facts' | 'inbox' | 'week' | 'graph' | 'settings';
export interface Back { href: string; label: string; tab: Tab | null }
export interface BackLookups {
  pageTitle(id: string): string | undefined;
  projectName(name: string): string | undefined;
  discussionTitle(id: string): string | undefined;
}

export const SUGGESTION_BACK = /^\/(approvals)?$/;
export const suggestionBack = (v: unknown): '/' | '/approvals' => v === '/approvals' ? '/approvals' : '/';
const UUID = /^[0-9a-f-]{36}$/;
const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/;
const factsBack: Back = { href: '/facts', label: 'Facts', tab: 'facts' };
const simple = (href: string, label: string, tab: Tab | null): Back => ({ href, label, tab });

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
    return simple('/facts' + (out.size ? '?' + out : ''), kind === 'profile' ? 'About you' : 'Facts', 'facts');
  }
  if (path === '/' && paramsAllowed(u, ['project'])) {
    const project = u.searchParams.get('project');
    if (project === null) return simple('/', 'Projects', 'projects');
    if (project.length > 63) return undefined;
    const name = look.projectName(project);
    return name ? simple('/?project=' + encodeURIComponent(name) + '#panel', name, 'projects') : undefined;
  }
  if (path === '/graph' && paramsAllowed(u, ['project', 'view'])) {
    const project = u.searchParams.get('project'), view = u.searchParams.get('view');
    if (view !== null && view !== 'list' && view !== '3d') return undefined;
    const name = project === null ? null : look.projectName(project);
    if (project !== null && !name) return undefined;
    const out = new URLSearchParams();
    if (name) out.set('project', name);
    if (view !== null) out.set('view', view);
    return simple('/graph' + (out.size ? '?' + out : ''), 'Graph', 'graph');
  }
  if (path === '/search' && paramsAllowed(u, ['q'])) {
    const q = u.searchParams.get('q');
    return simple('/search' + (q === null ? '' : '?q=' + encodeURIComponent(q.slice(0, 200))), 'Search', null);
  }
  if (!paramsAllowed(u, [])) return undefined;
  if (path === '/facts/tidy') return simple(path, 'Tidy up', 'facts');
  if (path === '/pages') return simple(path, 'Pages', 'pages');
  if (path.startsWith('/pages/') && UUID.test(path.slice(7))) {
    const title = look.pageTitle(path.slice(7));
    return title ? simple(path, title, 'pages') : undefined;
  }
  if (path.startsWith('/memories/') && UUID.test(path.slice(10))) return simple(path, 'Fact', 'facts');
  if (path.startsWith('/discussions/') && look.discussionTitle(path.slice(13))) return simple(path, 'Discussion', 'projects');
  if (path === '/approvals') return simple(path, 'Inbox', 'inbox');
  if (path === '/review') return simple(path, 'Last week', 'week');
  if (path === '/review/now') return simple(path, 'So far', 'week');
  if (path.startsWith('/review/') && REVIEW_DATE.test(path.slice(8))) {
    const date = path.slice(8);
    const d = new Date(date + 'T12:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return undefined;
    return simple(path, 'Week of ' + d.getUTCDate() + ' ' + d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), 'week');
  }
  return undefined;
}

export function factBackDefault(m: { project: string | null }, look: BackLookups): Back {
  const name = m.project === null ? undefined : look.projectName(m.project);
  return name ? simple('/?project=' + encodeURIComponent(name) + '#panel', name, 'projects') : factsBack;
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

/** The fixed line for `?error=changed` or `?error=failed`; anything else shows nothing. */
export const backError = (q: unknown): string | undefined => (q === 'changed' || q === 'failed' ? BACK_ERRORS[q] : undefined);

export const withBackError = (back: string, e: BackError): string => `${back}?error=${e}`;
