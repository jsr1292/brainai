import { EXPORT_PROMPT, VENDORS, type Vendor } from '../import/vendors.js';
import { MAX_FILE_BYTES } from '../import/fileUpload.js';
import { MAX_IMPORT_ROWS, MAX_PASTE_LINES } from '../import/lines.js';
import { PAGE_AREA_LABELS, PAGE_AREAS } from '../pages/types.js';
import { html, type SafeHtml } from './html.js';
import { plural } from './dashboardViews.js';

export interface ReviewRow { text: string; kind: 'profile' | 'decision'; project: string; /** Why the line reads like an instruction to assistants, or null. */ instruction: string | null; /** Existing facts it matches; null when duplicates could not be checked. */ duplicates: { id: string; content: string }[] | null }

export interface ImportPageInput {
  projects: string[];
  /** Said above the page: a result or a refusal. */
  said?: { kind: 'notice' | 'error'; text: string };
  /** A refusal of the uploaded file, shown beside the file control. */
  fileError?: string;
  pasteSource?: string;
  pasteText?: string;
}

const copyBtn = (text: string): SafeHtml => html`<button type="button" class="sm" data-copy="${text}">Copy</button>`;

function vendorBlock(v: Vendor): SafeHtml {
  return html`<details class="fold import-vendor"><summary class="row nolead">${v.name}<span class="chev"></span></summary>
<ol class="import-steps">${v.steps.map((s) => html`<li>${s}</li>`)}</ol>
<p class="import-prompt"><span class="path">${EXPORT_PROMPT}</span> ${copyBtn(EXPORT_PROMPT)}</p>
<p class="meta">Help page: <a href="${v.helpUrl}" target="_blank" rel="noopener">${v.helpTitle}</a>. Menu names change; if yours differ, use the prompt.</p></details>`;
}

export function importView(v: ImportPageInput): SafeHtml {
  return html`<div class="narrow import">
<h1>Import</h1>
<p class="lede">Bring what you already have into the brain. It all happens on your own machine: nothing is sent anywhere, and no AI reads it on the server.</p>
${v.said ? (v.said.kind === 'error' ? html`<p class="error" role="alert">${v.said.text}</p>` : html`<p class="notice" role="status">${v.said.text}</p>`) : ''}

<section class="panel import-section" id="memory"><h2>From ChatGPT, Claude or Gemini</h2>
<p class="meta">Each assistant keeps its own memory about you. Get it out as text, paste it here, and choose what to keep.</p>
${VENDORS.map(vendorBlock)}
<form method="post" action="/import/paste" class="stack">
  <label for="import-source">Where it came from</label>
  <select id="import-source" name="source">${VENDORS.map((x) => html`<option value="${x.id}"${x.id === v.pasteSource ? html` selected` : ''}>${x.name}</option>`)}</select>
  <label for="import-text">Paste it here</label>
  <textarea id="import-text" name="text" rows="10" required>${v.pasteText ?? ''}</textarea>
  <p class="meta">Each line becomes one candidate: bullets and numbers are stripped, empty and very short lines are dropped, and at most ${MAX_PASTE_LINES} lines are read. Lines that look like a password, key or token are refused. Nothing is saved until you tick it on the next screen.</p>
  <p><button type="submit" class="primary">Review the lines</button></p>
</form></section>

<section class="panel import-section" id="folders"><h2>From your project folders</h2>
<p class="meta">A connected coding assistant (Claude Code, Codex, Cursor) can read your project folders, which hold CLAUDE.md, README files and notes. BrainAI ships a skill for it, <strong>import-project-folders</strong>. Add it under <a href="/skills">Skills</a> (it waits in your Inbox as a proposal from BrainAI, once), then tell the assistant: "Run the import-project-folders skill on ~/Projects". What it finds lands in your <a href="/approvals">Inbox</a> for you to approve; nothing is saved without you.</p></section>

<section class="panel import-section" id="sessions"><h2>From past sessions</h2>
<p class="meta">The <strong>harvest-session</strong> skill goes over one finished working session and sends its decisions and lasting facts to your Inbox. See it under <a href="/skills">Skills</a>.</p></section>

<section class="panel import-section" id="file"><h2>Add a file as a page</h2>
<p class="meta">Upload one .md or .txt file (up to 1 MB). You see a preview first. The page says it was imported from the file, not written by an assistant. PDF is not supported yet; save it as text for now.</p>
<form method="post" action="/import/file" enctype="multipart/form-data" class="stack">
  <label for="import-file">File</label>
  ${v.fileError ? html`<p class="error" id="import-file-error" role="alert">${v.fileError}</p>` : ''}
  <input id="import-file" type="file" name="file" accept=".md,.markdown,.txt,text/markdown,text/plain" required${v.fileError ? html` aria-describedby="import-file-error"` : ''}>
  <p><button type="submit" class="primary">Preview the page</button></p>
</form></section>
</div>`;
}

