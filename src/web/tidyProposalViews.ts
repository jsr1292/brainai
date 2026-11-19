/**
 * B2, Tidy proposals: the Inbox card for what an assistant proposed in a tidy session. It shows before (the facts) and
 * after (what would happen), with Approve and Reject; a proposal whose facts changed since only offers Reject.
 * Kept apart from the other Inbox cards on purpose.
 */
import type { Memory } from '../memory/types.js';
import { factsOf, moveLine, type TidyBody, type TidyProposal } from '../memory/tidyService.js';
import { replaceableKind } from '../memory/supersessions.js';
import { when, writer } from './dashboardViews.js';
import { html, raw, type SafeHtml } from './html.js';
import { renderInline } from '../pages/markdown.js';
import { metaLine } from './metaLine.js';
import { t, tKey } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';

const day = (m: Memory): string => m.createdAt.slice(0, 10);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The Inbox row's title for a proposal. */
export function tidyProposalTitle(p: TidyProposal): string {
  const n = factsOf(p.body).length;
  const facts = t('inbox.tp.nFacts', { count: n });
  const b = p.body;
  return b.type === 'supersede' ? t('inbox.tp.supersede', { count: b.replacedIds.length, project: p.project })
    : b.type === 'merge' ? t('inbox.tp.merge', { facts, project: p.project })
    : b.type === 'move_to_page' ? t('inbox.tp.move', { facts, project: p.project })
    : t('inbox.tp.mark', { facts, project: p.project });
}

/** One fact in a card: its date and kind (never its id), then its text. `text` replaces the current text (a stale card shows what the assistant saw). */
type FactLabel = 'keep' | 'replaced' | 'replacedSince' | 'editedSince' | 'unchanged';
const factBlock = (m: Memory | undefined, label?: FactLabel, text?: string): SafeHtml => (m
  ? html`<blockquote class="${label === 'replaced' ? 'dim' : 'current'}">${label ? html`<b>${tKey(`inbox.tp.label.${label}`)}.</b> ` : ''}<span class="meta">${day(m)} · ${replaceableKind(m) === 'status' ? t('inbox.tp.status') : t('inbox.tp.decision')}</span><br>${text ?? m.content}${m.validUntil ? html`<br><span class="meta">${t('inbox.tp.validUntil', { date: m.validUntil })}</span>` : ''}</blockquote>`
  : html`<blockquote class="dim">${t('inbox.tp.gone')}</blockquote>`);

/** What became of a fact since the proposal was made. */
export type FactNow = 'same' | 'edited' | 'replaced' | 'gone';

export interface TidyCardInput {
  p: TidyProposal;
  /** The facts as they are now, by id. */
  facts: Map<string, Memory | undefined>;
  /** Why it cannot be applied any more ("changed since"), or null. */
  stale: string | null;
  /** `section`: the heading as the page shows it ("Key decisions"); `style`: how its dated lines write the date (lineStyle). */
  page?: { title: string; section: string; style: string } | null;
  next?: string | null;
  /** A stale card: each fact's text when the assistant proposed, and what became of it since. */
  asProposed?: Map<string, string>;
  now?: Map<string, FactNow>;
}

function after(b: TidyBody, i: TidyCardInput): SafeHtml {
  const f = (id: string) => i.facts.get(id);
  if (b.type === 'supersede') {
    return html`<p class="label">${t('inbox.tp.afterApproval')}</p><p>${b.replacedIds.length === 1 ? t('inbox.tp.supersedeOne') : t('inbox.tp.supersedeMany', { count: b.replacedIds.length })}</p>`;
  }
  if (b.type === 'merge') {
    const dates = b.ids.map((id) => f(id)?.validUntil ?? null);
    const until = dates.every((d) => d !== null) ? dates.reduce((x, y) => (x! > y! ? x : y)) : null;
    const kind = b.kind === 'summary' ? t('inbox.tp.mergeKindStatus') : t('inbox.tp.mergeKindDecision');
    return html`<p class="label">${t('inbox.tp.mergeAfter')}</p><blockquote class="proposed">${b.content}</blockquote>
<p class="meta">${until ? t('inbox.tp.mergeMetaUntil', { kind, project: i.p.project, by: i.p.proposedBy, date: until }) : t('inbox.tp.mergeMeta', { kind, project: i.p.project, by: i.p.proposedBy })}</p>
<p>${t('inbox.tp.mergeBecome', { count: b.ids.length })}</p>`;
  }
  if (b.type === 'move_to_page') {
    const lines = b.ids.map((id) => { const m = f(id); return m ? moveLine(m, i.page?.style ?? ' ') : ''; }).filter((x) => x !== '');
    const factLabel = t('inbox.tp.factLink');
    return html`<p class="label">${i.page ? tHtml('inbox.tp.moveTo', { page: html`<b>${i.page.title}</b>, ${i.page.section}` }) : t('inbox.tp.moveToPage')}</p><div class="sk-text">${raw(lines.map((l) => `<div>${renderInline(l.replace(/^- /, '').replace(/\|fact\]\]$/, `|${factLabel}]]`), (target) => (target.startsWith('fact:') ? { href: `/memories/${target.slice(5)}`, label: factLabel } : null)).value}</div>`).join(''))}</div>
<p>${t('inbox.tp.factsStay')}</p>`;
  }
  return html`<p class="label">${t('inbox.tp.afterApproval')}</p><p>${b.ids.length === 1 ? t('inbox.tp.markedOne') : t('inbox.tp.markedMany')}</p>`;
}

