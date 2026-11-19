/**
 * The markup of section 16 (superseded facts): functions of plain data, so the screens can move with the navigation
 * redesign without touching the queries. Words: "replaced" and "replaces", never "superseded".
 */
import type { FactEvent, FactStory } from '../memory/factStory.js';
import type { Replaceable } from '../memory/supersessions.js';
import type { Memory } from '../memory/types.js';
import { shortDay } from '../timezone.js';
import { withFrom } from './back.js';
import { kindLabel, versionMeta } from './factMetaViews.js';
import { t, tHtml, tKey } from '../i18n/index.js';
import { html, type SafeHtml } from './html.js';
import { writer, writerName } from './dashboardViews.js';

const EXCERPT = 160;
const excerpt = (s: string) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT - 1)}…` : s);
/** A short excerpt cut at a word, its trailing punctuation dropped, as the mockup's NOW and "replaced by" lines are. */
const shortExcerpt = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s;,.:—–-]+$/, '')}…`;
};
const NOW_EXCERPT = 48;
const BY_EXCERPT = 84;
/** A day as the mockup writes it ("30 Oct"; the year only when it is not this year's). */
const day = (iso: string, now: Date): string => shortDay(iso, now);
/** The replaceable kind as the owner reads it. */
export const kindWord = (m: Pick<Memory, 'kind' | 'tags'>): Replaceable => (m.kind === 'summary' || m.tags.includes('status') ? 'status' : 'decision');
/** `from`: the origin the fact this markup sits on was opened from, kept by every form that returns to it. */
const fromField = (from?: string): SafeHtml => (from ? html`<input type="hidden" name="from" value="${from}">` : html``);
const undoForm = (rowId: number, label: string, back?: string, from?: string) => html`<form method="post" action="/supersessions/${rowId}/undo">${back ? html`<input type="hidden" name="back" value="${back}">` : ''}${fromField(from)}<button type="submit" class="secondary">${label}</button></form>`;

const deletedText = (at: string | null | undefined, now: Date): string => (at ? t('facts.replacementDeletedOn', { day: day(at, now) }) : t('facts.replacementDeleted'));
const deletedAtOf = (story: FactStory, id: string): string | null | undefined => story.chain.find((s) => s.memory.id === id)?.memory.deletedAt;

/** The calm note at the top of a replaced fact's page: when and by whom, the fact that holds now, and one Undo. */
export function replacedNote(story: FactStory, now: Date = new Date(), from?: string): SafeHtml {
  const r = story.replacedBy;
  if (!r) return html``;
  const lead = tHtml('facts.replacedLead', { on: html`<strong>${t('facts.replacedOn', { day: day(r.row.createdAt, now) })}</strong>`, who: writer(r.row.createdBy) });
  const body = r.end
    ? html`<p>${lead} ${t('facts.replacedNote')}</p>
  <a class="now" href="${withFrom(`/memories/${r.end.id}`, from)}">${excerpt(r.end.content)}<small>${t('facts.currentLine', { kind: tKey(`projects.kind.${kindWord(r.end)}`), project: r.end.project ?? t('facts.noProject') })}</small></a>`
    : html`<p>${lead} <a href="${withFrom(`/memories/${r.endId}`, from)}">${deletedText(deletedAtOf(story, r.endId), now)}</a> ${t('facts.replacedNoteGone')}</p>`;
  return html`<div class="replaced-note" role="note">
  ${body}
  ${undoForm(r.row.id, t('facts.undoBringBack'), undefined, from)}
</div>`;
}

/** "Replaces": the facts this one replaced directly, each with who wrote it, who replaced it, and Undo. */
export function replacesBox(story: FactStory, now: Date = new Date(), from?: string): SafeHtml {
  if (story.replaces.length === 0) return html``;
  return html`<section class="replaces-box">
  <h3>${t('facts.replaces')}</h3>
  <ul class="cards">${story.replaces.map(({ row, old }) => html`<li class="card"><p><a href="${withFrom(`/memories/${old.id}`, from)}">${excerpt(old.content)}</a></p>
    <span class="meta">${tHtml('facts.replacesMeta', { writer: writer(old.createdBy), day: day(old.createdAt, now), by: writer(row.createdBy), replacedDay: day(row.createdAt, now) })}</span>
    ${undoForm(row.id, t('facts.undo'), undefined, from)}</li>`)}</ul>
</section>`;
}

