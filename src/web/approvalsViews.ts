import type { Memory, Suggestion } from '../memory/types.js';
import { errorBlock, plural, suggestionCard } from './dashboardViews.js';
import type { Skill, SkillProposal } from '../skills/types.js';
import { proposalCard } from './skillViews.js';
import { html, type SafeHtml } from './html.js';

/** The answer when a suggestion no longer waits (answered on another device in the meantime). */
export const ALREADY_ANSWERED = 'That suggestion was already answered.';

/**
 * The Inbox (its own place in the sidebar): what waits for the owner — suggestions, proposals, discussions that need
 * their answer, and possible tidy-ups — with the held suggestions as the full cards, each returning here.
 */
export function approvalsView(v: { pending: { suggestion: Suggestion; current: string | undefined; replaces: Memory[]; deleted?: Memory }[]; proposals?: { proposal: SkillProposal; current: Skill | undefined }[]; waiting?: { id: string; title: string }[]; tidy?: string | null; notice?: string; error?: string }): SafeHtml {
  const proposals = v.proposals ?? [];
  const waiting = v.waiting ?? [];
  const tidy = v.tidy ?? null;
  /** One line per thing that waits, above the cards: the discussions first, then the tidy-ups. */
  const lines: SafeHtml[] = [];
  if (waiting.length > 0) {
    const titles = waiting.map((w, i) => html`${i > 0 ? ', ' : ''}<a href="/discussions/${w.id}">${w.title}</a>`);
    lines.push(html`<li><span class="il-k">Discussions</span><span>${plural(waiting.length, 'discussion waits', 'discussions wait')} for your reply: ${titles}</span></li>`);
  }
  if (tidy !== null) lines.push(html`<li><span class="il-k">Facts</span><span><a href="/facts/tidy">Tidy up: ${tidy}</a></span><span class="il-m">Possible tidy-ups</span></li>`);
  const cards = v.pending.length > 0 || proposals.length > 0
    ? html`<ul class="cards">${v.pending.map((p) => html`<li>${suggestionCard(p.suggestion, p.current, { back: '/approvals', replaces: p.replaces, deleted: p.deleted })}</li>`)}${proposals.map((p) => html`<li>${proposalCard(p.proposal, p.current)}</li>`)}</ul>`
    : lines.length > 0 ? '' : html`<p class="quiet">Nothing waits for you. Suggestions from assistants, discussions that need your answer and possible tidy-ups land here.</p>`;
  return html`<div class="narrow approvals">
<h1>Inbox</h1>
${errorBlock(v.error)}
${v.notice ? html`<p class="notice" role="status">${v.notice}</p>` : ''}
${lines.length > 0 ? html`<h2 class="ib-h">Waiting for you</h2><ul class="inbox-lines">${lines}</ul>` : ''}
${cards}
</div>`;
}
