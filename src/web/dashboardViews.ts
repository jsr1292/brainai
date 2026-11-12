import type { GrantInfo } from '../auth/provider.js';
import type { SessionInfo } from '../auth/sessions.js';
import type { Flag, WriterTally } from '../memory/digest.js';
import type { BackupRun, BackupStatus, SimpleRun } from '../backupStatus.js';
import { deletedDay, MAX_CONTENT, MAX_ROADMAP } from '../memory/service.js';
import type { Overlap } from '../memory/tidy.js';
import type { ActivityRow } from '../memory/store.js';
import { KINDS, type HistoryEntry, type Kind, type Memory, type Suggestion } from '../memory/types.js';
import { parseRoadmap } from '../memory/roadmap.js';
import { deviceLabel } from './deviceLabel.js';
import type { FactEvent, FactStory } from '../memory/factStory.js';
import type { MemoryService } from '../memory/service.js';
import { withFrom } from './back.js';
import type { ConnStatus } from './connStatus.js';
import { pagesSubnav } from './skillViews.js';
import { chainList, factEvents, kindWord, pickerFold, replacedCard, replacedNote, replacesBox } from './factViews.js';
import type { Supersession, SupersessionStore } from '../memory/supersessions.js';
import { shortDay } from '../timezone.js';

export type ReplacedItem = ReturnType<SupersessionStore['replacedList']>[number];
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { subnav } from './subnav.js';
import { timeAgo, viewNow } from './when.js';

export const PAGE_SIZE = 50;
const EXCERPT = 160;

/** `base`: the updatedAt of the memory the form was filled from, so a save from a stale page is refused. */
export interface MemoryFormValues { kind: string; content: string; project: string; tags: string; keys?: string; base?: string }
export interface ActivityItem { at: string; by: string; action: ActivityRow['action']; memoryId: string; content: string }

export const when = (iso: string): SafeHtml => timeAgo(iso, viewNow());
export const errorBlock = (error?: string): SafeHtml => (error ? html`<p class="error" role="alert">${error}</p>` : html``);
export const excerpt = (s: string) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + '…' : s);
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const valuesOf = (m: Memory): MemoryFormValues => ({ kind: m.kind, content: m.content, project: m.project ?? '', tags: m.tags.join(' '), keys: m.keys, base: m.updatedAt });

// ---- Who wrote it (colour) and what kind it is (shape) ----

const KNOWN_WRITERS: [RegExp, string][] = [
  [/^owner$/i, 'you'], [/claude code/i, 'code'], [/^claude/i, 'claude'], [/^(?!.*grok build).*grok/i, 'grok'], [/chatgpt|openai/i, 'gpt'],
];

/** Colour key for a writer: known AIs get their own colour, anything else one of three spares, stable per name. */
export function writerKey(name: string): string {
  for (const [re, key] of KNOWN_WRITERS) if (re.test(name)) return key;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `x${h % 3}`;
}
export const writerName = (name: string) => (name === 'owner' ? 'You' : name);
export const writer = (name: string): SafeHtml => html`<span class="writer w-${writerKey(name)}">${writerName(name)}</span>`;
export const kindMark = (kind: string): SafeHtml => html`<span class="kind k-${kind}">${kind}</span>`;
export const projectLink = (p: string | null): SafeHtml =>
  (p ? html`<a class="project" href="/facts?project=${encodeURIComponent(p)}">${p}</a>` : html``);


// ---- Cards ----

/** The For-you row's words for what a suggestion does: "adding to your profile", "a change to your memory". */
export function suggestionPhrase(s: Pick<Suggestion, 'action' | 'kind'>): string {
  return `${{ add: 'adding to', update: 'a change to', delete: 'removing from' }[s.action]} your ${s.kind === 'profile' ? 'profile' : 'memory'}`;
}

/** `replaces`: the facts a held save would replace once approved (section 16), so the owner never approves blind. */
/** `deleted`: the fact the owner deleted that a held save is close to (§17a), quoted above what it saves. */
export function suggestionCard(s: Suggestion, current: string | undefined, o: { back: '/' | '/approvals'; replaces?: Memory[]; deleted?: Memory }): SafeHtml {
  const replaces = o.replaces ?? [];
  const deleting = s.action === 'delete';
  const quote = (cls: string, text: string | undefined) => html`<blockquote class="${cls}">${text ?? '(already gone)'}</blockquote>`;
  const body =
    deleting ? html`<p class="label">Remove:</p>${quote('removed', current)}`
    : s.action === 'update' ? html`<p class="label">Currently:</p>${quote('current', current)}${quote('proposed', s.content ?? '')}`
    : quote('proposed', s.content ?? '');
  // B9: the search words the save carries (a keys-only change has the same text on both sides).
  const keys = !deleting && s.keys ? html`<p class="sg-keys">Search words: ${s.keys}</p>` : '';
  const gone = o.deleted?.deletedAt ? o.deleted : undefined;
  const deletedQuote = gone && !deleting
    ? html`<p class="label">You deleted, ${deletedDay(gone.deletedAt!)}:</p><blockquote class="dim">${gone.content}</blockquote>
  <p class="label">Now saving:</p>`
    : '';
  // The text sits above the buttons, where the quote was; Edit first (only a toggle) stays between Approve and Reject and
  // the stylesheet shows the text while it is open. A hidden textarea still submits, so Approve without opening it sends
  // the suggestion unchanged.
  const editText = deleting ? html`` : html`<label class="edit-text">${s.action === 'update' ? 'New text' : 'Suggested text'} <textarea name="content" rows="4" maxlength="${s.kind === 'roadmap' ? MAX_ROADMAP : MAX_CONTENT}">${s.content ?? ''}</textarea></label>`;
  const editToggle = deleting ? html`` : html`<details class="edit-first"><summary class="button ghost">Edit first</summary></details>`;
  return html`<article class="card suggestion approval-card">
  <p class="approval-head">${writer(s.suggestedBy)} suggests ${suggestionPhrase(s)}</p>
  ${metaLine([when(s.suggestedAt), s.kind.charAt(0).toUpperCase() + s.kind.slice(1), s.project])}
  ${s.reason ? html`<p class="held">Held because it ${s.reason}. Saved as a ${s.kind}${s.project ? html` in ${s.project}` : ''} if you approve.</p>` : ''}
  ${deletedQuote}${body}${keys}
  ${replaces.length > 0 ? html`<p class="label">Approving also replaces:</p>
  ${replaces.map((m) => html`<blockquote class="dim"><a href="${withFrom(`/memories/${m.id}`, o.back)}">${excerpt(m.content)}</a></blockquote>`)}` : ''}
  <form method="post" action="/suggestions/${s.id}/approve">
    <input type="hidden" name="back" value="${o.back}">
    ${editText}
    <div class="actions">
      <button type="submit" class="primary">${deleting ? 'Delete it' : 'Approve'}</button>
      ${editToggle}
      <button type="submit" formaction="/suggestions/${s.id}/reject" formnovalidate class="ghost push-right">${deleting ? 'Keep it' : 'Reject'}</button>
    </div>
  </form>
  <p class="meta approval-foot">Both buttons bring you back here, and this goes.</p>
</article>`;
}

