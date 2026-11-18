import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { splitSections } from '../pages/markdown.js';
import type { PageService } from '../pages/service.js';
import { PageError } from '../pages/types.js';
import { MemoryError, type MemoryService } from './service.js';
import type { MemoryStore } from './store.js';
import { MAX_SUPERSEDES, replaceableKind } from './supersessions.js';
import { buildClusters, MAX_CLUSTER, type TidyCluster } from './tidyClusters.js';
import { OWNER_LABEL, type Memory } from './types.js';

/**
 * B2: assistant-run tidy sessions. The server does the cheap, deterministic half on demand only (clusters of facts, built
 * when an assistant asks and cached until the memories change; never on a timer, never on a page load); an assistant the
 * owner started proposes; the owner approves in the Inbox; nothing is destroyed.
 */

export const MAX_MERGE_CHARS = 1000;
export const MAX_REASON_CHARS = 500;
/** Proposals waiting at once: a runaway assistant cannot bury the Inbox. */
export const MAX_PENDING_TIDY = 50;
export const KEY_DECISIONS = 'key-decisions';

export type TidyBody =
  | { type: 'supersede'; keepId: string; replacedIds: string[] }
  | { type: 'merge'; ids: string[]; content: string; kind: 'decision' | 'summary' }
  | { type: 'move_to_page'; ids: string[]; pageId: string; section: string; baseVersion: number; sectionHash: string }
  | { type: 'keep'; ids: string[] };

export interface TidyProposal {
  id: string; project: string; body: TidyBody; stamps: Record<string, string>; reason: string;
  proposedBy: string; proposedAt: string; status: 'pending' | 'approved' | 'rejected'; decidedAt: string | null;
  result: { rows?: number[]; mergedId?: string; page?: number; retired?: string[] } | null;
}
interface Row {
  id: string; project: string; kind: string; payload: string; stamps: string; reason: string; proposed_by: string; proposed_at: string;
  status: TidyProposal['status']; decided_at: string | null; result: string | null;
}
const toProposal = (r: Row): TidyProposal => ({
  id: r.id, project: r.project, body: JSON.parse(r.payload) as TidyBody, stamps: JSON.parse(r.stamps) as Record<string, string>, reason: r.reason,
  proposedBy: r.proposed_by, proposedAt: r.proposed_at, status: r.status, decidedAt: r.decided_at, result: r.result === null ? null : JSON.parse(r.result) as TidyProposal['result'],
});

export class TidyError extends Error {
  constructor(public code: 'invalid' | 'not_found' | 'changed' | 'page' | 'answered', message: string) {
    super(message);
    this.name = 'TidyError';
  }
}
/** The heading of a page section as the page shows it ("Key decisions"), not its anchor ("key-decisions"). */
export function sectionTitle(body: string, anchor: string): string {
  const s = splitSections(body).find((x) => x.anchor === anchor);
  return s?.heading.trim() || `${anchor.charAt(0).toUpperCase()}${anchor.slice(1).replace(/-/g, ' ')}`;
}

/**
 * How a page's Key decisions lines write the date: the separator after it ("2026-11-11: text", "2026-11-11 — text" or
 * "2026-11-11 text"), taken from the first dated line already there; with none, the plain "date text" form the page reads as a timeline.
 */
export function lineStyle(sectionText: string): string {
  const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\d{4}-\d{2}-\d{2}(:|\s+[—–-](?=\s))?(?=\s|$)/m.exec(sectionText);
  return m === null ? ' ' : m[1] === ':' ? ': ' : m[1] === undefined ? ' ' : ' — ';
}

/** One line for a moved decision: its date, its text once, and a link to the fact (it works for a retired one too). */
export function moveLine(m: Pick<Memory, 'id' | 'createdAt' | 'content'>, style: string): string {
  return `- ${m.createdAt.slice(0, 10)}${style}${oneLine(m.content)} [[fact:${m.id}|fact]]`;
}

export const CHANGED_SINCE = 'These facts changed since the proposal. Ask the assistant to look again.';

/** The facts a proposal touches. */
export const factsOf = (b: TidyBody): string[] => (b.type === 'supersede' ? [b.keepId, ...b.replacedIds] : b.ids);

