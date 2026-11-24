/** Shared skills (round 2 §17c): Pages › Skills, a skill, its editor, history and files, and proposal cards. */
import { diffBodies, type DiffLine } from '../pages/diff.js';
import type { DeviceSkill, LinkState } from '../skills/sync.js';
import type { Skill, SkillFile, SkillProposal, SkillVersion } from '../skills/types.js';
import { t, tHtml } from '../i18n/index.js';
import { errorBlock, when, writer } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { subnav } from './subnav.js';

/** The Pages place's subnav: Pages | Skills | Facts. */
export const pagesSubnav = (current: '/pages' | '/skills' | '/facts' | null): SafeHtml =>
  subnav(t('shell.nav.pages'), [{ href: '/pages', text: t('shell.nav.pages') }, { href: '/skills', text: t('shell.nav.skills') }, { href: '/facts', text: t('shell.nav.facts') }], current);

const origin = (s: Pick<Skill, 'origin'>): string => (s.origin === 'here' ? t('skills.origin.here') : s.origin.startsWith('proposed:') ? t('skills.origin.proposed', { by: s.origin.slice(9) }) : s.origin.startsWith('device:') ? t('skills.origin.device') : s.origin);
const loaded = (s: Skill): SafeHtml => (s.lastLoadedAt ? tHtml('skills.loaded', { by: s.lastLoadedBy ?? '', when: when(s.lastLoadedAt) }) : html`${t('skills.neverLoaded')}`);
const chip = (on: boolean) => (on ? html`<span class="chip">${t('skills.on')}</span>` : html`<span class="chip plain">${t('skills.off')}</span>`);

/** One device's skills the brain doesn't have yet, with Share (or why one can't be). */
export interface DeviceFold { deviceId: string; deviceName: string; items: DeviceSkill[] }
const deviceFold = (d: DeviceFold): SafeHtml => html`<ul class="group nopage-group"><li><details class="fold nopage"${d.items.length > 0 ? html` open` : ''}><summary class="row nolead">${t('skills.from', { device: d.deviceName })}<span class="n">${d.items.length}</span><span class="chev"></span></summary>
<div class="fold-body"><p class="meta">${t('skills.deviceNote', { device: d.deviceName })}</p>
${d.items.length === 0 ? html`<p class="quiet">${t('skills.allShared')}</p>` : html`<ul class="rows sk-device">${d.items.map((x) => html`<li><span class="txt"><b>${x.name}</b><span class="sk-desc">${x.shareable ?? x.description}</span></span>${x.shareable === null
  ? html`<form method="post" action="/skills/share"><input type="hidden" name="device" value="${d.deviceId}"><input type="hidden" name="name" value="${x.name}"><button type="submit" class="secondary">${t('skills.share')}</button></form>` : ''}</li>`)}</ul>`}
</div></details></li></ul>`;

/** What the Skills page also shows: a skill just deleted or brought back, the deleted ones, and how many proposals wait. */
export interface SkillsExtras { deleted?: (Skill & { deletedAt: string })[]; justDeleted?: Skill; restored?: Skill; waiting?: number }

/** The fold of deleted skills, each with Undo. */
const deletedFold = (list: (Skill & { deletedAt: string })[]): SafeHtml => (list.length === 0 ? html`` : html`<ul class="group nopage-group"><li><details class="fold nopage"><summary class="row nolead">${t('skills.deletedFold')}<span class="n">${list.length}</span><span class="chev"></span></summary>
<div class="fold-body"><p class="meta">${t('skills.deletedFoldNote')}</p>
<ul class="rows sk-device">${list.map((x) => html`<li><span class="txt"><b>${x.name}</b><span class="sk-desc">${tHtml('skills.deletedWhen', { when: when(x.deletedAt) })}</span></span>${undoForm(x.id)}</li>`)}</ul>
</div></details></li></ul>`);
const undoForm = (id: string): SafeHtml => html`<form method="post" action="/skills/${id}/undelete"><button type="submit" class="secondary">${t('skills.undo')}</button></form>`;

