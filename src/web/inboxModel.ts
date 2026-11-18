/**
 * The Inbox, as data: everything that waits for the owner, in groups. This one function is the source for the list's
 * rows, its "k of N" and the sidebar's badge, so the three can never disagree.
 */
import { writerName, excerpt } from './dashboardViews.js';
import type { TidyItems } from './dashboardViews.js';
import type { AppDeps } from './app.js';
import { html, type SafeHtml } from './html.js';
import { makeTidyItems } from './tidyItems.js';
import { timeAgo } from './when.js';
import type { Memory, Suggestion } from '../memory/types.js';
import { tidyProposalTitle } from './tidyProposalViews.js';

export type InboxKind = 'suggestion' | 'proposal' | 'tidyProposal' | 'disagree' | 'tidy' | 'discussion';
export interface InboxItem {
  /** `kind:id`, unique in the Inbox. */
  key: string;
  kind: InboxKind;
  id: string;
  /** Where the row goes: the item's own page (the Inbox frame with it open, a discussion's own page). */
  href: string;
  title: string;
  sub: SafeHtml | string;
}
export interface InboxGroup { kind: 'approvals' | 'harvest' | 'tidyProposals' | 'disagree' | 'tidy' | 'discussions'; title: string; /** The group's whole page. */ href: string; items: InboxItem[] }
/** `total` is what needs the owner (the badge, the header); the tidy-ups are listed after it, counted apart in `tidyCount`. */
export interface InboxModel { groups: InboxGroup[]; items: InboxItem[]; total: number; tidyCount: number }

type Deps = Pick<AppDeps, 'service' | 'discussions' | 'store' | 'now' | 'sameProjectFloor'> & Partial<Pick<AppDeps, 'skills' | 'tidy'>>;

const projectOf = (m: Memory): string => m.project ?? 'No project';
const q = encodeURIComponent;

/** The tidy-ups as rows: one per pair, per pair of project names, per project with several statuses, per lost replacement; the stale facts as one. */
export function tidyRows(v: TidyItems): InboxItem[] {
  const rows: InboxItem[] = [];
  const row = (id: string, title: string, sub: string): void => { rows.push({ key: `tidy:${id}`, kind: 'tidy', id, href: `/facts/tidy?item=${q(id)}`, title, sub }); };
  for (const o of v.overlaps) row(`names:${o.smaller.project}|${o.larger.project}`, `${o.smaller.project} and ${o.larger.project} look alike`, 'Project names');
  for (const s of v.statuses) row(`statuses:${s.project}`, `${s.project} has ${s.statuses.length} statuses`, 'Several statuses');
  for (const p of v.duplicates) row(`pair:${p.a.id}:${p.b.id}`, `2 facts look like duplicates: ${excerpt(p.a.content)}`, projectOf(p.a));
  for (const g of v.gone ?? []) row(`gone:${g.row.id}`, `A replaced fact lost its replacement: ${excerpt(g.old.content)}`, projectOf(g.old));
  // A1: facts past their date, one row per project (the fact itself when it is the only one there).
  const past = new Map<string, Memory[]>();
  for (const m of v.pastDate ?? []) past.set(m.project ?? '', [...(past.get(m.project ?? '') ?? []), m]);
  for (const [project, ms] of past) {
    row(`past:${project}`, ms.length === 1 ? `Past its date: ${excerpt(ms[0]!.content)}` : `${ms.length} facts are past their date${project === '' ? '' : ` in ${project}`}`, project === '' ? 'No project' : project);
  }
  if (v.stale.length > 0) row('stale', v.stale.length === 1 ? "1 fact hasn't been touched in six months" : `${v.stale.length} facts haven't been touched in six months`, 'Still true?');
  return rows;
}

/** The tidy-ups that a row's id names, as the page's own items (so the same cards show). */
export function tidyOnly(v: TidyItems, id: string): TidyItems | null {
  const none: TidyItems = { overlaps: [], statuses: [], duplicates: [], stale: [], gone: [], pastDate: [] };
  if (id === 'stale') return v.stale.length > 0 ? { ...none, stale: v.stale } : null;
  const [kind, ...rest] = id.split(':');
  const arg = rest.join(':');
  if (kind === 'names') { const o = v.overlaps.filter((x) => `${x.smaller.project}|${x.larger.project}` === arg); return o.length ? { ...none, overlaps: o } : null; }
  if (kind === 'statuses') { const s = v.statuses.filter((x) => x.project === arg); return s.length ? { ...none, statuses: s } : null; }
  if (kind === 'pair') { const p = v.duplicates.filter((x) => `${x.a.id}:${x.b.id}` === arg); return p.length ? { ...none, duplicates: p } : null; }
  if (kind === 'past') { const p = (v.pastDate ?? []).filter((x) => (x.project ?? '') === arg); return p.length ? { ...none, pastDate: p } : null; }
  if (kind === 'gone') { const g = (v.gone ?? []).filter((x) => String(x.row.id) === arg); return g.length ? { ...none, gone: g } : null; }
  return null;
}

// ---- B1: harvested suggestions (suggest_memories) ----

/**
 * Each harvest (one suggest_memories call) is a group of its own under Approvals: "Harvested from <app> · <label>", with
 * its waiting items as ordinary approval rows. They count in the needs-you badge like any other approval.
 */
