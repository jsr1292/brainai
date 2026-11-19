import type { Disagreement } from '../memory/disagreements.js';
import type { Memory } from '../memory/types.js';
import { writer, writerName } from './dashboardViews.js';
import { sourceWords, sourceWordsNote } from './factMetaViews.js';
import { html, type SafeHtml } from './html.js';
import { t } from '../i18n/core.js';
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
  return html`<h3 id="p-disagree">${t('inbox.disagree.title')} <span class="n">${list.length}</span></h3>${pairs(list, now, `/?project=${encodeURIComponent(project)}#panel`, project)}`;
}

/** A2: where one side came from ("You said this", "An assistant inferred this"); nothing for a fact with no source. Display only. */
const sourceTag = (m: Memory): SafeHtml => (m.source
  ? html`<p class="dg-source meta">${sourceWordsNote(m)}</p>` : html``);

/** When one side is what the owner said and the other an assistant's inference, the pair says so. Settling is unchanged. */
const youVsAssistant = (d: OpenDisagreement): SafeHtml => {
  const said = [d.factA, d.factB].find((m) => m.source === 'owner_said');
  const inferred = [d.factA, d.factB].find((m) => m.source === 'inferred');
  // The wording of each side's own source: only the owner's own mark reads "You said this".
  return said && inferred
    ? html`<p class="dg-sources quiet">${t('inbox.disagree.youVsAssistant', { said: sourceWords(said), inferred: sourceWords(inferred).replace(/^./, (c) => c.toLowerCase()) })}</p>` : html``;
};

/** The pairs as a list; each settle form comes back to `back`. */
export function pairs(list: OpenDisagreement[], now: Date, back: string, project: string | null, next?: string | null): SafeHtml {
  const settle = (d: OpenDisagreement, how: 'a' | 'b' | 'both', label: string, cls: string) =>
    html`<form method="post" action="/disagreements/${d.id}/settle"><input type="hidden" name="how" value="${how}"><input type="hidden" name="back" value="${back}">${next ? html`<input type="hidden" name="next" value="${next}">` : ''}<button type="submit" class="${cls}">${label}</button></form>`;
  // On a project's page, a fact from elsewhere says where it is: settling may replace or delete it.
  const elsewhere = (m: Memory) => project !== null && m.project !== project ? (m.project === null ? t('inbox.disagree.aboutYou') : t('inbox.disagree.inProject', { project: m.project })) : null;
  const side = (d: OpenDisagreement, m: Memory, how: 'a' | 'b') => html`<div class="dg-fact"><a href="/memories/${m.id}">${project === null ? m.content : stripProjectPrefix(m.content, project)}</a>${metaLine([writer(m.updatedBy), timeAgo(m.updatedAt, now), elsewhere(m)])}${sourceTag(m)}${settle(d, how, t('inbox.disagree.right'), 'sm')}</div>`;
  return html`<ul class="disagree plain-list">${list.map((d) => html`<li><p class="dg-why">${d.why} <span class="quiet">${t('inbox.disagree.flaggedBy', { who: writerName(d.flaggedBy) })}</span></p>${youVsAssistant(d)}
    <div class="dg-pair">${side(d, d.factA, 'a')}${side(d, d.factB, 'b')}</div>${settle(d, 'both', t('inbox.disagree.both'), 'ghost sm')}</li>`)}</ul>`;
}

/** The page of every open pair, grouped by project (profile facts and facts with no project under "About you"). */
export function disagreementsView(groups: { project: string | null; list: OpenDisagreement[] }[], now: Date): SafeHtml {
  return html`<h1>${t('inbox.disagree.heading')}</h1>
  <p class="lede">${t('inbox.disagree.lede')}</p>
  ${groups.length === 0 ? html`<p class="quiet">${t('inbox.disagree.nothing')}</p>` : groups.map((g) => html`<section class="dg-group"><h2>${g.project ?? t('inbox.disagree.aboutYou')}</h2>${pairs(g.list, now, '/disagreements', g.project)}</section>`)}`;
}

/** One wording for every place that counts open pairs (For you, Brain health), the same count as the Inbox. */
export const disagreeText = (count: number): string => t('inbox.disagree.text', { count });

/** For you: one row for every open disagreement, to the page that lists them. */
export function disagreeRow(count: number): SafeHtml {
  const text = disagreeText(count);
  return html`<a class="row" href="/disagreements"><span class="dot" aria-hidden="true"></span><span class="txt">${text}</span><span class="chev"></span></a>`;
}