export function skillsListView(skills: Skill[], devices: DeviceFold[] = [], error?: string, extra: SkillsExtras = {}): SafeHtml {
  const rows = skills.map((s) => html`<li><a class="row nolead" href="/skills/${s.id}"><span class="txt"><b>${s.name}</b> ${chip(s.enabled)}<span class="sk-desc">${s.description}</span>${metaLine([origin(s), loaded(s)])}</span><span class="chev"></span></a></li>`);
  const waiting = extra.waiting ?? 0;
  // The confirmation stays in the page (no toast): "Deleted." with its Undo, or "back, switched Off".
  const notice = extra.justDeleted
    ? html`<div class="notice notice-undo" role="status"><span>${t('skills.deletedNotice', { name: extra.justDeleted.name })}</span>${undoForm(extra.justDeleted.id)}</div>`
    : extra.restored ? html`<p class="notice" role="status">${t('skills.restoredNotice', { name: extra.restored.name })}</p>` : '';
  const empty = waiting > 0 ? html`<p class="quiet"><a href="/approvals">${t('skills.waiting', { count: waiting })}</a></p>` : html`<p class="quiet">${t('skills.none')}</p>`;
  return html`<div class="pages-wrap solo"><div class="pmain">${pagesSubnav('/skills')}<h1>${t('shell.nav.skills')}</h1>
<p class="lede">${t('skills.lede')}</p>
${errorBlock(error)}${notice}
<section><div class="panel-head"><h2>${t('skills.count', { count: skills.length })}</h2><a class="button primary" href="/skills/new">${t('skills.new')}</a></div>
${skills.length === 0 ? empty : html`<ul class="group">${rows}</ul>`}</section>
${devices.map(deviceFold)}
${deletedFold(extra.deleted ?? [])}
</div></div>`;
}

/** How one device's copy stands, for the skill page. */
export interface DeviceLine { deviceId: string; deviceName: string; state: LinkState; reportedAt: string | null }
function deviceLine(s: Skill, d: DeviceLine): SafeHtml {
  if (d.state === 'same') return html`<p class="conn-setup"><span class="ok">${t('skills.dev.same', { device: d.deviceName })}</span></p>`;
  if (d.state === 'pending') return html`<p class="conn-setup">${t('skills.dev.pending', { device: d.deviceName })}</p>`;
  if (d.state === 'own_copy') return html`<p class="conn-setup"><span class="attention">${t('skills.dev.own', { device: d.deviceName, name: s.name })}</span></p>`;
  return html`<div class="conn-setup sk-changed"><span class="attention">${t('skills.dev.changed', { device: d.deviceName })}${d.reportedAt ? html` ${when(d.reportedAt)}` : ''}.</span>
<form method="post" action="/skills/${s.id}/take-device"><input type="hidden" name="device" value="${d.deviceId}"><button type="submit" class="secondary">${t('skills.dev.take')}</button></form>
<form method="post" action="/skills/${s.id}/keep"><input type="hidden" name="device" value="${d.deviceId}"><button type="submit" class="ghost">${t('skills.dev.keep')}</button></form></div>`;
}

export function skillView(s: Skill, rendered: SafeHtml, versions: number, devices: DeviceLine[] = []): SafeHtml {
  return html`<div class="pages-wrap solo"><div class="pmain"><p class="crumb back"><a href="/skills">‹ ${t('shell.nav.skills')}</a></p><h1>${s.name}</h1>
<form method="post" action="/skills/${s.id}/enabled" class="skill-head"><input type="hidden" name="on" value="${s.enabled ? '0' : '1'}"><button type="submit" class="switch" role="switch" aria-checked="${s.enabled ? 'true' : 'false'}" aria-label="${t('skills.switchLabel')}"><i aria-hidden="true"></i> ${t('skills.switch', { state: s.enabled ? t('skills.on') : t('skills.off') })}</button><span class="meta">${s.enabled ? t('skills.enabledNote') : t('skills.disabledNote')}</span></form>
<p class="lede">${s.description}</p>
${metaLine([origin(s), loaded(s), t('skills.versions', { count: versions })])}
${devices.map((d) => deviceLine(s, d))}
<p class="actions"><a class="button" href="/skills/${s.id}/edit">${t('skills.edit')}</a> <a class="button ghost" href="/skills/${s.id}/history">${t('skills.history')}</a></p>
<article class="art">${rendered}</article>
${s.files.length > 0 ? html`<h2>${t('skills.files')}</h2><ul class="sk-files">${s.files.map((f) => html`<li><a href="/skills/${s.id}/files?path=${encodeURIComponent(f.path)}">${f.path}</a><span class="meta">${kb(f.text)}</span></li>`)}</ul>` : ''}
<form method="post" action="/skills/${s.id}/delete" class="danger"><button type="submit" class="secondary">${t('skills.delete')}</button><p class="meta">${t('skills.deleteNote')}</p></form>
</div></div>`;
}

