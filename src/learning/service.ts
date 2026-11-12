/*
 * Where each project stands on the five areas, and what the owner has learned (spec
 * docs/superpowers/specs/2026-11-11-learning-layer-and-projects-page-design.md). "Work is safe" is read from the Mac's
 * folder report; the other four are set by assistants (or the owner) with a note. Nothing runs in the background:
 * everything is worked out when it is read.
 */
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { notPushed, type FolderMatch } from '../folders/match.js';
import { looksLikeInstruction } from '../memory/instructionLike.js';
import { looksLikeSecret } from '../memory/secrets.js';
import { isLifeArea } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { LearningStore, type CheckRow } from './store.js';
import {
  CHECK_AREAS, LESSON_LEVELS, MAX_NOTE, MAX_TOPIC, SNOOZE_DAYS, UPKEEP_DAYS,
  type AreaState, type CheckArea, type CheckStatus, type HandbookTopic, type LessonLevel, type ShownStatus,
} from './types.js';

const DAY_MS = 86_400_000;
/** The handbook's own project: it holds what was learned, so it is never checked against the five areas itself. */
export const HANDBOOK_PROJECT = 'developer-handbook';
/** A folder report older than this says nothing about work being safe now: unknown, never done. */
const REPORT_FRESH_DAYS = 7;
/** How bad a status is, for "the worse of the report and the hand status wins". */
const SEVERITY: Record<CheckStatus, number> = { not_needed: 0, done: 1, look: 2, todo: 3 };

export class LearningError extends Error {
  constructor(readonly code: 'invalid' | 'not_found', message: string) { super(message); }
}

/** A title as a stable key: lower case, no accents, words joined by "-". */
export const topicSlug = (title: string): string =>
  title.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function checkText(what: string, text: string, max: number): void {
  if (text.length > max) throw new LearningError('invalid', `The ${what} is at most ${max} characters; this one has ${text.length}.`);
  // Notes and titles are shown to every assistant in project_brief: the full check, as for memories, and no secrets.
  const reason = looksLikeInstruction(text);
  if (reason) throw new LearningError('invalid', `The ${what} reads like an instruction to AI assistants (${reason}). Describe it plainly.`);
  const secret = looksLikeSecret(text);
  if (secret) throw new LearningError('invalid', `The ${what} looks like it holds a secret (${secret}): never save passwords, keys or tokens.`);
}

export class LearningService {
  private readonly store: LearningStore;

  constructor(
    private db: DB,
    private now: Clock,
    private folders: { match(): FolderMatch },
    private projects: { get(name: string): Project | undefined; named(name: string): string; list?(): Project[] },
  ) {
    this.store = new LearningStore(db);
  }

  /** Open or parked projects that are not an area of life (finances, health…); ideas and finished ones have none. */
  inScope(p: Project): boolean {
    return (p.state === 'open' || p.state === 'parked') && !isLifeArea(p) && p.name !== HANDBOOK_PROJECT;
  }

  private project(name: string): Project | undefined {
    return this.projects.get(this.projects.named(name));
  }

  /** What the folder report says about work being safe, or null when the project has no reported folder or the report is stale. */
  private reported(name: string, folders: FolderMatch = this.folders.match()): CheckStatus | null {
    const f = folders.byProject.get(name);
    if (!f) return null;
    const at = f.reportedAt ?? folders.receivedAt;
    if (at && this.now().getTime() - Date.parse(at) > REPORT_FRESH_DAYS * DAY_MS) return null;
    if (!f.git) return 'todo';
    return notPushed(f, this.now()) ? 'look' : 'done';
  }

  /** The five areas, in learning order; null for a project out of scope or not in the registry. */
  areas(name: string, folders?: FolderMatch): AreaState[] | null {
    const p = this.project(name);
    if (!p || !this.inScope(p)) return null;
    const now = this.now();
    const hand = new Map(this.store.checks(p.name).map((r) => [r.area, r]));
    const snoozes = this.store.snoozes(p.name);
    return CHECK_AREAS.map((area): AreaState => {
      const h = hand.get(area);
      const until = snoozes.get(area);
      const snoozedUntil = until && until > now.toISOString() ? until : null;
      const base = { area, snoozedUntil, automatic: h?.automatic ?? false };
      const fromHand = (r: CheckRow, status: ShownStatus = r.status): AreaState => ({ ...base, status, note: r.note, setBy: r.setBy, setAt: r.setAt, source: 'hand' });
      if (area === 'safe') {
        const report = this.reported(p.name, folders);
        // A hand status holds until the report is worse than when it was set (a folder kept out of git on purpose stays
        // done); with no report at the time, worse than the hand status itself. "Not needed" always holds.
        const baseline = h?.reportAtSet ?? h?.status;
        if (h && (h.status === 'not_needed' || report === null || SEVERITY[report] <= SEVERITY[baseline!])) return fromHand(h);
        if (report !== null) return { ...base, status: report, note: null, setBy: null, setAt: null, source: 'report' };
        return { ...base, status: 'unknown', note: null, setBy: null, setAt: null, source: 'none' };
      }
      if (!h) return { ...base, status: 'todo', note: null, setBy: null, setAt: null, source: 'none' };
      const stale = area === 'upkeep' && h.status === 'done' && !h.automatic && now.getTime() - Date.parse(h.setAt) > UPKEEP_DAYS * DAY_MS;
      return fromHand(h, stale ? 'look' : h.status);
    });
  }