export function tidyProposalCard(i: TidyCardInput): SafeHtml {
  const { p } = i;
  const b = p.body;
  const keepId = b.type === 'supersede' ? b.keepId : null;
  const replaced = new Set(b.type === 'supersede' ? b.replacedIds : []);
  const ids = factsOf(b);
  const label = (id: string): FactLabel | undefined => (id === keepId ? 'keep' : replaced.has(id) ? 'replaced' : undefined);
  const next = i.next ? html`<input type="hidden" name="next" value="${i.next}">` : '';
  const head = html`<p class="approval-head">${tHtml('inbox.tp.proposes', { writer: writer(p.proposedBy), title: html`<b>${tidyProposalTitle(p)}</b>` })}</p>
${metaLine([when(p.proposedAt), t('inbox.tp.kindLabel'), p.project])}
<p class="label">${t('inbox.tp.why')}</p><blockquote class="proposed">${p.reason}</blockquote>`;
  if (i.stale) {
    // Nothing can be applied: what the assistant saw, what became of each fact, and only Dismiss.
    const nowBlock = (id: string): SafeHtml => {
      const state = i.now?.get(id) ?? 'same';
      const m = i.facts.get(id);
      return state === 'gone' ? html`<blockquote class="dim"><b>${t('inbox.tp.deleted')}</b></blockquote>`
        : state === 'replaced' ? factBlock(m, 'replacedSince')
        : state === 'edited' ? factBlock(m, 'editedSince')
        : factBlock(m, 'unchanged');
    };
    return html`<article class="card suggestion approval-card tidy-proposal">${head}
<p class="held">${i.stale}</p>
<p class="label">${t('inbox.tp.saw')}</p>${ids.map((id) => factBlock(i.facts.get(id), label(id), i.asProposed?.get(id)))}
<p class="label">${t('inbox.tp.now')}</p>${ids.map(nowBlock)}
<div class="actions"><form method="post" action="/tidy-proposals/${p.id}/reject" class="push-right">${next}<button type="submit" class="ghost">${t('inbox.tp.dismiss')}</button></form></div>
<p class="meta approval-foot">${t('inbox.tp.dismissNote')}</p></article>`;
  }
  const retire = b.type === 'move_to_page'
    ? html`<label class="choice retire-opt"><input type="checkbox" name="retire" value="1"><span>${t('inbox.tp.retire')} <small>${t('inbox.tp.retireNote')}</small></span></label>`
    : '';
  const replacing = b.type === 'supersede' || b.type === 'merge';
  return html`<article class="card suggestion approval-card tidy-proposal">${head}
<p class="label">${t('inbox.tp.before')}</p>${ids.map((id) => factBlock(i.facts.get(id), label(id)))}
${after(b, i)}
<form method="post" action="/tidy-proposals/${p.id}/approve">${next}${retire}
<div class="actions"><button type="submit" class="primary">${t('inbox.tp.approve')}</button><button type="submit" formaction="/tidy-proposals/${p.id}/reject" formnovalidate class="ghost push-right">${t('inbox.tp.reject')}</button></div></form>
<p class="meta approval-foot">${replacing ? t('inbox.tp.nothingChangesReplaced') : t('inbox.tp.nothingChanges')}</p></article>`;
}