export const ALLOWED_PROPOSALS = [
  'supersede: {keep_id, replaced_ids[]} (the kept fact replaces the others; they stay as replaced history)',
  'merge: {ids[], content, kind} (one new fact replaces them all; they stay as replaced history)',
  `move_to_page: {ids[], page_id, section?} (appends one line per decision to the page's Key decisions; the facts stay)`,
  'keep: {ids[]} (mark as looked at: not offered again until one of them changes)',
] as const;

const sha = (t: string): string => createHash('sha1').update(t).digest('hex');
const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

export interface ClusterView {
  id: string; project: string; why: TidyCluster['why']; because: string;
  facts: { id: string; kind: 'decision' | 'status'; content: string; date: string; updated_at: string; keys?: string; tags: string[]; valid_until?: string; source?: string; source_by?: string; role?: 'newest_status' }[];
}
export interface SessionStep { cluster: ClusterView; cursor: string; remaining: number; total: number }

export class TidyService {
  /** Bumped by every change here: part of the cache key (the memories' own changes are in memoryVersion). */
  private rev = 0;
  private cache = new Map<string, { key: string; clusters: TidyCluster[]; total: number }>();
  /** The group order the last session answer was taken from, per project: where a cursor whose group has gone stood. */
  private lastOrder = new Map<string, string[]>();

  constructor(private d: {
    db: DB; store: MemoryStore; service: MemoryService; pages: PageService; now: Clock;
    /** The embedding profile's cut-offs, read at each use (the search model in use decides them). */
    cuts: () => { related: number; duplicate: number };
  }) {}

  // ---- rows ----
  private ts(): string { return this.d.now().toISOString(); }
  get(id: string): TidyProposal | undefined {
    const r = this.d.db.prepare('SELECT * FROM tidy_proposals WHERE id = ?').get(id) as Row | undefined;
    return r && toProposal(r);
  }
  /** Waiting for the owner, oldest first. */
  pending(): TidyProposal[] {
    return (this.d.db.prepare("SELECT * FROM tidy_proposals WHERE status = 'pending' ORDER BY proposed_at, rowid").all() as Row[]).map(toProposal);
  }
  pendingCount(): number {
    return (this.d.db.prepare("SELECT COUNT(*) AS n FROM tidy_proposals WHERE status = 'pending'").get() as { n: number }).n;
  }
  private looked(): Map<string, string> {
    return new Map((this.d.db.prepare('SELECT fact_id, stamp FROM tidy_looked').all() as { fact_id: string; stamp: string }[]).map((r) => [r.fact_id, r.stamp]));
  }
  private markLooked(ids: string[], stamps: Record<string, string>, by: string): void {
    const put = this.d.db.prepare('INSERT INTO tidy_looked(fact_id, stamp, looked_at, looked_by) VALUES (?, ?, ?, ?) ON CONFLICT(fact_id) DO UPDATE SET stamp = excluded.stamp, looked_at = excluded.looked_at, looked_by = excluded.looked_by');
    for (const id of ids) put.run(id, stamps[id]!, this.ts(), by);
    this.rev++;
  }
  isLooked(id: string): boolean {
    const m = this.d.store.get(id);
    const r = this.d.db.prepare('SELECT stamp FROM tidy_looked WHERE fact_id = ?').get(id) as { stamp: string } | undefined;
    return !!m && !!r && r.stamp === m.updatedAt;
  }
  private setStatus(id: string, status: TidyProposal['status'], result: TidyProposal['result'] = null): void {
    this.d.db.prepare('UPDATE tidy_proposals SET status = ?, decided_at = ?, result = ? WHERE id = ?')
      .run(status, status === 'pending' ? null : this.ts(), result === null ? null : JSON.stringify(result), id);
    this.rev++;
  }

  // ---- the session (the deterministic half) ----
  private pendingFactIds(): Set<string> {
    return new Set(this.pending().flatMap((p) => factsOf(p.body)));
  }

  private clustersFor(project: string): { clusters: TidyCluster[]; total: number } {
    const cuts = this.d.cuts();
    const key = `${this.d.store.memoryVersion()}|${this.rev}|${cuts.related}|${cuts.duplicate}`;
    const hit = this.cache.get(project);
    if (hit && hit.key === key) return hit;
    const memories = this.d.store.list({ project });
    const vectors = new Map(this.d.store.activeEmbeddings({ project }).map((e) => [e.id, e.embedding]));
    const waiting = this.pendingFactIds();
    const looked = this.looked();
    const made = buildClusters(
      memories.filter((m) => vectors.has(m.id)).map((memory) => ({ memory, embedding: vectors.get(memory.id)! })),
      {
        project, related: cuts.related, duplicate: cuts.duplicate,
        excluded: (m) => waiting.has(m.id), looked: (m) => looked.get(m.id) === m.updatedAt,
        dismissed: (a, b) => this.d.store.isDismissed(a.id, b.id),
      },
    );
    const entry = { key, ...made };
    this.cache.set(project, entry);
    return entry;
  }

