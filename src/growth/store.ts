import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { GrowthError, type Evidence, type GrowthArea, type GrowthKind, type Observation, type Reaction } from './types.js';

interface ObservationRow {
  id: string; kind: GrowthKind; area: GrowthArea; project: string | null; summary: string; practise: string | null;
  embedding: Buffer; evidence_count: number; reaction: Reaction | null; reacted_at: string | null;
  created_at: string; created_by: string; last_evidence_at: string;
}
interface EvidenceRow { id: number; what: string; project: string | null; added_by: string; added_at: string }

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

const toObservation = (r: ObservationRow): Observation => ({
  id: r.id, kind: r.kind, area: r.area, project: r.project, summary: r.summary, practise: r.practise,
  evidenceCount: r.evidence_count, reaction: r.reaction, reactedAt: r.reacted_at,
  createdAt: r.created_at, createdBy: r.created_by, lastEvidenceAt: r.last_evidence_at,
});

/** Observations and their evidence (migration 14). Checks live in GrowthService; this only reads and writes. */
export class GrowthStore {
  constructor(private db: DB, private now: Clock) {}

  private ts(): string {
    return this.now().toISOString();
  }

  private must(id: string): Observation {
    const o = this.get(id);
    if (!o) throw new GrowthError('not_found', `No observation with id ${id}`);
    return o;
  }

  insert(o: { kind: GrowthKind; area: GrowthArea; project: string | null; summary: string; practise: string | null; embedding: Float32Array; by: string; client?: string }): Observation {
    const id = randomUUID();
    const t = this.ts();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO observations(id, kind, area, project, summary, practise, embedding, created_at, created_by, created_by_client, last_evidence_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, o.kind, o.area, o.project, o.summary, o.practise, toBlob(o.embedding), t, o.by, o.client ?? null, t);
      this.db.prepare('INSERT INTO observation_evidence(observation_id, what, project, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, o.summary, o.project, o.by, t);
    })();
    return this.must(id);
  }

  addEvidence(id: string, e: { what: string; project: string | null; by: string }): Observation {
    this.must(id);
    const t = this.ts();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO observation_evidence(observation_id, what, project, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, e.what, e.project, e.by, t);
      this.db.prepare('UPDATE observations SET evidence_count = evidence_count + 1, last_evidence_at = ? WHERE id = ?').run(t, id);
    })();
    return this.must(id);
  }

  /** Observations a repeat could merge into: same kind, area and project (null matches null), evidence since `since`. */
  candidates(kind: GrowthKind, area: GrowthArea, project: string | null, since: string): { observation: Observation; embedding: Float32Array }[] {
    const rows = this.db.prepare(
      `SELECT * FROM observations WHERE kind = ? AND area = ? AND project IS ? AND last_evidence_at >= ?`,
    ).all(kind, area, project, since) as ObservationRow[];
    return rows.map((r) => ({ observation: toObservation(r), embedding: fromBlob(r.embedding) }));
  }

  get(id: string): Observation | undefined {
    const r = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRow | undefined;
    return r ? toObservation(r) : undefined;
  }

  /** Every observation, newest evidence first. */
  list(): Observation[] {
    return (this.db.prepare('SELECT * FROM observations ORDER BY last_evidence_at DESC, created_at DESC').all() as ObservationRow[]).map(toObservation);
  }

  /** How many observations there are, and how many of each kind still count (not disagreed with or dismissed). */
  counts(): { total: number; strengths: number; improve: number } {
    const r = this.db.prepare(`SELECT count(*) total,
      coalesce(sum(kind = 'strength' AND coalesce(reaction, '') NOT IN ('disagree', 'dismiss')), 0) strengths,
      coalesce(sum(kind = 'improve' AND coalesce(reaction, '') NOT IN ('disagree', 'dismiss')), 0) improve
      FROM observations`).get() as { total: number; strengths: number; improve: number };
    return { total: r.total, strengths: r.strengths, improve: r.improve };
  }

  /** An observation's evidence, oldest first. */
  evidence(id: string): Evidence[] {
    return (this.db.prepare('SELECT * FROM observation_evidence WHERE observation_id = ? ORDER BY id').all(id) as EvidenceRow[])
      .map((r) => ({ id: r.id, what: r.what, project: r.project, addedBy: r.added_by, addedAt: r.added_at }));
  }

  react(id: string, reaction: Reaction | null): Observation {
    this.must(id);
    this.db.prepare('UPDATE observations SET reaction = ?, reacted_at = ? WHERE id = ?').run(reaction, reaction ? this.ts() : null, id);
    return this.must(id);
  }

  /** How many new observations an assistant saved since `since` (evidence added to older ones doesn't count). */
  createdBySince(by: string, since: string): number {
    return (this.db.prepare('SELECT count(*) c FROM observations WHERE created_by = ? AND created_at >= ?').get(by, since) as { c: number }).c;
  }

  /**
   * The same count for one connection, by its OAuth client id, whatever it was called at the time. Rows saved before
   * connections had an id (migration 19) count by the name they were saved under.
   */
  createdByClientSince(client: string, by: string, since: string): number {
    return (this.db.prepare('SELECT count(*) c FROM observations WHERE (created_by_client = ? OR (created_by_client IS NULL AND created_by = ?)) AND created_at >= ?')
      .get(client, by, since) as { c: number }).c;
  }
}
