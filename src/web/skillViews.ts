/** Shared skills (round 2 §17c): Pages › Skills, a skill, its editor, history and files, and proposal cards. */
import { diffBodies, type DiffLine } from '../pages/diff.js';
import type { DeviceSkill, LinkState } from '../skills/sync.js';
import type { Skill, SkillFile, SkillProposal, SkillVersion } from '../skills/types.js';
import { errorBlock, when, writer } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { subnav } from './subnav.js';

/** The Pages place's subnav: Pages | Skills | Facts. */
export const pagesSubnav = (current: '/pages' | '/skills' | '/facts' | null): SafeHtml =>
  subnav('Pages', [{ href: '/pages', text: 'Pages' }, { href: '/skills', text: 'Skills' }, { href: '/facts', text: 'Facts' }], current);

const origin = (s: Pick<Skill, 'origin'>): string => (s.origin === 'here' ? 'written here' : s.origin.startsWith('proposed:') ? `proposed by ${s.origin.slice(9)}` : s.origin.startsWith('device:') ? 'shared from a device' : s.origin);
const loaded = (s: Skill): SafeHtml => (s.lastLoadedAt ? html`loaded by ${s.lastLoadedBy}, ${when(s.lastLoadedAt)}` : html`never loaded`);
const chip = (on: boolean) => (on ? html`<span class="chip">On</span>` : html`<span class="chip plain">Off</span>`);

/** One device's skills the brain doesn't have yet, with Share (or why one can't be). */
export interface DeviceFold { deviceId: string; deviceName: string; items: DeviceSkill[] }
const deviceFold = (d: DeviceFold): SafeHtml => html`<ul class="group nopage-group"><li><details class="fold nopage"${d.items.length > 0 ? html` open` : ''}><summary class="row nolead">From ${d.deviceName}<span class="n">${d.items.length}</span><span class="chev"></span></summary>
<div class="fold-body"><p class="meta">Claude Code skills on ${d.deviceName} that the brain doesn't share yet. Share copies one in, Off.</p>
${d.items.length === 0 ? html`<p class="quiet">Every skill there is shared.</p>` : html`<ul class="rows sk-device">${d.items.map((x) => html`<li><span class="txt"><b>${x.name}</b><span class="sk-desc">${x.shareable ?? x.description}</span></span>${x.shareable === null
  ? html`<form method="post" action="/skills/share"><input type="hidden" name="device" value="${d.deviceId}"><input type="hidden" name="name" value="${x.name}"><button type="submit" class="secondary">Share</button></form>` : ''}</li>`)}</ul>`}
</div></details></li></ul>`;

export function skillsListView(skills: Skill[], devices: DeviceFold[] = [], error?: string): SafeHtml {
  const rows = skills.map((s) => html`<li><a class="row nolead" href="/skills/${s.id}"><span class="txt"><b>${s.name}</b> ${chip(s.enabled)}<span class="sk-desc">${s.description}</span>${metaLine([origin(s), loaded(s)])}</span><span class="chev"></span></a></li>`);
  return html`<div class="pages-wrap"><div class="pmain">${pagesSubnav('/skills')}<h1>Skills</h1>
<p class="lede">How-tos every assistant can load. Only skills that are On reach them, and only you turn one on.</p>
${errorBlock(error)}
<section><div class="panel-head"><h2>${skills.length === 1 ? '1 skill' : `${skills.length} skills`}</h2><a class="button primary" href="/skills/new">New skill</a></div>
${skills.length === 0 ? html`<p class="quiet">No skills yet. Write one, or let an assistant propose one: it waits in Approvals.</p>` : html`<ul class="group">${rows}</ul>`}</section>
${devices.map(deviceFold)}
</div></div>`;
}

/** How one device's copy stands, for the skill page. */
export interface DeviceLine { deviceId: string; deviceName: string; state: LinkState; reportedAt: string | null }
function deviceLine(s: Skill, d: DeviceLine): SafeHtml {
  if (d.state === 'same') return html`<p class="conn-setup"><span class="ok">On ${d.deviceName}: the same</span></p>`;
  if (d.state === 'pending') return html`<p class="conn-setup">On ${d.deviceName}: not yet (it gets it within 15 minutes)</p>`;
  if (d.state === 'own_copy') return html`<p class="conn-setup"><span class="attention">${d.deviceName} has its own ${s.name}, so it is left alone: rename or remove it on the Mac to get this one.</span></p>`;
  return html`<div class="conn-setup sk-changed"><span class="attention">On ${d.deviceName}: changed${d.reportedAt ? html` ${when(d.reportedAt)}` : ''}.</span>
<form method="post" action="/skills/${s.id}/take-device"><input type="hidden" name="device" value="${d.deviceId}"><button type="submit" class="secondary">Take the Mac’s version</button></form>
<form method="post" action="/skills/${s.id}/keep"><input type="hidden" name="device" value="${d.deviceId}"><button type="submit" class="ghost">Keep this one</button></form></div>`;
}

