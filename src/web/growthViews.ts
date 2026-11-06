import { GROWTH_AREA_LABELS, REACTIONS, type Evidence, type Observation, type Reaction } from '../growth/types.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { timeAgo } from './when.js';
import { weekNav } from './subnav.js';

/** The same relative date words as the other screens. */
const day = (iso: string): SafeHtml => timeAgo(iso);
const projectLink = (p: string | null): SafeHtml => (p === null ? html`` : html`<a href="/?project=${encodeURIComponent(p)}#panel">${p}</a>`);
const LABELS: Record<Reaction, string> = { agree: 'Agree', disagree: 'Disagree', dismiss: 'Dismiss' };
/** Disagreed and dismissed observations stop counting (spec section 11). */
export const counts = (o: Observation): boolean => o.reaction !== 'disagree' && o.reaction !== 'dismiss';

function reactForm(id: string, value: Reaction | 'clear', label: string, pressed: boolean | undefined): SafeHtml {
  // The current reaction is the one solid button; the others are secondary.
  return html`<form method="post" action="/growth/${id}/react"><input type="hidden" name="reaction" value="${value}"><button type="submit"${pressed === true ? '' : html` class="secondary"`}${pressed === undefined ? '' : html` aria-pressed="${String(pressed)}"`}>${label}</button></form>`;
}

function observationCard({ observation: o, evidence }: { observation: Observation; evidence: Evidence[] }): SafeHtml {
  const dimmed = !counts(o);
  const actions = dimmed
    ? html`<p class="label">You ${o.reaction === 'dismiss' ? 'dismissed' : 'disagreed with'} this, so it doesn't count.</p>${reactForm(o.id, 'clear', 'Undo', undefined)}`
    // Pressing the current reaction again clears it.
    : REACTIONS.map((r) => reactForm(o.id, o.reaction === r ? 'clear' : r, LABELS[r], o.reaction === r));
  return html`<li class="card obs${dimmed ? ' dimmed' : ''}" id="o-${o.id}">
  ${metaLine([html`<span class="chip">${GROWTH_AREA_LABELS[o.area]}</span>`, projectLink(o.project), `noted ${o.evidenceCount === 1 ? 'once' : `${o.evidenceCount} times`}`, html`latest ${day(o.lastEvidenceAt)}`, `by ${o.createdBy}`])}
  <p class="obs-what">${o.summary}</p>
  ${o.practise === null ? '' : html`<p class="obs-practise"><span class="label-inline">Practise</span> ${o.practise}</p>`}
  <details class="obs-evidence"><summary>Evidence <span class="n">${evidence.length}</span><span class="chev"></span></summary>
    <ul class="rows">${evidence.map((e) => html`<li><p>${e.what}</p>${metaLine([projectLink(e.project), e.addedBy, day(e.addedAt)])}</li>`)}</ul>
  </details>
  <div class="actions">${actions}</div>
</li>`;
}

/** The owner's Growth list: everything assistants noticed, by kind, with Agree, Disagree and Dismiss. */
export function growthView(items: { observation: Observation; evidence: Evidence[] }[]): SafeHtml {
  const section = (title: string, kind: Observation['kind'], none: string) => {
    const mine = items.filter((x) => x.observation.kind === kind);
    return html`<section class="panel growth">
  <div class="panel-head"><h2>${title} <span class="n">${mine.length}</span></h2></div>
  ${mine.length === 0 ? html`<p class="quiet">${none}</p>` : html`<ul class="cards">${mine.map(observationCard)}</ul>`}
</section>`;
  };
  // The same head as Last week and So far (title, one line, the control with All weeks), so the control keeps its place.
  return html`<div class="narrow"><div class="rv-head">
  <h1>Growth</h1>
  <p class="meta">What your assistants noticed so far.</p>
  ${weekNav('growth', false, html`<a href="/review/all">All weeks</a>`)}
</div>
<p class="lede">The full Growth page, with your top strengths and what to improve, comes once there are a few weeks of these.</p>
${items.length === 0
    ? html`<p class="quiet">Nothing noticed yet. Assistants add observations as they work with you.</p>`
    : html`${section('Strengths', 'strength', 'No strengths noted yet.')}${section('To improve', 'improve', 'Nothing to improve noted yet.')}`}</div>`;
}
