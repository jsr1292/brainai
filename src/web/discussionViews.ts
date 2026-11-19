import { askText, type OwnerDiscussionView, type OwnerSummary } from '../discussions/service.js';
import type { Post } from '../discussions/types.js';
import { withFrom } from './back.js';
import { t, tHtml } from '../i18n/index.js';
import { errorBlock, when, writerKey } from './dashboardViews.js';
import { html, memoryServerName, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { timeAgo } from './when.js';

/** Where "Ask in <name>" opens, by writer colour key. Other assistants (Mac apps) get only Copy. */
export const ASK_LINKS: Record<string, string> = {
  claude: 'https://claude.ai/new?q=',
  gpt: 'https://chatgpt.com/?q=',
  grok: 'https://grok.com/?q=',
};

/** Text the owner may have half-typed when a form was refused. */
export interface Drafts { note?: string; decision?: string; project?: string }

const lower = (s: string): string => s.trim().toLowerCase();
/** The same relative date words as the other screens. */
const day = (iso: string): SafeHtml => timeAgo(iso);

// ---- The Discussions list ----

function row(s: OwnerSummary): SafeHtml {
  const status = s.closedAt
    ? [tHtml('discussions.decided', { day: day(s.closedAt) }), t('discussions.savedToMemory')]
    : s.waitingFor.length > 0
      // Waiting on an assistant is not waiting on the owner: plain words, as on the project panel.
      ? [t('discussions.waitingFor', { names: s.waitingFor.join(', ') })]
      : [t('discussions.allReplied')];
  return html`<li><a class="row nolead" href="/discussions/${s.id}"><span class="txt"><b>${s.title}</b>${metaLine([s.project ? html`<span class="project">${s.project}</span>` : null, t('discussions.round', { round: s.round }), ...status])}</span><span class="chev"></span></a></li>`;
}

export function discussionsView(items: OwnerSummary[]): SafeHtml {
  const lede = html`<p class="lede">${t('discussions.lede')}</p>`;
  if (items.length === 0) return html`<div class="narrow"><h1>${t('discussions.title')}</h1>
${lede}
<p class="quiet">${t('discussions.none')}</p></div>`;
  const closed = items.filter((s) => s.closedAt);
  return html`<div class="narrow"><h1>${t('discussions.title')}</h1>
${lede}
<ul class="group">${items.filter((s) => !s.closedAt).map(row)}${closed.length > 0 ? html`<li><details class="fold"><summary class="row nolead">${t('discussions.closed')} <span class="n">${closed.length}</span><span class="chev"></span></summary><ul class="fold-list">${closed.map(row)}</ul></details></li>` : ''}</ul></div>`;
}

// ---- One discussion ----

function postCard(p: Post & { contains_instructions?: true }): SafeHtml {
  const who = p.kind === 'note' ? html`<span class="writer w-you">${t('discussions.yourNote')}</span>` : html`<span class="writer w-${writerKey(p.author)}">${p.author} · ${p.model}</span>`;
  return html`<article class="reply w-${p.kind === 'note' ? 'you' : writerKey(p.author)}">
  ${metaLine([who, when(p.createdAt)])}
  ${p.contains_instructions ? html`<p><span class="instr" title="${t('discussions.instr.reply')}">${t('discussions.instr')}</span></p>` : ''}
  <p class="post">${p.text}</p>
</article>`;
}

function askControl(v: OwnerDiscussionView, name: string): SafeHtml {
  const text = askText(v.id, v.round, memoryServerName());
  const link = ASK_LINKS[writerKey(name)];
  return html`<div class="actions">${link ? html`<a class="button" href="${link + encodeURIComponent(text)}" target="_blank" rel="noopener">${t('discussions.askIn', { name })}</a>` : ''}<button type="button" class="secondary" data-copy="${text}" aria-label="${t('discussions.copyFor', { name })}">${t('discussions.copy')}</button></div>`;
}

function pendingCard(v: OwnerDiscussionView, name: string): SafeHtml {
  return html`<article class="reply pending w-${writerKey(name)}">
  <p class="meta"><span class="writer w-${writerKey(name)}">${name}</span></p>
  <p class="quiet">${t('discussions.noReply', { round: v.round, name })}</p>
  ${askControl(v, name)}
</article>`;
}

function roundStrip(v: OwnerDiscussionView, repliedNames: Set<string>): SafeHtml {
  const base = `/discussions/${v.id}`;
  const pill = (name: string) => {
    const replied = repliedNames.has(lower(name));
    const remove = v.closedAt ? '' : html`<form method="post" action="${base}/ask"><input type="hidden" name="remove" value="${name}"><button type="submit" class="ghost" aria-label="${t('discussions.remove', { name })}">×</button></form>`;
    return html`<span class="pill ${replied ? 'ok' : 'wait'}"><span class="writer w-${writerKey(name)}">${name}</span> ${replied ? t('discussions.replied') : t('discussions.askNext')}${remove}</span>`;
  };
  const add = v.closedAt ? '' : html`<form class="add-ask" method="post" action="${base}/ask">
    <label class="label" for="add">${t('discussions.addLabel')}</label>
    <div class="actions"><input id="add" name="add" maxlength="100" placeholder="${t('discussions.addPlaceholder')}"><button type="submit" class="secondary">${t('discussions.add')}</button></div>
  </form>`;
  return html`<section class="round-strip">
  <p class="meta"><strong>${v.round === 1 && !v.closedAt ? t('discussions.roundBlind', { round: v.round }) : t('discussions.roundHead', { round: v.round })}</strong>${v.ask.length === 0 ? t('discussions.nobody') : ''}</p>
  <div class="pills">${v.ask.map(pill)}</div>
  ${add}
</section>`;
}

function roundSection(v: OwnerDiscussionView, round: number, repliedNames: Set<string>): SafeHtml {
  const posts = [...v.notes, ...v.replies].filter((p) => p.round === round).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const current = round === v.round;
  const waiting = current && !v.closedAt ? v.ask.filter((n) => !repliedNames.has(lower(n))) : [];
  const cards = html`<div class="replies">${posts.map(postCard)}${waiting.map((n) => pendingCard(v, n))}</div>`;
  if (current) return html`<section>${cards}</section>`;
  const count = v.replies.filter((p) => p.round === round).length;
  // Open on a wide screen (data-desk-open: app.js on load, desk.js in its sheet); inert, and closed, below 1100 px.
  return html`<details class="earlier" data-desk-open><summary>${t('discussions.earlier', { round, count })}<span class="chev"></span></summary>${cards}</details>`;
}

/** The decision form, offered while a discussion is open. */
function decidePanel(v: OwnerDiscussionView, projects: string[], drafts: Drafts): SafeHtml {
  const base = `/discussions/${v.id}`;
  const project = v.project ? html`<p class="label">${t('discussions.savedTo', { project: v.project })}</p>`
    : html`<label>${t('discussions.projectFor')}
    <select name="project" required><option value="">${t('discussions.chooseProject')}</option>${projects.map((p) => html`<option value="${p}"${drafts.project === p ? ' selected' : ''}>${p}</option>`)}</select></label>`;
  return html`<section class="panel decide">
  <h2>${t('discussions.decide')}</h2>
  <p class="label">${t('discussions.decideNote')}</p>
  <form method="post" action="${base}/decide">
    <label>${t('discussions.decisionLabel')}<textarea name="decision" maxlength="100000" required>${drafts.decision ?? ''}</textarea></label>
    ${project}
    <div class="actions"><button type="submit">${t('discussions.saveClose')}</button></div>
  </form>
</section>`;
}

/** The note form and Start next round, offered while a discussion is open. */
function noteAndRoundForms(v: OwnerDiscussionView, drafts: Drafts): SafeHtml {
  const base = `/discussions/${v.id}`;
  return html`<section class="panel">
  <form method="post" action="${base}/note">
    <label>${t('discussions.noteLabel')}
    <textarea name="text" maxlength="8000">${drafts.note ?? ''}</textarea></label>
    <div class="actions"><button type="submit" class="secondary">${t('discussions.addNote')}</button></div>
  </form>
  <form method="post" action="${base}/round" class="next-round">
    <button type="submit">${v.round === 1 ? t('discussions.startRound2') : t('discussions.startNext')}</button>
  </form>
</section>`;
}

/** The rare rest, folded away: the note, Start next round, Sharing and Delete. A refused note opens it again. */
function moreFold(v: OwnerDiscussionView, drafts: Drafts, discussionOpen: boolean): SafeHtml {
  return html`<details class="pfold more-fold"${drafts.note !== undefined ? ' open' : ''}><summary>${t('discussions.more')}<span class="chev"></span></summary>
${discussionOpen ? noteAndRoundForms(v, drafts) : ''}
${sharingPanel(v)}
${deletePanel(v)}
</details>`;
}

/** Who may see the discussion; offered open or closed. */
function sharingPanel(v: OwnerDiscussionView): SafeHtml {
  return html`<section class="panel sharing">
  <form method="post" action="/discussions/${v.id}/sharing">
    <p>${v.includeLimited ? t('discussions.sharing.can') : t('discussions.sharing.cannot')}</p>
    <input type="hidden" name="include" value="${v.includeLimited ? 'no' : 'yes'}">
    <div class="actions"><button type="submit" class="secondary">${v.includeLimited ? t('discussions.sharing.hide') : t('discussions.sharing.show')}</button></div>
  </form>
</section>`;
}

/** Delete, behind a confirm box; offered open or closed. */
function deletePanel(v: OwnerDiscussionView): SafeHtml {
  return html`<section class="panel danger">
  <h2>${t('discussions.delete')}</h2>
  <form method="post" action="/discussions/${v.id}/delete">
    <label class="choice"><input type="checkbox" name="confirm" value="yes" required> ${t('discussions.deleteConfirm')}</label>
    <div class="actions"><button type="submit" class="secondary">${t('discussions.deleteButton')}</button></div>
  </form>
</section>`;
}

export function discussionView(v: OwnerDiscussionView, projects: string[], error?: string, drafts: Drafts = {}): SafeHtml {
  const base = `/discussions/${v.id}`;
  const repliedNames = new Set(v.replies.filter((p) => p.round === v.round).map((p) => lower(p.author)));
  const rounds = Array.from({ length: v.round }, (_, i) => v.round - i);
  const files = v.files.length === 0 ? '' : html`<ul class="files">${v.files.map((f) => html`<li><a class="file" href="${base}/files/${encodeURIComponent(f.name)}">${f.name}</a></li>`)}</ul>`;
  const decision = html`<section class="panel decided">
  <h2>${t('discussions.decision')}</h2>
  <p class="post">${v.decision}</p>
  <p class="meta">${tHtml('discussions.decidedOn', { day: v.closedAt ? day(v.closedAt) : '' })}${v.decisionMemoryId ? html` · <a href="${withFrom(`/memories/${v.decisionMemoryId}`, `/discussions/${v.id}`)}">${t('discussions.openMemory')}</a>` : ''}</p>
</section>`;
  // An open discussion reads: the question, this round's replies, the earlier rounds folded, then Decide and the ask strip.
  // A closed one leads with its decision, then the question and the rounds.
  const question = html`<div class="question">${v.question_contains_instructions ? html`<p><span class="instr" title="${t('discussions.instr.question')}">${t('discussions.instr')}</span></p>` : ''}<p class="post">${v.question}</p>${files}</div>`;
  return html`<div class="discussion wide narrow">
${metaLine([v.project ? html`<span class="project">${v.project}</span>` : null, t('discussions.round', { round: v.round })])}
<h1>${v.title}</h1>
${errorBlock(error)}
${v.closedAt ? decision : ''}
${question}
${v.closedAt ? rounds.map((r) => roundSection(v, r, repliedNames)) : html`${roundSection(v, v.round, repliedNames)}
${rounds.slice(1).map((r) => roundSection(v, r, repliedNames))}`}
${v.closedAt ? '' : decidePanel(v, projects, drafts)}
${v.closedAt ? '' : html`<section class="ask-next">
<h2>${t('discussions.askNextTitle')}</h2>
${roundStrip(v, repliedNames)}
</section>`}
${moreFold(v, drafts, !v.closedAt)}
</div>`;
}