const kb = (text: string) => `${Math.max(1, Math.round(Buffer.byteLength(text, 'utf8') / 1024))} KB`;

export interface SkillForm { id?: string; base?: number; name: string; description: string; body: string; files: SkillFile[]; error?: string }

export function skillEditView(v: SkillForm): SafeHtml {
  const action = v.id ? `/skills/${v.id}` : '/skills';
  const fileRow = (f: SkillFile) => html`<fieldset class="sk-file"><legend>${f.path}</legend><input type="hidden" name="file_path" value="${f.path}">
<label>${t('skills.text')} <textarea name="file_text" rows="6">${f.text}</textarea></label>
<label class="choice"><input type="checkbox" name="file_remove" value="${f.path}"> ${t('skills.removeFile')}</label></fieldset>`;
  return html`<div class="narrow">
<p class="crumb back"><a href="${v.id ? `/skills/${v.id}` : '/skills'}">‹ ${v.id ? v.name : t('shell.nav.skills')}</a></p>
<h1>${v.id ? t('skills.editName', { name: v.name }) : t('skills.new')}</h1>
${errorBlock(v.error)}
<form method="post" action="${action}" class="editor">
${v.base !== undefined ? html`<input type="hidden" name="base" value="${v.base}">` : ''}
<label>${t('skills.name')} <input name="name" value="${v.name}" maxlength="64" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autocapitalize="off" spellcheck="false"><span class="meta">${t('skills.nameHint')}</span></label>
<label>${t('skills.whenToUse')} <textarea name="description" rows="3" maxlength="1024" required>${v.description}</textarea></label>
<label>${t('skills.whatItSays')} <textarea name="body" rows="18">${v.body}</textarea></label>
<h2>${t('skills.files')}</h2>
${v.files.map(fileRow)}
<fieldset class="sk-file"><legend>${t('skills.addFile')}</legend><label>${t('skills.path')} <input name="file_path" value="" placeholder="references/notes.md" autocapitalize="off" spellcheck="false"></label>
<label>${t('skills.text')} <textarea name="file_text" rows="4"></textarea></label></fieldset>
<div class="actions"><button type="submit" class="primary">${v.id ? t('skills.saveChanges') : t('skills.create')}</button></div>
</form>
<p class="meta">${t('skills.newNote')}</p>
</div>`;
}

export function skillHistoryView(s: Skill, versions: SkillVersion[]): SafeHtml {
  return html`<div class="narrow"><p class="crumb back"><a href="/skills/${s.id}">‹ ${s.name}</a></p><h1>${t('skills.history')}</h1>
${metaLine([s.name, t('skills.historyNote')])}
<ol class="vers">${versions.map((v) => html`<li${v.version === s.version ? html` class="on" aria-current="true"` : ''}><b>${t('skills.version', { version: v.version })}</b><span>${writer(v.savedBy)} · ${when(v.savedAt)}</span>${v.version === s.version ? html`<span class="what">${t('skills.current')}</span>`
    : html`<form method="post" action="/skills/${s.id}/restore"><input type="hidden" name="version" value="${v.version}"><button type="submit" class="secondary sm">${t('skills.restore')}</button></form>`}</li>`)}</ol>
</div>`;
}

export function skillFileView(s: Skill, f: SkillFile): SafeHtml {
  return html`<div class="narrow"><p class="crumb back"><a href="/skills/${s.id}">‹ ${s.name}</a></p><h1>${f.path}</h1><pre class="sk-text">${f.text}</pre></div>`;
}

const line = (d: DiffLine) => d.kind === 'skipped'
  ? html`<div class="dl s"><i></i><span>${t('skills.unchanged', { count: d.count })}</span></div>`
  : html`<div class="dl ${d.kind === 'added' ? 'a' : d.kind === 'removed' ? 'd' : 'c'}"><i>${d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : ''}</i><span>${d.text}</span></div>`;

