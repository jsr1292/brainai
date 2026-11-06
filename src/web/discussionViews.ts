import { askText, type OwnerDiscussionView, type OwnerSummary } from '../discussions/service.js';
import type { Post } from '../discussions/types.js';
import { withFrom } from './back.js';
import { errorBlock, plural, when, writerKey } from './dashboardViews.js';
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
    ? [html`decided ${day(s.closedAt)}`, 'saved to memory']
    : s.waitingFor.length > 0
      // Waiting on an assistant is not waiting on the owner: plain words, as on the project panel.
      ? [`waiting for ${s.waitingFor.join(', ')}`]
      : ['all replied'];
  return html`<li><a class="row nolead" href="/discussions/${s.id}"><span class="txt"><b>${s.title}</b>${metaLine([s.project ? html`<span class="project">${s.project}</span>` : null, `round ${s.round}`, ...status])}</span><span class="chev"></span></a></li>`;
}

export function discussionsView(items: OwnerSummary[]): SafeHtml {
  const lede = html`<p class="lede">Ask several assistants the same question. Start one from any assistant: "open a discussion about…".</p>`;
  if (items.length === 0) return html`<div class="narrow"><h1>Discussions</h1>
${lede}
<p class="quiet">No discussions yet. Ask an assistant to open one when you want several opinions.</p></div>`;
  const closed = items.filter((s) => s.closedAt);
  return html`<div class="narrow"><h1>Discussions</h1>
${lede}
<ul class="group">${items.filter((s) => !s.closedAt).map(row)}${closed.length > 0 ? html`<li><details class="fold"><summary class="row nolead">Closed <span class="n">${closed.length}</span><span class="chev"></span></summary><ul class="fold-list">${closed.map(row)}</ul></details></li>` : ''}</ul></div>`;
}

// ---- One discussion ----

function postCard(p: Post): SafeHtml {
  const who = p.kind === 'note' ? html`<span class="writer w-you">Your note</span>` : html`<span class="writer w-${writerKey(p.author)}">${p.author} · ${p.model}</span>`;
  return html`<article class="reply w-${p.kind === 'note' ? 'you' : writerKey(p.author)}">
  ${metaLine([who, when(p.createdAt)])}
  <p class="post">${p.text}</p>
</article>`;
}

function askControl(v: OwnerDiscussionView, name: string): SafeHtml {
  const text = askText(v.id, v.round, memoryServerName());
  const link = ASK_LINKS[writerKey(name)];
  return html`<div class="actions">${link ? html`<a class="button" href="${link + encodeURIComponent(text)}" target="_blank" rel="noopener">Ask in ${name}</a>` : ''}<button type="button" class="secondary" data-copy="${text}" aria-label="Copy the request for ${name}">Copy</button></div>`;
}

function pendingCard(v: OwnerDiscussionView, name: string): SafeHtml {
  return html`<article class="reply pending w-${writerKey(name)}">
  <p class="meta"><span class="writer w-${writerKey(name)}">${name}</span></p>
  <p class="quiet">No reply yet in round ${v.round}. Ask it, or copy the request to paste into ${name}.</p>
  ${askControl(v, name)}
</article>`;
}