  private view(c: TidyCluster): ClusterView {
    return {
      id: c.id, project: c.project, why: c.why, because: c.because,
      facts: c.ids.map((id) => {
        const m = this.d.store.get(id)!;
        return {
          id, kind: replaceableKind(m) === 'status' ? 'status' : 'decision', content: m.content, date: m.createdAt.slice(0, 10), updated_at: m.updatedAt,
          ...(m.keys === '' ? {} : { keys: m.keys }), tags: m.tags,
          ...(m.validUntil ? { valid_until: m.validUntil } : {}),
          ...(m.source ? { source: m.source, ...(m.sourceBy ? { source_by: m.sourceBy } : {}) } : {}),
          ...(c.newestStatusId === id ? { role: 'newest_status' as const } : {}),
        };
      }),
    };
  }

  /** The next group of facts worth a look in this project, after `cursor` (the id of the one handled before); null when none. */
  session(project: string, cursor?: string): SessionStep | null {
    const name = this.d.service.projectNamed(project);
    const { clusters, total } = this.clustersFor(name);
    const before = this.lastOrder.get(name) ?? [];
    let at = cursor === undefined ? -1 : clusters.findIndex((c) => c.id === cursor);
    let next: TidyCluster | undefined;
    let remaining: number;
    if (cursor !== undefined && at < 0 && before.includes(cursor)) {
      // The group just handled is gone (its facts left the pool after a proposal): carry on from where it stood, not from the top.
      const done = new Set(before.slice(0, before.indexOf(cursor) + 1));
      const rest = clusters.filter((c) => !done.has(c.id));
      next = rest[0];
      remaining = rest.length - 1;
    } else {
      next = clusters[at + 1];
      remaining = total - at - 2;
    }
    if (!next) return null;
    this.lastOrder.set(name, clusters.map((c) => c.id));
    return { cluster: this.view(next), cursor: next.id, remaining, total };
  }

  /** A group as the last session built it, by id (any project). */
  private clusterById(id: string): TidyCluster | undefined {
    for (const project of [...this.cache.keys()]) {
      const c = this.clustersFor(project).clusters.find((x) => x.id === id);
      if (c) return c;
    }
    return undefined;
  }

  // ---- proposing ----
  private current(id: string): Memory {
    const m = this.d.store.get(id);
    if (!m || m.deletedAt) throw new TidyError('not_found', `No current fact ${id}. Call tidy_session again.`);
    if (this.d.store.supersessions.liveFor(id)) throw new TidyError('changed', `Fact ${id} was replaced meanwhile. Call tidy_session again.`);
    if (replaceableKind(m) === null) throw new TidyError('invalid', `Fact ${id} is a ${m.kind}: tidy only handles decisions and statuses.`);
    return m;
  }

