import type { Disagreement } from '../memory/disagreements.js';
import type { Memory } from '../memory/types.js';
import { writer, writerName } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { stripProjectPrefix } from './stripProject.js';
import { timeAgo } from './when.js';

export type OpenDisagreement = Disagreement & { factA: Memory; factB: Memory };

/**
 * B1: a project's open disagreements, each pair side by side (stacked on the phone) with who saved each fact and
 * when, the reason it was flagged, and the three ways to settle it. Left out when there are none.
 */
export function disagreeGroup(project: string, list: OpenDisagreement[], now: Date): SafeHtml {
  if (list.length === 0) return html``;
  return html`<h3 id="p-disagree">These facts disagree <span class="n">${list.length}</span></h3>${pairs(list, now, `/?project=${encodeURIComponent(project)}#panel`, project)}`;
}

/** The pairs as a list; each settle form comes back to `back`. */
function pairs(list: OpenDisagreement[], now: Date, back: string, project: string | null): SafeHtml {
  const settle = (d: OpenDisagreement, how: 'a' | 'b' | 'both', label: string, cls: string) =>
    html`<form method="post" action="/disagreements/${d.id}/settle"><input type="hidden" name="how" value="${how}"><input type="hidden" name="back" value="${back}"><button type="submit" class="${cls}">${label}</button></form>`;
  // On a project's page, a fact from elsewhere says where it is: settling may replace or delete it.
  const elsewhere = (m: Memory) => project !== null && m.project !== project ? (m.project === null ? 'About you' : `in ${m.project}`) : null;
  const side = (d: OpenDisagreement, m: Memory, how: 'a' | 'b') => html`<div class="dg-fact"><a href="/memories/${m.id}">${project === null ? m.content : stripProjectPrefix(m.content, project)}</a>${metaLine([writer(m.updatedBy), timeAgo(m.updatedAt, now), elsewhere(m)])}${settle(d, how, 'This one is right', 'sm')}</div>`;
  return html`<ul class="disagree plain-list">${list.map((d) => html`<li><p class="dg-why">${d.why} <span class="quiet">· flagged by ${writerName(d.flaggedBy)}</span></p>
    <div class="dg-pair">${side(d, d.factA, 'a')}${side(d, d.factB, 'b')}</div>${settle(d, 'both', 'Both are right', 'ghost sm')}</li>`)}</ul>`;
}

/** The page of every open pair, grouped by project (profile facts and facts with no project under "About you"). */
export function disagreementsView(groups: { project: string | null; list: OpenDisagreement[] }[], now: Date): SafeHtml {
  return html`<h1>Facts that disagree</h1>
  <p class="lede">An assistant flagged each pair: they can't both be true. Pick the one that is right (the other is replaced), or say both are.</p>
  ${groups.length === 0 ? html`<p class="quiet">Nothing to settle.</p>` : groups.map((g) => html`<section class="dg-group"><h2>${g.project ?? 'About you'}</h2>${pairs(g.list, now, '/disagreements', g.project)}</section>`)}`;
}

/** For you: one row for every open disagreement, to the page that lists them. */
export function disagreeRow(count: number): SafeHtml {
  const text = count === 1 ? '2 facts disagree' : `${count} pairs of facts disagree`;
  return html`<a class="row" href="/disagreements"><span class="dot" aria-hidden="true"></span><span class="txt">${text}</span><span class="chev"></span></a>`;
}
