/*
 * The side fragment (desktop design §7): the one home for what a desktop sheet shows beside the canonical page and the
 * server does not render today: Lately (a project's newest changes), Next for you (approval and discussion sheets) and
 * Your profile today (beside a profile suggestion). Only desk.js asks for it, with ?pane=side on the canonical URL, so
 * no phone page carries any of it.
 */
import { cosine } from '../memory/embedder.js';
import { factStory } from '../memory/factStory.js';
import type { Memory, Suggestion } from '../memory/types.js';
import type { AppDeps } from './app.js';
import { activityRow, excerpt, suggestionPhrase, when, writer, writerName, type ActivityItem } from './dashboardViews.js';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';

/** How many profile facts the approval sheet shows before "All N in Facts ›" (as the project panel's Facts). */
export const PROFILE_SHOWN = 6;
/** How many facts Near it shows beside a fact. */
export const NEAR_SHOWN = 5;

/**
 * The facts nearest a fact by meaning (Near it, beside a fact on the desktop): the same kind, at or over the floor a
 * page's Related facts use (relatedSimilarity), never the fact itself nor one in its own chain, highest first.
 */
export function nearIt(d: Pick<AppDeps, 'store' | 'relatedSimilarity'>, m: Memory, limit = NEAR_SHOWN): Memory[] {
  const own = d.store.embeddingsOf([m.id]).get(m.id);
  if (!own) return [];
  const chain = new Set([m.id, ...factStory(d.store, m.id).chain.map((c) => c.memory.id)]);
  return d.store.activeEmbeddings({ kind: m.kind })
    .filter((e) => !chain.has(e.id))
    .map((e) => ({ id: e.id, sim: cosine(own, e.embedding) }))
    .filter((e) => e.sim >= d.relatedSimilarity)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((e) => d.store.get(e.id))
    .filter((x): x is Memory => x !== undefined);
}

/**
 * A roadmap's one line in Lately: its Now line; without one, the first line not labelled Done; else nothing. A roadmap
 * is written back Done first (formatRoadmap), so its first line would only repeat the last tick, which Done today shows.
 */
export function roadmapLine(content: string): string | null {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^Now:/i.test(l)) ?? lines.find((l) => !/^Done:/i.test(l)) ?? null;
}

/**
 * A project's newest changes, newest first, from its own memories (never a scan of the global feed): each memory once
 * (its newest change), a roadmap as its Now line.
 */
export function projectLately(d: Pick<AppDeps, 'store' | 'service'>, project: string, limit = 5): ActivityItem[] {
  const name = d.service.projectNamed(project);
  // One memory changed many times (a roadmap ticked again and again) fills a short read with repeats: read further until
  // enough memories are found or the project has no more changes.
  for (let read = limit * 3; ; read *= 4) {
    const rows = d.store.projectActivity(name, read);
    const seen = new Set<string>();
    const out: ActivityItem[] = [];
    for (const row of rows) {
      if (seen.has(row.memoryId)) continue;
      seen.add(row.memoryId);
      if (row.kind === 'roadmap') {
        const line = roadmapLine(row.content);
        if (line === null) continue;
        out.push({ ...row, content: line });
      } else out.push(row);
      if (out.length === limit) return out;
    }
    if (rows.length < read || read >= 5000) return out;
  }
}

/**
 * What waits on the owner after this sheet, in the For you order: the approval sheet shows one suggestion at a time
 * (/approvals?id=), so after one comes the next waiting suggestion, then the discussions that wait on the owner
 * (approvals never come after a discussion). After a discussion it is the next one after it, or else the first that is
 * not it. With no id the approval sheet shows the first suggestion.
 */
export function nextForYou(d: Pick<AppDeps, 'discussions' | 'service'>, after: { kind: 'approval'; id?: string } | { kind: 'discussion'; id: string }): { href: string; title: string } | null {
  const queue = d.discussions.waitingOnOwner();
  const to = (x: { id: string; title: string } | undefined) => (x ? { href: `/discussions/${x.id}`, title: x.title } : null);
  if (after.kind === 'approval') {
    const pending = d.service.pendingSuggestions();
    const at = after.id === undefined ? 0 : pending.findIndex((s) => s.id === after.id);
    const next = at >= 0 ? pending[at + 1] : undefined;
    if (next) return { href: `/approvals?id=${encodeURIComponent(next.id)}`, title: `${writerName(next.suggestedBy)} suggests ${suggestionPhrase(next)}` };
    return to(queue[0]);
  }
  const at = queue.findIndex((x) => x.id === after.id);
  return to((at >= 0 ? queue.slice(at + 1) : []).find((x) => x.id !== after.id) ?? queue.find((x) => x.id !== after.id));
}

/**
 * The owner's profile beside a profile suggestion: the facts it would replace (an update's or delete's memory, and
 * what it supersedes) first, then the rest, newest first. Null for any other suggestion.
 */
export function profileToday(d: Pick<AppDeps, 'service'>, s: Suggestion): { memory: Memory; replaced: boolean }[] | null {
  if (s.kind !== 'profile') return null;
  const gone = new Set([...(s.memoryId ? [s.memoryId] : []), ...s.supersedes]);
  const all = d.service.loadProfile().map((memory) => ({ memory, replaced: gone.has(memory.id) }));
  const newest = (a: { memory: Memory }, b: { memory: Memory }) => (a.memory.updatedAt < b.memory.updatedAt ? 1 : a.memory.updatedAt > b.memory.updatedAt ? -1 : 0);
  return [...all.filter((x) => x.replaced).sort(newest), ...all.filter((x) => !x.replaced).sort(newest)];
}

export function deskSideView(b: {
  lately?: ActivityItem[];
  /** The Lately links' way back (activityRow's `from`). */
  self?: string;
  next?: { href: string; title: string } | null;
  profile?: { memory: Memory; replaced: boolean }[] | null;
  /** Near it, beside a fact: its links come back to `self`. */
  near?: Memory[];
}): SafeHtml {
  const next = b.next ? html`<section class="desk-next"><h3>Next for you</h3><a class="row" href="${b.next.href}" data-sheet><span class="dot" aria-hidden="true"></span><span class="txt">${b.next.title}</span><kbd>↓</kbd></a></section>` : '';
  const shown = b.profile ? b.profile.slice(0, PROFILE_SHOWN) : [];
  const profile = b.profile ? html`<section class="desk-profile"><h3>Your profile today · About you</h3><ul class="plain-list">${shown.map((x) => html`<li${x.replaced ? html` class="replaced"` : ''}><span class="desk-fact">${x.memory.content}</span>${metaLine([writer(x.memory.updatedBy), when(x.memory.updatedAt), x.replaced ? 'would be replaced' : null])}</li>`)}</ul>${b.profile.length > PROFILE_SHOWN ? html`<a class="more-link" href="/facts?kind=profile">All ${b.profile.length} in Facts ›</a>` : ''}</section>` : '';
  const lately = b.lately && b.lately.length > 0 ? html`<section class="desk-lately"><h3>Lately</h3><ul class="plain-list">${b.lately.map((a) => activityRow(a, b.self))}</ul></section>` : '';
  const from = b.self ? `?from=${encodeURIComponent(b.self)}` : '';
  const near = b.near && b.near.length > 0 ? html`<section class="desk-near"><h3>Near it</h3><ul class="plain-list">${b.near.map((m) => html`<li><a href="/memories/${m.id}${from}">${excerpt(m.content)}</a>${metaLine([m.kind, when(m.updatedAt)])}</li>`)}</ul></section>` : '';
  return html`<aside class="desk-side">${next}${profile}${lately}${near}</aside>`;
}