function roundStrip(v: OwnerDiscussionView, repliedNames: Set<string>): SafeHtml {
  const base = `/discussions/${v.id}`;
  const pill = (name: string) => {
    const replied = repliedNames.has(lower(name));
    const remove = v.closedAt ? '' : html`<form method="post" action="${base}/ask"><input type="hidden" name="remove" value="${name}"><button type="submit" class="ghost" aria-label="Remove ${name} from the ask list">×</button></form>`;
    return html`<span class="pill ${replied ? 'ok' : 'wait'}"><span class="writer w-${writerKey(name)}">${name}</span> ${replied ? 'replied' : 'ask it next'}${remove}</span>`;
  };
  const add = v.closedAt ? '' : html`<form class="add-ask" method="post" action="${base}/ask">
    <label class="label" for="add">Add an assistant to ask</label>
    <div class="actions"><input id="add" name="add" maxlength="100" placeholder="Name, for example Grok"><button type="submit" class="secondary">Add</button></div>
  </form>`;
  return html`<section class="round-strip">
  <p class="meta"><strong>Round ${v.round}${v.round === 1 && !v.closedAt ? ' · blind' : ''}</strong>${v.ask.length === 0 ? 'Nobody is on the ask list.' : ''}</p>
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
  return html`<details class="earlier" data-desk-open><summary>Round ${round} · ${plural(count, 'reply', 'replies')}<span class="chev"></span></summary>${cards}</details>`;
}

/** The decision form, offered while a discussion is open. */
function decidePanel(v: OwnerDiscussionView, projects: string[], drafts: Drafts): SafeHtml {
  const base = `/discussions/${v.id}`;
  const project = v.project ? html`<p class="label">It will be saved to the memory of ${v.project}.</p>`
    : html`<label>Project for the decision
    <select name="project" required><option value="">Choose a project…</option>${projects.map((p) => html`<option value="${p}"${drafts.project === p ? ' selected' : ''}>${p}</option>`)}</select></label>`;
  return html`<section class="panel decide">
  <h2>Decide</h2>
  <p class="label">Your decision is saved to memory, so every assistant knows it. The discussion itself stays here.</p>
  <form method="post" action="${base}/decide">
    <label>Decision<textarea name="decision" maxlength="100000" required>${drafts.decision ?? ''}</textarea></label>
    ${project}
    <div class="actions"><button type="submit">Save decision and close</button></div>
  </form>
</section>`;
}

/** The note form and Start next round, offered while a discussion is open. */
function noteAndRoundForms(v: OwnerDiscussionView, drafts: Drafts): SafeHtml {
  const base = `/discussions/${v.id}`;
  return html`<section class="panel">
  <form method="post" action="${base}/note">
    <label>Your note for the next round (optional)
    <textarea name="text" maxlength="8000">${drafts.note ?? ''}</textarea></label>
    <div class="actions"><button type="submit" class="secondary">Add note</button></div>
  </form>
  <form method="post" action="${base}/round" class="next-round">
    <button type="submit">${v.round === 1 ? 'Start round 2 now' : 'Start next round'}</button>
  </form>
</section>`;
}

/** The rare rest, folded away: the note, Start next round, Sharing and Delete. A refused note opens it again. */
function moreFold(v: OwnerDiscussionView, drafts: Drafts, discussionOpen: boolean): SafeHtml {
  return html`<details class="pfold more-fold"${drafts.note !== undefined ? ' open' : ''}><summary>More<span class="chev"></span></summary>
${discussionOpen ? noteAndRoundForms(v, drafts) : ''}
${sharingPanel(v)}
${deletePanel(v)}
</details>`;
}

/** Who may see the discussion; offered open or closed. */
function sharingPanel(v: OwnerDiscussionView): SafeHtml {
  return html`<section class="panel sharing">
  <form method="post" action="/discussions/${v.id}/sharing">
    <p>${v.includeLimited ? 'Assistants with discussions-only access can see this discussion.' : 'Assistants with discussions-only access cannot see this discussion.'}</p>
    <input type="hidden" name="include" value="${v.includeLimited ? 'no' : 'yes'}">
    <div class="actions"><button type="submit" class="secondary">${v.includeLimited ? 'Hide it from them' : 'Show it to them'}</button></div>
  </form>
</section>`;
}

/** Delete, behind a confirm box; offered open or closed. */
function deletePanel(v: OwnerDiscussionView): SafeHtml {
  return html`<section class="panel danger">
  <h2>Delete</h2>
  <form method="post" action="/discussions/${v.id}/delete">
    <label class="choice"><input type="checkbox" name="confirm" value="yes" required> Yes, delete this discussion</label>
    <div class="actions"><button type="submit" class="secondary">Delete discussion</button></div>
  </form>
</section>`;
}

export function discussionView(v: OwnerDiscussionView, projects: string[], error?: string, drafts: Drafts = {}): SafeHtml {
  const base = `/discussions/${v.id}`;
  const repliedNames = new Set(v.replies.filter((p) => p.round === v.round).map((p) => lower(p.author)));
  const rounds = Array.from({ length: v.round }, (_, i) => v.round - i);
  const files = v.files.length === 0 ? '' : html`<ul class="files">${v.files.map((f) => html`<li><a class="file" href="${base}/files/${encodeURIComponent(f.name)}">${f.name}</a></li>`)}</ul>`;
  const decision = html`<section class="panel decided">
  <h2>Decision</h2>
  <p class="post">${v.decision}</p>
  <p class="meta">Decided ${v.closedAt ? day(v.closedAt) : ''}${v.decisionMemoryId ? html` · <a href="${withFrom(`/memories/${v.decisionMemoryId}`, `/discussions/${v.id}`)}">Open the memory</a>` : ''}</p>
</section>`;
  // An open discussion reads: the question, this round's replies, the earlier rounds folded, then Decide and the ask strip.
  // A closed one leads with its decision, then the question and the rounds.
  const question = html`<div class="question"><p class="post">${v.question}</p>${files}</div>`;
  return html`<div class="discussion wide narrow">
${metaLine([v.project ? html`<span class="project">${v.project}</span>` : null, `round ${v.round}`])}
<h1>${v.title}</h1>
${errorBlock(error)}
${v.closedAt ? decision : ''}
${question}
${v.closedAt ? rounds.map((r) => roundSection(v, r, repliedNames)) : html`${roundSection(v, v.round, repliedNames)}
${rounds.slice(1).map((r) => roundSection(v, r, repliedNames))}`}
${v.closedAt ? '' : decidePanel(v, projects, drafts)}
${v.closedAt ? '' : html`<section class="ask-next">
<h2>Ask the next one</h2>
${roundStrip(v, repliedNames)}
</section>`}
${moreFold(v, drafts, !v.closedAt)}
</div>`;
}
