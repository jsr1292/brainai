import type { Say } from '../i18n/errors.js';
import type { GrantInfo } from '../auth/provider.js';
import type { SessionInfo } from '../auth/sessions.js';
import type { Flag, WriterTally } from '../memory/digest.js';
import type { BackupRun, BackupStatus, SimpleRun } from '../backupStatus.js';
import { deletedDay, HOLD_REASON, MAX_CONTENT, MAX_ROADMAP } from '../memory/service.js';
import type { Overlap } from '../memory/tidy.js';
import type { ActivityRow } from '../memory/store.js';
import { KINDS, type FactMeta, type HistoryEntry, type Kind, type Memory, type Suggestion } from '../memory/types.js';
import { formatRoadmap, parseRoadmap, roadmapOneLine, ROADMAP_LABELS } from '../memory/roadmap.js';
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
import { backupProblems, reasonText, type FactField } from './errorText.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { heldMetaLines, metaFields, pastChip, sourceLine, validLine } from './factMetaViews.js';
import { subnav } from './subnav.js';
import { timeAgo, viewNow } from './when.js';
import { t, tKey } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';

export const PAGE_SIZE = 50;
const EXCERPT = 160;

/** `base`: the updatedAt of the memory the form was filled from, so a save from a stale page is refused. */
export interface MemoryFormValues { kind: string; content: string; project: string; tags: string; keys?: string; base?: string; validUntil?: string; source?: string; sourceBy?: string | null; sourceNote?: string; origValidUntil?: string; origSource?: string; origSourceNote?: string;
  /** The field a refused save was about: its message is shown under it (see `memoryForm`). */
  errorField?: FactField }
export interface ActivityItem { at: string; by: string; action: ActivityRow['action']; memoryId: string; content: string }

export const when = (iso: string): SafeHtml => timeAgo(iso, viewNow());
export const errorBlock = (error?: string): SafeHtml => (error ? html`<p class="error" role="alert">${error}</p>` : html``);
export const excerpt = (s: string) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + '…' : s);
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const valuesOf = (m: Memory): MemoryFormValues => ({ kind: m.kind, content: m.content, project: m.project ?? '', tags: m.tags.join(' '), keys: m.keys, base: m.updatedAt, validUntil: m.validUntil ?? '', source: m.source ?? '', sourceBy: m.sourceBy, sourceNote: m.sourceNote ?? '',
  origValidUntil: m.validUntil ?? '', origSource: m.source ?? '', origSourceNote: m.sourceNote ?? '' });

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
export const writerName = (name: string) => (name === 'owner' ? t('inbox.you') : name);
export const writer = (name: string): SafeHtml => html`<span class="writer w-${writerKey(name)}">${writerName(name)}</span>`;
/** A kind as the screen words it (`decision`, `summary`…): the stored code stays English. */
export const kindLabel = (kind: string): string => ((KINDS as readonly string[]).includes(kind) ? tKey(`inbox.kind.${kind}` as 'inbox.kind.profile') : kind);
export const kindMark = (kind: string): SafeHtml => html`<span class="kind k-${kind}">${kindLabel(kind)}</span>`;
export const projectLink = (p: string | null): SafeHtml =>
  (p ? html`<a class="project" href="/facts?project=${encodeURIComponent(p)}">${p}</a>` : html``);


// ---- Cards ----

/** The For-you row's words for what a suggestion does: "adding to your profile", "a change to your memory". */
export function suggestionPhrase(s: Pick<Suggestion, 'action' | 'kind'>): string {
  return tKey(`inbox.phrase.${s.action}.${s.kind === 'profile' ? 'profile' : 'memory'}`);
}

/** `replaces`: the facts a held save would replace once approved (section 16), so the owner never approves blind. */
/** `deleted`: the fact the owner deleted that a held save is close to (§17a), quoted above what it saves. */
export function suggestionCard(s: Suggestion, current: string | undefined, o: { back: '/' | '/approvals'; /** The Inbox item to open after this answer (its key). */ next?: string | null; replaces?: Memory[]; deleted?: Memory; /** A harvested near-duplicate: the existing fact it is close to. */ similar?: Memory; /** Shown inside its harvest's pane: the pane says where it comes from and what the buttons do. */ inBatch?: boolean; /** The fact's date and source now, for an update. */ currentMeta?: Pick<Memory, 'validUntil' | 'source' | 'sourceNote' | 'sourceBy'>; /** What approving stores (MemoryService.heldOutcome). */ heldOutcome?: FactMeta }): SafeHtml {
  const replaces = o.replaces ?? [];
  const deleting = s.action === 'delete';
  const quote = (cls: string, text: string | undefined) => html`<blockquote class="${cls}">${text ?? t('inbox.card.gone')}</blockquote>`;
  const body =
    deleting ? html`<p class="label">${t('inbox.card.remove')}</p>${quote('removed', current)}`
    : s.action === 'update' ? html`<p class="label">${t('inbox.card.currently')}</p>${quote('current', current)}${quote('proposed', s.content ?? '')}`
    : quote('proposed', s.content ?? '');
  // B9: the search words the save carries (a keys-only change has the same text on both sides).
  const keys = !deleting && s.keys ? html`<p class="sg-keys">${t('inbox.facts.searchWords', { keys: s.keys })}</p>` : '';
  // A1/A2: the date and the source the save carries (A12).
  const heldMeta = deleting ? '' : heldMetaLines(s, o.currentMeta, s.action === 'update' && s.content === current && !s.keys, o.heldOutcome);
  const gone = o.deleted?.deletedAt ? o.deleted : undefined;
  const deletedQuote = gone && !deleting
    ? html`<p class="label">${t('inbox.card.youDeleted', { day: deletedDay(gone.deletedAt!) })}</p><blockquote class="dim">${gone.content}</blockquote>
  <p class="label">${t('inbox.card.nowSaving')}</p>`
    : '';
  // The text sits above the buttons, where the quote was; Edit first (only a toggle) stays between Approve and Reject and
  // the stylesheet shows the text while it is open. A hidden textarea still submits, so Approve without opening it sends
  // the suggestion unchanged.
  const editText = deleting ? html`` : html`<label class="edit-text">${s.action === 'update' ? t('inbox.card.newText') : t('inbox.card.suggestedText')} <textarea name="content" rows="4" maxlength="${s.kind === 'roadmap' ? MAX_ROADMAP : MAX_CONTENT}">${s.content ?? ''}</textarea></label>`;
  const editToggle = deleting ? html`` : html`<details class="edit-first"><summary class="button ghost">${t('inbox.card.editFirst')}</summary></details>`;
  // A removal says so: "Saved as a decision" is the wording for an add.
  const ifApproved = deleting ? (s.project ? t('inbox.card.deletedFromIfApprove', { project: s.project }) : t('inbox.card.deletedIfApprove')) : (s.project ? t('inbox.card.savedAsIn', { kind: kindLabel(s.kind), project: s.project }) : t('inbox.card.savedAs', { kind: kindLabel(s.kind) }));
  return html`<article class="card suggestion approval-card">
  <p class="approval-head">${tHtml('inbox.card.suggests', { writer: writer(s.suggestedBy), phrase: suggestionPhrase(s) })}</p>
  ${metaLine([when(s.suggestedAt), ((l) => l.charAt(0).toUpperCase() + l.slice(1))(kindLabel(s.kind)), s.project])}
  ${s.harvest && !o.inBatch ? html`<p class="meta">${t('inbox.card.harvested', { label: s.harvest.label })}</p>` : ''}
  ${s.reason === HOLD_REASON ? html`<p class="held">${t('inbox.card.holdReason')}. ${ifApproved}</p>` : s.reason ? html`<p class="held">${t('inbox.card.heldBecause', { reason: reasonText(s.reason) })} ${ifApproved}</p>` : ''}
  ${o.similar && !o.similar.deletedAt ? html`<p class="meta">${tHtml('inbox.card.closeTo', { link: html`<a href="${withFrom(`/memories/${o.similar.id}`, o.back)}">${excerpt(o.similar.content)}</a>` })}</p>` : ''}
  ${deletedQuote}${body}${keys}${heldMeta}
  ${replaces.length > 0 ? html`<p class="label">${t('inbox.card.alsoReplaces')}</p>
  ${replaces.map((m) => html`<blockquote class="dim"><a href="${withFrom(`/memories/${m.id}`, o.back)}">${excerpt(m.content)}</a></blockquote>`)}` : ''}
  <form method="post" action="/suggestions/${s.id}/approve">
    <input type="hidden" name="back" value="${o.back}">${o.next ? html`<input type="hidden" name="next" value="${o.next}">` : ''}
    ${editText}
    <div class="actions">
      <button type="submit" class="primary">${deleting ? t('inbox.card.deleteIt') : t('inbox.card.approve')}${o.back === '/approvals' ? html` <kbd class="kbd-hint"><span class="k-mac">⌘↵</span><span class="k-pc">Ctrl ↵</span></kbd>` : ''}</button>
      ${editToggle}
      <button type="submit" formaction="/suggestions/${s.id}/reject" formnovalidate class="ghost push-right">${deleting ? t('inbox.card.keepIt') : t('inbox.card.reject')}</button>
    </div>
  </form>
  ${o.inBatch ? '' : html`<p class="meta approval-foot">${t('inbox.card.foot')}</p>`}
</article>`;
}