export function skillView(s: Skill, rendered: SafeHtml, versions: number, devices: DeviceLine[] = []): SafeHtml {
  return html`<div class="pages-wrap"><div class="pmain"><p class="crumb back"><a href="/skills">‹ Skills</a></p><h1>${s.name}</h1>
<form method="post" action="/skills/${s.id}/enabled" class="skill-head"><input type="hidden" name="on" value="${s.enabled ? '0' : '1'}"><button type="submit" class="switch" role="switch" aria-checked="${s.enabled ? 'true' : 'false'}" aria-label="Skill on for assistants"><i aria-hidden="true"></i> Skill · ${s.enabled ? 'On' : 'Off'}</button><span class="meta">${s.enabled ? 'Assistants list it and load it when a task matches.' : 'Assistants don’t see it until you turn it on.'}</span></form>
<p class="lede">${s.description}</p>
${metaLine([origin(s), loaded(s), versions === 1 ? '1 version' : `${versions} versions`])}
${devices.map((d) => deviceLine(s, d))}
<p class="actions"><a class="button" href="/skills/${s.id}/edit">Edit</a> <a class="button ghost" href="/skills/${s.id}/history">History</a></p>
<article class="art">${rendered}</article>
${s.files.length > 0 ? html`<h2>Files</h2><ul class="sk-files">${s.files.map((f) => html`<li><a href="/skills/${s.id}/files?path=${encodeURIComponent(f.path)}">${f.path}</a><span class="meta">${kb(f.text)}</span></li>`)}</ul>` : ''}
<form method="post" action="/skills/${s.id}/delete" class="danger"><button type="submit" class="secondary">Delete skill</button><p class="meta">Assistants stop seeing it at once. Its history stays in the backups.</p></form>
</div></div>`;
}

const kb = (text: string) => `${Math.max(1, Math.round(Buffer.byteLength(text, 'utf8') / 1024))} KB`;

export interface SkillForm { id?: string; base?: number; name: string; description: string; body: string; files: SkillFile[]; error?: string }

export function skillEditView(v: SkillForm): SafeHtml {
  const action = v.id ? `/skills/${v.id}` : '/skills';
  const fileRow = (f: SkillFile) => html`<fieldset class="sk-file"><legend>${f.path}</legend><input type="hidden" name="file_path" value="${f.path}">
<label>Text <textarea name="file_text" rows="6">${f.text}</textarea></label>
<label class="choice"><input type="checkbox" name="file_remove" value="${f.path}"> Remove this file</label></fieldset>`;
  return html`<div class="narrow">
<p class="crumb back"><a href="${v.id ? `/skills/${v.id}` : '/skills'}">‹ ${v.id ? v.name : 'Skills'}</a></p>
<h1>${v.id ? `Edit ${v.name}` : 'New skill'}</h1>
${errorBlock(v.error)}
<form method="post" action="${action}" class="editor">
${v.base !== undefined ? html`<input type="hidden" name="base" value="${v.base}">` : ''}
<label>Name <input name="name" value="${v.name}" maxlength="64" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autocapitalize="off" spellcheck="false"><span class="meta">Lowercase letters, digits and hyphens, like release-notes. Claude Code uses it as the folder name.</span></label>
<label>When to use it <textarea name="description" rows="3" maxlength="1024" required>${v.description}</textarea></label>
<label>What it says <textarea name="body" rows="18">${v.body}</textarea></label>
<h2>Files</h2>
${v.files.map(fileRow)}
<fieldset class="sk-file"><legend>Add a file</legend><label>Path <input name="file_path" value="" placeholder="references/notes.md" autocapitalize="off" spellcheck="false"></label>
<label>Text <textarea name="file_text" rows="4"></textarea></label></fieldset>
<div class="actions"><button type="submit" class="primary">${v.id ? 'Save changes' : 'Create skill'}</button></div>
</form>
<p class="meta">A new skill starts Off: turn it on from its page when it is ready.</p>
</div>`;
}

export function skillHistoryView(s: Skill, versions: SkillVersion[]): SafeHtml {
  return html`<div class="narrow"><p class="crumb back"><a href="/skills/${s.id}">‹ ${s.name}</a></p><h1>History</h1>
${metaLine([s.name, 'every saved version, newest first'])}
<ol class="vers">${versions.map((v) => html`<li${v.version === s.version ? html` class="on" aria-current="true"` : ''}><b>Version ${v.version}</b><span>${writer(v.savedBy)} · ${when(v.savedAt)}</span>${v.version === s.version ? html`<span class="what">current</span>`
    : html`<form method="post" action="/skills/${s.id}/restore"><input type="hidden" name="version" value="${v.version}"><button type="submit" class="secondary sm">Restore</button></form>`}</li>`)}</ol>
</div>`;
}

