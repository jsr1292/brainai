import type { Memory, Suggestion } from '../memory/types.js';
import { errorBlock, suggestionCard } from './dashboardViews.js';
import type { Skill, SkillProposal } from '../skills/types.js';
import { proposalCard } from './skillViews.js';
import { html, type SafeHtml } from './html.js';

/** The answer when a suggestion no longer waits (answered on another device in the meantime). */
export const ALREADY_ANSWERED = 'That suggestion was already answered.';

/** Approvals (Projects › Approvals, lit Projects): every held suggestion as the full card, each returning here. */
export function approvalsView(v: { pending: { suggestion: Suggestion; current: string | undefined; replaces: Memory[]; deleted?: Memory }[]; proposals?: { proposal: SkillProposal; current: Skill | undefined }[]; notice?: string; error?: string }): SafeHtml {
  const proposals = v.proposals ?? [];
  return html`<div class="narrow approvals">
<h1>Approvals</h1>
${errorBlock(v.error)}
${v.notice ? html`<p class="notice" role="status">${v.notice}</p>` : ''}
${v.pending.length === 0 && proposals.length === 0 ? html`<p class="quiet">Nothing waits for your approval.</p>` : html`<ul class="cards">${v.pending.map((p) => html`<li>${suggestionCard(p.suggestion, p.current, { back: '/approvals', replaces: p.replaces, deleted: p.deleted })}</li>`)}${proposals.map((p) => html`<li>${proposalCard(p.proposal, p.current)}</li>`)}</ul>`}
</div>`;
}