/** "This decision over time": every fact linked into the end of the chain, oldest first. */
export function chainList(story: FactStory, kind: Replaceable, now: Date = new Date(), from?: string): SafeHtml {
  if (story.chain.length === 0) return html``;
  const step = (s: FactStory['chain'][number]) => {
    const cls = [s.current ? 'cur' : '', s.here ? 'here' : ''].filter(Boolean).join(' ');
    const text = s.here ? html`${s.memory.content}` : html`<a href="${withFrom(`/memories/${s.memory.id}`, from)}">${excerpt(s.memory.content)}</a>`;
    const state = s.memory.deletedAt
      ? html` · ${s.memory.movedTo ? t('facts.chain.movedTo', { project: s.memory.movedTo }) : t('facts.chain.deleted')} · ${day(s.memory.deletedAt, now)}`
      : s.replacedAt ? html` · ${t('facts.chain.replaced', { day: day(s.replacedAt, now) })}` : s.current ? html` · ${t('facts.chain.current')}` : '';
    return html`<li${cls ? html` class="${cls}"` : ''}><span class="txt">${text}</span><span class="meta">${writer(s.memory.createdBy)} · ${day(s.memory.createdAt, now)}${state}${s.here ? html` · <em>${t('facts.chain.here')}</em>` : ''}</span></li>`;
  };
  return html`<h3>${t(kind === 'decision' ? 'facts.chain.decision' : 'facts.chain.status')}</h3>
<ol class="chain">${story.chain.map(step)}</ol>`;
}

/** History: edits keep "Undo to this"; a live replacement has Undo; a bringing back has no button. */
export function factEvents(events: FactEvent[], now: Date = new Date(), from?: string, movedTo?: string | null): SafeHtml {
  // The newest delete entry of a fact retired onto a page says where it went, not "delete".
  const retired = movedTo ? events.find((x) => x.type === 'edit' && x.entry.action === 'delete') : undefined;
  const row = (e: FactEvent) => {
    if (e.type === 'edit') {
      return html`<li class="card">
  <p class="meta"><span class="verb">${e === retired ? t('facts.movedTo', { project: movedTo! }) : tKey(`facts.verb.${e.entry.action}`)}</span> ${tHtml('facts.eventBy', { who: writer(e.entry.changedBy), day: day(e.entry.changedAt, now) })}</p>
  <blockquote>${e.entry.content}</blockquote>
  ${versionMeta(e.entry)}
  <form method="post" action="/history/${e.entry.id}/undo"><input type="hidden" name="part" value="history">${fromField(from)}<button type="submit" class="secondary">${t('facts.undoTo')}</button></form>
</li>`;
    }
    if (e.type === 'replaced') {
      return html`<li class="card"><div class="ev-row"><span class="meta">${tHtml('facts.replacedBy', { who: writer(e.row.createdBy), day: day(e.row.createdAt, now) })}</span>
  ${e.row.undoneAt === null ? html`<form method="post" action="/supersessions/${e.row.id}/undo"><input type="hidden" name="part" value="history">${fromField(from)}<button type="submit" class="secondary">${t('facts.undo')}</button></form>` : ''}</div></li>`;
    }
    return html`<li class="card"><p class="meta">${tHtml('facts.broughtBack', { who: writer(e.row.undoneBy ?? 'owner'), day: day(e.at, now) })}</p></li>`;
  };
  return events.length === 0 ? html`<p class="quiet">${t('facts.noEarlier')}</p>` : html`<ul class="cards fact-events">${events.map(row)}</ul>`;
}

/**
 * The project panel's "Replaced" fold, closed: each replaced fact in grey, the fact that holds NOW, who replaced it
 * and when, and Undo on its own line. Empty when the project has none.
 */
