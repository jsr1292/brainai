import { topReason, type Health, type Part } from '../health/health.js';
import { html, type SafeHtml } from './html.js';

/** Under this, a part of brain health earns a row in For you. */
export const HEALTH_FOR_YOU = 70;

const PARTS = (h: Health): [string, Part][] => [['Up to date', h.upToDate], ['Ready', h.ready], ['Waiting on you', h.waiting]];

/** Settings › Brain health and backups (B1): each part's number on a meter, then its reasons as links. */
export function healthBlock(h: Health | undefined): SafeHtml {
  if (!h) return html``;
  return html`<ul class="health-parts">${PARTS(h).map(([label, p]) => html`<li>
    <div class="hp-head"><span class="hp-label">${label}</span><span class="hp-score">${p.score}</span></div>
    <meter class="hp-bar" min="0" max="100" low="${HEALTH_FOR_YOU}" high="90" optimum="100" value="${p.score}" aria-label="${label}: ${p.score} of 100"></meter>
    ${p.reasons.length === 0 ? html`<p class="quiet">Nothing to do</p>` : html`<ul class="hp-reasons">${p.reasons.map((r) => html`<li><a href="${r.href}">${r.text}</a></li>`)}</ul>`}
  </li>`)}</ul>`;
}

/** Reasons For you already shows as rows of their own: approvals, disagreements, discussions waiting on the owner. */
const OWN_ROW = (href: string) => href === '/approvals' || href === '/disagreements' || href.startsWith('/discussions');

/** For you: while a part is under HEALTH_FOR_YOU, its first reason that For you doesn't already show; else nothing. */
export function healthRow(h: Health | undefined): SafeHtml | null {
  if (!h) return null;
  const text = topReason(h, OWN_ROW, HEALTH_FOR_YOU);
  if (text === null) return null;
  return html`<a class="row" href="/settings#health"><span class="dot muted" aria-hidden="true"></span><span class="txt"><b>Brain health</b>: ${text}</span><span class="chev"></span></a>`;
}
