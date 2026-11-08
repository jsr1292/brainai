import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { SupersessionStore } from './supersessions.js';
import { DisagreementStore } from './disagreements.js';
import { OWNER_LABEL, type HistoryEntry, type Kind, type Memory, type Suggestion } from './types.js';
import { words } from './words.js';
import { MAX_NICKNAMES } from '../projects/store.js';

export interface MemoryRow {
  id: string; kind: Kind; content: string; project: string | null; tags: string;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
  last_recalled_at: string | null; deleted_at: string | null;
}
export interface HistoryRow {
  id: number; memory_id: string; action: HistoryEntry['action']; content: string; project: string | null;
  tags: string; changed_at: string; changed_by: string;
}
interface SuggestionRow {
  id: string; action: Suggestion['action']; memory_id: string | null; content: string | null; tags: string;
  kind: Kind; project: string | null; reason: string | null;
  suggested_at: string; suggested_by: string; status: Suggestion['status']; supersedes: string; deleted_match: string | null;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export const toMemory = (r: MemoryRow): Memory => ({
  id: r.id, kind: r.kind, content: r.content, project: r.project, tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
  lastRecalledAt: r.last_recalled_at, deletedAt: r.deleted_at,
});
export const toHistory = (r: HistoryRow): HistoryEntry => ({
  id: r.id, memoryId: r.memory_id, action: r.action, content: r.content, project: r.project,
  tags: JSON.parse(r.tags) as string[], changedAt: r.changed_at, changedBy: r.changed_by,
});
const toSuggestion = (r: SuggestionRow): Suggestion => ({
  id: r.id, action: r.action, memoryId: r.memory_id, content: r.content, tags: JSON.parse(r.tags) as string[],
  kind: r.kind, project: r.project, reason: r.reason, suggestedAt: r.suggested_at, suggestedBy: r.suggested_by, status: r.status,
  supersedes: JSON.parse(r.supersedes ?? '[]') as string[], deletedMatch: r.deleted_match ?? null,
});

/**
 * Replaced facts (section 16): 'hide' (the default) leaves them out, 'only' keeps just them, 'include' keeps both. A
 * fact is replaced while it has a supersessions row with undone_at NULL.
 */
export type ReplacedFilter = 'hide' | 'only' | 'include';

/** `projects` limits to memories of exactly those projects (none: nothing matches), never profile memories. */
export interface Filter { kind?: Kind; project?: string; projects?: string[]; replaced?: ReplacedFilter }

/** The condition that the memories row named `alias` is replaced, always written against `<alias>.id`. */
export const replacedSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM supersessions s WHERE s.old_id = ${alias}.id AND s.undone_at IS NULL)`;

function filterSql(f: Filter, alias: string): { sql: string; params: string[] } {
  const p = `${alias}.`;
  let sql = '';
  const params: string[] = [];
  if (f.kind) { sql += ` AND ${p}kind = ?`; params.push(f.kind); }
  if (f.project) { sql += ` AND ${p}project = ?`; params.push(f.project); }
  if (f.projects) {
    sql += f.projects.length === 0 ? ' AND 0' : ` AND ${p}project IN (${f.projects.map(() => '?').join(', ')}) AND ${p}kind != 'profile'`;
    params.push(...f.projects);
  }
  const replaced = f.replaced ?? 'hide';
  if (replaced === 'hide') sql += ` AND NOT ${replacedSql(alias)}`;
  else if (replaced === 'only') sql += ` AND ${replacedSql(alias)}`;
  return { sql, params };
}

/** One line of the Activity list (the old fact's id and text for a replacement and its undo). */
/** `kind` is the memory's kind (a project's Lately shows a roadmap as its Now line). */
export interface ActivityRow { at: string; by: string; action: 'created' | 'updated' | 'deleted' | 'restored' | 'replaced' | 'brought back'; memoryId: string; content: string; kind: Kind }

export class MemoryStore {
  /** Which fact replaced which (section 16): the one source of truth for replaced facts. */
  readonly supersessions: SupersessionStore;
  /** Pairs of facts an assistant flagged as disagreeing (B1). */
  readonly disagreements: DisagreementStore;

  /**
   * B1: every open disagreement with a fact that is deleted or replaced is settled as 'gone', in one statement.
   * Returns how many pairs it settled.
   */
  settleGoneDisagreements(): number {
    const live = (col: string) => `EXISTS (SELECT 1 FROM memories m WHERE m.id = disagreements.${col} AND m.deleted_at IS NULL AND NOT ${replacedSql('m')})`;
    return this.db.prepare(`UPDATE disagreements SET settled_at = ?, settled_how = 'gone', settled_by = 'BrainAI'
      WHERE settled_at IS NULL AND NOT (${live('a')} AND ${live('b')})`).run(this.ts()).changes;
  }

  /** Brain health: each project's newest live, current status (kind summary, or decision tagged status), in one query. */
  statusTimes(): Map<string, string> {
    const rows = this.db.prepare(`SELECT m.project AS project, m.kind AS kind, m.tags AS tags, m.updated_at AS at FROM memories m
      WHERE m.deleted_at IS NULL AND m.project IS NOT NULL AND m.kind IN ('summary', 'decision') AND NOT ${replacedSql('m')}`)
      .all() as { project: string; kind: string; tags: string; at: string }[];
    const times = new Map<string, string>();
    for (const r of rows) {
      if (r.kind === 'decision' && !(JSON.parse(r.tags) as string[]).includes('status')) continue;
      if ((times.get(r.project) ?? '') < r.at) times.set(r.project, r.at);
    }
    return times;
  }

  constructor(private db: DB, private now: Clock) {
    this.supersessions = new SupersessionStore(db, now);
    this.disagreements = new DisagreementStore(db, now);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  nowDate(): Date {
    return this.now();
  }

  private ftsReplace(id: string, content: string, project: string | null, tags: string[]): void {
    this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
    this.db.prepare('INSERT INTO memories_fts(memory_id, content, project, tags) VALUES (?, ?, ?, ?)')
      .run(id, content, project ?? '', tags.join(' '));
  }

  private ftsRemove(id: string): void {
    this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
  }

  private writeHistory(m: Memory, action: HistoryEntry['action'], by: string): void {
    this.db.prepare(
      'INSERT INTO memory_history(memory_id, action, content, project, tags, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(m.id, action, m.content, m.project, JSON.stringify(m.tags), this.ts(), by);
  }

  private mustGet(id: string): Memory {
    const m = this.get(id);
    if (!m) throw new Error(`memory not found: ${id}`);
    return m;
  }

  /** Gives a project its registry row (state open) the first time a memory is filed under it. */
  private ensureProject(project: string | null, kind: Kind, by: string): void {
    if (project === null || kind === 'profile') return;
    // A row is never made for a name that is an alias: memories under it belong to the real project.
    project = this.aliasTarget(project) ?? project;
    const t = this.ts();
    this.db.prepare(`INSERT OR IGNORE INTO projects(name, state, state_changed_at, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'open', ?, ?, ?, ?, ?)`).run(project, t, t, by, t, by);
  }

  /** When a project's live memories last changed, optionally ignoring one writer (the owner's own ticks); no embeddings read. */
  newestChange(project: string, notBy?: string): string | undefined {
    const row = (notBy === undefined
      ? this.db.prepare('SELECT max(updated_at) AS at FROM memories WHERE project = ? AND deleted_at IS NULL').get(project)
      : this.db.prepare('SELECT max(updated_at) AS at FROM memories WHERE project = ? AND deleted_at IS NULL AND updated_by != ?').get(project, notBy)) as { at: string | null };
    return row.at ?? undefined;
  }

  /** The owner-set state of a project in the registry, or undefined when it has no row. */
  projectState(name: string): 'idea' | 'open' | 'parked' | 'done' | 'archived' | undefined {
    return (this.db.prepare('SELECT state FROM projects WHERE name = ?').get(name) as { state: 'open' } | undefined)?.state;
  }

  /**
   * After a project's memories went to another name: its registry row becomes that project's when the target has
   * none, otherwise it is dropped (the target's state, pin and description win). `targetHeldNothing`: the target had
   * no live memories of its own before the move (by default, it has none now).
   */
  mergeProjectRow(from: string, to: string, targetHeldNothing = this.list({ project: to, limit: 1, replaced: 'include' }).length === 0): void {
    if (from === to) return;
    this.db.transaction(() => {
      const target = this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(to);
      if (target) {
        // A bare target row made automatically (open, unpinned, nothing set by the owner, no memories of its own) takes
        // the merged project's state. A target holding work keeps its own: a stray archived or parked to hide it must
        // not take the real project out of What's left.
        if (targetHeldNothing) this.db.prepare(`UPDATE projects SET
            state = (SELECT state FROM projects WHERE name = ?), state_changed_at = (SELECT state_changed_at FROM projects WHERE name = ?),
            pinned_at = (SELECT pinned_at FROM projects WHERE name = ?), snoozed_until = (SELECT snoozed_until FROM projects WHERE name = ?)
          WHERE name = ? AND state = 'open' AND pinned_at IS NULL AND created_by != 'owner' AND updated_by != 'owner'
            AND EXISTS (SELECT 1 FROM projects WHERE name = ?)`).run(from, from, from, from, to, from);
        // What the owner or an assistant set on the merged name fills in what the target lacks.
        this.db.prepare(`UPDATE projects SET
            one_liner = COALESCE(one_liner, (SELECT one_liner FROM projects WHERE name = ?)),
            area = COALESCE(area, (SELECT area FROM projects WHERE name = ?)),
            folder = COALESCE(folder, (SELECT folder FROM projects WHERE name = ?)),
            url = COALESCE(url, (SELECT url FROM projects WHERE name = ?)),
            runs_on = CASE WHEN runs_on = '[]' THEN COALESCE((SELECT runs_on FROM projects WHERE name = ?), '[]') ELSE runs_on END
          WHERE name = ?`).run(from, from, from, from, from, to);
        // Nicknames of both: the target's first, repeats (as words) once, at most MAX_NICKNAMES.
        const nicknamesOf = (name: string) => JSON.parse((this.db.prepare('SELECT nicknames FROM projects WHERE name = ?').get(name) as { nicknames: string } | undefined)?.nicknames ?? '[]') as string[];
        const both: string[] = [];
        for (const n of [...nicknamesOf(to), ...nicknamesOf(from)]) if (!both.some((b) => words(b) === words(n))) both.push(n);
        this.db.prepare('UPDATE projects SET nicknames = ? WHERE name = ?').run(JSON.stringify(both.slice(0, MAX_NICKNAMES)), to);
        this.db.prepare('DELETE FROM projects WHERE name = ?').run(from);
      } else this.db.prepare('UPDATE projects SET name = ? WHERE name = ?').run(to, from);
    })();
  }

  /** Runs fn in one SQLite transaction (nests safely with the store's own transactions). */
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * The real project for a name that has become an alias. Resolved again inside each write: a save whose project was
   * merged into another while its text was embedded lands in the project it was merged into.
   */
  private real(project: string | null): string | null {
    return project === null ? null : this.aliasTarget(project) ?? project;
  }

  insert(m: { kind: Kind; content: string; project: string | null; tags: string[]; embedding: Float32Array; by: string }): Memory {
    const id = randomUUID();
    const t = this.ts();
    this.db.transaction(() => {
      const project = this.real(m.project);
      this.db.prepare(
        `INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, m.kind, m.content, project, JSON.stringify(m.tags), toBlob(m.embedding), t, m.by, t, m.by);
      this.ftsReplace(id, m.content, project, m.tags);
      this.ensureProject(project, m.kind, m.by);
    })();
    return this.mustGet(id);
  }

  get(id: string): Memory | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return r && toMemory(r);
  }

  update(id: string, f: { content: string; project: string | null; tags: string[]; embedding: Float32Array; by: string }): Memory {
    this.db.transaction(() => {
      const prev = this.mustGet(id);
      if (prev.deletedAt) throw new Error(`memory is deleted: ${id}`);
      this.writeHistory(prev, 'update', f.by);
      this.applyContent(id, f, f.by);
    })();
    return this.mustGet(id);
  }

  /**
   * Changes only the project and tags, recorded in history. updated_at stays, because the text did not change and
   * statuses are ordered by it.
   */
  relabel(id: string, f: { project: string | null; tags: string[]; by: string }): Memory {
    this.db.transaction(() => {
      const prev = this.mustGet(id);
      const project = this.real(f.project);
      this.writeHistory(prev, 'update', f.by);
      this.db.prepare('UPDATE memories SET project = ?, tags = ? WHERE id = ?').run(project, JSON.stringify(f.tags), id);
      this.ftsReplace(id, prev.content, project, f.tags);
      this.ensureProject(project, prev.kind, f.by);
    })();
    return this.mustGet(id);
  }

  private applyContent(id: string, f: { content: string; project: string | null; tags: string[]; embedding: Float32Array }, by: string): void {
    const project = this.real(f.project);
    this.db.prepare(
      'UPDATE memories SET content = ?, project = ?, tags = ?, embedding = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    ).run(f.content, project, JSON.stringify(f.tags), toBlob(f.embedding), this.ts(), by, id);
    this.ftsReplace(id, f.content, project, f.tags);
    this.ensureProject(project, this.mustGet(id).kind, by);
  }

  softDelete(id: string, by: string): void {
    this.db.transaction(() => {
      const prev = this.mustGet(id);
      this.writeHistory(prev, 'delete', by);
      this.db.prepare('UPDATE memories SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(this.ts(), by, id);
      this.ftsRemove(id);
    })();
  }

  restore(historyId: number, by: string, embedding: Float32Array | null): Memory {
    const h = this.db.prepare('SELECT * FROM memory_history WHERE id = ?').get(historyId) as HistoryRow | undefined;
    if (!h) throw new Error(`history entry not found: ${historyId}`);
    this.db.transaction(() => {
      const cur = this.mustGet(h.memory_id);
      // A memory restored under a name that has since become an alias goes back into the real project.
      if (h.action === 'delete') {
        const project = this.real(cur.project);
        this.writeHistory(cur, 'restore', by);
        // updated_at stays, as for a move: the text did not change, and an old status brought back must not become
        // the project's latest word (statuses are ordered by it). The restore is in history, with its time.
        this.db.prepare('UPDATE memories SET deleted_at = NULL, deleted_by = NULL, project = ? WHERE id = ?')
          .run(project, cur.id);
        this.ftsReplace(cur.id, cur.content, project, cur.tags);
        this.ensureProject(project, cur.kind, by);
      } else {
        if (!embedding) throw new Error('embedding required to restore a previous version');
        this.writeHistory(cur, 'restore', by);
        this.applyContent(cur.id, { content: h.content, project: h.project, tags: JSON.parse(h.tags) as string[], embedding }, by);
      }
    })();
    return this.mustGet(h.memory_id);
  }

  historyEntry(id: number): HistoryEntry | undefined {
    const r = this.db.prepare('SELECT * FROM memory_history WHERE id = ?').get(id) as HistoryRow | undefined;
    return r && toHistory(r);
  }

  history(memoryId: string): HistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id DESC').all(memoryId) as HistoryRow[];
    return rows.map(toHistory);
  }

  /** Replaced facts are left out unless `replaced` says otherwise. */
  list(f: { kind?: Kind; project?: string; includeDeleted?: boolean; limit?: number; offset?: number; replaced?: ReplacedFilter }): Memory[] {
    const fs = filterSql(f, 'm');
    const sql = `SELECT m.* FROM memories m WHERE 1=1${f.includeDeleted ? '' : ' AND m.deleted_at IS NULL'}${fs.sql}
      ORDER BY m.updated_at DESC, m.rowid DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...fs.params, f.limit ?? -1, f.offset ?? 0) as MemoryRow[];
    return rows.map(toMemory);
  }

  /** Current facts only, without loading their bodies or embeddings. */
  countCurrent(f: { kind?: Kind; project?: string } = {}): number {
    const fs = filterSql(f, 'm');
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE m.deleted_at IS NULL${fs.sql}`)
      .get(...fs.params) as { n: number }).n;
  }

  /** The real project name for an alias, or undefined when the name is not an alias. */
  aliasTarget(alias: string): string | undefined {
    return (this.db.prepare('SELECT project FROM project_aliases WHERE alias = ?').get(alias) as { project: string } | undefined)?.project;
  }

  /** Records `alias` as another name of `project`; aliases that pointed at `alias` now point at `project` too. */
  addAlias(alias: string, project: string, by: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_aliases WHERE alias = ?').run(project);
      this.db.prepare('UPDATE project_aliases SET project = ? WHERE project = ?').run(project, alias);
      this.db.prepare('INSERT OR REPLACE INTO project_aliases(alias, project, added_at, added_by) VALUES (?, ?, ?, ?)').run(alias, project, this.ts(), by);
      this.mergeProjectRow(alias, project);
    })();
  }

  removeAlias(alias: string): boolean {
    return this.db.transaction(() => {
      const removed = this.db.prepare('DELETE FROM project_aliases WHERE alias = ?').run(alias).changes > 0;
      // Memories still filed under the old name make it a project of its own again.
      if (removed && this.list({ project: alias, replaced: 'include' }).some((m) => m.kind !== 'profile')) this.ensureProject(alias, 'decision', 'owner');
      return removed;
    })();
  }

  aliases(): { alias: string; project: string }[] {
    return this.db.prepare('SELECT alias, project FROM project_aliases ORDER BY alias').all() as { alias: string; project: string }[];
  }

  /** Every project in the registry, with the folder it lives in on the Mac (null when none is set). */
  /** Every project nickname with its project (projects.nicknames, B4). */
  nicknames(): { nickname: string; project: string }[] {
    return (this.db.prepare('SELECT j.value AS nickname, p.name AS project FROM projects p, json_each(p.nicknames) j').all() as { nickname: string; project: string }[]);
  }

  registryProjects(): { name: string; folder: string | null }[] {
    return this.db.prepare('SELECT name, folder FROM projects ORDER BY name').all() as { name: string; folder: string | null }[];
  }

  /**
   * `withoutProfile` leaves profile memories out of the counts (and projects that have only those). Replaced facts are
   * not counted (a project holding only those is left out) unless `replaced` says otherwise.
   */
  listProjects(opts: { withoutProfile?: boolean; replaced?: ReplacedFilter } = {}): { project: string; count: number }[] {
    const fs = filterSql({ replaced: opts.replaced }, 'm');
    return this.db.prepare(
      `SELECT m.project AS project, COUNT(*) AS count FROM memories m WHERE m.deleted_at IS NULL AND m.project IS NOT NULL${opts.withoutProfile ? " AND m.kind != 'profile'" : ''}${fs.sql}
       GROUP BY m.project ORDER BY m.project`,
    ).all(...fs.params) as { project: string; count: number }[];
  }

  /** Current, live decisions and summaries filed under exactly these names, or under no project when `projects` is null. */
  currentDecisionsAndStatuses(projects: string[] | null): Memory[] {
    const where = projects === null ? 'm.project IS NULL' : projects.length === 0 ? '0' : `m.project IN (${projects.map(() => '?').join(', ')})`;
    const rows = this.db.prepare(`SELECT m.* FROM memories m WHERE m.deleted_at IS NULL AND m.kind IN ('decision', 'summary') AND ${where}
      AND NOT ${replacedSql('m')}`).all(...(projects ?? [])) as MemoryRow[];
    return rows.map(toMemory);
  }

  /**
   * Current decisions of these projects (live, kind decision, not replaced) saved after `since` or with a history row
   * after it: the candidates for a page's "newer decisions" (round 2 section 13). Tags are left to the caller.
   */
  decisionsTouchedAfter(projects: string[], since: string): Memory[] {
    if (projects.length === 0) return [];
    const rows = this.db.prepare(`SELECT m.* FROM memories m WHERE m.kind = 'decision' AND m.deleted_at IS NULL
      AND m.project IN (SELECT value FROM json_each(?)) AND NOT ${replacedSql('m')}
      AND (m.created_at > ? OR EXISTS (SELECT 1 FROM memory_history h WHERE h.memory_id = m.id AND h.changed_at > ?))
      ORDER BY m.created_at, m.rowid`).all(JSON.stringify(projects), since, since) as MemoryRow[];
    return rows.map(toMemory);
  }

  /** The database's schema version (for reports). */
  schemaVersion(): number {
    return (this.db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  /** These memories, deleted ones included, by id (one query). */
  getMany(ids: readonly string[]): Map<string, Memory> {
    if (ids.length === 0) return new Map();
    const rows = this.db.prepare('SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as MemoryRow[];
    return new Map(rows.map((r) => [r.id, toMemory(r)]));
  }

  /** These memories' history rows after `since`, oldest first. */
  historyAfter(ids: string[], since: string): HistoryEntry[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM memory_history WHERE memory_id IN (SELECT value FROM json_each(?)) AND changed_at > ?
      ORDER BY changed_at, id`).all(JSON.stringify(ids), since) as HistoryRow[];
    return rows.map(toHistory);
  }

  /** The embeddings of these live memories only, by id. */
  embeddingsOf(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT id, embedding FROM memories WHERE deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`)
        .all(...chunk) as { id: string; embedding: Buffer }[];
      for (const r of rows) out.set(r.id, fromBlob(r.embedding));
    }
    return out;
  }

  /** `replaced` on each row is true only for a replaced fact, asked for with 'include' or 'only'. */
  activeEmbeddings(f: Filter): { id: string; embedding: Float32Array; replaced: boolean }[] {
    const fs = filterSql(f, 'm');
    const flag = (f.replaced ?? 'hide') === 'hide' ? '0' : replacedSql('m');
    const rows = this.db.prepare(`SELECT m.id AS id, m.embedding AS embedding, ${flag} AS replaced FROM memories m WHERE m.deleted_at IS NULL${fs.sql}`)
      .all(...fs.params) as { id: string; embedding: Buffer; replaced: number }[];
    return rows.map((r) => ({ id: r.id, embedding: fromBlob(r.embedding), replaced: r.replaced === 1 }));
  }

  /**
   * Forgetting that sticks (§17a): the embeddings of facts deleted on purpose, by the owner or through a deletion the
   * owner approved (recorded under the assistant's name). An assistant's own forget is cleanup and doesn't count.
   */
  deletedEmbeddings(): { id: string; embedding: Float32Array }[] {
    const rows = this.db.prepare(`SELECT m.id AS id, m.embedding AS embedding FROM memories m WHERE m.deleted_at IS NOT NULL
      AND (m.deleted_by = ? OR EXISTS (SELECT 1 FROM profile_suggestions s WHERE s.memory_id = m.id AND s.action = 'delete' AND s.status = 'approved'))`)
      .all(OWNER_LABEL) as { id: string; embedding: Buffer }[];
    return rows.map((r) => ({ id: r.id, embedding: fromBlob(r.embedding) }));
  }

  ftsSearch(ftsQuery: string, f: Filter, limit: number): string[] {
    const fs = filterSql(f, 'm');
    const rows = this.db.prepare(
      `SELECT memories_fts.memory_id AS id FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id
       WHERE memories_fts MATCH ? AND m.deleted_at IS NULL${fs.sql}
       ORDER BY bm25(memories_fts) LIMIT ?`,
    ).all(ftsQuery, ...fs.params, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * "Still true": marks the memory as freshly reviewed, which keeps it off the stale list. Changes no content, so it
   * writes no history, and leaves updated_at alone: an old status confirmed as true must not become the latest word.
   */
  touch(id: string): void {
    this.db.prepare('UPDATE memories SET last_recalled_at = ? WHERE id = ? AND deleted_at IS NULL').run(this.ts(), id);
  }

  dismissPair(a: string, b: string): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare('INSERT OR IGNORE INTO dismissed_pairs(a, b) VALUES (?, ?)').run(x, y);
  }

  isDismissed(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db.prepare('SELECT 1 FROM dismissed_pairs WHERE a = ? AND b = ?').get(x, y) !== undefined;
  }

  dismissProjects(a: string, b: string): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare('INSERT OR IGNORE INTO dismissed_projects(a, b) VALUES (?, ?)').run(x, y);
  }

  isProjectPairDismissed(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db.prepare('SELECT 1 FROM dismissed_projects WHERE a = ? AND b = ?').get(x, y) !== undefined;
  }

  /**
   * Moves a project's active memories to another project name and returns how many moved. Each move is recorded
   * in history; updated_at stays, because the text did not change and statuses are ordered by it.
   */
  moveProject(from: string, to: string, by: string): number {
    return this.db.transaction(() => {
      // Replaced facts move with their project: they stay readable in its Replaced fold.
      const moving = this.list({ project: from, replaced: 'include' });
      const targetHeldNothing = this.list({ project: to, limit: 1, replaced: 'include' }).length === 0;
      for (const m of moving) {
        this.writeHistory(m, 'update', by);
        this.db.prepare('UPDATE memories SET project = ? WHERE id = ?').run(to, m.id);
        this.ftsReplace(m.id, m.content, to, m.tags);
      }
      if (moving.length > 0) this.mergeProjectRow(from, to, targetHeldNothing);
      this.ensureProject(moving.length > 0 ? to : null, 'decision', by);
      return moving.length;
    })();
  }

  /**
   * The latest changes, newest first: creations (from memories) and every edit, deletion and restore (from
   * memory_history). `content` is the memory's current text. A "Still true" confirmation is not an activity.
   */
  recentActivity(limit: number): ActivityRow[] {
    return this.db.prepare(
      `SELECT at, by, action, memoryId, content, kind FROM (
         SELECT m.created_at AS at, m.created_by AS by, 'created' AS action, m.id AS memoryId, m.content AS content, m.kind AS kind, 0 AS ord, m.rowid AS seq
           FROM memories m
         UNION ALL
         SELECT h.changed_at, h.changed_by,
                CASE h.action WHEN 'update' THEN 'updated' WHEN 'delete' THEN 'deleted' ELSE 'restored' END,
                h.memory_id, m.content, m.kind, 1, h.id
           FROM memory_history h JOIN memories m ON m.id = h.memory_id
         UNION ALL
         SELECT s.created_at, s.created_by, 'replaced', s.old_id, m.content, m.kind, 2, s.id
           FROM supersessions s JOIN memories m ON m.id = s.old_id
         UNION ALL
         SELECT s.undone_at, s.undone_by, 'brought back', s.old_id, m.content, m.kind, 2, s.id
           FROM supersessions s JOIN memories m ON m.id = s.old_id WHERE s.undone_at IS NOT NULL
       ) ORDER BY at DESC, ord DESC, seq DESC LIMIT ?`,
    ).all(limit) as ActivityRow[];
  }

  /**
   * recentActivity for one project (the desktop sheet's Lately): the same four kinds of change, each joined on the
   * memory's project, in the same order. One query, so a quiet project still shows its last changes.
   */
  projectActivity(project: string, limit: number): ActivityRow[] {
    return this.db.prepare(
      `SELECT at, by, action, memoryId, content, kind FROM (
         SELECT m.created_at AS at, m.created_by AS by, 'created' AS action, m.id AS memoryId, m.content AS content, m.kind AS kind, 0 AS ord, m.rowid AS seq
           FROM memories m WHERE m.project = ?
         UNION ALL
         SELECT h.changed_at, h.changed_by,
                CASE h.action WHEN 'update' THEN 'updated' WHEN 'delete' THEN 'deleted' ELSE 'restored' END,
                h.memory_id, m.content, m.kind, 1, h.id
           FROM memory_history h JOIN memories m ON m.id = h.memory_id WHERE m.project = ?
         UNION ALL
         SELECT s.created_at, s.created_by, 'replaced', s.old_id, m.content, m.kind, 2, s.id
           FROM supersessions s JOIN memories m ON m.id = s.old_id WHERE m.project = ?
         UNION ALL
         SELECT s.undone_at, s.undone_by, 'brought back', s.old_id, m.content, m.kind, 2, s.id
           FROM supersessions s JOIN memories m ON m.id = s.old_id WHERE s.undone_at IS NOT NULL AND m.project = ?
       ) ORDER BY at DESC, ord DESC, seq DESC LIMIT ?`,
    ).all(project, project, project, project, limit) as ActivityRow[];
  }

  /** Memories created in [start, end), deleted ones included, oldest first. */
  createdBetween(start: Date, end: Date): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid')
      .all(start.toISOString(), end.toISOString()) as MemoryRow[];
    return rows.map(toMemory);
  }

  /** Edits, deletions and restores in [start, end), oldest first. */
  historyBetween(start: Date, end: Date): HistoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memory_history WHERE changed_at >= ? AND changed_at < ? ORDER BY id')
      .all(start.toISOString(), end.toISOString()) as HistoryRow[];
    return rows.map(toHistory);
  }

  /** When each project got its first memory, deleted ones included. */
  projectsFirstSeen(): Map<string, string> {
    const rows = this.db.prepare('SELECT project, MIN(created_at) AS first FROM memories WHERE project IS NOT NULL GROUP BY project')
      .all() as { project: string; first: string }[];
    return new Map(rows.map((r) => [r.project, r.first]));
  }

  logToolCall(client: string, tool: string): void {
    this.db.prepare('INSERT INTO tool_calls(at, client, tool) VALUES (?, ?, ?)').run(this.ts(), client, tool);
  }

  /** When the first tool call was counted, or null before any. */
  firstToolCallAt(): string | null {
    return (this.db.prepare('SELECT MIN(at) AS at FROM tool_calls').get() as { at: string | null }).at;
  }

  toolCalls(start: Date, end: Date): { client: string; tool: string; count: number }[] {
    return this.db.prepare(
      'SELECT client, tool, COUNT(*) AS count FROM tool_calls WHERE at >= ? AND at < ? GROUP BY client, tool ORDER BY client, tool',
    ).all(start.toISOString(), end.toISOString()) as { client: string; tool: string; count: number }[];
  }

  /**
   * Changes whenever anything the tidy page's pair checks or the map depend on changes: memories added, edited, moved,
   * deleted or restored (count, latest update, latest history entry), and dismissed pairs. Not recalls: assistants
   * recall in nearly every session, and the pair checks cost seconds at a few thousand memories (see recallVersion).
   */
  memoryVersion(): string {
    const r = this.db.prepare(`SELECT (SELECT COUNT(*) FROM memories) AS n, (SELECT MAX(updated_at) FROM memories) AS u,
      (SELECT MAX(id) FROM memory_history) AS h,
      (SELECT COUNT(*) FROM dismissed_pairs) AS dp, (SELECT COUNT(*) FROM dismissed_projects) AS dj,
      (SELECT MAX(id) FROM supersessions) AS ss, (SELECT COUNT(*) FROM supersessions WHERE undone_at IS NOT NULL) AS su`).get() as Record<string, unknown>;
    return JSON.stringify(r);
  }

  /** Changes whenever a memory is recalled or confirmed "Still true": what the stale list depends on besides the memories. */
  recallVersion(): string {
    return String((this.db.prepare('SELECT MAX(last_recalled_at) AS r FROM memories').get() as { r: string | null }).r);
  }

  markRecalled(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE memories SET last_recalled_at = ? WHERE id = ?');
    const t = this.ts();
    this.db.transaction(() => { for (const id of ids) stmt.run(t, id); })();
  }

  /** Kind, project and reason default to a profile change. */
  addSuggestion(s: Omit<Suggestion, 'id' | 'suggestedAt' | 'status' | 'kind' | 'project' | 'reason' | 'supersedes' | 'deletedMatch'> & Partial<Pick<Suggestion, 'kind' | 'project' | 'reason' | 'supersedes' | 'deletedMatch'>>): Suggestion {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO profile_suggestions(id, action, memory_id, content, tags, kind, project, reason, suggested_at, suggested_by, supersedes, deleted_match) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, s.action, s.memoryId, s.content, JSON.stringify(s.tags), s.kind ?? 'profile', s.project ?? null, s.reason ?? null, this.ts(), s.suggestedBy, JSON.stringify(s.supersedes ?? []), s.deletedMatch ?? null);
    return this.getSuggestion(id)!;
  }

  listSuggestions(status: Suggestion['status']): Suggestion[] {
    const rows = this.db.prepare('SELECT * FROM profile_suggestions WHERE status = ? ORDER BY suggested_at, rowid')
      .all(status) as SuggestionRow[];
    return rows.map(toSuggestion);
  }

  getSuggestion(id: string): Suggestion | undefined {
    const r = this.db.prepare('SELECT * FROM profile_suggestions WHERE id = ?').get(id) as SuggestionRow | undefined;
    return r && toSuggestion(r);
  }

  resolveSuggestion(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare('UPDATE profile_suggestions SET status = ?, resolved_at = ? WHERE id = ?').run(status, this.ts(), id);
  }
}
