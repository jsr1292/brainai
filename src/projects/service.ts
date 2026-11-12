import type { AreaState, HandbookTopic } from '../learning/types.js';
import type { PageHeader } from '../pages/types.js';
import { isStatus } from '../memory/brief.js';
import { checkRoadmap, formatRoadmap, parseRoadmap, type Roadmap } from '../memory/roadmap.js';
import { notPushed, type FolderMatch } from '../folders/match.js';
import type { FolderState } from '../folders/report.js';
import { LIST_CHANGED, MAX_ROADMAP, QUIET_DAYS, type MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { Supersession } from '../memory/supersessions.js';
import type { Memory } from '../memory/types.js';
import type { Disagreement } from '../memory/disagreements.js';
import { localDay, shortDay } from '../timezone.js';
import type { ProjectStore } from './store.js';
import { MAX_PINNED, ProjectError, type Area, type Project, type ProjectStateName } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An item due within this many days is "soon". */
export const SOON_DAYS = 7;
/** An open project quiet for this long gets a "park it?" suggestion. */
export const PARK_SUGGESTION_DAYS = 21;
export const SNOOZE_DAYS = 30;
export const MAX_SUGGESTIONS = 3;
const MAX_IDEA_NAME = 40;
const OWNER = { type: 'owner' } as const;

export interface ProjectCard {
  project: Project;
  roadmap: Roadmap | null;
  next: string | null;
  lastTouched: string;
  /** Days since the last change, only when the project is quiet (QUIET_DAYS or more). */
  quietDays: number | null;
  waiting: number;
  late: number;
  soonestDue: string | null;
  /** Parked or done, yet something changed since the owner set that. */
  newActivity: boolean;
  /** The Mac's latest report shows work in its folder that isn't on any remote. */
  notPushed: boolean;
  /** Its state dot on the Projects page: wait (something waits on the owner), on (being worked on), quiet. */
  dot: Dot;
  /** The learning layer's "work is safe" warning (not pushed, or not in git): the one mark the home page shows. */
  safeWarning: boolean;
}
export type Dot = 'on' | 'wait' | 'quiet';
/** One area's part of the Projects page: its live projects as tiles, the rest folded (spec 2026-11-11). */
export interface AreaSection {
  area: Area | null; live: ProjectCard[]; quiet: ProjectCard[]; ideas: ProjectCard[]; parked: ProjectCard[]; done: ProjectCard[];
  /** Personal only: the areas of life (finances, health…), folded into one line. */
  lifeAreas: ProjectCard[];
}
/** The order of the Projects page's sections; projects with no area come last, as Unsorted. */
export const SECTION_ORDER: (Area | null)[] = ['apps', 'tools', 'home', 'work', 'personal', null];
export interface WaitingRow { index: number; text: string; due: string | null; late: boolean; soon: boolean }
export interface DoneRow { index: number; text: string; date: string | null }
/** `needsYou`: an open round every assistant has answered, so it waits on the owner. */
export interface PanelDiscussion { id: string; title: string; open: boolean; needsYou: boolean; label: string }
export interface ProjectDetail {
  card: ProjectCard; leftOff: Memory | null; waiting: WaitingRow[]; doneToday: DoneRow[]; nextSteps: string[]; continueCommand: string;
  /**
   * The newest decisions (statuses and the roadmap left out), and how many current facts the project holds in all.
   * `replaces`: how many facts each of `newest` replaced directly (section 16), for its "replaces N" tag.
   */
  facts: { total: number; newest: Memory[]; replaces: Record<string, number> };
  /** Its replaced facts (aliases followed, deleted ones left out), newest replacement first, at most PANEL_REPLACED. */
  replaced: { rows: ReplacedRow[]; total: number };
  /** The project's discussions, open ones first, at most PANEL_DISCUSSIONS. */
  discussions: PanelDiscussion[];
  /** Every discussion of the project (the list caps at PANEL_DISCUSSIONS; the jump row counts them all). */
  discussionsTotal: number;
  /** The project's pages, by title, each marked when it may be out of date. */
  pages: { id: string; title: string; mayBeOutOfDate: boolean }[];
  /** The project's folder in the Mac's latest report, if one matched. */
  folder: FolderState | null;
  /** B1: pairs of its facts an assistant flagged as disagreeing, not settled yet, newest first. */
  disagreements: (Disagreement & { factA: Memory; factB: Memory })[];
  /** The five areas (null for a project without them: an idea, a finished one, an area of life). */
  areas: AreaState[] | null;
  /** The owner's handbook topics applied on this project. */
  handbook: HandbookTopic[];
}
/** What the panel needs from discussions: the owner's list of every discussion. */
/** What the panel needs from pages: a project's live pages, and which of them may be out of date. */
export interface PageList { forProject(name: string): PageHeader[]; flaggedIds?(ps: PageHeader[]): Set<string> }
export interface DiscussionList { ownerList(): { id: string; title: string; project: string | null; round: number; closed: boolean; waitingFor: string[]; closedAt: string | null }[] }
export const PANEL_FACTS = 3;
/** The Replaced fold lists at most this many, then "All N replaced facts →" (calm rule: every list has a hard cap). */
export const PANEL_REPLACED = 10;
/** One replaced fact in the project panel's fold: what replaced it, and the current fact at the end of its chain. */
export interface ReplacedRow { row: Supersession; old: Memory; end: Memory | null; endId: string; endDeletedAt: string | null; steps: number }
export const PANEL_DISCUSSIONS = 3;
export interface HomeSuggestion { project: string; kind: 'pin-late' | 'park-quiet' | 'reopen-active'; text: string }
/** What the home screen needs from the Mac's folder report. */
export interface FolderSource { match(): FolderMatch }
export interface Home {
  /** The Projects page by area (spec 2026-11-11); the fields below stay for the graph and older readers. */
  sections: AreaSection[];
  onTheGo: ProjectCard[];
  open: ProjectCard[];
  /** Open projects with no change for QUIET_DAYS or more, folded away so Also open stays short. */
  quiet: ProjectCard[];
  ideas: ProjectCard[];
  parked: ProjectCard[];
  done: ProjectCard[];
  personal: ProjectCard[];
  suggestions: HomeSuggestion[];
  /** Folders in the latest report that no project matched ("Not in the brain yet"), and where the report came from. */
  folders: { unmatched: FolderState[]; receivedAt: string | null; device: string | null };
}

/** "Today", late and Done dates follow the owner's calendar, not UTC (src/timezone.ts). */
const day = localDay;
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);
const newestFirst = (a: ProjectCard, b: ProjectCard) => b.lastTouched.localeCompare(a.lastTouched);
const DUE_IN_TEXT = /\s*\(by (\d{4}-\d{2}-\d{2})\)\s*$/i;

