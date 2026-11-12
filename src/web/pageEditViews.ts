import type { DiffLine } from '../pages/diff.js';
import { PAGE_AREA_LABELS, PAGE_AREAS, type PageVersion } from '../pages/types.js';
import { errorBlock } from './dashboardViews.js';
import { asset, html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { timeAgo } from './when.js';
import { deletePageFold, layout, pagesNav, type NavEntry } from './pageViews.js';

const who = (by: string) => (by === 'owner' ? 'you' : by);
const day = (iso: string): SafeHtml => timeAgo(iso);
const wrap = (nav: NavEntry[], current: string | undefined, main: SafeHtml) => layout(pagesNav(nav, current), html`<div class="wide-narrow">${main}</div>`);
/** The editor's own column: no pages tree, just the reading column's width (UI round, task 2). */
const editWrap = (main: SafeHtml) => layout(html``, main, undefined, { edit: true });

/** What the editor shows and posts back: a new page, the whole page, or one section. */
export interface EditForm {
  mode: 'new' | 'page' | 'section';
  pageId?: string;
  pageTitle?: string;
  base?: number;
  section?: { anchor: string; heading: string };
  title: string;
  project: string;
  area: string;
  body: string;
  projects: string[];
  error?: string;
  preview?: SafeHtml;
}

function fields(v: EditForm): SafeHtml {
  if (v.mode === 'section') return html``;
  const placeholder = v.project ? `${v.project} — short description` : 'Title';
  // The title input is the editor's heading: it reads like the page's own h1. Project and Area are Details, folded away
  // once the page has them (only a new page opens them). Area exists only for a page without a project: it is not
  // rendered for a project page, and Task 3's script hides it (data-area-for-no-project) when a project is chosen.
  const open = v.mode === 'new' ? html` open` : '';
  return html`<input name="title" class="ptitle-input" aria-label="Title" maxlength="140" required value="${v.title}" placeholder="${placeholder}">
<details class="pdetails"${open}><summary>Details<span class="chev"></span></summary><div class="pdetails-body">
<label>Project <select name="project"><option value=""${v.project === '' ? html` selected` : ''}>No project</option>${v.projects.map((p) => html`<option value="${p}"${p === v.project ? html` selected` : ''}>${p}</option>`)}</select></label>
${v.project === '' ? html`<label>Area <select name="area" data-area-for-no-project>${PAGE_AREAS.map((a) => html`<option value="${a}"${a === v.area ? html` selected` : ''}>${PAGE_AREA_LABELS[a]}</option>`)}</select></label>` : ''}
</div></details>`;
}

function editor(v: EditForm): SafeHtml {
  const action = v.mode === 'new' ? '/pages' : `/pages/${v.pageId}`;
  const cancel = v.mode === 'new' ? '/pages' : `/pages/${v.pageId}${v.section ? `#${v.section.anchor}` : ''}`;
  // Enter in the Title field (or a phone's Go key) sends the form's first submit button: this hidden Save, not the Write tab.
  // Adding pictures needs editor-pics.js (an upload without script would lose the unsaved text), so its button and
  // status line stay hidden until that script shows them.
  return html`<form method="post" action="${action}" class="peditor" data-pics="${asset('editor-pics.js')}" data-cm="${asset('editor-cm.js')}">
<button type="submit" name="intent" value="save" class="visually-hidden" tabindex="-1" aria-hidden="true">Save</button>
${v.base !== undefined ? html`<input type="hidden" name="base" value="${v.base}">` : ''}
${v.section ? html`<input type="hidden" name="section" value="${v.section.anchor}">` : ''}
${fields(v)}
<section class="panel ed">
<div class="ptools"><button type="submit" name="intent" value="write" class="ptool${v.preview ? '' : ' on'}" aria-pressed="${v.preview ? 'false' : 'true'}" formnovalidate>Write</button><button type="submit" name="intent" value="preview" class="ptool${v.preview ? ' on' : ''}" aria-pressed="${v.preview ? 'true' : 'false'}" formnovalidate>Preview</button><button type="button" class="ptool add-pic" hidden>＋ Add picture</button><input type="file" class="pic-input" accept="image/*" multiple hidden>
<span class="phint">[[ links a page or fact</span></div>
<p class="pic-strip" role="status" hidden></p>
${v.preview ? html`<div class="preview art"${/class="(pic|diagram)"/.test(v.preview.value) ? html` data-viewer="${asset('viewer.js')}"` : ''}${v.preview.value.includes('class="diagram"') ? html` data-diagrams="${asset('diagrams.js')}" data-renderer="${asset('diagram-frame.js')}"` : ''}>${v.preview}</div>` : ''}
<textarea name="body" rows="${v.mode === 'section' ? 14 : 24}" aria-label="${v.mode === 'section' && v.section ? `Text of the ${v.section.heading || 'Introduction'} section (Markdown)` : 'Page text (Markdown)'}" spellcheck="true" data-editor${v.preview ? html` class="under-preview"` : ''}>${v.body}</textarea>
</section>
<div class="psavebar"><button type="submit" name="intent" value="save" class="primary">${v.mode === 'section' ? 'Save section' : v.mode === 'new' ? 'Create page' : 'Save page'}<kbd>⌘S</kbd></button><a class="quiet-btn" href="${cancel}">Cancel</a><span class="psave-note">${v.mode === 'new' ? 'Saving makes version 1.' : `Saving makes version ${(v.base ?? 0) + 1}.`}</span></div>
</form>
${v.mode === 'page' && v.pageId ? deletePageFold(v.pageId) : ''}`;
}

/** The editor (mockup pages-edit.html): a new page, the whole page or one section. */
export function editView(nav: NavEntry[], v: EditForm): SafeHtml {
  void nav; // the editor has no pages tree; the column is its own (UI round, task 2)
  const heading = v.mode === 'section' ? html`<h1>Editing “${v.section!.heading || 'Introduction'}”</h1>` : html``;
  const sub = v.mode === 'section' ? metaLine([v.pageTitle, `version ${v.base}`, html`<a href="/pages/${v.pageId}/edit">Edit the whole page instead</a>`]) : '';
  return editWrap(html`${heading}${sub}${errorBlock(v.error)}${editor(v)}`);
}

export interface PageFields { title: string; project: string; area: string }

const sameFields = (a: PageFields, b: PageFields) => a.title === b.title && a.project === b.project && (a.project !== '' || a.area === b.area);
const fieldsLine = (x: PageFields): SafeHtml =>
  metaLine([`Title: ${x.title}`, `Project: ${x.project || 'No project'}`, x.project ? null : `Area: ${PAGE_AREA_LABELS[x.area as keyof typeof PAGE_AREA_LABELS] ?? x.area}`]);

/**
 * Someone else saved first: both texts side by side, then the editor again on the current version.
 * In page mode, `current` is the saved title and project: when the owner changed them, both columns show them.
 */
export function conflictView(nav: NavEntry[], v: EditForm & { savedBy: string; version: number; theirs: string; mine: string; current?: PageFields }): SafeHtml {
  void nav; // like the editor it replaces: its own column, no pages tree
  const fieldsChanged = v.mode === 'page' && v.current !== undefined && !sameFields(v.current, v);
  return editWrap(html`
<h1>Someone else saved first</h1>
<section class="panel conflict">
<p class="warn">${v.savedBy === 'owner' ? 'You saved this page in another tab or on another device' : `${v.savedBy} saved this page`} while you were editing (version ${v.version}). Nothing of yours is lost: your text is below. Copy what you need into the current version, then save.</p>
<div class="two"><div><h2>Current · version ${v.version} · ${who(v.savedBy)}</h2>${fieldsChanged ? fieldsLine(v.current!) : ''}<pre class="theirs">${v.theirs}</pre></div>
<div><h2>Yours · based on version ${v.base}</h2>${fieldsChanged ? fieldsLine(v) : ''}<pre class="mine">${v.mine}</pre></div></div>
<div class="actions"><a class="button secondary" href="/pages/${v.pageId}">Discard mine</a></div>
</section>
<h2 class="state">Edit the current version</h2>
${editor({ ...v, base: v.version, body: v.theirs })}`);
}

/** History (mockup pages-history.html): every version, and the chosen one compared with the one before. */
export function historyView(nav: NavEntry[], v: {
  pageId: string; pageTitle: string; versions: (PageVersion & { summary: string })[]; selected: PageVersion; previous: PageVersion | undefined; diff: DiffLine[]; error?: string;
}): SafeHtml {
  const s = v.selected;
  const line = (d: DiffLine) => d.kind === 'skipped'
    ? html`<div class="dl s"><i></i><span>… ${d.count} unchanged lines</span></div>`
    : html`<div class="dl ${d.kind === 'added' ? 'a' : d.kind === 'removed' ? 'd' : 'c'}"><i>${d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : ''}</i><span>${d.text}</span></div>`;
  // Each version opens at #diff: on a phone the diff and Restore sit below the whole version list.
  return wrap(nav, v.pageId, html`
<h1>History</h1>
${metaLine([v.pageTitle, 'every saved version, newest first'])}
${errorBlock(v.error)}
<div class="hist">
<ol class="vers">${v.versions.map((x) => html`<li${x.version === s.version ? html` class="on" aria-current="true"` : ''}><a href="/pages/${v.pageId}/history?v=${x.version}#diff"><b>Version ${x.version}</b><span>${who(x.savedBy)} · ${day(x.savedAt)}</span><span class="what">${x.summary}</span></a></li>`)}</ol>
<section class="panel diff" id="diff">
<div class="panel-head"><h2>${v.previous ? `Version ${s.version} compared with version ${v.previous.version}` : `Version ${s.version}, created`}</h2>
${v.previous ? html`<form method="post" action="/pages/${v.pageId}/restore"><input type="hidden" name="version" value="${v.previous.version}"><button type="submit" class="secondary">Restore version ${v.previous.version}</button></form>` : ''}</div>
${v.previous && v.previous.title !== s.title ? html`<p class="meta">Title: ${v.previous.title} → ${s.title}</p>` : ''}
<div class="dlist">${v.diff.map(line)}</div>
<p class="meta">Restoring saves the old text as a new version, so nothing is ever lost.</p>
</section>
</div>`);
}