export function skillFileView(s: Skill, f: SkillFile): SafeHtml {
  return html`<div class="narrow"><p class="crumb back"><a href="/skills/${s.id}">‹ ${s.name}</a></p><h1>${f.path}</h1><pre class="sk-text">${f.text}</pre></div>`;
}

const line = (d: DiffLine) => d.kind === 'skipped'
  ? html`<div class="dl s"><i></i><span>… ${d.count} unchanged lines</span></div>`
  : html`<div class="dl ${d.kind === 'added' ? 'a' : d.kind === 'removed' ? 'd' : 'c'}"><i>${d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : ''}</i><span>${d.text}</span></div>`;

/** What a proposal does to the files: each changed file's diff, the new ones in full, the removed ones named. */
function fileChanges(before: SkillFile[], after: SkillFile[]): SafeHtml {
  const was = new Map(before.map((f) => [f.path, f.text]));
  const now = new Map(after.map((f) => [f.path, f.text]));
  const parts: SafeHtml[] = [];
  for (const f of after) {
    const old = was.get(f.path);
    if (old === undefined) parts.push(html`<p class="label"><b>${f.path}</b> (new)</p><pre class="sk-text">${f.text}</pre>`);
    else if (old !== f.text) parts.push(html`<p class="label"><b>${f.path}</b> (changed)</p><div class="dlist">${diffBodies(old, f.text).map(line)}</div>`);
  }
  for (const f of before) if (!now.has(f.path)) parts.push(html`<p class="label"><b>${f.path}</b> (removed)</p>`);
  return parts.length === 0 ? html`<p class="meta">Files unchanged.</p>` : html`${parts}`;
}

/**
 * A proposal in Approvals: a new skill with its text and every file in full, or a change with a diff of the text and of
 * each file, so the owner never approves instructions they haven't seen. `changed`: the apply was refused, ask again.
 */
export function proposalCard(p: SkillProposal, current: Skill | undefined, o: { changed?: string } = {}): SafeHtml {
  if (p.skillId === null || !current) {
    const files = p.files.length === 0 ? html`<p class="meta">No files.</p>` : html`${p.files.map((f) => html`<p class="label"><b>${f.path}</b></p><pre class="sk-text">${f.text}</pre>`)}`;
    return html`<article class="card suggestion approval-card"><p class="approval-head">${writer(p.proposedBy)} proposes a skill: <b>${p.name}</b></p>
${metaLine([when(p.proposedAt), 'Skill', 'new'])}
<p class="label">When to use it:</p><blockquote class="proposed">${p.description}</blockquote>
<p class="label">What it says:</p><pre class="sk-text">${p.body}</pre>
${files}
<div class="actions"><form method="post" action="/skill-proposals/${p.id}/add"><input type="hidden" name="on" value="1"><button type="submit" class="primary">Add it and turn on</button></form>
<form method="post" action="/skill-proposals/${p.id}/add"><input type="hidden" name="on" value="0"><button type="submit" class="secondary">Add it, Off</button></form>
<form method="post" action="/skill-proposals/${p.id}/reject" class="push-right"><button type="submit" class="ghost">Reject</button></form></div>
<p class="meta approval-foot">Only you turn a skill on. Assistants see it once it is On.</p></article>`;
  }
  const rename = p.name !== current.name ? html`<p class="held">Renames ${current.name} → ${p.name}.</p>` : '';
  const desc = p.description !== current.description ? html`<p class="label">When to use it, new:</p><blockquote class="proposed">${p.description}</blockquote>` : '';
  const text = p.body !== current.body ? html`<p class="label">The change:</p><div class="dlist">${diffBodies(current.body, p.body).map(line)}</div>` : html`<p class="meta">Text unchanged.</p>`;
  return html`<article class="card suggestion approval-card"><p class="approval-head">${writer(p.proposedBy)} proposes a change to <b>${current.name}</b></p>
${metaLine([when(p.proposedAt), `Skill · ${current.enabled ? 'On' : 'Off'}`])}
${o.changed ? html`<p class="held">${o.changed} Apply it anyway?</p>` : ''}
${rename}${desc}${text}
${fileChanges(current.files, p.files)}
<div class="actions"><form method="post" action="/skill-proposals/${p.id}/apply">${o.changed ? html`<input type="hidden" name="confirm" value="1">` : ''}<button type="submit" class="primary">Apply it</button></form>
<form method="post" action="/skill-proposals/${p.id}/reject" class="push-right"><button type="submit" class="ghost">Reject</button></form></div>
<p class="meta approval-foot">${current.enabled ? 'The skill stays On; assistants get the new text from their next load.' : 'The skill stays Off.'}</p></article>`;
}
