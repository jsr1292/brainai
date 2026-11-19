import { EXPORT_PROMPT, VENDORS, type Vendor } from '../import/vendors.js';
import { MAX_FILE_BYTES } from '../import/fileUpload.js';
import { MAX_IMPORT_ROWS, MAX_PASTE_LINES } from '../import/lines.js';
import { PAGE_AREAS, type PageArea } from '../pages/types.js';
import { html, type SafeHtml } from './html.js';
import { catalogOf, t, tKey, type Key } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { reasonText } from './errorText.js';

/** The area names of the page-area list, in the request's language (a key per area id). */

const areaLabel = (a: PageArea): string => tKey(`data.area.${a}` as Key);

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

const copyBtn = (text: string): SafeHtml => html`<button type="button" class="sm" data-copy="${text}">${t('data.copy')}</button>`;

/** One step of a vendor's export steps, in the request's language (the English the vendor table carries is the fallback). */
function vendorStep(v: Vendor, i: number, fallback: string): string {
  const key = `data.vendor.${v.id}.${i + 1}`;
  return catalogOf('en')[key] === undefined ? fallback : tKey(key as Key);
}

function vendorBlock(v: Vendor): SafeHtml {
  return html`<details class="fold import-vendor"><summary class="row nolead">${v.name}<span class="chev"></span></summary>
<ol class="import-steps">${v.steps.map((s, i) => html`<li>${vendorStep(v, i, s)}</li>`)}</ol>
<p class="import-prompt"><span class="path">${EXPORT_PROMPT}</span> ${copyBtn(EXPORT_PROMPT)}</p>
<p class="meta">${tHtml('data.vendor.help', { link: html`<a href="${v.helpUrl}" target="_blank" rel="noopener">${v.helpTitle}</a>` })}</p></details>`;
}

export function importView(v: ImportPageInput): SafeHtml {
  return html`<div class="narrow import">
<h1>${t('data.import.title')}</h1>
<p class="lede">${t('data.import.lede')}</p>
${v.said ? (v.said.kind === 'error' ? html`<p class="error" role="alert">${v.said.text}</p>` : html`<p class="notice" role="status">${v.said.text}</p>`) : ''}

<section class="panel import-section" id="memory"><h2>${t('data.import.memoryHead')}</h2>
<p class="meta">${t('data.import.memoryNote')}</p>
${VENDORS.map(vendorBlock)}
<form method="post" action="/import/paste" class="stack">
  <label for="import-source">${t('data.import.source')}</label>
  <select id="import-source" name="source">${VENDORS.map((x) => html`<option value="${x.id}"${x.id === v.pasteSource ? html` selected` : ''}>${x.name}</option>`)}</select>
  <label for="import-text">${t('data.import.paste')}</label>
  <textarea id="import-text" name="text" rows="10" required>${v.pasteText ?? ''}</textarea>
  <p class="meta">${t('data.import.lineRules', { max: MAX_PASTE_LINES })}</p>
  <p><button type="submit" class="primary">${t('data.import.review')}</button></p>
</form></section>

<section class="panel import-section" id="folders"><h2>${t('data.import.foldersHead')}</h2>
<p class="meta">${tHtml('data.import.folders', { skill: html`<strong>import-project-folders</strong>`, skills: html`<a href="/skills">${t('shell.nav.skills')}</a>`, inbox: html`<a href="/approvals">${t('shell.nav.inbox')}</a>` })}</p></section>

<section class="panel import-section" id="sessions"><h2>${t('data.import.sessionsHead')}</h2>
<p class="meta">${tHtml('data.import.sessions', { skill: html`<strong>harvest-session</strong>`, skills: html`<a href="/skills">${t('shell.nav.skills')}</a>` })}</p></section>

<section class="panel import-section" id="file"><h2>${t('data.import.fileHead')}</h2>
<p class="meta">${t('data.import.fileNote')}</p>
<form method="post" action="/import/file" enctype="multipart/form-data" class="stack">
  <label for="import-file">${t('data.import.file')}</label>
  ${v.fileError ? html`<p class="error" id="import-file-error" role="alert">${v.fileError}</p>` : ''}
  <input id="import-file" type="file" name="file" accept=".md,.markdown,.txt,text/markdown,text/plain" required${v.fileError ? html` aria-describedby="import-file-error"` : ''}>
  <p><button type="submit" class="primary">${t('data.import.preview')}</button></p>
</form></section>
</div>`;
}

const projectChoices = (projects: string[]): SafeHtml => html`<datalist id="import-projects">${projects.map((p) => html`<option value="${p}">`)}</datalist>`;

