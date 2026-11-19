/** Settings › Remove BrainAI: what will happen and where the copy goes, then what happened. */
import { thisComputer } from '../desktop/computer.js';
import { factsAndPages } from '../saved/savedCopy.js';
import { html, type SafeHtml } from './html.js';
import { whereChoice } from './savedViews.js';

/** `mac`: the folder report exists only on the Mac, so only there is it named. */
export function removePage(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; said: string | null; mac: boolean }): SafeHtml {
  return html`<div class="narrow">
<h1>Remove BrainAI from ${thisComputer()}</h1>
<p class="lede">BrainAI first saves a copy of everything, then takes itself out of your tools. Nothing is removed unless the copy is saved.</p>
${v.said ? html`<p class="notice" role="alert">${v.said}</p>` : ''}
<h2>What happens, in this order</h2>
<ol>
<li>${v.synced === null ? 'A saved copy of every memory and page is made in your Documents folder.' : 'A saved copy of every memory and page is made in the folder you choose below: your Documents folder or your home folder.'}</li>
<li>Reach from phone and web is turned off, and the Cloudflare tunnel is deleted if you made one.</li>
<li>Claude Code, Codex, OpenCode, Cursor and Gemini CLI are disconnected from this BrainAI. A tool that uses another BrainAI is left alone.</li>
<li>${v.mac ? html`BrainAI's Claude Code hooks and the folder report on ${thisComputer()} are removed` : "BrainAI's Claude Code hooks are removed"}, unless they belong to another brain.</li>
<li>The original tool settings BrainAI backed up go into the saved copy.</li>
<li>A checklist shows what only you can remove, such as the connectors in Claude, ChatGPT and Grok.</li>
<li>When you choose Finish on the last page, BrainAI stops, deletes its data folder (memories, backups, logs and settings) and removes the app from ${thisComputer()}.</li>
</ol>
<h2>What is kept</h2>
<p>Only the saved copy, and anything the last page lists as left in place. Everything else BrainAI keeps on ${thisComputer()} goes.</p>
${whereChoice({ ...v, action: '/settings/remove', start: true })}
</div>`;
}

export type ToolOutcome = { name: string; what: 'disconnected' | 'left alone' | 'unreadable' | 'failed'; detail?: string };

export function removeDone(v: { folder: string; facts: number; pages: number; tools: ToolOutcome[]; checklist: string[]; kept: string[]; revealIn: 'Finder' | 'Explorer' }): SafeHtml {
  const line = (t: ToolOutcome) =>
    t.what === 'disconnected' ? html`<li>${t.name}: disconnected</li>`
      : t.what === 'unreadable' ? html`<li>${t.name}: ${t.detail}</li>`
      : t.what === 'left alone' ? html`<li>${t.name}: left alone because it uses another brain${t.detail ? html` (${t.detail})` : ''}</li>`
        : html`<li>${t.name}: failed${t.detail ? html`: ${t.detail}` : ''}</li>`;
  return html`<div class="narrow">
<h1>BrainAI is ready to be removed</h1>
<p><span class="ok">Saved ✓</span> ${factsAndPages(v.facts, v.pages)} are in <code class="path">${v.folder}</code></p>
<p>It holds every memory in plain text: keep it private.</p>
<div class="row-actions">
<form method="post" action="/settings/remove/show"><button type="submit" class="secondary">Show in ${v.revealIn}</button></form>
</div>
${v.tools.length > 0 ? html`<h2>Your tools</h2><ul>${v.tools.map(line)}</ul>` : ''}
${v.kept.length > 0 ? html`<h2>Left in place</h2><ul>${v.kept.map((k) => html`<li>${k}</li>`)}</ul>` : ''}
<h2>Still to do by hand</h2>
<ul>${v.checklist.map((c) => html`<li>${c}</li>`)}</ul>
<p>The same list is in the README of the saved folder.</p>
<div class="row-actions"><a class="primary button" href="/app/removed">Finish removing BrainAI</a></div>
</div>`;
}