export function replacedFold(project: string, replaced: { rows: { row: { id: number; createdAt: string; createdBy: string }; old: Memory; end: Memory | null; endId: string; endDeletedAt: string | null; steps: number }[]; total: number }, now: Date = new Date(), from?: string): SafeHtml {
  if (replaced.total === 0) return html``;
  const row = (r: (typeof replaced.rows)[number]) => html`<li>
    <div class="old">${excerpt(r.old.content)}</div>
    <div class="now">${r.end ? html`<b>${t('facts.fold.now')}</b><a href="${withFrom(`/memories/${r.end.id}`, from)}">${shortExcerpt(r.end.content, NOW_EXCERPT)}</a>` : html`<a href="${withFrom(`/memories/${r.endId}`, from)}">${deletedText(r.endDeletedAt, now)}</a>`}</div>
    <p class="meta">${tHtml('facts.replacedBy', { who: writer(r.row.createdBy), day: day(r.row.createdAt, now) })}${r.steps > 1 ? html` · <a href="${withFrom(`/memories/${r.old.id}`, from)}">${t('facts.fold.steps', { steps: r.steps })}</a>` : ''}</p>
    ${undoForm(r.row.id, t('facts.undo'), 'panel')}
  </li>`;
  return html`<details class="pfold"><summary>${t('facts.fold.replaced')} <span class="n">${replaced.total}</span><span class="chev"></span></summary>
  <ul class="rlist">${replaced.rows.map(row)}</ul>
  ${replaced.total > replaced.rows.length ? html`<p class="more-link"><a href="/facts?project=${encodeURIComponent(project)}&amp;show=replaced">${t('facts.fold.all', { total: replaced.total })}</a></p>` : ''}
</details>`;
}

/** One replaced fact in All facts › Replaced: greyed, with what replaced it (and whether that one was replaced too), or when that was deleted. */
export function replacedCard(item: { row: { createdAt: string; createdBy: string }; old: Memory; next: Memory; nextReplaced: boolean }, now: Date = new Date(), from?: string): SafeHtml {
  return html`<li class="card rep">
  <a class="card-link" href="${withFrom(`/memories/${item.old.id}`, from)}">${excerpt(item.old.content)}</a>
  ${item.next.deletedAt
    ? html`<p class="by">→ <a href="${withFrom(`/memories/${item.next.id}`, from)}">${t('facts.replacementDeletedOn', { day: day(item.next.deletedAt, now) })}</a></p>`
    : html`<p class="by">${t('facts.card.replacedBy')} <a href="${withFrom(`/memories/${item.next.id}`, from)}">${shortExcerpt(item.next.content, BY_EXCERPT)}</a>${item.nextReplaced ? html` <span class="badge">${t('facts.card.also')}</span>` : ''}</p>`}
  <p class="meta"><span class="kind k-${item.old.kind}">${kindLabel(item.old.kind)}</span> ${item.old.project ? html`<a class="project" href="/facts?project=${encodeURIComponent(item.old.project)}">${item.old.project}</a>` : ''} ${tHtml('facts.card.metaTail', { who: writer(item.row.createdBy), day: day(item.row.createdAt, now) })}</p>
</li>`;
}

/** "Has a newer fact replaced this one?": radio rows of current facts of the same kind and project, folded. */
export function pickerFold(m: Memory, picker: { choices: Memory[]; total: number; kind: Replaceable; project: string | null }, pickAll: boolean, now: Date = new Date(), open = false, selectedBy?: string, from?: string): SafeHtml {
  const k = picker.kind;
  const where = picker.project ? tKey(`facts.picker.where.${k}.project`, { project: picker.project }) : tKey(`facts.picker.where.${k}.none`);
  const legend = t('facts.picker.legend', { where, order: pickAll ? t('facts.picker.newest') : t('facts.picker.alike') });
  const choice = (c: Memory) => html`<label class="choice"><input type="radio" name="by" value="${c.id}" required${c.id === selectedBy ? ' checked' : ''}><span>${excerpt(c.content)}<small>${writerName(c.createdBy)} · ${shortDay(c.createdAt, now)}</small></span></label>`;
  const empty = html`<p class="quiet">${picker.project ? tKey(`facts.picker.empty.${k}.project`, { project: picker.project }) : tKey(`facts.picker.empty.${k}.none`)}</p>`;
  return html`<details class="pfold" id="picker"${pickAll || open ? ' open' : ''}><summary>${t('facts.picker.title')}<span class="chev"></span></summary>
<form method="post" action="/memories/${m.id}/supersede" class="pick">
  ${pickAll ? html`<input type="hidden" name="pick" value="all">` : ''}
  ${fromField(from)}
  <p class="quiet">${t('facts.picker.help')}</p>
  ${picker.choices.length === 0 ? empty : html`<fieldset class="picker" id="replace">
    <legend>${legend}</legend>
    ${picker.choices.map(choice)}
  </fieldset>
  <div class="picker-foot"><button type="submit">${t('facts.picker.mark')}</button>${!pickAll && picker.total > picker.choices.length ? html`<a href="${withFrom(`/memories/${m.id}?pick=all#replace`, from)}">${tKey(`facts.picker.showAll.${k}`, { total: picker.total })}</a>` : ''}</div>`}
</form>
</details>`;
}