export function reviewView(v: { source: Vendor; rows: ReviewRow[]; projects: string[]; secrets: number; skipped: number; overCap: number; checked: boolean }): SafeHtml {
  const dropped = [
    v.secrets > 0 ? t('data.review.secrets', { count: v.secrets }) : null,
    v.skipped > 0 ? t('data.review.skipped', { count: v.skipped }) : null,
    v.overCap > 0 ? t('data.review.overCap', { count: v.overCap, max: MAX_PASTE_LINES }) : null,
  ].filter((x): x is string => x !== null);
  const tooMany = v.rows.length > MAX_IMPORT_ROWS;
  return html`<div class="narrow import">
<h1>${t('data.review.title', { source: v.source.name })}</h1>
${dropped.length > 0 ? html`<p class="notice" role="status">${dropped.join('. ')}.</p>` : ''}
${v.rows.length === 0 ? html`<p class="lede">${t('data.review.none')}</p><p><a href="/import#memory">${t('data.review.backToImport')}</a></p>` : html`
<p class="lede">${t('data.review.count', { count: v.rows.length })} ${tooMany ? t('data.review.ledeMany', { max: MAX_IMPORT_ROWS }) : t('data.review.lede', { max: MAX_IMPORT_ROWS })}</p>
${v.checked ? '' : html`<p class="notice" role="status">${t('data.review.keywordsOnly')}</p>`}
<form method="post" action="/import/save" class="stack import-review">
  <input type="hidden" name="source" value="${v.source.id}"><input type="hidden" name="n" value="${v.rows.length}">
  <ul class="rows import-rows">${v.rows.map((r, i) => { const dup = r.duplicates !== null && r.duplicates.length > 0; return html`<li class="import-row">
    <input type="hidden" name="text_${i}" value="${r.text}">${dup ? html`<input type="hidden" name="dup_${i}" value="1">` : ''}
    <label class="import-tick"><input type="checkbox" name="on_${i}" value="1"${dup || r.instruction ? '' : html` checked`}><span>${r.text}</span></label>
    ${dup ? html`<p class="attention">${t('data.review.dup', { matches: r.duplicates!.map((m) => m.content.replace(/[.!?\s]+$/, '')).join(`; ${tKey('data.review.also')}: `) })}</p>` : ''}
    ${r.instruction ? html`<p class="attention">${t('data.review.instruction', { reason: reasonText(r.instruction) })}</p>
    <label class="choice import-confirm"><input type="checkbox" name="confirm_${i}" value="1"> ${t('data.review.confirm')}</label>` : ''}
    <span class="import-fields">
      <label>${t('data.review.kind')} <select name="kind_${i}"><option value="decision"${r.kind === 'decision' ? html` selected` : ''}>${t('data.review.decision')}</option><option value="profile"${r.kind === 'profile' ? html` selected` : ''}>${t('data.review.profile')}</option></select></label>
      <label>${t('data.review.project')} <input name="project_${i}" list="import-projects" value="${r.project}" placeholder="${t('data.review.projectPlaceholder')}" autocomplete="off"></label>
    </span></li>`; })}</ul>
  ${projectChoices(v.projects)}
  <p class="meta">${t('data.review.projectNote')}</p>
  <p><button type="submit" class="primary">${t('data.review.save')}</button> <a href="/import#memory">${t('data.cancel')}</a></p>
</form>`}
</div>`;
}

export function filePreviewView(v: { name: string; title: string; project: string; area: string; body: string; rendered: SafeHtml; projects: string[]; error?: string }): SafeHtml {
  return html`<div class="narrow import">
<h1>${t('data.import.fileHead')}</h1>
${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
<p class="meta">${tHtml('data.file.preview', { name: html`<span class="path">${v.name}</span>` })}</p>
<form method="post" action="/import/file/create" class="stack">
  <input type="hidden" name="file_name" value="${v.name}">
  <label for="file-title">${t('data.file.title')}</label>
  <input id="file-title" name="title" value="${v.title}" maxlength="140" required>
  <label for="file-project">${t('data.review.project')}</label>
  <select id="file-project" name="project"><option value=""${v.project === '' ? html` selected` : ''}>${t('data.file.noProject')}</option>${v.projects.map((p) => html`<option value="${p}"${p === v.project ? html` selected` : ''}>${p}</option>`)}</select>
  <label for="file-area">${t('data.file.area')}</label>
  <select id="file-area" name="area">${PAGE_AREAS.map((a) => html`<option value="${a}"${a === v.area ? html` selected` : ''}>${areaLabel(a)}</option>`)}</select>
  <textarea name="body" hidden>${v.body}</textarea>
  <p><button type="submit" class="primary">${t('data.file.create')}</button> <a href="/import#file">${t('data.cancel')}</a></p>
</form>
<h2>${t('data.file.previewHead')}</h2>
<div class="art import-preview">${v.rendered}</div>
</div>`;
}

export { MAX_FILE_BYTES };