/** `replaced`: a replaced fact listed among current ones (All facts › Everything), shown in grey. */
export function memoryCard(m: Memory, replaced = false, from?: string): SafeHtml {
  return html`<li class="${replaced ? 'card rep' : 'card'}" data-kind="${m.kind}">
  <a class="card-link" href="/memories/${m.id}${from ? `?from=${encodeURIComponent(from)}` : ''}">${excerpt(m.content)}</a>
  ${metaLine([kindMark(m.kind), projectLink(m.project), writer(m.updatedBy), when(m.updatedAt)])}
</li>`;
}

export function activityRow(a: ActivityItem, from?: string): SafeHtml {
  return html`<li class="entry w-${writerKey(a.by)}">
  ${metaLine([html`${writer(a.by)} <span class="verb">${a.action}</span>`, when(a.at)])}
  <a class="card-link" href="${withFrom(`/memories/${a.memoryId}`, from)}">${excerpt(a.content)}</a>
</li>`;
}

// ---- Backups ----

/** "/mnt/nas/Backups/memory-backups" → "nas/Backups"; "gdrive:memory-backups" → "Google Drive". */
const placeName = (where: string): string => (where.startsWith('gdrive:')
  ? 'Google Drive'
  : where.replace(/^\/mnt\//, '').replace(/\/memory-backups\/?$/, '') || where);

export function backupsPanel(b: { status: BackupStatus; health: { ok: boolean; problems: string[] }; offsite: boolean; jobs?: boolean }, opts: { id?: string; title?: string; extra?: SafeHtml } = {}): SafeHtml {
  const { nightly, offsite } = b.status;
  const job = (label: string, r: SimpleRun | undefined) => html`<li><span class="label-inline">${label}</span> ${r ? html`${when(r.at)} <span class="place${r.ok ? '' : ' bad'}">${r.ok ? '✓' : '✗'}</span>` : html`<span class="quiet">not yet</span>`}</li>`;
  const run = (label: string, r: BackupRun | undefined, places: SafeHtml) => html`<li><span class="label-inline">${label}</span> ${r ? html`${when(r.at)} ${places}` : html`<span class="quiet">not yet</span>`}</li>`;
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  const nightlyPlaces = nightly?.ok
    ? html`${(nightly.copies ?? []).map((c) => html`<span class="place${c.result === 'copied' ? '' : ' bad'}">${placeName(c.where)} ${mark(c.result === 'copied')}</span>`)}`
    : html`<span class="place bad">failed ✗</span>`;
  const offsitePlaces = html`<span class="place${offsite?.ok ? '' : ' bad'}">${placeName(offsite?.where ?? '')} ${mark(offsite?.ok === true)}</span>`;
  return html`<section${opts.id ? html` id="${opts.id}"` : ''} class="panel backups${b.health.ok ? '' : ' attention'}">
  <div class="panel-head"><h2>${opts.title ?? 'Backups'}</h2></div>
  ${opts.extra ?? ''}
  <ul class="backup-runs">
    ${run('Nightly', nightly, nightlyPlaces)}
    ${b.offsite ? run('Off-site', offsite, offsitePlaces) : ''}
    ${b.jobs ? html`${job('Git copy', b.status.git)}${job('Markdown export', b.status.export)}` : ''}
  </ul>
  ${nightly?.counts ? html`<p class="meta">Last backup: ${plural(nightly.counts.facts, 'fact', 'facts')}, ${plural(nightly.counts.pages, 'page', 'pages')}</p>` : ''}
  ${b.health.ok ? '' : html`<ul class="problems">${b.health.problems.map((p) => html`<li>${p}</li>`)}</ul>`}
</section>`;
}

// ---- Tidy up ----

export interface TidyItems {
  overlaps: Overlap[];
  statuses: { project: string; statuses: Memory[] }[];
  /** `replaceable`: the two are the same kind in the same project, so "Newer replaces older" is offered. */
  duplicates: { a: Memory; b: Memory; similarity: number; replaceable?: boolean }[];
  stale: Memory[];
  /** Replaced facts whose replacement was deleted (section 16), with the deletion to restore. */
  gone?: { row: Supersession; old: Memory; newer: Memory; deletion: HistoryEntry | undefined }[];
}

export const tidyCount = (v: TidyItems): number => v.overlaps.length + v.statuses.length + v.duplicates.length + v.stale.length + (v.gone?.length ?? 0);

export function tidyView(v: TidyItems, error?: string, now: Date = new Date()): SafeHtml {
  const memories = (n: number) => plural(n, 'memory', 'memories');
  /** This screen's own address, so every fact it links goes back here. */
  const self = '/facts/tidy';
  const fact = (id: string): string => withFrom(`/memories/${id}`, self);
  // One black button a screen: the first "Newer replaces older" offered; failing that, "Replaced by the latest" when it
  // is the only replacement on the screen (one project with two statuses).
  const firstReplaceable = v.duplicates.find((d) => d.replaceable);
  const loneLatest = firstReplaceable === undefined && v.statuses.length === 1 && v.statuses[0]!.statuses.length === 2;
  const move = (from: string, to: string, secondary: boolean) => html`<form method="post" action="/tidy/projects/move"><input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}"><button type="submit"${secondary ? html` class="secondary"` : ''}>Move all to ${to}</button></form>`;
  const overlapCard = ({ smaller, larger }: Overlap) => html`<li class="card">
  <p>${projectLink(smaller.project)} (${memories(smaller.count)}) reads like ${projectLink(larger.project)} (${memories(larger.count)}).</p>
  <div class="actions">
    ${move(smaller.project, larger.project, false)}
    ${move(larger.project, smaller.project, true)}
    <form method="post" action="/tidy/projects/different"><input type="hidden" name="a" value="${smaller.project}"><input type="hidden" name="b" value="${larger.project}"><button type="submit" class="secondary">Different projects</button></form>
  </div>
  <p class="label">Moving renames the project on those memories. Each memory's history keeps the old name.</p>
</li>`;
  const statusCard = ({ project, statuses }: { project: string; statuses: Memory[] }) => html`<li class="card">
  <p class="meta">${projectLink(project)} has ${statuses.length} statuses, newest first.</p>
  <ol class="statuses">${statuses.map((m, i) => html`<li>
    <blockquote><a href="${fact(m.id)}">${excerpt(m.content)}</a></blockquote>
    <div class="status-foot">
      <p class="meta">${i === 0 ? 'Latest, updated' : 'Updated'} ${when(m.updatedAt)} by ${writer(m.updatedBy)}</p>
      <span class="actions">${i === 0 ? '' : html`<form method="post" action="/tidy/statuses/supersede"><input type="hidden" name="id" value="${m.id}"><input type="hidden" name="latest" value="${statuses[0]!.id}"><button type="submit"${loneLatest ? html` class="primary"` : ''}>Replaced by the latest</button></form>`}
      <form method="post" action="/memories/${m.id}/delete"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Delete</button></form></span>
    </div>
  </li>`)}</ol>
  <form method="post" action="/tidy/statuses/keep"><input type="hidden" name="project" value="${project}"><button type="submit" class="secondary">All still current</button></form>
</li>`;
  const dupCard = (item: TidyItems['duplicates'][number]) => {
    const { a, b, similarity, replaceable } = item;
    // "Newer replaces older" (section 16) is the one primary button when offered; newer means saved later.
    const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    const side = (keep: Memory, drop: Memory) => html`<div class="dup-side">
  <blockquote><a href="${fact(keep.id)}">${excerpt(keep.content)}</a></blockquote>
  <p class="meta">${replaceable ? `${keep.id === older.id ? 'older' : 'newer'} · ` : ''}updated ${when(keep.updatedAt)}</p>
  <form method="post" action="/duplicates/merge"><input type="hidden" name="keep" value="${keep.id}"><input type="hidden" name="drop" value="${drop.id}"><button type="submit"${replaceable ? html` class="secondary"` : ''}>Keep this one</button></form>
</div>`;
    const keepBoth = html`<form method="post" action="/duplicates/keep-both"><input type="hidden" name="a" value="${a.id}"><input type="hidden" name="b" value="${b.id}"><button type="submit" class="secondary">Keep both</button></form>`;
    return html`<li class="card">
  <p class="meta">Probably the same (${Math.round(similarity * 100)}% similar)${replaceable ? html` · both ${kindWord(a) === 'status' ? 'statuses' : 'decisions'}${a.project ? html` in ${a.project}` : ''}` : ''}</p>
  <div class="pair">${side(a, b)}${side(b, a)}</div>
  ${replaceable ? html`<div class="tacts"><form method="post" action="/tidy/duplicates/supersede"><input type="hidden" name="older" value="${older.id}"><input type="hidden" name="newer" value="${newer.id}"><button type="submit"${item === firstReplaceable ? html` class="primary"` : ''}>Newer replaces older</button></form>${keepBoth}</div>
  <p class="label">"Keep this one" deletes the other. "Newer replaces older" keeps the older one readable, out of search.</p>`
    : html`${keepBoth}
  <p class="label">Keeping one deletes the other.</p>`}
</li>`;
  };
  const goneCard = ({ row, old, newer, deletion }: NonNullable<TidyItems['gone']>[number]) => html`<li class="card">
  <blockquote><a href="${fact(old.id)}">${excerpt(old.content)}</a></blockquote>
  <p class="meta">${projectLink(old.project)} · its replacement was deleted ${newer.deletedAt ? shortDay(newer.deletedAt, now) : ''} by ${writer(deletion?.changedBy ?? newer.updatedBy)}</p>
  <div class="tacts">
    <form method="post" action="/supersessions/${row.id}/undo"><input type="hidden" name="back" value="tidy"><button type="submit">Bring it back</button></form>
    <form method="post" action="/memories/${old.id}/delete"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Delete it too</button></form>
    ${deletion ? html`<form method="post" action="/history/${deletion.id}/undo"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Restore the newer one</button></form>` : ''}
  </div>
</li>`;
  const staleCard = (m: Memory) => html`<li class="card">
  <a class="card-link" href="${fact(m.id)}">${excerpt(m.content)}</a>
  <p class="meta">${kindMark(m.kind)} ${projectLink(m.project)} last updated ${when(m.updatedAt)}</p>
  <div class="actions">
    <form method="post" action="/memories/${m.id}/confirm"><button type="submit">Still true</button></form>
    <form method="post" action="/memories/${m.id}/delete"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Delete</button></form>
  </div>
</li>`;
  const section = <T>(title: string, why: string, items: T[], card: (item: T) => SafeHtml) => (items.length === 0 ? html`` : html`<section class="panel tidy">
  <div class="panel-head"><h2>${title} <span class="n">${items.length}</span></h2></div>
  <p class="quiet">${why}</p>
  <ul class="cards">${items.map(card)}</ul>
</section>`);
  return html`<div class="narrow">
<h1>Tidy up</h1>
<p class="lede">What could be cleaner in memory, so assistants find the right thing. Anything you change here can be undone.</p>
${errorBlock(error)}
${tidyCount(v) === 0 ? html`<p class="quiet">Nothing to tidy.</p>` : ''}
${section('Same project under two names?', 'Assistants look projects up by name, so memories under the other name get missed.', v.overlaps, overlapCard)}
${section('Several statuses for one project', "A project's briefing shows every status, so an outdated one can mislead an assistant. Delete what is no longer true, or edit the newest so it covers what still matters.", v.statuses, statusCard)}
${section('Possible duplicates', 'Two memories that say almost the same thing.', v.duplicates, dupCard)}
${section('Not touched in a long while', 'Nobody has changed or recalled these in six months.', v.stale, staleCard)}
${section("Replaced by a fact that's gone", 'The newer fact was deleted, so nothing in search says this any more. Nothing changes until you choose.', v.gone ?? [], goneCard)}</div>`;
}

// ---- Weekly digest ----

export function flagRow(flag: Flag): SafeHtml {
  const quote = (m: Memory) => html`<blockquote><a href="/memories/${m.id}">${excerpt(m.content)}</a></blockquote>`;
  switch (flag.kind) {
    case 'waiting':
      return html`<li class="entry"><p>${plural(flag.count, 'suggestion is', 'suggestions are')} waiting for your approval. <a href="/approvals">Review</a></p></li>`;
    case 'connected':
      return html`<li class="entry w-${writerKey(flag.client)}"><p>${writer(flag.client)} connected${flag.times > 1 ? ` ${flag.times} times, last` : ''} ${when(flag.at)}. If that wasn't you, revoke it in <a href="/settings#connections">Settings</a>.</p></li>`;
    case 'no-saves':
      return html`<li class="entry w-${writerKey(flag.client)}"><p>${writer(flag.client)} looked things up ${flag.lookups} times but saved nothing. If you decided anything with it, ask it to save that.</p></li>`;
    case 'deleted-by-ai':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${writer(flag.by)} deleted a memory ${when(flag.at)}. You can restore it from its history.</p>${quote(flag.memory)}</li>`;
    case 'changed-others':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${writer(flag.by)} changed a memory ${flag.author === 'owner' ? 'you wrote' : html`${writer(flag.author)} wrote`} ${when(flag.at)}.</p>${quote(flag.memory)}</li>`;
    case 'replaced-others':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${writer(flag.by)} replaced a memory ${flag.author === 'owner' ? 'you wrote' : html`${writer(flag.author)} wrote`} ${when(flag.at)}.</p>${quote(flag.memory)}</li>`;
    case 'no-project':
      return html`<li class="entry w-${writerKey(flag.memory.createdBy)}"><p>${writer(flag.memory.createdBy)} saved a memory without a project, so project briefings won't include it.</p>${quote(flag.memory)}</li>`;
  }
}

/** Lookups started being counted at `lookupsSince`; a week from before then shows none. */
function lookupsNote(lookupsSince: string | null, weekStart: string): SafeHtml | string {
  return lookupsSince === null
    ? 'Lookups are searches, briefings and profile loads. None counted yet.'
    : lookupsSince > weekStart
      ? html`Lookups are searches, briefings and profile loads, counted since ${when(lookupsSince)}.`
      : 'Lookups are searches, briefings and profile loads.';
}

/** The per-assistant table of the weekly digest: Saved, Changed, Deleted and Lookups (the owner looks nothing up). */
export function writersTable(writers: WriterTally[], lookupsSince: string | null, weekStart: string): SafeHtml {
  return html`<table class="week-table">
    <thead><tr><th scope="col">Who</th><th scope="col" class="num">Saved</th><th scope="col" class="num">Changed</th><th scope="col" class="num">Deleted</th><th scope="col" class="num">Lookups</th></tr></thead>
    <tbody>${writers.map((w) => html`<tr><th scope="row">${writer(w.name)}</th><td class="num">${w.saved}</td><td class="num">${w.changed}</td><td class="num">${w.deleted}</td><td class="num">${w.name === 'owner' ? '–' : w.lookups}</td></tr>`)}</tbody>
  </table>
  <p class="meta">${lookupsNote(lookupsSince, weekStart)}</p>`;
}

// ---- Memories ----

export type FactsShow = 'current' | 'replaced' | 'everything';

/** One group of facts on the Facts page: its project (null for the profile and for the facts with none), its label, how many it holds and the few shown. */
export interface FactGroup { project: string | null; label: string; total: number; shown: Memory[] }

/** The filter for the facts with no project: the leftover group has no project of its own, so it gets a name of its own. */
export const NO_PROJECT = 'none';

/**
 * The facts grouped for the Facts page: the profile facts first ("About you"), then one group per project, the
 * project whose newest fact is newest first, and the facts with no project last. Each group shows its newest
 * `perGroup` facts and counts them all, so nothing is lost: the rest sit behind the group's own link.
 */
export function groupFacts(facts: Memory[], perGroup: number): FactGroup[] {
  const newest = (a: Memory, b: Memory) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  const profile: Memory[] = [];
  const loose: Memory[] = [];
  const byProject = new Map<string, Memory[]>();
  for (const m of facts) {
    if (m.kind === 'profile') { profile.push(m); continue; }
    if (m.project === null || m.project === '') { loose.push(m); continue; }
    const list = byProject.get(m.project) ?? [];
    list.push(m);
    byProject.set(m.project, list);
  }
  const groups: FactGroup[] = [];
  if (profile.length > 0) {
    profile.sort(newest);
    groups.push({ project: null, label: 'About you', total: profile.length, shown: profile.slice(0, perGroup) });
  }
  const projects = [...byProject.entries()].map(([project, list]) => [project, list.sort(newest)] as const)
    .sort(([, a], [, b]) => newest(a[0]!, b[0]!));
  for (const [project, list] of projects) groups.push({ project, label: project, total: list.length, shown: list.slice(0, perGroup) });
  if (loose.length > 0) {
    loose.sort(newest);
    groups.push({ project: null, label: 'No project', total: loose.length, shown: loose.slice(0, perGroup) });
  }
  return groups;
}

/** A roadmap fact read as three short lines: Now, Next and Done; nothing when it parses to nothing. */
function roadmapLines(content: string): SafeHtml | null {
  const r = parseRoadmap(content);
  const now = r.now === null ? null : r.progress ? `${r.now} (${r.progress.done}/${r.progress.total})` : r.now;
  const next = r.nextSteps[0] ?? r.next;
  const dated = r.done.filter((d) => d.date !== null);
  const done = (dated.length > 0 ? dated.at(-1)! : r.done.at(-1))?.text ?? null;
  const lines: [string, string][] = [['Now:', now], ['Next:', next], ['Done:', done]].filter((l): l is [string, string] => l[1] !== null);
  if (lines.length === 0) return null;
  return html`<dl class="rmap">${lines.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/** One fact in a group: its text (a roadmap reads as Now, Next and Done) and its meta line. */
function groupRow(m: Memory, from?: string): SafeHtml {
  const href = `/memories/${m.id}${from ? `?from=${encodeURIComponent(from)}` : ''}`;
  const roadmap = m.kind === 'roadmap' ? roadmapLines(m.content) : null;
  return html`<li class="frow"><a class="card-link" href="${href}">${roadmap ?? excerpt(m.content)}</a>
  <p class="fmeta"><span class="fkind">${m.kind}</span> · ${writer(m.updatedBy)} · ${when(m.updatedAt)}</p></li>`;
}

/** One group: its heading (the project links to the project), its facts, and a link to the ones it does not show. */
function groupView(g: FactGroup, from?: string): SafeHtml {
  const heading = g.project === null
    ? html`<h2>${g.label} <span class="n">${g.total}</span></h2>`
    : html`<h2><a href="/?project=${encodeURIComponent(g.project)}#panel">${g.label}</a> <span class="n">${g.total}</span></h2>`;
  const all = g.total > g.shown.length
    ? html`<a class="fall" href="${g.project === null ? (g.label === 'About you' ? '/facts?kind=profile' : `/facts?project=${NO_PROJECT}`) : `/facts?project=${encodeURIComponent(g.project)}`}">All ${g.total} ${g.label === 'No project' ? '' : `${g.label} `}facts</a>`
    : '';
  return html`<section class="fgroup">${heading}<ul class="flist">${g.shown.map((m) => groupRow(m, from))}</ul>${all}</section>`;
}


/**
 * All facts. `show` (section 16): Current (default), Replaced (`replaced` cards, newest replacement first, of
 * `replacedTotal`), or Everything (`items`, with `replacedIds` shown in grey, then `replaced` for a search).
 * With `groups`, the facts come grouped by project instead, each group a heading and a few of its newest facts.
 */
export function listView(v: {
  items: Memory[];
  groups?: FactGroup[];
  projects?: string[];
  filter: { kind?: Kind; project?: string; q?: string };
  page: number;
  hasNext: boolean;
  show?: FactsShow;
  replaced?: ReplacedItem[];
  replacedTotal?: number;
  replacedIds?: ReadonlySet<string>;
  now?: Date;
  counts?: { all: number; profile: number; replaced: number };
  tidy?: string | null;
  from?: string;
}): SafeHtml {
  const show = v.show ?? 'current';
  const now = v.now ?? new Date();
  const link = (page: number, which: FactsShow = show, withQuery = false) => {
    const p = new URLSearchParams();
    if (withQuery && v.filter.q !== undefined) p.set('q', v.filter.q);
    if (v.filter.kind) p.set('kind', v.filter.kind);
    if (v.filter.project) p.set('project', v.filter.project);
    if (which !== 'current') p.set('show', which);
    if (page > 1) p.set('page', String(page));
    const qs = p.toString();
    return '/facts' + (qs ? '?' + qs : '');
  };
  const seg = (which: FactsShow, label: string) => (which === show
    ? html`<a href="${link(1, which, true)}" class="on" aria-current="true">${label}</a>`
    : html`<a href="${link(1, which, true)}">${label}</a>`);
  const replaced = v.replaced ?? [];
  const currentList = v.items.length === 0 ? '' : html`<ul class="cards list">${v.items.map((m) => memoryCard(m, v.replacedIds?.has(m.id) ?? false, v.from))}</ul>`;
  const replacedList = replaced.length === 0 ? '' : html`<ul class="cards list">${replaced.map((r) => replacedCard(r, now, v.from))}</ul>`;
  const total = v.replacedTotal ?? replaced.length;
  const groups = v.groups;
  const groupList = groups === undefined ? '' : html`${groups.map((g) => groupView(g, v.from))}`;
  const results = groups !== undefined ? groupList : (show === 'replaced'
    ? html`${v.filter.q === undefined && total > 0 ? html`<p class="quiet rep-line">${total === 1 ? '1 replaced fact' : `${total} replaced facts`}, newest replacement first. You and your assistants don't find them in search. Deleted ones are not listed.</p>` : ''}${replacedList}`
    : html`${currentList}${replacedList}`);
  const empty = groups !== undefined ? groups.length === 0 : v.items.length === 0 && replaced.length === 0;
  const counts = v.counts ?? { all: v.items.length, profile: 0, replaced: total };
  const plain = !v.filter.q && !v.filter.kind && !v.filter.project && show === 'current' && v.page === 1;
  const profile = v.filter.kind === 'profile' && !v.filter.q && !v.filter.project && show === 'current' && v.page === 1;
  const onlyReplaced = !v.filter.kind && !v.filter.q && !v.filter.project && show === 'replaced' && v.page === 1;
  const quick = (href: string, label: string, on: boolean) => html`<a href="${href}"${on ? html` aria-current="page"` : ''}>${label}</a>`;
  // The filter row: one line, with the project names the Facts route knows.
  const projects = [...new Set([...(v.projects ?? []), ...(v.filter.project && v.filter.project !== NO_PROJECT ? [v.filter.project] : [])])];
  const filters = html`<form method="get" action="/facts" class="frow-filters">
  <input type="search" name="q" value="${v.filter.q ?? ''}" maxlength="200" placeholder="Search facts" aria-label="Search facts"${v.filter.q ? html` autofocus` : ''}>
  <select name="kind" aria-label="Kind"><option value="">Any kind</option>${KINDS.map((k) => html`<option value="${k}"${k === v.filter.kind ? ' selected' : ''}>${k}</option>`)}</select>
  <select name="project" aria-label="Project"><option value="">All projects</option><option value="${NO_PROJECT}"${v.filter.project === NO_PROJECT ? ' selected' : ''}>No project</option>${projects.map((p) => html`<option value="${p}"${p === v.filter.project ? ' selected' : ''}>${p}</option>`)}</select>
  ${show === 'current' ? '' : html`<input type="hidden" name="show" value="${show}">`}
  <span class="seg" role="group" aria-label="Show">${seg('current', 'Current')}${seg('replaced', 'Replaced')}${seg('everything', 'Everything')}</span>
  <button type="submit" class="filter-show">Show</button>
</form>`;
  return html`<div class="narrow">
${pagesSubnav('/facts')}
<div class="fhead">
<h1>Facts <span class="n">${counts.all} current</span></h1>
<a class="button new-fact" href="/memories/new">New fact</a>
</div>
<nav class="seg" aria-label="Facts quick views">${quick('/facts', `All ${counts.all}`, plain)}${counts.profile ? quick('/facts?kind=profile', `About you ${counts.profile}`, profile) : ''}${counts.replaced ? quick('/facts?show=replaced', `Replaced ${counts.replaced}`, onlyReplaced) : ''}</nav>
${profile ? html`<p class="lede">What every assistant loads about you at the start of a conversation. Assistants can only suggest changes here; you approve them on Projects.</p>` : ''}
${filters}
${v.tidy ? html`<p class="tidy-line">Tidy up: ${v.tidy}. <a href="/facts/tidy">Have a look</a></p>` : ''}
${empty ? html`<p class="quiet">${plain && counts.all === 0 ? 'No facts yet. Assistants save them as you work.' : 'No facts found.'}</p>` : results}
${v.filter.q === undefined && (v.page > 1 || v.hasNext) ? html`<p class="pager">
  ${v.page > 1 ? html`<a href="${link(v.page - 1)}">Newer</a>` : ''}
  ${v.hasNext ? html`<a href="${link(v.page + 1)}">Older</a>` : ''}</p>` : ''}
</div>`;
}

function memoryForm(action: string, values: MemoryFormValues, opts: { kindEditable: boolean; submit: string; from?: string }): SafeHtml {
  return html`<form method="post" action="${action}" class="editor">
  ${values.base ? html`<input type="hidden" name="base" value="${values.base}">` : ''}
  ${opts.from ? html`<input type="hidden" name="from" value="${opts.from}">` : ''}
  ${opts.kindEditable
    ? html`<label>Kind <select name="kind">${KINDS.map((k) => html`<option value="${k}"${k === values.kind ? ' selected' : ''}>${k}</option>`)}</select></label>`
    : ''}
  <label>Memory <textarea name="content" rows="6" maxlength="${opts.kindEditable || values.kind === 'roadmap' ? MAX_ROADMAP : MAX_CONTENT}" required>${values.content}</textarea></label>
  <div class="two">
    <label>Project <input type="text" name="project" value="${values.project}" maxlength="63"></label>
    <label>Tags (separated by spaces or commas) <input type="text" name="tags" value="${values.tags}"></label>
  </div>
  <label>Search words (help search find this fact; never in search results) <input type="text" name="keys" value="${values.keys ?? ''}" maxlength="200"></label>
  <div class="actions"><button type="submit" class="primary">${opts.submit}</button></div>
</form>`;
}

export function newView(values: MemoryFormValues, error?: string): SafeHtml {
  return html`<div class="narrow">
<h1>New fact</h1>
${errorBlock(error)}
${memoryForm('/memories', values, { kindEditable: true, submit: 'Save' })}
<p class="label">Profile memories take effect immediately.</p></div>`;
}

/**
 * A fact's own page. `extra.story` (section 16) adds the replaced note, Replaces, the timeline and replacement events in
 * History; `extra.picker` the owner's "Has a newer fact replaced this one?" fold on a current fact.
 */
export type FactPart = 'edit' | 'history' | 'picker';

export function detailView(m: Memory, history: HistoryEntry[], values: MemoryFormValues, error?: string,
  extra: { story?: FactStory; picker?: ReturnType<MemoryService['pickerChoices']>; pickAll?: boolean; now?: Date; open?: FactPart; selectedBy?: string; where?: { project: string | null; pages: { id: string; title: string }[]; discussion?: { id: string; title: string } }; from?: string } = {}): SafeHtml {
  const now = extra.now ?? new Date();
  const story = extra.story;
  const replaced = story?.replacedBy != null && !m.deletedAt;
  const events = story ? story.events : history.map((entry): FactEvent => ({ type: 'edit', at: entry.changedAt, entry }));
  // One level only: a link drawn on this page carries the page's own plain path; the origin (extra.from) is kept by
  // the forms and the picker's "Show all", which reopens this same fact.
  const self = `/memories/${m.id}`;
  const editor = html`${memoryForm(self, values, { kindEditable: false, submit: 'Save changes', from: extra.from })}
<form method="post" action="/memories/${m.id}/delete" class="danger">${extra.from ? html`<input type="hidden" name="from" value="${extra.from}">` : ''}<button type="submit" class="secondary">Delete</button>
<p class="meta">It leaves search for you and your assistants. Assistants that try to save it again will ask you first. You can bring it back from its History.</p></form>`;
  const where = extra.where;
  const whereShown = where && (where.project !== null || where.pages.length > 0 || where.discussion);
  return html`<div class="narrow">
${errorBlock(error)}
${replaced ? replacedNote(story!, now, self) : ''}
<p class="eyebrow fact-kind">${kindMark(m.kind)}${m.project ? html` · ${projectLink(m.project)}` : ''}${replaced ? html` · <span class="chip plain">replaced</span>` : ''}</p>
<h1 class="fact-text${replaced ? ' rep' : ''}">${m.content}</h1>
${metaLine([html`Saved by ${writer(m.createdBy)}`, when(m.createdAt), ...(history.length > 0 && !m.deletedAt ? [html`edited by ${writer(m.updatedBy)}`, when(m.updatedAt)] : []), ...(m.tags.length ? [html`Tags: ${m.tags.join(', ')}`] : [])])}
${m.keys ? html`<p class="fact-keys">Search words: ${m.keys}</p>` : ''}
${m.deletedAt ? html`<p class="quiet">Deleted ${when(m.deletedAt)}. Use Undo in History to bring it back.</p>` : html`<details class="pfold" id="edit"${extra.open === 'edit' ? ' open' : ''}><summary>Edit or delete<span class="chev"></span></summary>${replaced ? html`<p class="quiet">Editing a replaced fact keeps it replaced.</p>` : ''}${editor}</details>`}
<details class="pfold" id="history"${m.deletedAt || extra.open === 'history' ? ' open' : ''}><summary>History${events.length > 0 ? html` <span class="n">${events.length}</span>` : ''}<span class="chev"></span></summary>${factEvents(events, now, extra.from)}</details>
${story ? html`${replacesBox(story, now, self)}${chainList(story, kindWord(m), now, self)}` : ''}
${whereShown ? html`<section class="where"><h3>Where it shows</h3><ul class="rows">${where.project ? html`<li><a href="/?project=${encodeURIComponent(where.project)}#panel">${where.project}</a></li>` : ''}${where.pages.map((p) => html`<li><a href="${withFrom(`/pages/${p.id}`, self)}">${p.title}</a></li>`)}${where.discussion ? html`<li>Decided in: <a href="/discussions/${where.discussion.id}">${where.discussion.title}</a></li>` : ''}</ul></section>` : ''}
${extra.picker ? pickerFold(m, extra.picker, extra.pickAll ?? false, now, extra.open === 'picker', extra.selectedBy, extra.from) : ''}</div>`;
}

// ---- Clients and activity ----

/** Checkboxes for the projects a read-only connection may read, the given ones ticked. */
export function projectChoices(all: string[], picked: string[]): SafeHtml {
  return html`<fieldset class="project-choices"><legend>Projects it can read</legend>
  ${all.length === 0 ? html`<p class="quiet">No projects yet.</p>` : all.map((p) => html`<label class="choice"><input type="checkbox" name="projects" value="${p}"${picked.includes(p) ? ' checked' : ''}> ${p}</label>`)}
</fieldset>`;
}

/** A read-only grant's projects; one renamed or merged since reads nothing, and says so. */
const accessLabel = (g: GrantInfo, projects: string[]): string =>
  g.access === 'discussions' ? 'Discussions only'
  : g.access === 'projects' ? `Read only: ${g.projects.map((p) => (projects.includes(p) ? p : `${p} (no longer a project: tick its new name)`)).join(', ')}`
  : 'Full access';

/**
 * The connected AIs, one compact row each (name, access, last used, Revoke), with rename and access folded under
 * Change; revoked ones are folded away in their own list (Settings › Connections).
 */
/** Guided setup (§17b): the line under a connection: its setup text, then whether to refresh the connector. */
function setupLine(s: ConnStatus): SafeHtml {
  const href = s.app ? `/settings/setup/${s.app}` : '/settings#setup';
  const text = s.setup === 'none' ? '' : s.setup === 'current' ? html`<span class="ok">Setup text ${s.version} · up to date ✓</span>`
    : s.setup === 'older' ? html`<span class="attention">Setup text ${s.version} · older. <a href="${href}">Copy the new text</a></span>`
    : html`<span class="attention">Setup text: unknown. <a href="${href}">Paste the setup text</a> so the brain can tell</span>`;
  const br = text === '' ? '' : html`<br>`;
  const tools = s.added > 0 ? html`${br}<span class="attention">Refresh the connector: ${s.added === 1 ? '1 tool was' : `${s.added} tools were`} added since it last looked</span>`
    : s.changed ? html`${br}<span class="attention">Refresh the connector: its tools changed since it last looked</span>` : '';
  if (text === '' && tools === '') return html``;
  return html`<p class="conn-setup">${text}${tools}</p>`;
}

export function grantCards(v: { grants: GrantInfo[]; work?: boolean; projects?: string[]; status?: Map<string, ConnStatus> }): SafeHtml {
  const forms = (g: GrantInfo) => html`<form method="post" action="/clients/${g.id}/name" class="actions">
    <label>Name <input type="text" name="name" value="${g.clientName}" maxlength="100" required></label>
    <button type="submit" class="secondary">Rename</button>
  </form>
  ${v.work ? '' : html`<form method="post" action="/clients/${g.id}/access" class="actions">
    <label class="choice"><input type="radio" name="access" value="full"${g.access === 'full' ? ' checked' : ''}> Full access</label>
    <label class="choice"><input type="radio" name="access" value="discussions"${g.access === 'discussions' ? ' checked' : ''}> Discussions only</label>
    <label class="choice"><input type="radio" name="access" value="projects"${g.access === 'projects' ? ' checked' : ''}> Read only, chosen projects</label>
    <details class="project-picker"${g.access === 'projects' ? ' open' : ''}><summary>Projects for read only<span class="chev"></span></summary>${projectChoices(v.projects ?? [], g.projects)}</details>
    <button type="submit" class="secondary">Change access</button>
  </form>`}`;
  const row = (g: GrantInfo) => html`<li class="conn">
  <div class="conn-row"><span class="conn-name">${writer(g.clientName)}</span>${v.work ? '' : html`<span class="conn-access">${accessLabel(g, v.projects ?? [])}</span>`}<span class="meta">used ${g.lastUsedAt ? when(g.lastUsedAt) : 'never'}</span>
  <form method="post" action="/clients/${g.id}/revoke"><button type="submit" class="secondary" aria-label="Revoke ${g.clientName}">Revoke</button></form></div>
  ${v.status?.get(g.id) ? setupLine(v.status.get(g.id)!) : ''}
  <details class="conn-change"><summary>Change<span class="visually-hidden"> ${g.clientName}</span><span class="chev"></span></summary>${forms(g)}<p class="meta">Connected ${when(g.createdAt)}</p></details>
</li>`;
  const revokedRow = (g: GrantInfo) => html`<li class="conn-old">${writer(g.clientName)} <span class="meta">connected ${when(g.createdAt)}, revoked ${when(g.revokedAt!)}</span></li>`;
  const active = v.grants.filter((g) => !g.revokedAt);
  const revoked = v.grants.filter((g) => g.revokedAt);
  return html`${active.length === 0 ? html`<p class="quiet">No AI is connected.</p>` : html`<ul class="conns">${active.map(row)}</ul>`}
${revoked.length > 0 ? html`<details class="conn-revoked"><summary>Revoked connections <span class="n">${revoked.length}</span><span class="chev"></span></summary><ul class="plain">${revoked.map(revokedRow)}</ul></details>` : ''}`;
}

/** The devices the owner is logged in on, each with Log out (Settings › Your login). */
export function sessionCards(v: { sessions: SessionInfo[]; currentSessionId: string | undefined }): SafeHtml {
  const session = (s: SessionInfo) => html`<li class="card">
  <p><strong>${deviceLabel(s.userAgent)}</strong>${s.id === v.currentSessionId ? html` <span class="badge">this device</span>` : ''}</p>
  ${metaLine([html`Logged in ${when(s.createdAt)}`, html`last seen ${when(s.lastSeenAt)}`])}
  <form method="post" action="/sessions/${s.id}/revoke"><button type="submit" class="secondary">Log out</button></form>
</li>`;
  return v.sessions.length === 0 ? html`<p class="quiet">No devices.</p>` : html`<ul class="cards">${v.sessions.map(session)}</ul>`;
}