/** `replaced`: a replaced fact listed among current ones (All facts › Everything), shown in grey. */
export function memoryCard(m: Memory, replaced = false, from?: string): SafeHtml {
  return html`<li class="${replaced ? 'card rep' : 'card'}" data-kind="${m.kind}">
  <a class="card-link" href="/memories/${m.id}${from ? `?from=${encodeURIComponent(from)}` : ''}">${excerpt(m.content)}</a>
  ${metaLine([kindMark(m.kind), projectLink(m.project), writer(m.updatedBy), when(m.updatedAt), pastChip(m)])}
</li>`;
}

export function activityRow(a: ActivityItem, from?: string): SafeHtml {
  return html`<li class="entry w-${writerKey(a.by)}">
  ${metaLine([html`${writer(a.by)} <span class="verb">${tKey(`inbox.verb.${a.action}`)}</span>`, when(a.at)])}
  <a class="card-link" href="${withFrom(`/memories/${a.memoryId}`, from)}">${excerpt(a.content)}</a>
</li>`;
}

// ---- Backups ----

/** "/mnt/nas/Backups/memory-backups" → "nas/Backups"; "gdrive:memory-backups" → "Google Drive". */
const placeName = (where: string): string => (where.startsWith('gdrive:')
  ? 'Google Drive'
  : where.replace(/^\/mnt\//, '').replace(/\/memory-backups\/?$/, '') || where);

/** A run's ✓ or ✗ for the eye, with the same thing in words for a screen reader (the glyph alone reads "check mark" or "ballot X"). */
export const okMark = (r: 'copied' | 'skipped' | 'failed'): SafeHtml => html`<span aria-hidden="true">${r === 'copied' ? '✓' : '✗'}</span><span class="visually-hidden">${r === 'copied' ? t('inbox.settings.mark.ok') : r === 'skipped' ? t('backup.p.result.skipped') : t('backup.p.result.failed')}</span>`;

export function backupsPanel(b: { status: BackupStatus; health: { ok: boolean; problems: string[]; say?: Say[] }; offsite: boolean; jobs?: boolean }, opts: { id?: string; title?: string; extra?: SafeHtml; /** After the runs: what follows them in the section. */ after?: SafeHtml } = {}): SafeHtml {
  const { nightly, offsite } = b.status;
  const job = (label: string, r: SimpleRun | undefined) => html`<li><span class="label-inline">${label}</span> ${r ? html`${when(r.at)} <span class="place${r.ok ? '' : ' bad'}">${okMark(r.ok ? 'copied' : 'failed')}</span>` : html`<span class="quiet">${t('inbox.settings.notYet')}</span>`}</li>`;
  const run = (label: string, r: BackupRun | undefined, places: SafeHtml) => html`<li><span class="label-inline">${label}</span> ${r ? html`${when(r.at)} ${places}` : html`<span class="quiet">${t('inbox.settings.notYet')}</span>`}</li>`;
  const nightlyPlaces = nightly?.ok
    ? html`${(nightly.copies ?? []).map((c) => html`<span class="place${c.result === 'copied' ? '' : ' bad'}">${placeName(c.where)} ${okMark(c.result)}</span>`)}`
    : html`<span class="place bad"><span aria-hidden="true">✗</span> ${t('inbox.settings.failed')}</span>`;
  const offsitePlaces = html`<span class="place${offsite?.ok ? '' : ' bad'}">${placeName(offsite?.where ?? '')} ${okMark(offsite?.ok === true ? 'copied' : 'failed')}</span>`;
  return html`<section${opts.id ? html` id="${opts.id}"` : ''} class="panel backups${b.health.ok ? '' : ' attention'}">
  <div class="panel-head"><h2>${opts.title ?? t('inbox.settings.backups')}</h2></div>
  ${opts.extra ?? ''}
  <ul class="backup-runs">
    ${run(t('inbox.settings.nightly'), nightly, nightlyPlaces)}
    ${b.offsite ? run(t('inbox.settings.offsite'), offsite, offsitePlaces) : ''}
    ${b.offsite && b.status.drill ? html`<li><span class="label-inline">${t('inbox.settings.drill')}</span> ${when(b.status.drill.date)} <span class="place${b.status.drill.result === 'pass' ? '' : ' bad'}">${b.status.drill.copy} <span aria-hidden="true">${b.status.drill.result === 'pass' ? '✓' : '✗'}</span><span class="visually-hidden">${t(b.status.drill.result === 'pass' ? 'inbox.settings.drill.pass' : 'inbox.settings.drill.fail')}</span></span></li>` : ''}
    ${b.jobs ? html`${job(t('inbox.settings.gitCopy'), b.status.git)}${job(t('inbox.settings.mdExport'), b.status.export)}` : ''}
  </ul>
  ${nightly?.counts ? html`<p class="meta">${t('inbox.settings.lastBackup', { facts: t('inbox.facts.nFacts', { count: nightly.counts.facts }), pages: t('inbox.facts.nPages', { count: nightly.counts.pages }) })}</p>` : ''}
  ${b.health.ok ? '' : html`<ul class="problems">${backupProblems(b.health).map((p) => html`<li>${p}</li>`)}</ul>`}
  ${opts.after ?? ''}
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
  /** A1: current facts past their valid_until date, oldest date first. */
  pastDate?: Memory[];
}

export const tidyCount = (v: TidyItems): number => v.overlaps.length + v.statuses.length + v.duplicates.length + v.stale.length + (v.gone?.length ?? 0) + (v.pastDate?.length ?? 0);

/** "Probably the same (N% similar)" and, for a pair that can replace each other, what both are and where. */
function sameLine(pct: number, kind: 'status' | 'decision' | null, project: string | null): string {
  if (kind === null) return t('inbox.tidy.same', { pct });
  const statuses = kind === 'status';
  return project ? t(statuses ? 'inbox.tidy.sameStatusesIn' : 'inbox.tidy.sameDecisionsIn', { pct, project }) : t(statuses ? 'inbox.tidy.sameStatuses' : 'inbox.tidy.sameDecisions', { pct });
}

/** `back`: where the page's forms return to after an answer: Tidy up itself, or the Inbox when the cards sit in its pane. */
export function tidyView(v: TidyItems, error?: string, now: Date = new Date(), back: 'tidy' | 'inbox' = 'tidy'): SafeHtml {
  const backField = html`<input type="hidden" name="back" value="${back}">`;
  /** The forms that had no `back` before only say so in the Inbox pane (their default is Tidy up itself). */
  const backExtra = back === 'inbox' ? backField : html``;
  const memories = (n: number) => t('inbox.tidy.nMemories', { count: n });
  /** This screen's own address, so every fact it links goes back here. */
  const self = '/facts/tidy';
  const fact = (id: string): string => withFrom(`/memories/${id}`, self);
  // One black button a screen: the first "Newer replaces older" offered; failing that, "Replaced by the latest" when it
  // is the only replacement on the screen (one project with two statuses).
  const firstReplaceable = v.duplicates.find((d) => d.replaceable);
  const loneLatest = firstReplaceable === undefined && v.statuses.length === 1 && v.statuses[0]!.statuses.length === 2;
  const move = (from: string, to: string, secondary: boolean) => html`<form method="post" action="/tidy/projects/move">${backExtra}<input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}"><button type="submit"${secondary ? html` class="secondary"` : ''}>${t('inbox.tidy.moveAll', { to })}</button></form>`;
  const overlapCard = ({ smaller, larger }: Overlap) => html`<li class="card">
  <p>${tHtml('inbox.tidy.overlap', { a: projectLink(smaller.project), aCount: memories(smaller.count), b: projectLink(larger.project), bCount: memories(larger.count) })}</p>
  <div class="actions">
    ${move(smaller.project, larger.project, false)}
    ${move(larger.project, smaller.project, true)}
    <form method="post" action="/tidy/projects/different">${backExtra}<input type="hidden" name="a" value="${smaller.project}"><input type="hidden" name="b" value="${larger.project}"><button type="submit" class="secondary">${t('inbox.tidy.different')}</button></form>
  </div>
  <p class="label">${t('inbox.tidy.moveNote')}</p>
</li>`;
  const statusCard = ({ project, statuses }: { project: string; statuses: Memory[] }) => html`<li class="card">
  <p class="meta">${tHtml('inbox.tidy.statusesLine', { project: projectLink(project), count: statuses.length })}</p>
  <ol class="statuses">${statuses.map((m, i) => html`<li>
    <blockquote><a href="${fact(m.id)}">${excerpt(m.content)}</a></blockquote>
    <div class="status-foot">
      <p class="meta">${tHtml(i === 0 ? 'inbox.tidy.latestUpdated' : 'inbox.tidy.updatedBy', { when: when(m.updatedAt), who: writer(m.updatedBy) })}</p>
      <span class="actions">${i === 0 ? '' : html`<form method="post" action="/tidy/statuses/supersede">${backExtra}<input type="hidden" name="id" value="${m.id}"><input type="hidden" name="latest" value="${statuses[0]!.id}"><button type="submit"${loneLatest ? html` class="primary"` : ''}>${t('inbox.tidy.replacedByLatest')}</button></form>`}
      <form method="post" action="/memories/${m.id}/delete">${backField}<button type="submit" class="secondary">${t('inbox.tidy.delete')}</button></form></span>
    </div>
  </li>`)}</ol>
  <form method="post" action="/tidy/statuses/keep">${backExtra}<input type="hidden" name="project" value="${project}"><button type="submit" class="secondary">${t('inbox.tidy.allCurrent')}</button></form>
</li>`;
  const dupCard = (item: TidyItems['duplicates'][number]) => {
    const { a, b, similarity, replaceable } = item;
    // "Newer replaces older" (section 16) is the one primary button when offered; newer means saved later.
    const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    const side = (keep: Memory, drop: Memory) => html`<div class="dup-side">
  <blockquote><a href="${fact(keep.id)}">${excerpt(keep.content)}</a></blockquote>
  <p class="meta">${tHtml(replaceable ? (keep.id === older.id ? 'inbox.tidy.sideOlder' : 'inbox.tidy.sideNewer') : 'inbox.tidy.sideUpdated', { when: when(keep.updatedAt) })}</p>
  <form method="post" action="/duplicates/merge">${backExtra}<input type="hidden" name="keep" value="${keep.id}"><input type="hidden" name="drop" value="${drop.id}"><button type="submit"${replaceable ? html` class="secondary"` : ''}>${t('inbox.tidy.keepThis')}</button></form>
</div>`;
    const keepBoth = html`<form method="post" action="/duplicates/keep-both">${backExtra}<input type="hidden" name="a" value="${a.id}"><input type="hidden" name="b" value="${b.id}"><button type="submit" class="secondary">${t('inbox.tidy.keepBoth')}</button></form>`;
    return html`<li class="card">
  <p class="meta">${sameLine(Math.round(similarity * 100), replaceable ? kindWord(a) : null, a.project)}</p>
  <div class="pair">${side(a, b)}${side(b, a)}</div>
  ${replaceable ? html`<div class="tacts"><form method="post" action="/tidy/duplicates/supersede">${backExtra}<input type="hidden" name="older" value="${older.id}"><input type="hidden" name="newer" value="${newer.id}"><button type="submit"${item === firstReplaceable ? html` class="primary"` : ''}>${t('inbox.tidy.newerReplaces')}</button></form>${keepBoth}</div>
  <p class="label">${t('inbox.tidy.dupNoteReplace')}</p>`
    : html`${keepBoth}
  <p class="label">${t('inbox.tidy.dupNote')}</p>`}
</li>`;
  };
  const goneCard = ({ row, old, newer, deletion }: NonNullable<TidyItems['gone']>[number]) => html`<li class="card">
  <blockquote><a href="${fact(old.id)}">${excerpt(old.content)}</a></blockquote>
  <p class="meta">${tHtml('inbox.tidy.goneMeta', { project: projectLink(old.project), day: newer.deletedAt ? shortDay(newer.deletedAt, now) : '', who: writer(deletion?.changedBy ?? newer.updatedBy) })}</p>
  <div class="tacts">
    <form method="post" action="/supersessions/${row.id}/undo">${backField}<button type="submit">${t('inbox.tidy.bringBack')}</button></form>
    <form method="post" action="/memories/${old.id}/delete">${backField}<button type="submit" class="secondary">${t('inbox.tidy.deleteToo')}</button></form>
    ${deletion ? html`<form method="post" action="/history/${deletion.id}/undo">${backField}<button type="submit" class="secondary">${t('inbox.tidy.restoreNewer')}</button></form>` : ''}
  </div>
</li>`;
  const staleCard = (m: Memory) => html`<li class="card">
  <a class="card-link" href="${fact(m.id)}">${excerpt(m.content)}</a>
  <p class="meta">${tHtml('inbox.tidy.staleMeta', { kind: kindMark(m.kind), project: projectLink(m.project), when: when(m.updatedAt) })}</p>
  <div class="actions">
    <form method="post" action="/memories/${m.id}/confirm">${backExtra}<button type="submit">${t('inbox.tidy.stillTrue')}</button></form>
    <form method="post" action="/memories/${m.id}/delete">${backField}<button type="submit" class="secondary">${t('inbox.tidy.delete')}</button></form>
  </div>
</li>`;
  // A1: "Still true" clears the date; "Set a new date" takes one; "Replace…" opens the fact on its replace picker.
  const pastCard = (m: Memory) => html`<li class="card">
  <a class="card-link" href="${fact(m.id)}">${excerpt(m.content)}</a>
  <p class="meta">${tHtml('inbox.tidy.pastMeta', { kind: kindMark(m.kind), project: projectLink(m.project), date: m.validUntil ?? '' })}</p>
  <div class="tacts">
    <form method="post" action="/memories/${m.id}/valid-until">${backExtra}<input type="hidden" name="valid_until" value=""><button type="submit">${t('inbox.tidy.stillTrueClear')}</button></form>
    <form method="post" action="/memories/${m.id}/valid-until" class="tacts">${backExtra}<label class="visually-hidden" for="vu-${m.id}">${t('inbox.tidy.newDate')}</label><input type="date" id="vu-${m.id}" name="valid_until" required><button type="submit" class="secondary">${t('inbox.tidy.setDate')}</button></form>
    <a class="button secondary" href="${fact(m.id)}#picker">${t('inbox.tidy.replace')}</a>
  </div>
</li>`;
  const section = <T>(title: string, why: string, items: T[], card: (item: T) => SafeHtml) => (items.length === 0 ? html`` : html`<section class="panel tidy">
  <div class="panel-head"><h2>${title} <span class="n">${items.length}</span></h2></div>
  <p class="quiet">${why}</p>
  <ul class="cards">${items.map(card)}</ul>
</section>`);
  return html`<div class="narrow">
<h1>${t('inbox.tidy.title')}</h1>
<p class="lede">${t('inbox.tidy.lede')}</p>
${errorBlock(error)}
${tidyCount(v) === 0 ? html`<p class="quiet">${t('inbox.tidy.nothing')}</p>` : ''}
${section(t('inbox.tidy.s.overlaps'), t('inbox.tidy.s.overlapsWhy'), v.overlaps, overlapCard)}
${section(t('inbox.tidy.s.statuses'), t('inbox.tidy.s.statusesWhy'), v.statuses, statusCard)}
${section(t('inbox.tidy.s.duplicates'), t('inbox.tidy.s.duplicatesWhy'), v.duplicates, dupCard)}
${section(t('inbox.tidy.s.past'), t('inbox.tidy.s.pastWhy'), v.pastDate ?? [], pastCard)}
${section(t('inbox.tidy.s.stale'), t('inbox.tidy.s.staleWhy'), v.stale, staleCard)}
${section(t('inbox.tidy.s.gone'), t('inbox.tidy.s.goneWhy'), v.gone ?? [], goneCard)}</div>`;
}

// ---- Weekly digest ----

export function flagRow(flag: Flag): SafeHtml {
  const quote = (m: Memory) => html`<blockquote><a href="/memories/${m.id}">${excerpt(m.content)}</a></blockquote>`;
  switch (flag.kind) {
    case 'waiting':
      return html`<li class="entry"><p>${tHtml('inbox.digest.waiting', { count: flag.count, link: html`<a href="/approvals">${t('inbox.digest.review')}</a>` })}</p></li>`;
    case 'connected': {
      const settingsLink = html`<a href="/settings#connections">${t('shell.nav.settings')}</a>`;
      return html`<li class="entry w-${writerKey(flag.client)}"><p>${flag.times > 1 ? tHtml('inbox.digest.connectedTimes', { who: writer(flag.client), times: flag.times, when: when(flag.at), link: settingsLink }) : tHtml('inbox.digest.connected', { who: writer(flag.client), when: when(flag.at), link: settingsLink })}</p></li>`;
    }
    case 'no-saves':
      return html`<li class="entry w-${writerKey(flag.client)}"><p>${tHtml('inbox.digest.noSaves', { who: writer(flag.client), count: flag.lookups })}</p></li>`;
    case 'deleted-by-ai':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${tHtml('inbox.digest.deletedByAi', { who: writer(flag.by), when: when(flag.at) })}</p>${quote(flag.memory)}</li>`;
    case 'changed-others':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${flag.author === 'owner' ? tHtml('inbox.digest.changedYou', { who: writer(flag.by), when: when(flag.at) }) : tHtml('inbox.digest.changedOther', { who: writer(flag.by), author: writer(flag.author), when: when(flag.at) })}</p>${quote(flag.memory)}</li>`;
    case 'replaced-others':
      return html`<li class="entry w-${writerKey(flag.by)}"><p>${flag.author === 'owner' ? tHtml('inbox.digest.replacedYou', { who: writer(flag.by), when: when(flag.at) }) : tHtml('inbox.digest.replacedOther', { who: writer(flag.by), author: writer(flag.author), when: when(flag.at) })}</p>${quote(flag.memory)}</li>`;
    case 'no-project':
      return html`<li class="entry w-${writerKey(flag.memory.createdBy)}"><p>${tHtml('inbox.digest.noProject', { who: writer(flag.memory.createdBy) })}</p>${quote(flag.memory)}</li>`;
  }
}

/** Lookups started being counted at `lookupsSince`; a week from before then shows none. */
function lookupsNote(lookupsSince: string | null, weekStart: string): SafeHtml | string {
  return lookupsSince === null
    ? t('inbox.digest.lookupsNone')
    : lookupsSince > weekStart
      ? tHtml('inbox.digest.lookupsSince', { when: when(lookupsSince) })
      : t('inbox.digest.lookups');
}

/** The per-assistant table of the weekly digest: Saved, Changed, Deleted and Lookups (the owner looks nothing up). */
export function writersTable(writers: WriterTally[], lookupsSince: string | null, weekStart: string): SafeHtml {
  return html`<table class="week-table">
    <thead><tr><th scope="col">${t('inbox.digest.who')}</th><th scope="col" class="num">${t('inbox.digest.saved')}</th><th scope="col" class="num">${t('inbox.digest.changed')}</th><th scope="col" class="num">${t('inbox.digest.deleted')}</th><th scope="col" class="num">${t('inbox.digest.lookupsHead')}</th></tr></thead>
    <tbody>${writers.map((w) => html`<tr><th scope="row">${writer(w.name)}</th><td class="num">${w.saved}</td><td class="num">${w.changed}</td><td class="num">${w.deleted}</td><td class="num">${w.name === 'owner' ? '–' : w.lookups}</td></tr>`)}</tbody>
  </table>
  <p class="meta">${lookupsNote(lookupsSince, weekStart)}</p>`;
}

// ---- Memories ----

export type FactsShow = 'current' | 'replaced' | 'everything';

/** One group of facts on the Facts page: its project (null for the profile and for the facts with none), its label, how many it holds and the few shown. */
export interface FactGroup { project: string | null; /** What the group is: the profile facts, one project's, or the ones with no project (the label is only its words). */ group: 'profile' | 'project' | 'none'; label: string; total: number; shown: Memory[] }

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
    groups.push({ project: null, group: 'profile', label: t('inbox.facts.aboutYou'), total: profile.length, shown: profile.slice(0, perGroup) });
  }
  const projects = [...byProject.entries()].map(([project, list]) => [project, list.sort(newest)] as const)
    .sort(([, a], [, b]) => newest(a[0]!, b[0]!));
  for (const [project, list] of projects) groups.push({ project, group: 'project', label: project, total: list.length, shown: list.slice(0, perGroup) });
  if (loose.length > 0) {
    loose.sort(newest);
    groups.push({ project: null, group: 'none', label: t('inbox.facts.noProject'), total: loose.length, shown: loose.slice(0, perGroup) });
  }
  return groups;
}

