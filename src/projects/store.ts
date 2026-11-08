import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { looksLikeInstruction } from '../memory/instructionLike.js';
import { looksLikeSecret } from '../memory/secrets.js';
import { STOPWORDS } from '../memory/stopwords.js';
import { words } from '../memory/words.js';
import { normalizePlaces } from './places.js';
import { AREAS, MAX_PINNED, ProjectError, STATES, type Area, type Project, type ProjectStateName } from './types.js';

interface ProjectRow {
  name: string; one_liner: string | null; area: Area | null; state: ProjectStateName; state_changed_at: string;
  pinned_at: string | null; folder: string | null; remotes: string; url: string | null; runs_on: string; nicknames: string; snoozed_until: string | null;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
}

const toProject = (r: ProjectRow): Project => ({
  name: r.name, oneLiner: r.one_liner, area: r.area, state: r.state, stateChangedAt: r.state_changed_at,
  pinnedAt: r.pinned_at, folder: r.folder, remotes: JSON.parse(r.remotes) as string[], url: r.url, runsOn: JSON.parse(r.runs_on) as string[], nicknames: JSON.parse(r.nicknames) as string[],
  snoozedUntil: r.snoozed_until, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

export const MAX_ONE_LINER = 140;
const MAX_FOLDER = 120;
const MAX_URL = 300;
const MAX_REMOTES = 5;
export const MAX_NICKNAMES = 8;
const NICKNAME_CHARS = [2, 40] as const;

const invalid = (message: string) => new ProjectError('invalid', message);

function checkNoSecret(field: string, s: string): void {
  const reason = looksLikeSecret(s);
  if (reason) throw invalid(`The ${field} looks like it contains a secret (${reason}). Secrets are never stored.`);
}

function checkOneLiner(v: string | null): string | null {
  if (v === null) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/[\r\n]/.test(s)) throw invalid('The one-liner must be a single line');
  if (s.length > MAX_ONE_LINER) throw invalid(`The one-liner is ${s.length} characters; the limit is ${MAX_ONE_LINER}`);
  checkNoSecret('one-liner', s);
  return s;
}

/**
 * A folder name goes into the "Continue in Claude Code" command the owner pastes into a terminal, so it may hold only
 * letters, digits, spaces, dots, hyphens and underscores, starting with a letter or digit: nothing a shell would run.
 */
const FOLDER_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** Whether a name can be stored as a project's folder (the rule checkFolder enforces). */
export function validFolder(v: string): boolean {
  const s = v.trim();
  return s.length > 0 && s.length <= MAX_FOLDER && FOLDER_RE.test(s) && !s.includes('..') && looksLikeSecret(s) === null;
}

function checkFolder(v: string | null): string | null {
  if (v === null || v.trim() === '') return null;
  const s = v.trim();
  if (s.length > MAX_FOLDER || !FOLDER_RE.test(s) || s.includes('..')) {
    throw invalid(`The folder is a folder name inside ~/Projects: letters, digits, spaces, dots, hyphens and underscores, at most ${MAX_FOLDER} characters`);
  }
  checkNoSecret('folder', s);
  return s;
}

function checkUrl(v: string | null): string | null {
  if (v === null || v.trim() === '') return null;
  const s = v.trim();
  if (s.length > MAX_URL || !/^https?:\/\/[^\s]+$/i.test(s)) throw invalid('The URL must start with https:// or http://');
  checkNoSecret('URL', s);
  return s;
}

function checkPlaces(v: string | readonly string[]): string[] {
  const places = normalizePlaces(v);
  for (const p of places) checkNoSecret('place', p);
  return places;
}

function checkRemotes(v: string[]): string[] {
  if (v.length > MAX_REMOTES || v.some((r) => typeof r !== 'string' || r.length === 0 || r.length > MAX_URL || /\s/.test(r))) {
    throw invalid(`At most ${MAX_REMOTES} git remotes, each without spaces`);
  }
  return [...new Set(v)];
}

/** The projects registry: one row per project with its area, description, owner-set state and pin. */
export class ProjectStore {
  constructor(private db: DB, private now: Clock) {}

  private ts(): string {
    return this.now().toISOString();
  }

  get(name: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
    return r && toProject(r);
  }

  private mustGet(name: string): Project {
    const p = this.get(name);
    if (!p) throw new ProjectError('not_found', `No project ${name}`);
    return p;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[]).map(toProject);
  }

  create(name: string, init: { state: ProjectStateName; oneLiner?: string | null; area?: Area | null }, by: string): Project {
    if (this.get(name)) throw invalid(`A project named ${name} already exists`);
    if (!STATES.includes(init.state)) throw invalid(`state must be one of: ${STATES.join(', ')}`);
    const area = init.area ?? null;
    if (area !== null && !AREAS.includes(area)) throw invalid(`area must be one of: ${AREAS.join(', ')}`);
    const t = this.ts();
    this.db.prepare(`INSERT INTO projects(name, one_liner, area, state, state_changed_at, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, checkOneLiner(init.oneLiner ?? null), area, init.state, t, t, by, t, by);
    return this.mustGet(name);
  }

  /** Fields left out stay as they are; null clears one. */
  setInfo(name: string, info: { oneLiner?: string | null; area?: Area | null; folder?: string | null; remotes?: string[]; url?: string | null; runsOn?: string | readonly string[]; nicknames?: string | readonly string[] }, by: string): Project {
    const p = this.mustGet(name);
    if (info.area !== undefined && info.area !== null && !AREAS.includes(info.area)) throw invalid(`area must be one of: ${AREAS.join(', ')}`);
    const next = {
      oneLiner: info.oneLiner === undefined ? p.oneLiner : checkOneLiner(info.oneLiner),
      area: info.area === undefined ? p.area : info.area,
      folder: info.folder === undefined ? p.folder : checkFolder(info.folder),
      remotes: info.remotes === undefined ? p.remotes : checkRemotes(info.remotes),
      url: info.url === undefined ? p.url : checkUrl(info.url),
      runsOn: info.runsOn === undefined ? p.runsOn : checkPlaces(info.runsOn),
      nicknames: info.nicknames === undefined ? p.nicknames : this.checkNicknames(name, info.nicknames),
    };
    this.db.prepare('UPDATE projects SET one_liner = ?, area = ?, folder = ?, remotes = ?, url = ?, runs_on = ?, nicknames = ?, updated_at = ?, updated_by = ? WHERE name = ?')
      .run(next.oneLiner, next.area, next.folder, JSON.stringify(next.remotes), next.url, JSON.stringify(next.runsOn), JSON.stringify(next.nicknames), this.ts(), by, name);
    return this.mustGet(name);
  }

  /**
   * A comma-separated string or a list as `project`'s nicknames: trimmed, repeats (as words) dropped, at most 8, each
   * 2 to 40 characters, none reading like an instruction or holding a secret, and none naming another project: its
   * name, an alias of it or one of its nicknames, compared as words. Recall matches nicknames as whole words of a
   * question, so one must keep all its letters in that form (Latin letters and digits, accents allowed), have at least
   * 4 letters besides filler words ("it", "the app" would match unrelated questions), and hold no comma (the
   * dashboard's list is comma-separated).
   */
  private checkNicknames(project: string, input: string | readonly string[]): string[] {
    const raw = typeof input === 'string' ? input.split(',') : input;
    const out: string[] = [];
    for (const entry of raw) {
      const n = String(entry).trim().replace(/\s+/g, ' ');
      if (n === '' || out.some((o) => words(o) === words(n))) continue;
      if (n.length < NICKNAME_CHARS[0] || n.length > NICKNAME_CHARS[1] || words(n).trim() === '') throw invalid(`Each nickname is ${NICKNAME_CHARS[0]} to ${NICKNAME_CHARS[1]} characters`);
      if (n.includes(',')) throw invalid(`A nickname holds no comma: ${JSON.stringify(n)}`);
      const kept = words(n).replace(/ /g, '');
      if (kept.length !== n.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').length) {
        throw invalid(`A nickname has only letters and digits (accents allowed) besides spaces and punctuation: ${JSON.stringify(n)}`);
      }
      if (words(n).trim().split(' ').filter((w) => !STOPWORDS.has(w)).join('').length < 4) {
        throw invalid(`The nickname ${JSON.stringify(n)} is too generic: it would match questions about anything. Use a name only this project goes by.`);
      }
      const reason = looksLikeInstruction(n);
      if (reason) throw invalid(`The nickname ${JSON.stringify(n)} reads like an instruction to AI assistants (${reason}). Use the name people call the project.`);
      checkNoSecret('nickname', n);
      out.push(n);
    }
    if (out.length > MAX_NICKNAMES) throw invalid(`At most ${MAX_NICKNAMES} nicknames`);
    const taken = new Map<string, string>();
    for (const p of this.list()) {
      if (p.name === project) continue;
      taken.set(words(p.name.replace(/-/g, ' ')), p.name);
      for (const n of p.nicknames) taken.set(words(n), p.name);
    }
    for (const a of this.db.prepare('SELECT alias, project FROM project_aliases').all() as { alias: string; project: string }[]) {
      if (a.project !== project) taken.set(words(a.alias.replace(/-/g, ' ')), a.project);
    }
    for (const n of out) {
      const other = taken.get(words(n));
      if (other !== undefined) throw invalid(`The nickname ${JSON.stringify(n)} is already ${other}'s name or nickname: each nickname names one project.`);
    }
    return out;
  }

  /** Every place some project runs on, each once, sorted (the tool description lists them so assistants reuse them). */
  placesInUse(): string[] {
    return (this.db.prepare('SELECT DISTINCT j.value AS v FROM projects, json_each(projects.runs_on) j ORDER BY v').all() as { v: string }[]).map((r) => r.v);
  }

  /** Leaving open also takes the project off On the go. */
  setState(name: string, state: ProjectStateName, by: string): Project {
    const p = this.mustGet(name);
    if (!STATES.includes(state)) throw invalid(`state must be one of: ${STATES.join(', ')}`);
    const t = this.ts();
    this.db.prepare('UPDATE projects SET state = ?, state_changed_at = ?, pinned_at = ?, updated_at = ?, updated_by = ? WHERE name = ?')
      .run(state, state === p.state ? p.stateChangedAt : t, state === 'open' ? p.pinnedAt : null, t, by, name);
    return this.mustGet(name);
  }

  pin(name: string, by: string): Project {
    return this.db.transaction(() => {
      const p = this.mustGet(name);
      if (p.pinnedAt !== null) return p;
      if (p.state !== 'open') throw invalid('Only an open project can be on the go: reopen it first');
      const pinned = (this.db.prepare('SELECT count(*) AS n FROM projects WHERE pinned_at IS NOT NULL').get() as { n: number }).n;
      if (pinned >= MAX_PINNED) throw new ProjectError('pin_limit', `On the go holds ${MAX_PINNED} projects: unpin one first`);
      const t = this.ts();
      this.db.prepare('UPDATE projects SET pinned_at = ?, updated_at = ?, updated_by = ? WHERE name = ?').run(t, t, by, name);
      return this.mustGet(name);
    })();
  }

  unpin(name: string, by: string): Project {
    this.mustGet(name);
    this.db.prepare('UPDATE projects SET pinned_at = NULL, updated_at = ?, updated_by = ? WHERE name = ?').run(this.ts(), by, name);
    return this.mustGet(name);
  }

  snooze(name: string, until: string, by: string): Project {
    this.mustGet(name);
    this.db.prepare('UPDATE projects SET snoozed_until = ?, updated_at = ?, updated_by = ? WHERE name = ?').run(until, this.ts(), by, name);
    return this.mustGet(name);
  }
}