/**
 * A Personal project that isn't on the go is an area of life (finances, health…), not a project: folded away on the
 * home, and never nudged or named in a weekly review.
 */
export const isLifeArea = (p: Project | undefined): boolean => p !== undefined && p.area === 'personal' && p.pinnedAt === null;

/** No registry row, or one nobody set anything on: open, not on the go, no one-liner, folder, link or area. */
export const nothingSet = (p: Project | undefined): boolean => p === undefined
  || (p.state === 'open' && p.pinnedAt === null && p.oneLiner === null && p.folder === null && p.url === null && p.area === null);

/** A folder name as one shell word: quoted when it has anything beyond letters, digits, dots, hyphens and underscores. */
/** A folder as one shell word: plain names as they are, anything else single-quoted with its quotes escaped. */
export const shellWord = (folder: string): string => (/^[A-Za-z0-9._-]+$/.test(folder) ? folder : `'${folder.replace(/'/g, `'\\''`)}'`);

/** A project name from free text: "Cámara de fotos!" → "camara-de-fotos", at most 40 characters, cut at a hyphen. */
export function ideaName(text: string): string {
  let name = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (name.length > MAX_IDEA_NAME) {
    name = name.slice(0, MAX_IDEA_NAME);
    const cut = name.lastIndexOf('-');
    if (cut >= 10) name = name.slice(0, cut);
    name = name.replace(/-+$/, '');
  }
  return name;
}

/** The projects home: the registry joined with roadmaps and memories, and the owner's actions on it. */
export class ProjectsService {
  constructor(private registry: ProjectStore, private memories: MemoryService, private store: MemoryStore, private discussions?: DiscussionList, private pages?: PageList, private folders?: FolderSource,
    private learning?: { safeWarning(name: string, folders?: FolderMatch): boolean; areas?(name: string, folders?: FolderMatch): AreaState[] | null; topics?(project: string): HandbookTopic[] }) {}

  /** Projects something waits on the owner for: a held save or suggestion filed under them, or a discussion round they must answer. */
  private needingOwner(): Set<string> {
    const out = new Set<string>();
    for (const sg of this.memories.pendingSuggestions()) if (sg.project) out.add(this.memories.projectNamed(sg.project));
    for (const d of this.discussions?.ownerList() ?? []) if (!d.closed && d.waitingFor.length === 0 && d.project) out.add(this.memories.projectNamed(d.project));
    return out;
  }

  /** The newest change to the project's facts, or its folder's last commit on the Mac when that is newer. */
  private lastTouched(p: Project, folders?: FolderMatch): string {
    const facts = this.store.newestChange(p.name) ?? p.updatedAt;
    const commit = folders?.byProject.get(p.name)?.lastCommit;
    return commit && new Date(commit).toISOString() > facts ? new Date(commit).toISOString() : facts;
  }

  /** The newest change by an assistant: the owner's own ticks are not "new activity" on a parked project. */
  private lastAiChange(p: Project): string | undefined {
    return this.store.newestChange(p.name, 'owner');
  }

  /** When the owner last dealt with this project's state: setting it, or "Not now" on a suggestion about it. */
  private acknowledged(p: Project): string {
    const snoozedAt = p.snoozedUntil === null ? '' : new Date(Date.parse(p.snoozedUntil) - SNOOZE_DAYS * DAY_MS).toISOString();
    return snoozedAt > p.stateChangedAt ? snoozedAt : p.stateChangedAt;
  }

  /** A row with nothing behind it: open, no live memories, and nothing the owner or an assistant set on it. */
  private isEmpty(p: Project): boolean {
    return nothingSet(p) && this.store.list({ project: p.name, limit: 1, replaced: 'include' }).length === 0;
  }

  private match(): FolderMatch {
    return this.folders?.match() ?? { byProject: new Map(), unmatched: [], receivedAt: null, device: null };
  }

  private card(p: Project, now: Date, folders: FolderMatch = this.match(), owner: Set<string> = this.needingOwner()): ProjectCard {
    const memory = this.memories.roadmapOf(p.name);
    const roadmap = memory ? parseRoadmap(memory.content) : null;
    const lastTouched = this.lastTouched(p, folders);
    const days = Math.floor((now.getTime() - Date.parse(lastTouched)) / DAY_MS);
    const today = day(now);
    // A done or archived project has nothing left: no waiting count, no late chip (as in What's left).
    const finished = p.state === 'done' || p.state === 'archived';
    const waiting = finished ? [] : roadmap?.waiting ?? [];
    const dues = waiting.map((w) => w.due).filter((d): d is string => d !== null).sort();
    return {
      project: p,
      roadmap,
      // What is being done comes first: the roadmap's Now, else its first Next step.
      next: roadmap?.now ?? roadmap?.nextSteps[0] ?? null,
      lastTouched,
      quietDays: days >= QUIET_DAYS ? days : null,
      waiting: waiting.length,
      late: dues.filter((d) => d < today).length,
      soonestDue: dues[0] ?? null,
      newActivity: (p.state === 'parked' || p.state === 'done') && (this.lastAiChange(p) ?? '') > this.acknowledged(p),
      // Done projects too: finished work that exists only on the Mac is exactly what must not go unseen.
      notPushed: folders.byProject.has(p.name) && notPushed(folders.byProject.get(p.name)!, now),
      dot: waiting.length > 0 || owner.has(p.name) ? 'wait' : p.state === 'open' && (p.pinnedAt !== null || days < QUIET_DAYS) ? 'on' : 'quiet',
      safeWarning: this.learning?.safeWarning(p.name, folders) ?? false,
    };
  }

  /** `holdBackPark`: projects whose "park it?" suggestion waits while the Monday line already says they went quiet. */
  home(now: Date, opts: { holdBackPark?: ReadonlySet<string> } = {}): Home {
    const folders = this.match();
    const owner = this.needingOwner();
    const cards = this.registry.list().filter((p) => !this.isEmpty(p)).map((p) => this.card(p, now, folders, owner));
    const by = (f: (c: ProjectCard) => boolean) => cards.filter(f).sort(newestFirst);
    const personal = (c: ProjectCard) => isLifeArea(c.project);
    const pinnedFirst = (a: ProjectCard, b: ProjectCard) =>
      (a.project.pinnedAt === null ? 1 : 0) - (b.project.pinnedAt === null ? 1 : 0) || (a.project.pinnedAt ?? '').localeCompare(b.project.pinnedAt ?? '') || newestFirst(a, b);
    const sections = SECTION_ORDER.map((area): AreaSection => {
      const mine = cards.filter((c) => c.project.area === area);
      const open = (c: ProjectCard) => c.project.state === 'open' && !personal(c);
      return {
        area,
        live: mine.filter((c) => open(c) && (c.project.pinnedAt !== null || c.quietDays === null)).sort(pinnedFirst),
        quiet: mine.filter((c) => open(c) && c.project.pinnedAt === null && c.quietDays !== null).sort(newestFirst),
        ideas: mine.filter((c) => c.project.state === 'idea').sort(newestFirst),
        parked: mine.filter((c) => c.project.state === 'parked' && !personal(c)).sort(newestFirst),
        done: mine.filter((c) => c.project.state === 'done' || c.project.state === 'archived').sort(newestFirst),
        lifeAreas: mine.filter((c) => (c.project.state === 'open' || c.project.state === 'parked') && personal(c)).sort(newestFirst),
      };
    }).filter((x) => x.live.length + x.quiet.length + x.ideas.length + x.parked.length + x.done.length + x.lifeAreas.length > 0);
    return {
      sections,
      onTheGo: cards.filter((c) => c.project.state === 'open' && c.project.pinnedAt !== null)
        .sort((a, b) => a.project.pinnedAt!.localeCompare(b.project.pinnedAt!)),
      open: by((c) => c.project.state === 'open' && c.project.pinnedAt === null && !personal(c) && c.quietDays === null),
      quiet: by((c) => c.project.state === 'open' && c.project.pinnedAt === null && !personal(c) && c.quietDays !== null),
      personal: by((c) => (c.project.state === 'open' || c.project.state === 'parked') && personal(c)),
      ideas: by((c) => c.project.state === 'idea'),
      parked: by((c) => c.project.state === 'parked' && !personal(c)),
      done: by((c) => c.project.state === 'done' || c.project.state === 'archived'),
      suggestions: this.suggestions(cards, now, cards.filter((c) => c.project.state === 'open' && c.project.pinnedAt !== null).length, opts.holdBackPark),
      folders: { unmatched: folders.unmatched, receivedAt: folders.receivedAt, device: folders.device },
    };
  }

  private suggestions(cards: ProjectCard[], now: Date, pinned: number, holdBackPark: ReadonlySet<string> = new Set()): HomeSuggestion[] {
    const awake = cards.filter((c) => c.project.snoozedUntil === null || c.project.snoozedUntil <= now.toISOString());
    const reopen = awake.filter((c) => c.newActivity).sort(newestFirst)
      .map((c): HomeSuggestion => ({ project: c.project.name, kind: 'reopen-active', text: `${c.project.name} is ${c.project.state} but has new activity: back to open?` }));
    // "Put it on the go?" only while there is room: with On the go full its button could only fail.
    const pin = awake.filter((c) => pinned < MAX_PINNED && c.project.state === 'open' && c.project.pinnedAt === null && c.late > 0).sort(newestFirst)
      .map((c): HomeSuggestion => ({ project: c.project.name, kind: 'pin-late', text: `${c.project.name} has something late: put it on the go?` }));
    const park = awake.filter((c) => c.project.state === 'open' && c.quietDays !== null && c.quietDays >= PARK_SUGGESTION_DAYS && !holdBackPark.has(c.project.name))
      .sort((a, b) => a.lastTouched.localeCompare(b.lastTouched))
      .map((c): HomeSuggestion => ({ project: c.project.name, kind: 'park-quiet', text: `${c.project.name} has been quiet for ${Math.floor(c.quietDays! / 7)} weeks: park it?` }));
    return [...reopen, ...pin, ...park].slice(0, MAX_SUGGESTIONS);
  }

  /** The project's pick-up-here panel; an alias opens its project; undefined for a name not in the registry. */
  detail(name: string, now: Date): ProjectDetail | undefined {
    const p = this.registry.get(this.memories.projectNamed(name));
    if (!p) return undefined;
    const folders = this.match();
    const card = this.card(p, now, folders);
    const today = day(now);
    const soonEnd = day(addDays(now, SOON_DAYS));
    const r = card.roadmap;
    return {
      card,
      leftOff: this.store.list({ project: p.name }).find(isStatus) ?? null,
      waiting: (r?.waiting ?? []).map((w, index) => ({ index, text: w.text, due: w.due, late: w.due !== null && w.due < today, soon: w.due !== null && w.due >= today && w.due <= soonEnd })),
      doneToday: this.ownerTickedToday(p.name, r, today),
      nextSteps: r?.nextSteps ?? [],
      continueCommand: `cd ~/Projects/${shellWord(folders.byProject.get(p.name)?.name.normalize('NFC') ?? p.folder ?? p.name)} && claude`,
      facts: this.panelFacts(p.name),
      replaced: this.panelReplaced(p.name),
      discussions: this.panelDiscussions(p.name, now),
      discussionsTotal: this.discussionsOf(p.name).length,
      pages: this.panelPages(p.name),
      folder: folders.byProject.get(p.name) ?? null,
      disagreements: this.memories.openDisagreements(p.name),
      areas: this.learning?.areas?.(p.name) ?? null,
      handbook: this.learning?.topics?.(p.name) ?? [],
    };
  }

  /**
   * Done entries the owner ticked today: dated today and added by one of the owner's own changes today (history keeps
   * each earlier version and who replaced it), even when an assistant has saved the roadmap since. Steps an assistant
   * finished get no Undo.
   */
  private ownerTickedToday(name: string, r: Roadmap | null, today: string): DoneRow[] {
    const m = this.memories.roadmapOf(name);
    if (!m || !r) return [];
    const key = (d: { text: string; date: string | null }) => `${d.text}|${d.date}`;
    const ticked = new Set<string>();
    let after = m.content;
    for (const h of this.store.history(m.id)) {
      if (day(new Date(h.changedAt)) !== today) break;
      if (h.changedBy === 'owner') {
        const before = new Set(parseRoadmap(h.content).done.map(key));
        for (const d of parseRoadmap(after).done) if (!before.has(key(d))) ticked.add(key(d));
      }
      after = h.content;
    }
    return r.done.map((d, index) => ({ index, text: d.text, date: d.date }))
      .filter((d) => d.date === today && ticked.has(key(d)));
  }

  private panelFacts(name: string): ProjectDetail['facts'] {
    const all = this.store.list({ project: name }).filter((m) => m.kind !== 'roadmap' && m.kind !== 'profile');
    const newest = all.filter((m) => m.kind === 'decision' && !isStatus(m)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, PANEL_FACTS);
    return { total: all.length, newest, replaces: Object.fromEntries(this.store.supersessions.liveCounts(newest.map((m) => m.id))) };
  }

  private panelReplaced(name: string): ProjectDetail['replaced'] {
    const live = this.store.supersessions.liveForProject(name);
    const rows = live.slice(0, PANEL_REPLACED).map((row): ReplacedRow => {
      const { endId, steps } = this.store.supersessions.chainEnd(row.oldId);
      const end = this.store.get(endId);
      return { row, old: this.store.get(row.oldId)!, end: end && end.deletedAt === null ? end : null, endId, endDeletedAt: end?.deletedAt ?? null, steps };
    });
    return { rows, total: live.length };
  }

  /** The project's discussions (aliases followed), open ones first; the panel shows at most PANEL_DISCUSSIONS. */
  private discussionsOf(name: string) {
    return (this.discussions?.ownerList() ?? [])
      // A discussion filed under an alias (or under a name since moved) belongs to the real project.
      .filter((d) => d.project !== null && this.memories.projectNamed(d.project) === name)
      .sort((a, b) => Number(a.closed) - Number(b.closed) || (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  }

  private panelDiscussions(name: string, now: Date): PanelDiscussion[] {
    return this.discussionsOf(name)
      .slice(0, PANEL_DISCUSSIONS)
      .map((d) => ({
        id: d.id, title: d.title, open: !d.closed, needsYou: !d.closed && d.waitingFor.length === 0,
        label: d.closed ? `Decided ${d.closedAt ? shortDay(d.closedAt, now) : ''}`.trim()
          : d.waitingFor.length > 0 ? `Round ${d.round} · waiting for ${d.waitingFor.join(', ')}` : `Round ${d.round} · ready for you`,
      }));
  }

  /** The roadmap to change. One not in the usual five-line shape is refused: rewriting it would drop what didn't parse. */
  private mustRoadmap(name: string): { id: string; content: string; parsed: Roadmap } {
    const m = this.memories.roadmapOf(this.memories.projectNamed(name));
    if (!m) throw new ProjectError('not_found', `Project ${name} has no roadmap`);
    if (checkRoadmap(m.content) !== null) throw new ProjectError('invalid', "This roadmap isn't in the usual shape: fix it on its memory page first");
    return { id: m.id, content: m.content, parsed: parseRoadmap(m.content) };
  }

  /**
   * Saves a changed roadmap as the owner, only if nobody changed it meanwhile. When it no longer fits, Done entries go
   * undated first, then earliest date first, never the one just added (`keep`).
   */
  private async saveRoadmap(id: string, before: string, r: Roadmap, keep?: DoneRow['text']): Promise<void> {
    let content = formatRoadmap(r);
    while (content.length > MAX_ROADMAP && r.done.length > 1) {
      const candidates = r.done.map((d, i) => ({ d, i })).filter(({ d, i }) => !(keep !== undefined && i === r.done.length - 1 && d.text === keep));
      if (candidates.length === 0) break;
      const drop = candidates.reduce((a, b) => ((a.d.date ?? '') <= (b.d.date ?? '') ? a : b));
      r.done.splice(drop.i, 1);
      content = formatRoadmap(r);
    }
    if (content.length > MAX_ROADMAP) {
      throw new ProjectError('invalid', 'This roadmap is full: ask an assistant to shorten it, or edit it on its memory page');
    }
    await this.memories.update(id, { content }, OWNER, { expectContent: before });
  }

  /** Ticks off one waiting item: it moves to Done with today's date. `text` guards against a list that changed meanwhile. */
  async completeWaiting(name: string, index: number, text: string, now: Date): Promise<void> {
    const { id, content, parsed } = this.mustRoadmap(name);
    const item = parsed.waiting[index];
    if (!item || item.text !== text) throw new ProjectError('invalid', LIST_CHANGED);
    parsed.waiting.splice(index, 1);
    const doneText = item.due ? `${item.text} (by ${item.due})` : item.text;
    parsed.done.push({ text: doneText, date: day(now) });
    await this.saveRoadmap(id, content, parsed, doneText);
  }

  /** Unticks an item done today: it goes back to the end of Waiting, with its due date if it had one. */
  async undoDone(name: string, index: number, text: string, now: Date): Promise<void> {
    const { id, content, parsed } = this.mustRoadmap(name);
    const done = parsed.done[index];
    if (!done || done.text !== text || done.date !== day(now)) throw new ProjectError('invalid', LIST_CHANGED);
    parsed.done.splice(index, 1);
    const due = DUE_IN_TEXT.exec(done.text);
    parsed.waiting.push(due ? { text: done.text.slice(0, due.index).trim(), due: due[1]! } : { text: done.text, due: null });
    await this.saveRoadmap(id, content, parsed);
  }

  /** A new idea from one line of text: a project in state idea, named after the text. */
  private panelPages(name: string): ProjectDetail['pages'] {
    const ps = this.pages?.forProject(name) ?? [];
    const flagged = this.pages?.flaggedIds?.(ps) ?? new Set<string>();
    return ps.map((x) => ({ id: x.id, title: x.title, mayBeOutOfDate: flagged.has(x.id) }));
  }

  createIdea(text: string, _now: Date): Project {
    const base = ideaName(text);
    if (base === '' || !/^[a-z0-9]/.test(base)) throw new ProjectError('invalid', 'Write a few words (letters or digits) for the idea');
    const taken = (n: string) => this.registry.get(n) !== undefined || this.store.aliasTarget(n) !== undefined;
    let name = base;
    for (let i = 2; taken(name); i++) name = `${base.slice(0, MAX_IDEA_NAME - String(i).length - 1).replace(/-+$/, '')}-${i}`;
    return this.registry.create(name, { state: 'idea', oneLiner: text.trim().replace(/\s+/g, ' ').slice(0, 140) }, 'owner');
  }

  private name(name: string): string {
    return this.memories.projectNamed(name);
  }

  setState(name: string, state: ProjectStateName): Project {
    return this.registry.setState(this.name(name), state, 'owner');
  }

  pin(name: string): Project {
    return this.registry.pin(this.name(name), 'owner');
  }

  unpin(name: string): Project {
    return this.registry.unpin(this.name(name), 'owner');
  }

  /** Hides this project's home suggestions for SNOOZE_DAYS. */
  snooze(name: string, now: Date): Project {
    return this.registry.snooze(this.name(name), addDays(now, SNOOZE_DAYS).toISOString(), 'owner');
  }
}
