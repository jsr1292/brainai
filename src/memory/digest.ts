import { projectBrief } from './brief.js';
import type { MemoryStore } from './store.js';
import { OWNER_LABEL, type Memory } from './types.js';
import { zoneOffsetMs } from '../timezone.js';

/** Tools that read memory; the digest counts them as lookups. */
export const LOOKUP_TOOLS: readonly string[] = ['load_profile', 'recall', 'project_brief', 'list_projects'];
/** An assistant with at least this many lookups and no saves in a week is flagged: it reads but doesn't write. */
export const LOOKUPS_WITHOUT_SAVES = 5;

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface Week {
  /** The Monday, as a date in the owner's time zone (YYYY-MM-DD). */
  monday: string;
  start: Date;
  end: Date;
}

const offset = zoneOffsetMs;

/** The instant of 00:00 in the owner's time zone on the calendar day `day` (milliseconds of a UTC midnight). */
function midnight(day: number): Date {
  const first = day - offset(day);
  return new Date(day - offset(first));
}

const ymd = (day: number) => new Date(day).toISOString().slice(0, 10);

function weekOfDay(day: number): Week {
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
  return { monday: ymd(monday), start: midnight(monday), end: midnight(monday + 7 * DAY_MS) };
}

/** The week that `now` falls in, in the owner's time zone (src/timezone.ts). */
export function weekOf(now: Date): Week {
  const local = new Date(now.getTime() + offset(now.getTime()));
  return weekOfDay(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** The week containing the date YYYY-MM-DD, or undefined when it is not a real date. */
export function weekContaining(date: string): Week | undefined {
  const m = DATE_RE.exec(date);
  if (!m) return undefined;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (ymd(day) !== date) return undefined;
  return weekOfDay(day);
}

/** The Monday `weeks` weeks before (negative) or after `monday`. */
export const shiftWeek = (monday: string, weeks: number): string => ymd(Date.parse(monday) + weeks * 7 * DAY_MS);

export interface Tally { saved: number; changed: number; deleted: number }
export type WriterTally = Tally & { name: string; lookups: number };
export type ProjectTally = Tally & { project: string; isNew: boolean; latestStatus: Memory | null };
export type Flag =
  | { kind: 'waiting'; count: number }
  | { kind: 'connected'; client: string; at: string; times: number }
  | { kind: 'no-saves'; client: string; lookups: number }
  | { kind: 'deleted-by-ai'; by: string; at: string; memory: Memory }
  | { kind: 'changed-others'; by: string; author: string; at: string; memory: Memory }
  /** An assistant replaced a fact someone else wrote (section 16): it left search, as a deletion would. */
  | { kind: 'replaced-others'; by: string; author: string; at: string; memory: Memory }
  | { kind: 'no-project'; memory: Memory };

export interface Digest {
  week: Week;
  totals: Tally;
  /** Busiest first. */
  writers: WriterTally[];
  /** Busiest first. */
  projects: ProjectTally[];
  /** Things that may need the owner, in the order above. */
  flags: Flag[];
  /** When lookups started being counted (null: not yet); weeks before it show no lookups. */
  lookupsSince: string | null;
}

/** One flag per client that connected, with its latest connection: re-logins are not news. */
function connections(grants: { clientName: string; createdAt: string }[]): Flag[] {
  const by = new Map<string, { kind: 'connected'; client: string; at: string; times: number }>();
  for (const g of [...grants].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const seen = by.get(g.clientName);
    by.set(g.clientName, { kind: 'connected', client: g.clientName, at: g.createdAt, times: (seen?.times ?? 0) + 1 });
  }
  return [...by.values()];
}

const zero = (): Tally => ({ saved: 0, changed: 0, deleted: 0 });
const writes = (t: Tally) => t.saved + t.changed + t.deleted;

/**
 * What happened in memory during `week`. Profile edits and deletions by an AI are not flagged: they only happen
 * once the owner approved them. `waiting` is the number of suggestions waiting now.
 */
export function weeklyDigest(store: MemoryStore, week: Week, extra: { grants: { clientName: string; createdAt: string }[]; waiting: number }): Digest {
  const totals = zero();
  const writers = new Map<string, WriterTally>();
  const projects = new Map<string, Tally>();
  const writer = (name: string) => writers.get(name) ?? writers.set(name, { name, ...zero(), lookups: 0 }).get(name)!;
  const project = (p: string | null) => (p === null ? zero() : projects.get(p) ?? projects.set(p, zero()).get(p)!);
  const count = (what: keyof Tally, by: string, p: string | null) => {
    totals[what]++; writer(by)[what]++; project(p)[what]++;
  };

  const created = store.createdBetween(week.start, week.end);
  for (const m of created) count('saved', m.createdBy, m.project);

  const deleted: Flag[] = [];
  const changedOthers = new Map<string, Flag & { kind: 'changed-others' }>();
  for (const h of store.historyBetween(week.start, week.end)) {
    const m = store.get(h.memoryId)!;
    count(h.action === 'delete' ? 'deleted' : 'changed', h.changedBy, m.project);
    // Profile changes go through the owner; roadmaps are kept current by whichever assistant is working.
    if (h.changedBy === OWNER_LABEL || m.kind === 'profile' || m.kind === 'roadmap') continue;
    if (h.action === 'delete') deleted.push({ kind: 'deleted-by-ai', by: h.changedBy, at: h.changedAt, memory: m });
    else if (h.action === 'update' && m.createdBy !== h.changedBy) {
      changedOthers.set(`${m.id} ${h.changedBy}`, { kind: 'changed-others', by: h.changedBy, author: m.createdBy, at: h.changedAt, memory: m });
    }
  }

  // Replacing and bringing back count as Changed for who did them, under the old fact's project.
  const replacedOthers = new Map<string, Flag & { kind: 'replaced-others' }>();
  const startIso = week.start.toISOString();
  const endIso = week.end.toISOString();
  for (const row of store.supersessions.between(week.start, week.end)) {
    const old = store.get(row.oldId)!;
    if (row.createdAt >= startIso && row.createdAt < endIso) {
      count('changed', row.createdBy, old.project);
      // One already undone is nothing to look at: its page has nothing left to undo.
      if (row.undoneAt === null && row.createdBy !== OWNER_LABEL && old.createdBy !== row.createdBy && !replacedOthers.has(`${old.id} ${row.createdBy}`)) {
        replacedOthers.set(`${old.id} ${row.createdBy}`, { kind: 'replaced-others', by: row.createdBy, author: old.createdBy, at: row.createdAt, memory: old });
      }
    }
    if (row.undoneAt !== null && row.undoneBy !== null && row.undoneAt >= startIso && row.undoneAt < endIso) count('changed', row.undoneBy, old.project);
  }

  for (const c of store.toolCalls(week.start, week.end)) {
    if (LOOKUP_TOOLS.includes(c.tool)) writer(c.client).lookups += c.count;
  }

  const firstSeen = store.projectsFirstSeen();
  const inWeek = (iso: string) => iso >= week.start.toISOString() && iso < week.end.toISOString();
  const busiest = <T extends Tally>(a: T, b: T) => writes(b) - writes(a);

  const flags: Flag[] = [
    ...(extra.waiting > 0 ? [{ kind: 'waiting', count: extra.waiting } as const] : []),
    ...connections(extra.grants.filter((g) => inWeek(g.createdAt))),
    ...[...writers.values()]
      .filter((w) => w.name !== OWNER_LABEL && w.lookups >= LOOKUPS_WITHOUT_SAVES && w.saved + w.changed === 0)
      .sort((a, b) => b.lookups - a.lookups)
      .map((w): Flag => ({ kind: 'no-saves', client: w.name, lookups: w.lookups })),
    ...deleted,
    ...replacedOthers.values(),
    ...changedOthers.values(),
    ...created.filter((m) => m.project === null && m.kind !== 'profile' && !m.deletedAt).map((m): Flag => ({ kind: 'no-project', memory: m })),
  ];

  return {
    week,
    totals,
    writers: [...writers.values()].sort((a, b) =>
      writes(b) + b.lookups - writes(a) - a.lookups || busiest(a, b) || a.name.localeCompare(b.name)),
    projects: [...projects].map(([p, t]): ProjectTally => ({
      project: p, ...t, isNew: inWeek(firstSeen.get(p) ?? ''), latestStatus: projectBrief(store, p)?.statuses[0] ?? null,
    })).sort((a, b) => busiest(a, b) || a.project.localeCompare(b.project)),
    flags,
    lookupsSince: store.firstToolCallAt(),
  };
}
