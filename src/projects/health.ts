/**
 * A project's computed health label. Never set by an assistant or the owner: it is worked out from the roadmap, the
 * latest status, the project's age and the Mac's folder report, and only for open projects (idea, parked, done and
 * archived have no label). Pure: the service gathers the inputs.
 */
import type { Roadmap } from '../memory/roadmap.js';
import { localDay } from '../timezone.js';
import type { ProjectStateName } from './types.js';

/** A dated "Waiting on you" item counts when it is late or due within this many days of today (inclusive). */
export const NEEDS_YOU_DAYS = 3;
/** A project with no Done step and no status for more than this many days is stuck (exactly this many is not). */
export const STUCK_DAYS = 14;

export type HealthState = 'needs_you' | 'at_risk' | 'stuck' | 'on_track';
/** Priority order when several apply. */
export const HEALTH_ORDER: readonly Exclude<HealthState, 'on_track'>[] = ['needs_you', 'at_risk', 'stuck'];

export type HealthReason =
  /** `days`: whole days from today to the due date; negative when it is late. */
  | { kind: 'needs_you'; text: string; due: string; days: number }
  /** Commits only on the Mac (`count`), or when there are none, uncommitted files older than a day (`uncommitted`). */
  | { kind: 'at_risk'; count: number; uncommitted: number }
  /** `days`: since the newest of the last dated Done step, the latest status, or the project's creation. */
  | { kind: 'stuck'; days: number; next: string };
export interface Health { state: HealthState; reasons: HealthReason[] }

export interface HealthInput {
  state: ProjectStateName;
  roadmap: Roadmap | null;
  /** When the project's latest status (kind summary) was last changed, or null when it has none. */
  statusAt: string | null;
  createdAt: string;
  /** An area of life (finances, health…): it can wait on the owner but is never stuck. */
  lifeArea?: boolean;
  /** Work only on the Mac, from a report the caller trusts (fresh); null when there is none or it is not fresh. */
  notPushed: { count: number; uncommitted: number } | null;
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** `today` is the owner's calendar day (YYYY-MM-DD); instants are turned into days in the owner's zone. */
export function projectHealth(input: HealthInput, today: string): Health | null {
  if (input.state !== 'open') return null;
  const reasons: HealthReason[] = [];
  const r = input.roadmap;

  for (const w of r?.waiting ?? []) {
    if (w.due === null) continue;
    const days = daysBetween(today, w.due);
    if (days <= NEEDS_YOU_DAYS) reasons.push({ kind: 'needs_you', text: w.text, due: w.due, days });
  }

  if (input.notPushed) reasons.push({ kind: 'at_risk', count: input.notPushed.count, uncommitted: input.notPushed.uncommitted });

  const next = r?.now ?? r?.nextSteps[0] ?? r?.next ?? null;
  if (next !== null && !input.lifeArea) {
    // The project's own creation counts as movement: with no Done step and no status, its age is how long it has been still.
    const moves = (r?.done ?? []).map((d) => d.date).filter((d): d is string => d !== null);
    moves.push(localDay(new Date(input.createdAt)));
    if (input.statusAt !== null) moves.push(localDay(new Date(input.statusAt)));
    const last = moves.reduce((a, b) => (a > b ? a : b));
    const days = daysBetween(last, today);
    if (days > STUCK_DAYS) reasons.push({ kind: 'stuck', days, next });
  }

  const order = (x: HealthReason) => HEALTH_ORDER.indexOf(x.kind);
  reasons.sort((a, b) => order(a) - order(b));
  return { state: reasons[0]?.kind ?? 'on_track', reasons };
}

/** How many items wait on the owner by the needs_you rule: the Monday card's second number. */
export const waitingNow = (h: Health | null): number => h?.reasons.filter((x) => x.kind === 'needs_you').length ?? 0;

/** One reason as a plain English sentence, for the assistants' tools (screens word it from the data, in the owner's language). */
export function reasonText(r: HealthReason): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  switch (r.kind) {
    case 'needs_you': return r.days < 0 ? `Waiting on the owner and late: "${r.text}" was due ${r.due}.` : `Waiting on the owner: "${r.text}" is due ${r.due}.`;
    case 'at_risk': return r.count > 0 ? `${plural(r.count, 'commit is', 'commits are')} only on the owner's Mac.` : `${plural(r.uncommitted, 'uncommitted file is', 'uncommitted files are')} only on the owner's Mac.`;
    case 'stuck': return `No step finished and no status saved for ${r.days} days, with "${r.next}" still to do.`;
  }
}

/** The shape the assistants' tools return: the state and its reasons as short sentences. */
export const healthJson = (h: Health): { state: HealthState; reasons: string[] } => ({ state: h.state, reasons: h.reasons.map(reasonText) });