/** What a proposal does to the files: each changed file's diff, the new ones in full, the removed ones named. */
function fileChanges(before: SkillFile[], after: SkillFile[]): SafeHtml {
  const was = new Map(before.map((f) => [f.path, f.text]));
  const now = new Map(after.map((f) => [f.path, f.text]));
  const parts: SafeHtml[] = [];
  for (const f of after) {
    const old = was.get(f.path);
    if (old === undefined) parts.push(html`<p class="label"><b>${f.path}</b> ${t('skills.fileNew')}</p><pre class="sk-text">${f.text}</pre>`);
    else if (old !== f.text) parts.push(html`<p class="label"><b>${f.path}</b> ${t('skills.fileChanged')}</p><div class="dlist">${diffBodies(old, f.text).map(line)}</div>`);
  }
  for (const f of before) if (!now.has(f.path)) parts.push(html`<p class="label"><b>${f.path}</b> ${t('skills.fileRemoved')}</p>`);
  return parts.length === 0 ? html`<p class="meta">${t('skills.filesUnchanged')}</p>` : html`${parts}`;
}

/**
 * A proposal in Approvals: a new skill with its text and every file in full, or a change with a diff of the text and of
 * each file, so the owner never approves instructions they haven't seen. `changed`: the apply was refused, ask again.
 */
export function proposalCard(p: SkillProposal, current: Skill | undefined, o: { changed?: string; back?: '/approvals'; next?: string | null } = {}): SafeHtml {
  if (p.skillId === null || !current) {
    const files = p.files.length === 0 ? html`<p class="meta">${t('skills.noFiles')}</p>` : html`${p.files.map((f) => html`<p class="label"><b>${f.path}</b></p><pre class="sk-text">${f.text}</pre>`)}`;
    return html`<article class="card suggestion approval-card"><p class="approval-head">${tHtml('skills.prop.new', { who: writer(p.proposedBy), name: html`<b>${p.name}</b>` })}</p>
${metaLine([when(p.proposedAt), t('skills.prop.skill'), t('skills.prop.newTag')])}
${p.builtin ? html`<p class="meta">${t('skills.prop.builtin')}</p>` : ''}
<p class="label">${t('skills.prop.whenToUse')}</p><blockquote class="proposed">${p.description}</blockquote>
<p class="label">${t('skills.prop.whatItSays')}</p><pre class="sk-text">${p.body}</pre>
${files}
<div class="actions"><form method="post" action="/skill-proposals/${p.id}/add"><input type="hidden" name="on" value="1"><button type="submit" class="primary">${t('skills.prop.addOn')}</button></form>
<form method="post" action="/skill-proposals/${p.id}/add"><input type="hidden" name="on" value="0"><button type="submit" class="secondary">${t('skills.prop.addOff')}</button></form>
<form method="post" action="/skill-proposals/${p.id}/reject" class="push-right">${o.next ? html`<input type="hidden" name="next" value="${o.next}">` : ''}<button type="submit" class="ghost">${t('skills.prop.reject')}</button></form></div>
<p class="meta approval-foot">${t('skills.prop.foot')}</p></article>`;
  }
  const rename = p.name !== current.name ? html`<p class="held">${t('skills.prop.renames', { from: current.name, to: p.name })}</p>` : '';
  const desc = p.description !== current.description ? html`<p class="label">${t('skills.prop.whenNew')}</p><blockquote class="proposed">${p.description}</blockquote>` : '';
  const text = p.body !== current.body ? html`<p class="label">${t('skills.prop.change')}</p><div class="dlist">${diffBodies(current.body, p.body).map(line)}</div>` : html`<p class="meta">${t('skills.prop.unchanged')}</p>`;
  return html`<article class="card suggestion approval-card"><p class="approval-head">${tHtml('skills.prop.changeTo', { who: writer(p.proposedBy), name: html`<b>${current.name}</b>` })}</p>
${metaLine([when(p.proposedAt), t('skills.prop.skillState', { state: current.enabled ? t('skills.on') : t('skills.off') })])}
${o.changed ? html`<p class="held">${t('skills.prop.applyAnyway', { message: o.changed })}</p>` : ''}
${rename}${desc}${text}
${fileChanges(current.files, p.files)}
<div class="actions"><form method="post" action="/skill-proposals/${p.id}/apply">${o.changed ? html`<input type="hidden" name="confirm" value="1">` : ''}<button type="submit" class="primary">${t('skills.prop.apply')}</button></form>
<form method="post" action="/skill-proposals/${p.id}/reject" class="push-right">${o.next ? html`<input type="hidden" name="next" value="${o.next}">` : ''}<button type="submit" class="ghost">${t('skills.prop.reject')}</button></form></div>
<p class="meta approval-foot">${current.enabled ? t('skills.prop.stayOn') : t('skills.prop.stayOff')}</p></article>`;
}