const projectChoices = (projects: string[]): SafeHtml => html`<datalist id="import-projects">${projects.map((p) => html`<option value="${p}">`)}</datalist>`;

export function reviewView(v: { source: Vendor; rows: ReviewRow[]; projects: string[]; secrets: number; skipped: number; overCap: number; checked: boolean }): SafeHtml {
  const dropped = [
    v.secrets > 0 ? `${plural(v.secrets, 'line', 'lines')} left out because ${v.secrets === 1 ? 'it looks' : 'they look'} like a password, key or token` : null,
    v.skipped > 0 ? `${plural(v.skipped, 'line', 'lines')} left out as empty, too short, a heading or repeated` : null,
    v.overCap > 0 ? `${plural(v.overCap, 'line', 'lines')} past the first ${MAX_PASTE_LINES}` : null,
  ].filter((x): x is string => x !== null);
  const tooMany = v.rows.length > MAX_IMPORT_ROWS;
  return html`<div class="narrow import">
<h1>Review ${v.source.name} memory</h1>
${dropped.length > 0 ? html`<p class="notice" role="status">${dropped.join('. ')}.</p>` : ''}
${v.rows.length === 0 ? html`<p class="lede">No usable lines were found.</p><p><a href="/import#memory">Back to Import</a></p>` : html`
<p class="lede">${plural(v.rows.length, 'candidate', 'candidates')}. Tick what to keep. You are choosing these yourself, so a ticked profile line goes straight into your profile. One import saves up to ${MAX_IMPORT_ROWS} facts${tooMany ? '; tick at most that many and import the rest afterwards' : ''}.</p>
${v.checked ? '' : html`<p class="notice" role="status">Search is running on keywords only right now, so duplicates cannot be checked. Anything you tick is saved as it is.</p>`}
<form method="post" action="/import/save" class="stack import-review">
  <input type="hidden" name="source" value="${v.source.id}"><input type="hidden" name="n" value="${v.rows.length}">
  <ul class="rows import-rows">${v.rows.map((r, i) => { const dup = r.duplicates !== null && r.duplicates.length > 0; return html`<li class="import-row">
    <input type="hidden" name="text_${i}" value="${r.text}">${dup ? html`<input type="hidden" name="dup_${i}" value="1">` : ''}
    <label class="import-tick"><input type="checkbox" name="on_${i}" value="1"${dup || r.instruction ? '' : html` checked`}><span>${r.text}</span></label>
    ${dup ? html`<p class="attention">Already saved, or close to it: ${r.duplicates!.map((m) => m.content.replace(/[.!?\s]+$/, '')).join('; also: ')}. Left unticked.</p>` : ''}
    ${r.instruction ? html`<p class="attention">Reads like an instruction to assistants (${r.instruction}). Left unticked.</p>
    <label class="choice import-confirm"><input type="checkbox" name="confirm_${i}" value="1"> Save it to my profile anyway</label>` : ''}
    <span class="import-fields">
      <label>Kind <select name="kind_${i}"><option value="decision"${r.kind === 'decision' ? html` selected` : ''}>decision</option><option value="profile"${r.kind === 'profile' ? html` selected` : ''}>profile</option></select></label>
      <label>Project <input name="project_${i}" list="import-projects" value="${r.project}" placeholder="none, or a name" autocomplete="off"></label>
    </span></li>`; })}</ul>
  ${projectChoices(v.projects)}
  <p class="meta">Project applies to decisions; profile lines belong to you, not a project.</p>
  <p><button type="submit" class="primary">Save the ticked facts</button> <a href="/import#memory">Cancel</a></p>
</form>`}
</div>`;
}

export function filePreviewView(v: { name: string; title: string; project: string; area: string; body: string; rendered: SafeHtml; projects: string[]; error?: string }): SafeHtml {
  return html`<div class="narrow import">
<h1>Add a file as a page</h1>
${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
<p class="meta">Preview of <span class="path">${v.name}</span>. Nothing is saved until you press Create the page.</p>
<form method="post" action="/import/file/create" class="stack">
  <input type="hidden" name="file_name" value="${v.name}">
  <label for="file-title">Title</label>
  <input id="file-title" name="title" value="${v.title}" maxlength="140" required>
  <label for="file-project">Project</label>
  <select id="file-project" name="project"><option value=""${v.project === '' ? html` selected` : ''}>No project</option>${v.projects.map((p) => html`<option value="${p}"${p === v.project ? html` selected` : ''}>${p}</option>`)}</select>
  <label for="file-area">Area, when there is no project</label>
  <select id="file-area" name="area">${PAGE_AREAS.map((a) => html`<option value="${a}"${a === v.area ? html` selected` : ''}>${PAGE_AREA_LABELS[a]}</option>`)}</select>
  <textarea name="body" hidden>${v.body}</textarea>
  <p><button type="submit" class="primary">Create the page</button> <a href="/import#file">Cancel</a></p>
</form>
<h2>Preview</h2>
<div class="art import-preview">${v.rendered}</div>
</div>`;
}

export { MAX_FILE_BYTES };