  propose(input: {
    clusterId?: string; ids?: string[];
    proposal: { supersede?: { keep_id: string; replaced_ids: string[] }; merge?: { ids: string[]; content: string; kind: string }; move_to_page?: { ids: string[]; page_id: string; section?: string }; keep?: { ids: string[] } };
    reason: string;
  }, by: string): TidyProposal {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '' || reason.length > MAX_REASON_CHARS) throw new TidyError('invalid', `reason: say why, in 1 to ${MAX_REASON_CHARS} characters.`);
    const kinds = (['supersede', 'merge', 'move_to_page', 'keep'] as const).filter((k) => input.proposal?.[k] !== undefined);
    if (kinds.length !== 1) throw new TidyError('invalid', `proposal: give exactly one of supersede, merge, move_to_page, keep (got ${kinds.length === 0 ? 'none' : kinds.join(' and ')}).`);
    // The group the proposal is about: its facts are the most it may touch.
    let scope: string[];
    if (input.clusterId !== undefined) {
      const c = this.clusterById(input.clusterId);
      if (!c) throw new TidyError('not_found', `No group ${input.clusterId} any more (the facts changed, or it was handled). Call tidy_session again.`);
      scope = c.ids;
    } else if (input.ids !== undefined && input.ids.length > 0) scope = [...new Set(input.ids)];
    else throw new TidyError('invalid', 'Give cluster_id (from tidy_session) or ids.');
    const unique = (ids: string[], what: string, max: number, min = 1): string[] => {
      const u = [...new Set(ids)];
      if (u.length < min || u.length > max) throw new TidyError('invalid', `${what}: ${min === max ? `exactly ${min}` : `${min} to ${max}`} different fact ids (got ${u.length}).`);
      const outside = u.filter((id) => !scope.includes(id));
      if (outside.length > 0) throw new TidyError('invalid', `${what}: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the group you gave.`);
      return u;
    };
    let body: TidyBody;
    const p = input.proposal;
    if (p.supersede) {
      const replacedIds = unique(p.supersede.replaced_ids ?? [], 'replaced_ids', MAX_SUPERSEDES);
      const keepId = p.supersede.keep_id;
      if (replacedIds.includes(keepId)) throw new TidyError('invalid', 'keep_id cannot also be in replaced_ids.');
      unique([keepId], 'keep_id', 1);
      body = { type: 'supersede', keepId, replacedIds };
    } else if (p.merge) {
      const ids = unique(p.merge.ids ?? [], 'merge.ids', MAX_SUPERSEDES, 2);
      const content = typeof p.merge.content === 'string' ? p.merge.content.replace(/\r\n?/g, '\n').trim() : '';
      if (content === '' || content.length > MAX_MERGE_CHARS) throw new TidyError('invalid', `merge.content: 1 to ${MAX_MERGE_CHARS} characters (got ${content.length}).`);
      if (p.merge.kind !== 'decision' && p.merge.kind !== 'summary') throw new TidyError('invalid', 'merge.kind: "decision" or "summary" (a status).');
      body = { type: 'merge', ids, content, kind: p.merge.kind };
    } else if (p.move_to_page) {
      const ids = unique(p.move_to_page.ids ?? [], 'move_to_page.ids', MAX_CLUSTER);
      const page = this.d.pages.get(p.move_to_page.page_id);
      if (!page || page.deletedAt) throw new TidyError('not_found', `No page ${p.move_to_page.page_id}.`);
      const section = p.move_to_page.section ?? KEY_DECISIONS;
      const found = splitSections(page.body).find((s) => s.anchor === section);
      if (!found) throw new TidyError('not_found', `Page ${page.id} has no section ${section}; its sections are: ${splitSections(page.body).map((s) => s.anchor).join(', ')}.`);
      body = { type: 'move_to_page', ids, pageId: page.id, section, baseVersion: page.version, sectionHash: sha(this.sectionText(page.body, section)) };
    } else {
      body = { type: 'keep', ids: unique(p.keep!.ids ?? [], 'keep.ids', 50) };
    }
    // Every fact it touches: current, in one project, decision or status, not waiting in another proposal.
    const touched = factsOf(body);
    const facts = touched.map((id) => this.current(id));
    const projects = new Set(facts.map((m) => m.project));
    if (projects.size !== 1 || facts[0]!.project === null) throw new TidyError('invalid', 'All the facts must be in one project.');
    const project = this.d.service.projectNamed(facts[0]!.project!);
    const waiting = this.pendingFactIds();
    const busy = touched.filter((id) => waiting.has(id));
    if (busy.length > 0) throw new TidyError('invalid', `${busy.join(', ')} already ${busy.length === 1 ? 'waits' : 'wait'} in another proposal for the owner.`);
    if (this.pendingCount() >= MAX_PENDING_TIDY) throw new TidyError('invalid', `${MAX_PENDING_TIDY} tidy proposals already wait for the owner. Ask the owner to answer them first.`);
    try {
      if (body.type === 'supersede') this.d.service.checkReplacement(body.replacedIds, this.d.store.get(body.keepId)!);
      else if (body.type === 'merge') {
        if (body.ids.some((id) => (replaceableKind(this.d.store.get(id)!) === 'status') !== (body.kind === 'summary'))) {
          throw new TidyError('invalid', 'merge.kind must match the facts: "decision" for decisions, "summary" for statuses.');
        }
        this.d.service.checkReplacement(body.ids, { kind: body.kind, tags: [], project: facts[0]!.project });
      } else if (body.type === 'move_to_page') {
        const page = this.d.pages.get(body.pageId)!;
        if (page.project === null || this.d.service.projectNamed(page.project) !== project) throw new TidyError('invalid', `Page ${page.id} belongs to ${page.project ?? 'no project'}, not ${project}.`);
        const status = facts.filter((m) => replaceableKind(m) !== 'decision');
        if (status.length > 0) throw new TidyError('invalid', `${status.map((m) => m.id).join(', ')} ${status.length === 1 ? 'is a status' : 'are statuses'}: only decisions go to Key decisions.`);
        const there = facts.filter((m) => page.body.includes(`[[fact:${m.id}]]`) || page.body.includes(`[[fact:${m.id}|`));
        if (there.length > 0) throw new TidyError('invalid', `${there.map((m) => m.id).join(', ')} already ${there.length === 1 ? 'has' : 'have'} a line on that page.`);
      }
    } catch (e) {
      if (e instanceof MemoryError) throw new TidyError('invalid', e.message);
      throw e;
    }
    if (body.type === 'merge') {
      // Secrets and size are checked with the same rules as a save.
      try { void this.d.service.checkContentOf(body.content, body.kind); } catch (e) { if (e instanceof MemoryError) throw new TidyError('invalid', e.message); throw e; }
    }
    const stamps = Object.fromEntries(facts.map((m) => [m.id, m.updatedAt]));
    const id = randomUUID().slice(0, 8);
    this.d.db.prepare(`INSERT INTO tidy_proposals(id, project, kind, payload, stamps, reason, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, project, body.type, JSON.stringify(body), JSON.stringify(stamps), reason, by, this.ts());
    this.rev++;
    return this.get(id)!;
  }

  // ---- answering ----
  /** Why a waiting proposal can no longer be applied, or null. */
  staleReason(p: TidyProposal): string | null {
    for (const id of factsOf(p.body)) {
      const m = this.d.store.get(id);
      if (!m || m.deletedAt || m.updatedAt !== p.stamps[id] || this.d.store.supersessions.liveFor(id)) return CHANGED_SINCE;
    }
    if (p.body.type === 'move_to_page') {
      const page = this.d.pages.get(p.body.pageId);
      if (!page || page.deletedAt) return 'The page is gone. Ask the assistant to look again.';
      if (page.project === null || this.d.service.projectNamed(page.project) !== this.d.service.projectNamed(p.project)) return `The page now belongs to ${page.project ?? 'no project'}, not ${p.project}. Ask the assistant to look again.`;
    }
    return null;
  }

  /** A fact's text when the proposal was made: the oldest earlier version saved after it, else the text it has now (null: the fact is gone). */
  textAtProposal(p: TidyProposal, id: string): string | null {
    const m = this.d.store.get(id);
    if (!m) return null;
    const after = this.d.store.history(id).filter((h) => h.changedAt > p.proposedAt).sort((a, b) => a.id - b.id)[0];
    return after ? after.content : m.content;
  }

  /** What became of a fact since the proposal: unchanged, edited, replaced or gone. */
  factNow(p: TidyProposal, id: string): 'same' | 'edited' | 'replaced' | 'gone' {
    const m = this.d.store.get(id);
    if (!m || m.deletedAt) return 'gone';
    if (this.d.store.supersessions.liveFor(id)) return 'replaced';
    return m.updatedAt !== p.stamps[id] ? 'edited' : 'same';
  }

  /** The text of a section, heading included, as the page holds it. */
  private sectionText(body: string, anchor: string): string {
    const s = splitSections(body).find((x) => x.anchor === anchor);
    return s ? body.split('\n').slice(s.start, s.end).join('\n').replace(/\s+$/, '') : '';
  }

  private pendingOf(id: string): TidyProposal {
    const p = this.get(id);
    if (!p) throw new TidyError('not_found', 'No such tidy proposal.');
    if (p.status !== 'pending') throw new TidyError('answered', 'That tidy proposal was already answered.');
    return p;
  }

  /** Applies a waiting proposal as the owner. `retire`: for move_to_page, also move the facts to Deleted (they can be restored). */
  async approve(id: string, o: { retire?: boolean } = {}): Promise<{ message: string; undoable: boolean }> {
    const p = this.pendingOf(id);
    const stale = this.staleReason(p);
    if (stale) throw new TidyError('changed', stale);
    const b = p.body;
    const owner = { type: 'owner' as const };
    try {
      if (b.type === 'supersede') {
        const rows = this.d.service.supersede(b.replacedIds, b.keepId, owner, 'owner').map((r) => r.id);
        this.setStatus(id, 'approved', { rows });
        return { message: `Done: ${b.replacedIds.length === 1 ? '1 fact is' : `${b.replacedIds.length} facts are`} now replaced by the one you kept. They stay as history.`, undoable: true };
      }
      if (b.type === 'merge') {
        const made = await this.d.service.mergeFacts({ ids: b.ids, content: b.content, kind: b.kind, by: p.proposedBy, replacedBy: OWNER_LABEL });
        this.setStatus(id, 'approved', { rows: made.rows.map((r) => r.id), mergedId: made.memory.id });
        return { message: `Done: ${b.ids.length} facts are replaced by one merged fact. They stay as history.`, undoable: true };
      }
      if (b.type === 'keep') {
        this.markLooked(b.ids, p.stamps, OWNER_LABEL);
        this.setStatus(id, 'approved');
        return { message: 'Marked as looked at. They are not offered again until one of them changes.', undoable: false };
      }
      // move_to_page
      const page = this.d.pages.get(b.pageId)!;
      const text = this.sectionText(page.body, b.section);
      if (text === '') throw new TidyError('page', `The page no longer has a section ${b.section}. Ask the assistant to look again.`);
      // Another section may have changed; this one must be as the proposal saw it.
      if (page.version !== b.baseVersion && sha(text) !== b.sectionHash) {
        throw new TidyError('page', `The page changed since the proposal (now version ${page.version}) and its ${b.section} section is not as it was. Ask the assistant again.`);
      }
      const style = lineStyle(text);
      const lines = b.ids.map((fid) => moveLine(this.d.store.get(fid)!, style));
      const saved = await this.d.pages.saveSection(page.id, { base: page.version, anchor: b.section, text: `${text}\n${lines.join('\n')}` }, OWNER_LABEL);
      const retired: string[] = [];
      for (const fid of b.ids) if (o.retire) { this.d.service.retireToPage(fid, `${saved.title} › ${sectionTitle(page.body, b.section)}`, owner); retired.push(fid); }
      if (!o.retire) this.markLooked(b.ids, p.stamps, OWNER_LABEL);
      this.setStatus(id, 'approved', { page: saved.version, ...(retired.length > 0 ? { retired } : {}) });
      return { message: `Added ${lines.length === 1 ? '1 line' : `${lines.length} lines`} to ${saved.title}, ${sectionTitle(page.body, b.section)} (version ${saved.version}).${o.retire ? ' The facts moved to Deleted (you can restore them), and that does not count as forgetting them.' : ' The facts stay.'}`, undoable: false };
    } catch (e) {
      if (e instanceof PageError) throw new TidyError('page', e.message);
      if (e instanceof MemoryError) throw new TidyError('changed', `${e.message} Ask the assistant to look again.`);
      throw e;
    }
  }

  reject(id: string): void {
    this.pendingOf(id);
    this.setStatus(id, 'rejected');
  }

  /** Undo of a rejection: it waits again. */
  reopenRejected(id: string): void {
    const p = this.get(id);
    if (!p || p.status !== 'rejected') throw new TidyError('invalid', 'That tidy proposal was not rejected.');
    this.setStatus(id, 'pending');
  }

  /** Takes back an approved supersede or merge when that is still clean; the proposal waits again. */
  undoApproved(id: string): void {
    const p = this.get(id);
    if (!p || p.status !== 'approved' || !p.result?.rows) throw new TidyError('invalid', 'That can no longer be undone.');
    try {
      if (p.body.type === 'merge' && p.result.mergedId) this.d.service.undoMerge(p.result.mergedId, p.result.rows);
      else if (p.body.type === 'supersede') {
        const rows = p.result.rows.map((r) => this.d.store.supersessions.get(r));
        if (rows.some((r) => !r || r.undoneAt !== null)) throw new MemoryError('invalid', 'That can no longer be undone: a replacement was already brought back.');
        for (const r of p.result.rows) this.d.service.undoSupersession(r, { type: 'owner' });
      } else throw new TidyError('invalid', 'That can no longer be undone.');
    } catch (e) {
      if (e instanceof MemoryError) throw new TidyError('invalid', e.message);
      throw e;
    }
    this.setStatus(id, 'pending');
  }
}