/** `roadmapOneLine` with its "Now" and "Next" labels in the owner's language: for a heading or a result list. */
export const roadmapLine = (content: string): string | null => roadmapOneLine(content, { now: t('inbox.roadmap.Now'), next: t('inbox.roadmap.Next') });

/** A roadmap fact read as three short lines: Now, Next and Done; nothing when it parses to nothing. */
function roadmapLines(content: string): SafeHtml | null {
  const r = parseRoadmap(content);
  const now = r.now === null ? null : r.progress ? `${r.now} (${r.progress.done}/${r.progress.total})` : r.now;
  const next = r.nextSteps[0] ?? r.next;
  const dated = r.done.filter((d) => d.date !== null);
  const done = (dated.length > 0 ? dated.at(-1)! : r.done.at(-1))?.text ?? null;
  const lines: [string, string][] = [[`${t('inbox.roadmap.Now')}:`, now], [`${t('inbox.roadmap.Next')}:`, next], [`${t('inbox.roadmap.Done')}:`, done]].filter((l): l is [string, string] => l[1] !== null);
  if (lines.length === 0) return null;
  return html`<dl class="rmap">${lines.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/** A stored roadmap label ("Now:") in the owner's language; a label that is not one of the five stays as written. */
function roadmapLabel(label: string): string {
  const name = label.replace(/:$/, '');
  return (ROADMAP_LABELS as readonly string[]).includes(name) ? `${tKey(`inbox.roadmap.${name}` as 'inbox.roadmap.Now')}:` : label;
}

/** A roadmap fact in full, under its one-line heading: Done, Now, Next, Later and Waiting on you, each as it is saved. Null when the heading already shows the text. */
function roadmapFull(content: string): SafeHtml | null {
  if (roadmapLine(content) === null) return null;
  const lines = formatRoadmap(parseRoadmap(content)).split('\n').map((l) => { const i = l.indexOf(':'); return [roadmapLabel(l.slice(0, i + 1)), l.slice(i + 1).trim()] as const; });
  return html`<dl class="rmap rmap-full">${lines.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/** One fact in a group: its text (a roadmap reads as Now, Next and Done) and its meta line. */
function groupRow(m: Memory, from?: string): SafeHtml {
  const href = `/memories/${m.id}${from ? `?from=${encodeURIComponent(from)}` : ''}`;
  const roadmap = m.kind === 'roadmap' ? roadmapLines(m.content) : null;
  return html`<li class="frow"><a class="card-link" href="${href}">${roadmap ?? excerpt(m.content)}</a>
  <p class="fmeta"><span class="fkind">${kindLabel(m.kind)}</span> · ${writer(m.updatedBy)} · ${when(m.updatedAt)}${pastChip(m).value !== '' ? html` · ${pastChip(m)}` : ''}</p></li>`;
}

/** One group: its heading (the project links to the project), its facts, and a link to the ones it does not show. */
function groupView(g: FactGroup, from?: string): SafeHtml {
  const heading = g.project === null
    ? html`<h2>${g.label} <span class="n">${g.total}</span></h2>`
    : html`<h2><a href="/?project=${encodeURIComponent(g.project)}#panel">${g.label}</a> <span class="n">${g.total}</span></h2>`;
  const all = g.total > g.shown.length
    ? html`<a class="fall" href="${g.project === null ? (g.group === 'profile' ? '/facts?kind=profile' : `/facts?project=${NO_PROJECT}`) : `/facts?project=${encodeURIComponent(g.project)}`}">${g.group === 'none' ? t('inbox.facts.allNone', { count: g.total }) : g.group === 'profile' ? t('inbox.facts.allProfile', { count: g.total }) : t('inbox.facts.allIn', { count: g.total, label: g.label })}</a>`
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
    ? html`${v.filter.q === undefined && total > 0 ? html`<p class="quiet rep-line">${t('inbox.facts.replacedLine', { count: total })}</p>` : ''}${replacedList}`
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
  <input type="search" name="q" value="${v.filter.q ?? ''}" maxlength="200" placeholder="${t('inbox.facts.searchFacts')}" aria-label="${t('inbox.facts.searchFacts')}"${v.filter.q ? html` autofocus` : ''}>
  <select name="kind" aria-label="${t('inbox.facts.kind')}"><option value="">${t('inbox.facts.anyKind')}</option>${KINDS.map((k) => html`<option value="${k}"${k === v.filter.kind ? ' selected' : ''}>${kindLabel(k)}</option>`)}</select>
  <select name="project" aria-label="${t('inbox.facts.project')}"><option value="">${t('inbox.facts.allProjects')}</option><option value="${NO_PROJECT}"${v.filter.project === NO_PROJECT ? ' selected' : ''}>${t('inbox.facts.noProject')}</option>${projects.map((p) => html`<option value="${p}"${p === v.filter.project ? ' selected' : ''}>${p}</option>`)}</select>
  ${show === 'current' ? '' : html`<input type="hidden" name="show" value="${show}">`}
  <span class="seg" role="group" aria-label="${t('inbox.facts.show')}">${seg('current', t('inbox.facts.current'))}${seg('replaced', t('inbox.facts.replaced'))}${seg('everything', t('inbox.facts.everything'))}</span>
  <button type="submit" class="filter-show">${t('inbox.facts.show')}</button>
</form>`;
  return html`<div class="narrow">
${pagesSubnav('/facts')}
<div class="fhead">
<h1>${t('shell.nav.facts')} <span class="n">${t('inbox.facts.nCurrent', { count: counts.all })}</span></h1>
<a class="button new-fact" href="/memories/new">${t('inbox.facts.newFact')}</a>
</div>
<nav class="seg" aria-label="${t('inbox.facts.quickViews')}">${quick('/facts', t('inbox.facts.quickAll', { count: counts.all }), plain)}${counts.profile ? quick('/facts?kind=profile', t('inbox.facts.quickProfile', { count: counts.profile }), profile) : ''}${counts.replaced ? quick('/facts?show=replaced', t('inbox.facts.quickReplaced', { count: counts.replaced }), onlyReplaced) : ''}</nav>
${profile ? html`<p class="lede">${t('inbox.facts.profileLede')}</p>` : ''}
${filters}
${v.tidy ? html`<p class="tidy-line">${tHtml('inbox.facts.tidyLine', { text: v.tidy, link: html`<a href="/facts/tidy">${t('inbox.facts.haveALook')}</a>` })}</p>` : ''}
${empty ? html`<p class="quiet">${plain && counts.all === 0 ? t('inbox.facts.noneYet') : t('inbox.facts.noneFound')}</p>` : results}
${v.filter.q === undefined && (v.page > 1 || v.hasNext) ? html`<p class="pager">
  ${v.page > 1 ? html`<a href="${link(v.page - 1)}">${t('inbox.facts.newer')}</a>` : ''}
  ${v.hasNext ? html`<a href="${link(v.page + 1)}">${t('inbox.facts.older')}</a>` : ''}</p>` : ''}
</div>`;
}

function memoryForm(action: string, values: MemoryFormValues, opts: { kindEditable: boolean; submit: string; from?: string; meta?: boolean; error?: string }): SafeHtml {
  // A refusal about one field shows under it: the field points at the message (aria-describedby), is marked invalid and
  // takes the focus when the page opens (autofocus), so a screen reader and the keyboard land where the fix is.
  const bad = opts.error && values.errorField ? values.errorField : undefined;
  const aria = (f: FactField): SafeHtml => (bad === f ? html` aria-invalid="true" aria-describedby="fact-${f}-error" autofocus` : html``);
  const fieldError = (f: FactField): SafeHtml => (bad === f ? html`<p class="error" id="fact-${f}-error">${opts.error}</p>` : html``);
  const two = bad === 'tags' || bad === 'project' ? html`${fieldError('project')}${fieldError('tags')}` : '';
  return html`<form method="post" action="${action}" class="editor">
  ${values.base ? html`<input type="hidden" name="base" value="${values.base}">` : ''}
  ${opts.from ? html`<input type="hidden" name="from" value="${opts.from}">` : ''}
  ${opts.kindEditable
    ? html`<label>${t('inbox.facts.formKind')} <select name="kind">${KINDS.map((k) => html`<option value="${k}"${k === values.kind ? ' selected' : ''}>${kindLabel(k)}</option>`)}</select></label>`
    : ''}
  <label>${t('inbox.facts.formMemory')} <textarea name="content" rows="6" maxlength="${opts.kindEditable || values.kind === 'roadmap' ? MAX_ROADMAP : MAX_CONTENT}" required${aria('content')}>${values.content}</textarea></label>
  ${fieldError('content')}
  <div class="two">
    <label>${t('inbox.facts.formProject')} <input type="text" name="project" value="${values.project}" maxlength="63"${aria('project')}></label>
    <label>${t('inbox.facts.formTags')} <input type="text" name="tags" value="${values.tags}"${aria('tags')}></label>
  </div>
  ${two}
  <label>${t('inbox.facts.formKeys')} <input type="text" name="keys" value="${values.keys ?? ''}" maxlength="200"${aria('keys')}></label>
  ${fieldError('keys')}
  ${opts.meta ? metaFields(values) : ''}
  <div class="actions"><button type="submit" class="primary">${opts.submit}</button></div>
</form>`;
}

export function newView(values: MemoryFormValues, error?: string): SafeHtml {
  return html`<div class="narrow">
<h1>${t('inbox.facts.newFact')}</h1>
${errorBlock(values.errorField ? undefined : error)}
${memoryForm('/memories', values, { kindEditable: true, submit: t('inbox.facts.save'), meta: true, error })}
<p class="label">${t('inbox.facts.profileNow')}</p></div>`;
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
  const editor = html`${memoryForm(self, values, { kindEditable: false, submit: t('inbox.facts.saveChanges'), from: extra.from, meta: true, error })}
<form method="post" action="/memories/${m.id}/delete" class="danger">${extra.from ? html`<input type="hidden" name="from" value="${extra.from}">` : ''}<button type="submit" class="secondary">${t('inbox.facts.delete')}</button>
<p class="meta">${t('inbox.facts.deleteNote')}</p></form>`;
  const where = extra.where;
  const whereShown = where && (where.project !== null || where.pages.length > 0 || where.discussion);
  return html`<div class="narrow">
${errorBlock(values.errorField ? undefined : error)}
${replaced ? replacedNote(story!, now, self) : ''}
<p class="eyebrow fact-kind">${kindMark(m.kind)}${m.project ? html` · ${projectLink(m.project)}` : ''}${replaced ? html` · <span class="chip plain">${t('inbox.facts.replacedChip')}</span>` : ''}</p>
<h1 class="fact-text${replaced ? ' rep' : ''}">${(m.kind === 'roadmap' ? roadmapLine(m.content) : null) ?? m.content}</h1>
${m.kind === 'roadmap' ? roadmapFull(m.content) ?? '' : ''}
${metaLine([tHtml('inbox.facts.savedBy', { who: writer(m.createdBy) }), when(m.createdAt), ...(history.length > 0 && !m.deletedAt ? [tHtml('inbox.facts.editedBy', { who: writer(history[0].changedBy) }), when(history[0].changedAt)] : []), ...(m.tags.length ? [t('inbox.facts.tags', { tags: m.tags.join(', ') })] : [])])}
${m.keys ? html`<p class="fact-keys">${t('inbox.facts.searchWords', { keys: m.keys })}</p>` : ''}
${validLine(m, now)}${sourceLine(m)}
${m.deletedAt ? html`<p class="quiet">${m.movedTo ? tHtml('inbox.facts.movedTo', { project: m.movedTo, when: when(m.deletedAt) }) : tHtml('inbox.facts.deletedAt', { when: when(m.deletedAt) })}</p>` : html`<details class="pfold" id="edit"${extra.open === 'edit' ? ' open' : ''}><summary>${t('inbox.facts.editOrDelete')}<span class="chev"></span></summary>${replaced ? html`<p class="quiet">${t('inbox.facts.editReplaced')}</p>` : ''}${editor}</details>`}
<details class="pfold" id="history"${m.deletedAt || extra.open === 'history' ? ' open' : ''}><summary>${t('inbox.facts.history')}${events.length > 0 ? html` <span class="n">${events.length}</span>` : ''}<span class="chev"></span></summary>${factEvents(events, now, extra.from, m.movedTo)}</details>
${story ? html`${replacesBox(story, now, self)}${chainList(story, kindWord(m), now, self)}` : ''}
${whereShown ? html`<section class="where"><h3>${t('inbox.facts.where')}</h3><ul class="rows">${where.project ? html`<li><a href="/?project=${encodeURIComponent(where.project)}#panel">${where.project}</a></li>` : ''}${where.pages.map((p) => html`<li><a href="${withFrom(`/pages/${p.id}`, self)}">${p.title}</a></li>`)}${where.discussion ? html`<li>${tHtml('inbox.facts.decidedIn', { link: html`<a href="/discussions/${where.discussion.id}">${where.discussion.title}</a>` })}</li>` : ''}</ul></section>` : ''}
${extra.picker ? pickerFold(m, extra.picker, extra.pickAll ?? false, now, extra.open === 'picker', extra.selectedBy, extra.from) : ''}</div>`;
}

// ---- Clients and activity ----

/** Checkboxes for the projects a read-only connection may read, the given ones ticked. */
export function projectChoices(all: string[], picked: string[]): SafeHtml {
  return html`<fieldset class="project-choices"><legend>${t('inbox.settings.projectsItCanRead')}</legend>
  ${all.length === 0 ? html`<p class="quiet">${t('inbox.settings.noProjects')}</p>` : all.map((p) => html`<label class="choice"><input type="checkbox" name="projects" value="${p}"${picked.includes(p) ? ' checked' : ''}> ${p}</label>`)}
</fieldset>`;
}

/** A read-only grant's projects; one renamed or merged since reads nothing, and says so. */
const accessLabel = (g: GrantInfo, projects: string[]): string =>
  g.access === 'discussions' ? t('inbox.settings.access.discussions')
  : g.access === 'projects' ? t('inbox.settings.access.readOnly', { list: g.projects.map((p) => (projects.includes(p) ? p : t('inbox.settings.access.noLonger', { project: p }))).join(', ') })
  : t('inbox.settings.access.full');

/**
 * The connected AIs, one compact row each (name, access, last used, Revoke), with rename and access folded under
 * Change; revoked ones are folded away in their own list (Settings › Connections).
 */
/** Guided setup (§17b): the line under a connection: its setup text, then whether to refresh the connector. */
function setupLine(s: ConnStatus): SafeHtml {
  const href = s.app ? `/settings/setup/${s.app}` : '/settings#setup';
  const text = s.setup === 'none' ? '' : s.setup === 'current' ? html`<span class="ok">${t('inbox.settings.setupCurrent', { version: s.version ?? '' })}</span>`
    : s.setup === 'older' ? html`<span class="attention">${tHtml('inbox.settings.setupOlder', { version: s.version ?? '', link: html`<a href="${href}">${t('inbox.settings.copyNew')}</a>` })}</span>`
    : html`<span class="attention">${tHtml('inbox.settings.setupUnknown', { link: html`<a href="${href}">${t('inbox.settings.pasteSetup')}</a>` })}</span>`;
  const br = text === '' ? '' : html`<br>`;
  const tools = s.added > 0 ? html`${br}<span class="attention">${t('inbox.settings.refreshAdded', { count: s.added })}</span>`
    : s.changed ? html`${br}<span class="attention">${t('inbox.settings.refreshChanged')}</span>` : '';
  if (text === '' && tools === '') return html``;
  return html`<p class="conn-setup">${text}${tools}</p>`;
}

/** The "added, not signed in yet" line of Settings › Connections; empty when there is none. */
export function addedToolsLine(added: string[]): SafeHtml {
  return added.length === 0 ? html`` : html`<p class="attention"><span class="dot attention" aria-hidden="true"></span> ${t('inbox.settings.addedNotSignedIn', { names: added.join(', ') })}</p>`;
}

export function grantCards(v: { grants: GrantInfo[]; projects?: string[]; status?: Map<string, ConnStatus>; /** Tools BrainAI added that have not signed in yet (local mode). */ added?: string[] }): SafeHtml {
  const forms = (g: GrantInfo) => html`<form method="post" action="/clients/${g.id}/name" class="actions">
    <label>${t('inbox.settings.name')} <input type="text" name="name" value="${g.clientName}" maxlength="100" required></label>
    <button type="submit" class="secondary">${t('inbox.settings.rename')}</button>
  </form>
  <form method="post" action="/clients/${g.id}/access" class="actions">
    <label class="choice"><input type="radio" name="access" value="full"${g.access === 'full' ? ' checked' : ''}> ${t('inbox.settings.optFull')}</label>
    <label class="choice"><input type="radio" name="access" value="discussions"${g.access === 'discussions' ? ' checked' : ''}> ${t('inbox.settings.optDiscussions')}</label>
    <label class="choice"><input type="radio" name="access" value="projects"${g.access === 'projects' ? ' checked' : ''}> ${t('inbox.settings.optProjects')}</label>
    <details class="project-picker"${g.access === 'projects' ? ' open' : ''}><summary>${t('inbox.settings.projectsForRead')}<span class="chev"></span></summary>${projectChoices(v.projects ?? [], g.projects)}</details>
    <button type="submit" class="secondary">${t('inbox.settings.changeAccess')}</button>
  </form>
  <form method="post" action="/clients/${g.id}/saves-wait" class="actions">
    <label class="choice"><input type="checkbox" name="wait" value="1"${g.savesWait ? ' checked' : ''}> ${t('inbox.settings.savesWaitForMe')}</label>
    <button type="submit" class="secondary">${t('inbox.settings.saveSetting')}</button>
  </form>
  <p class="meta">${t('inbox.settings.savesWaitNote')}</p>`;
  const row = (g: GrantInfo) => html`<li class="conn">
  <div class="conn-row"><span class="conn-name">${writer(g.clientName)}</span><span class="conn-access">${accessLabel(g, v.projects ?? [])}${g.savesWait ? ` · ${t('inbox.settings.access.savesWait')}` : ''}</span><span class="meta">${g.lastUsedAt ? tHtml('inbox.settings.used', { when: when(g.lastUsedAt) }) : t('inbox.settings.usedNever')}</span>
  </div>
  ${v.status?.get(g.id) ? setupLine(v.status.get(g.id)!) : ''}
  <details class="conn-change"><summary>${t('inbox.settings.change')}<span class="visually-hidden"> ${g.clientName}</span><span class="chev"></span></summary>${forms(g)}<p class="meta">${tHtml('inbox.settings.connected', { when: when(g.createdAt) })}</p></details>
  <details class="pg-danger"><summary>${t('inbox.settings.revokeFold', { name: g.clientName })}<span class="chev"></span></summary><p class="meta">${t('inbox.settings.revokeHelp')}</p><form method="post" action="/clients/${g.id}/revoke"><button type="submit" class="secondary" aria-label="${t('inbox.settings.revokeName', { name: g.clientName })}">${t('inbox.settings.revoke')}</button></form></details>
</li>`;
  const revokedRow = (g: GrantInfo) => html`<li class="conn-old">${writer(g.clientName)} <span class="meta">${tHtml('inbox.settings.connectedRevoked', { when: when(g.createdAt), when2: when(g.revokedAt!) })}</span></li>`;
  const active = v.grants.filter((g) => !g.revokedAt);
  const revoked = v.grants.filter((g) => g.revokedAt);
  const added = v.added ?? [];
  const addedLine = addedToolsLine(added);
  return html`${active.length === 0 ? (added.length === 0 ? html`<p class="quiet">${t('inbox.settings.noAi')}</p>` : addedLine) : html`<ul class="conns">${active.map(row)}</ul>${addedLine}`}
${revoked.length > 0 ? html`<details class="conn-revoked"><summary>${t('inbox.settings.revokedConns')} <span class="n">${revoked.length}</span><span class="chev"></span></summary><ul class="plain">${revoked.map(revokedRow)}</ul></details>` : ''}`;
}

/** The devices the owner is logged in on, each with Log out (Settings › Your login). */
export function sessionCards(v: { sessions: SessionInfo[]; currentSessionId: string | undefined }): SafeHtml {
  const session = (s: SessionInfo) => html`<li class="card">
  <p><strong>${deviceLabel(s.userAgent)}</strong>${s.id === v.currentSessionId ? html` <span class="badge">${t('inbox.settings.thisDevice')}</span>` : ''}</p>
  ${metaLine([tHtml('inbox.settings.loggedIn', { when: when(s.createdAt) }), tHtml('inbox.settings.lastSeen', { when: when(s.lastSeenAt) })])}
  <details class="pg-danger"><summary>${t('inbox.settings.logOutFold')}<span class="visually-hidden"> ${deviceLabel(s.userAgent)}</span><span class="chev"></span></summary><p class="meta">${t(s.id === v.currentSessionId ? 'inbox.settings.logOutHelpHere' : 'inbox.settings.logOutHelp')}</p><form method="post" action="/sessions/${s.id}/revoke"${s.id === v.currentSessionId ? html` data-logout` : ''}><button type="submit" class="secondary">${t('inbox.settings.logOut')}</button></form></details>
</li>`;
  return v.sessions.length === 0 ? html`<p class="quiet">${t('inbox.settings.noDevices')}</p>` : html`<ul class="cards">${v.sessions.map(session)}</ul>`;
}
