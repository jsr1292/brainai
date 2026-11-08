/** The Mac app's pages (D3): Settings › Tools on this Mac. */
import type { ToolState } from '../desktop/tools.js';
import { html, type SafeHtml } from './html.js';
import { ThisComputer, thisComputer } from '../desktop/computer.js';

const copyBox = (text: string, label: string) =>
  html`<div class="copy-box"><pre>${text}</pre><button type="button" class="secondary" data-copy="${text}" aria-label="Copy ${label}">Copy</button></div>`;

function toolRow(t: ToolState, back: 'welcome' | null = null): SafeHtml {
  const backField = back ? html`<input type="hidden" name="back" value="${back}">` : html``;
  const action = (what: 'connect' | 'disconnect', label: string, extra = html``, cls = 'secondary') =>
    html`<form method="post" action="/settings/tools/${t.id}/${what}" class="inline">${backField}${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const status = !t.installed ? html`<span class="meta">Not on ${thisComputer()}</span>`
    : t.state === 'connected' ? html`<span class="ok">Connected ✓</span>`
    : t.state === 'other-brainai' ? html`<span class="attention">Uses another BrainAI: ${t.detail}</span>`
    : html`<span class="meta">Not connected</span>`;
  const buttons = !t.installed ? html``
    : t.state === 'connected' ? action('disconnect', 'Disconnect')
    : t.state === 'other-brainai' ? action('connect', 'Replace', html`<input type="hidden" name="replace" value="1">`)
    : action('connect', 'Connect', html``, 'primary');
  return html`<li class="tool"><div><strong>${t.name}</strong><br>${status}</div><div>${buttons}</div></li>`;
}

export function toolsPage(v: { tools: ToolState[]; said: string | null; cursorRules: string }): SafeHtml {
  const cursor = v.tools.find((t) => t.id === 'cursor');
  return html`<div class="narrow">
<h1>Tools on ${thisComputer()}</h1>
<p class="lede">Connect adds BrainAI to the tool and its short rules to the tool's instructions. Each tool then signs in once: your browser asks you to Allow.</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
<ul class="group tools">${v.tools.map((t) => toolRow(t))}</ul>
<p class="meta">A tool that already uses another BrainAI is left as it is unless you press Replace. Files are backed up next to themselves (<code>.brainai-backup</code>) before any change.</p>
${cursor?.installed ? html`<h2>Rules for Cursor</h2><p>Cursor keeps its rules in its settings: paste this into Cursor › Settings › Rules.</p>${copyBox(v.cursorRules, 'the rules for Cursor')}` : ''}
</div>`;
}

/** The welcome for a new Mac install (D3), three steps as in the approved mockup. */
export function welcomePage(v: { step: 1 | 2 | 3; tools: ToolState[]; said: string | null; cursorRules: string }): SafeHtml {
  const steps = html`<p class="meta">Step ${v.step} of 3</p>`;
  if (v.step === 1) {
    return html`<div class="narrow welcome">${steps}
<h1>Your brain is running</h1>
<p class="lede">One memory for all your AI assistants. Tell one of them something, and the others know it too.</p>
<p>It stays on ${thisComputer()}: only apps on ${thisComputer()} can reach it.</p>
<form method="post" action="/welcome/name" class="stack">
  <label for="owner-name">Your name, so your assistants know who you are (optional)</label>
  <input id="owner-name" name="name" maxlength="80" autocomplete="name">
  <p><button type="submit" class="primary">Next</button></p>
</form>
</div>`;
  }
  if (v.step === 2) {
    const any = v.tools.some((t) => t.installed);
    return html`<div class="narrow welcome">${steps}
<h1>Connect your assistants</h1>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${any ? html`<p>Found on ${thisComputer()}:</p><ul class="group tools">${v.tools.filter((t) => t.installed).map((t) => toolRow(t, 'welcome'))}</ul>`
    : html`<p>No coding tools found on ${thisComputer()}. You can connect them later from Settings › Tools on ${thisComputer()}.</p>`}
<p class="meta">Connect adds BrainAI to the tool and its short rules to the tool's instructions. Each tool signs in once: your browser asks you to Allow. You can undo it in Settings.</p>
<p><a class="button primary" href="/welcome?step=3">Next</a></p>
</div>`;
  }
  return html`<div class="narrow welcome">${steps}
<h1>Try it</h1>
<p>Open one of the assistants you connected and say:</p>
<div class="copy-box"><pre>Save a note in BrainAI that I set it up today.</pre></div>
<p class="conn-setup" data-setup-status="/welcome/first">Waiting for your first memory…</p>
<p>Then ask another assistant: <em>what do you know about me?</em></p>
<form method="post" action="/welcome/done"><button type="submit" class="primary">Open my brain</button></form>
</div>`;
}

/** The welcome's waiting line: the first thing an assistant saved, or suggested. */
export function firstLine(v: { memory: { by: string; content: string } | null; suggestion: { by: string; content: string } | null }): SafeHtml {
  if (v.memory) return html`<span class="ok">Saved by ${v.memory.by}: ${v.memory.content}</span>`;
  if (v.suggestion) return html`<span class="ok">${v.suggestion.by} suggested: ${v.suggestion.content} It waits for your approval on Projects.</span>`;
  return html`<span class="attention">Waiting for your first memory…</span>`;
}
