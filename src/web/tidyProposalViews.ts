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

const day = (m: Memory): string => m.createdAt.slice(0, 10);
const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** The Inbox row's title for a proposal. */
export function tidyProposalTitle(p: TidyProposal): string {
  const n = factsOf(p.body).length;
  const facts = n === 1 ? '1 fact' : `${n} facts`;
  const b = p.body;
  return b.type === 'supersede' ? `Keep one fact, replace ${b.replacedIds.length === 1 ? '1 other' : `${b.replacedIds.length} others`} (${p.project})`
    : b.type === 'merge' ? `Merge ${facts} into one (${p.project})`
    : b.type === 'move_to_page' ? `Add ${facts} to a page's Key decisions (${p.project})`
    : `Mark ${facts} as looked at (${p.project})`;
}

/** One fact in a card: its date and kind (never its id), then its text. `text` replaces the current text (a stale card shows what the assistant saw). */
const factBlock = (m: Memory | undefined, label?: string, text?: string): SafeHtml => (m
  ? html`<blockquote class="${label === 'Replaced' ? 'dim' : 'current'}">${label ? html`<b>${label}.</b> ` : ''}<span class="meta">${day(m)} · ${replaceableKind(m) === 'status' ? 'status' : 'decision'}</span><br>${text ?? m.content}${m.validUntil ? html`<br><span class="meta">valid until ${m.validUntil}</span>` : ''}</blockquote>`
  : html`<blockquote class="dim">(gone)</blockquote>`);

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
    return html`<p class="label">After approval:</p><p>The fact marked Keep stays current. ${b.replacedIds.length === 1 ? 'The other one becomes' : `The other ${b.replacedIds.length} become`} replaced history: still there, and you can bring ${b.replacedIds.length === 1 ? 'it' : 'them'} back from ${b.replacedIds.length === 1 ? 'its' : 'their'} page.</p>`;
  }
  if (b.type === 'merge') {
    const dates = b.ids.map((id) => f(id)?.validUntil ?? null);
    const until = dates.every((d) => d !== null) ? dates.reduce((x, y) => (x! > y! ? x : y)) : null;
    return html`<p class="label">After approval, a new fact:</p><blockquote class="proposed">${b.content}</blockquote>
<p class="meta">${b.kind === 'summary' ? 'Status' : 'Decision'} · ${i.p.project} · source: inferred by ${i.p.proposedBy}${until ? ` · valid until ${until}` : ''}</p>
<p>The ${b.ids.length} facts above become replaced history: still there, and you can bring them back.</p>`;
  }
  if (b.type === 'move_to_page') {
    const lines = b.ids.map((id) => { const m = f(id); return m ? moveLine(m, i.page?.style ?? ' ') : ''; }).filter((x) => x !== '');
    return html`<p class="label">After approval, added to ${i.page ? html`<b>${i.page.title}</b>, ${i.page.section}` : 'the page'} (a new version of the page):</p><div class="sk-text">${raw(lines.map((l) => `<div>${renderInline(l.replace(/^- /, ''), (t) => (t.startsWith('fact:') ? { href: `/memories/${t.slice(5)}`, label: 'fact' } : null)).value}</div>`).join(''))}</div>
<p>The facts stay as they are.</p>`;
  }
  return html`<p class="label">After approval:</p><p>${b.ids.length === 1 ? 'This fact is' : 'These facts are'} marked as looked at and not offered again until ${b.ids.length === 1 ? 'it changes' : 'one of them changes'}.</p>`;
}

export function tidyProposalCard(i: TidyCardInput): SafeHtml {
  const { p } = i;
  const b = p.body;
  const keepId = b.type === 'supersede' ? b.keepId : null;
  const replaced = new Set(b.type === 'supersede' ? b.replacedIds : []);
  const ids = factsOf(b);
  const label = (id: string) => (id === keepId ? 'Keep' : replaced.has(id) ? 'Replaced' : undefined);
  const next = i.next ? html`<input type="hidden" name="next" value="${i.next}">` : '';
  const head = html`<p class="approval-head">${writer(p.proposedBy)} proposes: <b>${tidyProposalTitle(p)}</b></p>
${metaLine([when(p.proposedAt), 'Tidy proposal', p.project])}
<p class="label">Why:</p><blockquote class="proposed">${p.reason}</blockquote>`;
  if (i.stale) {
    // Nothing can be applied: what the assistant saw, what became of each fact, and only Dismiss.
    const nowBlock = (id: string): SafeHtml => {
      const state = i.now?.get(id) ?? 'same';
      const m = i.facts.get(id);
      return state === 'gone' ? html`<blockquote class="dim"><b>Deleted.</b></blockquote>`
        : state === 'replaced' ? factBlock(m, 'Replaced since')
        : state === 'edited' ? factBlock(m, 'Edited since')
        : factBlock(m, 'Unchanged');
    };
    return html`<article class="card suggestion approval-card tidy-proposal">${head}
<p class="held">${i.stale}</p>
<p class="label">What the assistant saw:</p>${ids.map((id) => factBlock(i.facts.get(id), label(id), i.asProposed?.get(id)))}
<p class="label">Now:</p>${ids.map(nowBlock)}
<div class="actions"><form method="post" action="/tidy-proposals/${p.id}/reject" class="push-right">${next}<button type="submit" class="ghost">Dismiss</button></form></div>
<p class="meta approval-foot">Dismissing only clears this proposal. No fact is changed.</p></article>`;
  }
  const retire = b.type === 'move_to_page'
    ? html`<label class="choice retire-opt"><input type="checkbox" name="retire" value="1"><span>Also retire these facts <small>They move to Deleted, where you can restore them. This is not forgetting them.</small></span></label>`
    : '';
  const replacing = b.type === 'supersede' || b.type === 'merge';
  return html`<article class="card suggestion approval-card tidy-proposal">${head}
<p class="label">Before:</p>${ids.map((id) => factBlock(i.facts.get(id), label(id)))}
${after(b, i)}
<form method="post" action="/tidy-proposals/${p.id}/approve">${next}${retire}
<div class="actions"><button type="submit" class="primary">Approve</button><button type="submit" formaction="/tidy-proposals/${p.id}/reject" formnovalidate class="ghost push-right">Reject</button></div></form>
<p class="meta approval-foot">Nothing changes until you approve.${replacing ? ' Facts that are replaced stay as history.' : ''}</p></article>`;
}
