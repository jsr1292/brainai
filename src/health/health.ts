/**
 * Brain health (B1): three plain numbers, each 0–100 with its reasons and a link to fix each one. Computed from what
 * the server already knows; never stored.
 *   Up to date: the share of open projects whose status or roadmap changed in the last FRESH_DAYS days, with pages
 *     behind newer decisions counting against it.
 *   Ready: equal shares of checks — something in the profile; each open project has a status and a roadmap; each
 *     connected app runs the newest setup text; backups are healthy (when this install has backup jobs).
 *   Waiting on you: 100 less WAITING_STEP for each thing that needs the owner, never below 0. Tidy-up suggestions
 *     are left out: they are slow to work out, and they are suggestions, not things the owner must do.
 */
export const FRESH_DAYS = 30;
export const MAX_REASONS = 5;
export const WAITING_STEP = 10;

export interface Reason { text: string; href: string }
export interface Part { score: number; reasons: Reason[] }
export interface Health { upToDate: Part; ready: Part; waiting: Part }

export interface HealthInput {
  /** The open projects (on the go and also open): when their newest status or roadmap changed, and whether they have each. */
  projects: { name: string; lastUpdate: string | null; hasStatus: boolean; hasRoadmap: boolean }[];
  /** Pages flagged as behind newer decisions or changed facts. */
  outOfDatePages: { id: string; title: string }[];
  profileFacts: number;
  /** Connected apps and what each reports of the setup text: the newest, an older one, or none yet. */
  apps: { name: string; setup: 'current' | 'older' | 'unknown'; href: string }[];
  /** Null when this install has no backup jobs to check (the desktop app, work mode without them). */
  backups: { ok: boolean; problems: string[] } | null;
  waiting: {
    approvals: number; disagreements: number;
    overdue: { project: string; text: string; due: string }[];
    discussions: { id: string; title: string }[];
  };
}

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
const panel = (name: string) => `/?project=${encodeURIComponent(name)}#panel`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** At most MAX_REASONS, then one "and N more" pointing at `more`. */
function capped(reasons: Reason[], more: string): Reason[] {
  if (reasons.length <= MAX_REASONS) return reasons;
  return [...reasons.slice(0, MAX_REASONS), { text: `and ${reasons.length - MAX_REASONS} more`, href: more }];
}
/** 100 only when nothing is wrong: a part with something to fix never rounds up to it. */
const share = (good: number, total: number) => (good >= total ? 100 : Math.min(99, Math.round((100 * good) / total)));

export function brainHealth(input: HealthInput, now: Date): Health {
  // Up to date: never-updated projects first, then the oldest; then the pages.
  const age = (iso: string | null) => (iso === null ? Infinity : Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
  const stale = input.projects.filter((p) => age(p.lastUpdate) > FRESH_DAYS).sort((a, b) => age(b.lastUpdate) - age(a.lastUpdate) || a.name.localeCompare(b.name));
  const upToDate: Part = {
    score: share(input.projects.length - stale.length, input.projects.length + input.outOfDatePages.length),
    reasons: capped([
      ...stale.map((p) => ({ text: p.lastUpdate === null ? `${p.name} has no status yet` : `${p.name} was last updated ${age(p.lastUpdate)} days ago`, href: panel(p.name) })),
      ...input.outOfDatePages.map((pg) => ({ text: `Page "${pg.title}" may be out of date`, href: `/pages/${pg.id}` })),
    ], '/'),
  };

  // Ready: one check each; a failed one is a reason.
  const checks: { ok: boolean; reason: Reason }[] = [
    { ok: input.profileFacts > 0, reason: { text: 'Nothing about you yet: add a fact to your profile', href: '/facts?kind=profile' } },
    ...input.projects.map((p) => ({
      ok: p.hasStatus && p.hasRoadmap,
      reason: { text: `${p.name} has no ${!p.hasStatus && !p.hasRoadmap ? 'status or roadmap' : p.hasStatus ? 'roadmap' : 'status'}`, href: panel(p.name) },
    })),
    ...input.apps.map((a) => ({ ok: a.setup === 'current', reason: { text: a.setup === 'older' ? `${a.name} runs an older setup text` : `${a.name} hasn't reported its setup text yet`, href: a.href } })),
    ...(input.backups === null ? [] : [{ ok: input.backups.ok, reason: { text: `Backups: ${input.backups.problems[0] ?? 'not working'}`, href: '/settings#health' } }]),
  ];
  const ready: Part = { score: share(checks.filter((c) => c.ok).length, checks.length), reasons: capped(checks.filter((c) => !c.ok).map((c) => c.reason), '/settings#health') };

  // Waiting on you: the owner's own to-dos, most pressing first.
  const w = input.waiting;
  const items = w.approvals + w.disagreements + w.overdue.length + w.discussions.length;
  const waitingReasons: Reason[] = [
    ...(w.approvals > 0 ? [{ text: `${w.approvals} ${plural(w.approvals, 'change waits', 'changes wait')} for your approval`, href: '/approvals' }] : []),
    ...(w.disagreements > 0 ? [{ text: w.disagreements === 1 ? '2 facts disagree' : `${w.disagreements} pairs of facts disagree`, href: '/disagreements' }] : []),
    ...w.overdue.map((o) => ({ text: `${o.project}: "${o.text}" was due ${dayLabel(o.due)}`, href: panel(o.project) })),
    ...w.discussions.map((x) => ({ text: `${x.title} waits on you`, href: `/discussions/${x.id}` })),
  ];
  const waiting: Part = { score: Math.max(0, 100 - WAITING_STEP * items), reasons: capped(waitingReasons, '/') };

  return { upToDate, ready, waiting };
}

/** The reason brain health leads with: the lowest part's first, lowest first on a tie; `skip` leaves some out. */
export function topReason(h: Health, skip: (href: string) => boolean = () => false, under = 101): string | null {
  const parts = [h.upToDate, h.ready, h.waiting].filter((p) => p.score < under).sort((a, b) => a.score - b.score);
  for (const p of parts) {
    const r = p.reasons.find((x) => !skip(x.href));
    if (r) return r.text;
  }
  return null;
}