  set(name: string, area: CheckArea, s: { status: CheckStatus; note?: string; automatic?: boolean }, by: string): AreaState {
    const p = this.project(name);
    if (!p) throw new LearningError('not_found', `There is no project ${JSON.stringify(name)}.`);
    if (!this.inScope(p)) throw new LearningError('invalid', `${p.name} has no five areas: only open or parked projects that are not an area of life do.`);
    const note = s.note?.trim() || null;
    if (note !== null) checkText('note', note, MAX_NOTE);
    if (s.status === 'not_needed' && note === null) throw new LearningError('invalid', 'Say in the note why this area is not needed for this project (the reason).');
    const old = this.store.checks(p.name).find((r) => r.area === area);
    this.store.put({
      project: p.name, area, status: s.status, note, automatic: s.automatic ?? old?.automatic ?? false, setBy: by, setAt: this.now().toISOString(),
      reportAtSet: area === 'safe' ? this.reported(p.name) : null,
    });
    return this.areas(p.name)!.find((a) => a.area === area)!;
  }

  /** "Not now" for an area of a project: it is not suggested again for SNOOZE_DAYS. Returns until when. */
  notNow(name: string, area: CheckArea, by: string): string {
    const p = this.project(name);
    if (!p) throw new LearningError('not_found', `There is no project ${JSON.stringify(name)}.`);
    const until = new Date(this.now().getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
    this.store.snooze(p.name, area, until, by);
    return until;
  }

  /** The area to bring up next for a project: the first not started or worth-a-look one in learning order, not snoozed. */
  nextArea(name: string, folders?: FolderMatch): CheckArea | null {
    return this.areas(name, folders)?.find((a) => (a.status === 'todo' || a.status === 'look') && a.snoozedUntil === null)?.area ?? null;
  }

  /**
   * Whether the project's work exists only on the Mac, by the folder report: the one mark the home page shows. A project
   * without five areas (done, parked as an area of life, an idea) still gets it for unpushed work: finished work that
   * exists only on the Mac is exactly what must not go unseen.
   */
  safeWarning(name: string, folders?: FolderMatch): boolean {
    const areas = this.areas(name, folders);
    if (areas === null) return this.project(name) !== undefined && this.reported(this.project(name)!.name, folders) === 'look';
    const safe = areas.find((a) => a.area === 'safe')!;
    return safe.source === 'report' && (safe.status === 'look' || safe.status === 'todo');
  }

  recordLesson(t: { title: string; level: LessonLevel; project?: string; pageId?: string }, by: string): HandbookTopic {
    void by;
    const title = t.title.trim();
    checkText('topic title', title, MAX_TOPIC);
    const slug = topicSlug(title);
    if (slug === '') throw new LearningError('invalid', 'Give the topic a title with words in it.');
    const project = t.project === undefined ? undefined : this.projects.named(t.project);
    const old = this.store.topics().find((x) => x.slug === slug);
    const level = old && LESSON_LEVELS.indexOf(old.level) > LESSON_LEVELS.indexOf(t.level) ? old.level : t.level;
    const projects = [...(old?.projects ?? [])];
    if (project !== undefined && !projects.includes(project)) projects.push(project);
    const topic: HandbookTopic = { slug, title: old?.title ?? title, level, pageId: t.pageId ?? old?.pageId ?? null, projects, updatedAt: this.now().toISOString() };
    this.store.putTopic(topic);
    return topic;
  }

  /** Handbook topics, by title; with `project`, only those applied on it. */
  topics(project?: string): HandbookTopic[] {
    const all = this.store.topics();
    if (project === undefined) return all;
    const name = this.projects.named(project);
    return all.filter((t) => t.projects.includes(name));
  }

  moveProject(from: string, to: string): void {
    this.store.moveProject(from, to);
  }

  /** Every project that has the five areas, by name. */
  scopeNames(): string[] {
    return (this.projects.list?.() ?? []).filter((p) => this.inScope(p)).map((p) => p.name);
  }

  /** Records, for the week starting `week` (its Monday), how many in-scope projects stand where in each area; once per week, replaced on a later view. */
  snapshot(week: string): void {
    const counts = new Map<string, number>();
    for (const name of this.scopeNames()) {
      for (const a of this.areas(name) ?? []) counts.set(`${a.area}\n${a.status}`, (counts.get(`${a.area}\n${a.status}`) ?? 0) + 1);
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM map_snapshots WHERE week = ?').run(week);
      const put = this.db.prepare('INSERT INTO map_snapshots(week, area, status, count) VALUES (?, ?, ?, ?)');
      for (const [k, n] of counts) { const [area, status] = k.split('\n'); put.run(week, area, status, n); }
    })();
  }

  /** The recorded weeks, newest `weeks` of them, oldest first. */
  history(weeks: number): { week: string; area: CheckArea; status: ShownStatus; count: number }[] {
    const kept = (this.db.prepare('SELECT DISTINCT week FROM map_snapshots ORDER BY week DESC LIMIT ?').all(weeks) as { week: string }[]).map((r) => r.week);
    if (kept.length === 0) return [];
    return this.db.prepare(`SELECT week, area, status, count FROM map_snapshots WHERE week >= ? ORDER BY week, area, status`).all(kept.at(-1)!) as
      { week: string; area: CheckArea; status: ShownStatus; count: number }[];
  }
}