export function harvestGroups(pending: Suggestion[], now: Date): InboxGroup[] {
  const batches = new Map<string, Suggestion[]>();
  for (const s of pending) if (s.harvest) batches.set(s.harvest.batch, [...(batches.get(s.harvest.batch) ?? []), s]);
  return [...batches].map(([batch, list]) => ({
    kind: 'harvest' as const,
    title: `Harvested from ${writerName(list[0]!.suggestedBy)} · ${list[0]!.harvest!.label}`,
    href: `/approvals?batch=${q(batch)}`,
    items: list.map((s): InboxItem => ({
      key: `suggestion:${s.id}`, kind: 'suggestion', id: s.id, href: `/approvals?id=${q(s.id)}`,
      title: `${s.kind === 'profile' ? 'Profile' : s.kind === 'summary' ? 'Status' : 'Decision'}: ${excerpt(s.content ?? '')}`,
      sub: html`${s.project ?? 'About you'} · ${timeAgo(s.suggestedAt, now)}`,
    })),
  }));
}

export function inboxModel(d: Deps): InboxModel {
  const now = d.now();
  const suggestions: InboxItem[] = d.service.pendingSuggestions().filter((s) => !s.harvest).map((s) => ({
    key: `suggestion:${s.id}`, kind: 'suggestion', id: s.id, href: `/approvals?id=${q(s.id)}`,
    title: `${{ add: 'Add to', update: 'Change', delete: 'Remove from' }[s.action]} your ${s.kind === 'profile' ? 'profile' : 'memory'}`,
    sub: html`${writerName(s.suggestedBy)} · ${timeAgo(s.suggestedAt, now)}`,
  }));
  const proposals: InboxItem[] = (d.skills?.pendingProposals() ?? []).map((p) => ({
    key: `proposal:${p.id}`, kind: 'proposal', id: p.id, href: `/approvals?proposal=${q(p.id)}`,
    title: p.skillId ? `Change to skill: ${p.name}` : `New skill: ${p.name}`,
    sub: html`${writerName(p.proposedBy)} · ${timeAgo(p.proposedAt, now)}`,
  }));
  // B2: tidy proposals from an assistant the owner started: explicit requests, so they count like approvals.
  const tidyProposals: InboxItem[] = tidyProposalRows(d.tidy, now);
  const disagree: InboxItem[] = d.service.openDisagreements().map((x) => ({
    key: `disagree:${x.id}`, kind: 'disagree', id: x.id, href: `/disagreements?id=${q(x.id)}`,
    title: excerpt(x.why), sub: d.service.projectNamed(x.factA.project ?? x.factB.project ?? '') || 'About you',
  }));
  const tidy = tidyRows(makeTidyItems(d)());
  const discussions: InboxItem[] = d.discussions.waitingOnOwner().map((w) => ({
    key: `discussion:${w.id}`, kind: 'discussion', id: w.id, href: `/discussions/${w.id}`, title: w.title, sub: 'Waiting for your reply',
  }));
  // Tidy-ups come last, under their own quiet heading: they do not need the owner, so they are not counted in `total`.
  const groups: InboxGroup[] = [
    { kind: 'approvals', title: 'Approvals', href: '/approvals', items: [...suggestions, ...proposals] },
    ...harvestGroups(d.service.pendingSuggestions(), now),
    { kind: 'tidyProposals', title: 'Tidy proposals', href: '/approvals', items: tidyProposals },
    { kind: 'disagree', title: 'Facts that disagree', href: '/disagreements', items: disagree },
    { kind: 'discussions', title: 'Discussions waiting', href: '/discussions', items: discussions },
    { kind: 'tidy', title: 'Tidy-ups', href: '/facts/tidy', items: tidy },
  ].filter((g) => g.items.length > 0) as InboxGroup[];
  const items = groups.flatMap((g) => g.items);
  return { groups, items, total: items.length - tidy.length, tidyCount: tidy.length };
}

/** What needs the owner, counted without the tidy scans: the one source for the badge, Home's "For you" and Settings. */
export function needsYouCounts(d: Pick<AppDeps, 'service' | 'discussions'> & Partial<Pick<AppDeps, 'skills' | 'tidy'>>): { approvals: number; disagreements: number; discussions: number; total: number } {
  // Tidy proposals (B2) are approvals too.
  const approvals = d.service.pendingSuggestions().length + (d.skills?.pendingProposals().length ?? 0) + (d.tidy?.pendingCount() ?? 0);
  const disagreements = d.service.openDisagreements().length;
  const discussions = d.discussions.waitingOnOwner().length;
  return { approvals, disagreements, discussions, total: approvals + disagreements + discussions };
}

/** The sidebar's number: the rows that need the owner (never the tidy-ups, and never a duplicate scan). */
export const inboxCount = (d: Pick<AppDeps, 'service' | 'discussions'> & Partial<Pick<AppDeps, 'skills' | 'tidy'>>): number => needsYouCounts(d).total;

// ---- B2: Tidy proposals (a block of its own) ----

/** One row per waiting tidy proposal, oldest first. */
function tidyProposalRows(tidy: AppDeps['tidy'] | undefined, now: Date): InboxItem[] {
  return (tidy?.pending() ?? []).map((p) => ({
    key: `tidyProposal:${p.id}`, kind: 'tidyProposal' as const, id: p.id, href: `/approvals?tidyproposal=${q(p.id)}`,
    title: tidyProposalTitle(p), sub: html`${writerName(p.proposedBy)} · ${timeAgo(p.proposedAt, now)}`,
  }));
}
