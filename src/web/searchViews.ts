import type { Memory } from '../memory/types.js';
import type { Page } from '../pages/types.js';
import type { Project } from '../projects/types.js';
import { withFrom } from './back.js';
import { excerpt, roadmapLine, when, writer } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { kindLabel, pastChip } from './factMetaViews.js';
import { t, tHtml } from '../i18n/index.js';
import { staleChip } from './freshnessViews.js';
import { stripProjectPrefix } from './stripProject.js';

/** A fact found: its text (without a leading "<project>:", which the chip already says) and a meta line led by the project. */
const factRow = (m: Memory, from: string): SafeHtml => html`<li><a class="row nolead" href="${withFrom(`/memories/${m.id}`, from)}"><span class="txt">${excerpt((m.kind === 'roadmap' ? roadmapLine(m.content) : null) ?? (m.project ? stripProjectPrefix(m.content, m.project) : m.content))}${metaLine([m.project ? html`<span class="chip plain">${m.project}</span>` : null, kindLabel(m.kind), writer(m.updatedBy), when(m.updatedAt), pastChip(m)])}</span><span class="chev"></span></a></li>`;
const projectRow = (p: Project): SafeHtml => html`<li><a class="row nolead" href="/?project=${encodeURIComponent(p.name)}#panel"><span class="txt"><b>${p.name}</b>${p.oneLiner ? html`<span class="sub">${p.oneLiner}</span>` : ''}</span><span class="chev"></span></a></li>`;
const pageRow = (r: { page: Page; anchor: string; heading: string; snippet: string; stale?: boolean }, from: string): SafeHtml => html`<li><a class="row nolead" href="${withFrom(`/pages/${r.page.id}#${r.anchor}`, from)}"><span class="txt"><b>${r.page.title}${r.anchor === 'top' ? '' : ` › ${r.heading}`}</b>${r.snippet ? html`<span class="sub">${r.snippet}</span>` : ''}${r.stale ? metaLine([staleChip()]) : ''}</span><span class="chev"></span></a></li>`;

/**
 * Search results: projects first, then facts, then page sections, each one grouped list. Replaced facts stay out;
 * the ones that ranked among the results are counted in one quiet line under Facts (section 16). Every fact and page
 * row carries the search's own address, so its back link returns to the results.
 */
export function searchView(v: { q: string; projects: Project[]; facts: Memory[]; pages: { page: Page; anchor: string; heading: string; snippet: string; stale?: boolean }[]; alsoReplaced?: number }): SafeHtml {
  if (v.q === '') return html`<div class="search-page"><h1>${t('search.title')}</h1><p class="quiet">${t('search.typeSomething')}</p></div>`;
  const from = `/search?q=${encodeURIComponent(v.q)}`;
  const also = v.alsoReplaced ?? 0;
  const none = v.projects.length === 0 && v.facts.length === 0 && v.pages.length === 0 && also === 0;
  const alsoLine = also === 0 ? '' : html`<p class="also-line">${t('search.alsoReplaced', { count: also })} <a href="/facts?q=${encodeURIComponent(v.q)}&amp;show=replaced">${also === 1 ? t('search.showReplacedOne') : t('search.showReplacedMany')}</a></p>`;
  return html`<div class="search-page"><h1>${t('search.title')}</h1>
<p class="lede">${tHtml('search.resultsFor', { q: html`<strong>${v.q}</strong>` })}</p>
${none ? html`<p class="quiet empty">${t('search.none', { q: v.q })}</p>` : ''}
${v.projects.length > 0 ? html`<section class="search-group"><h2>${t('projects.title')}</h2><ul class="group">${v.projects.map(projectRow)}</ul></section>` : ''}
${v.facts.length > 0 || also > 0 ? html`<section class="search-group"><h2>${t('projects.facts')}</h2>${v.facts.length > 0 ? html`<ul class="group">${v.facts.map((m) => factRow(m, from))}</ul>` : ''}${alsoLine}</section>` : ''}
${v.pages.length > 0 ? html`<section class="search-group"><h2>${t('projects.pages')}</h2><ul class="group">${chipOncePerPage(v.pages).map((r) => pageRow(r, from))}</ul></section>` : ''}</div>`;
}

/** A flagged page's chip goes on its first hit only, so several sections of one page don't repeat it. */
function chipOncePerPage<T extends { page: Page; stale?: boolean }>(rows: T[]): T[] {
  const chipped = new Set<string>();
  return rows.map((r) => {
    if (!r.stale) return r;
    if (chipped.has(r.page.id)) return { ...r, stale: false };
    chipped.add(r.page.id);
    return r;
  });
}
