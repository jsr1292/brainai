/** Skills' rows (round 2 §17c): the skill, its files now, every version, and proposals. */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import type { Skill, SkillFile, SkillProposal, SkillVersion } from './types.js';

interface SkillRow {
  id: string; name: string; description: string; body: string; enabled: number; origin: string; version: number;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
  last_loaded_at: string | null; last_loaded_by: string | null; deleted_at: string | null;
}
interface ProposalRow {
  id: string; skill_id: string | null; name: string; description: string; body: string; files: string; base_version: number | null;
  proposed_by: string; proposed_at: string; status: SkillProposal['status'];
}

export class SkillStore {
  constructor(private readonly db: DB, private readonly now: Clock) {}

  ts(): string { return this.now().toISOString(); }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  private files(id: string): SkillFile[] {
    return this.db.prepare('SELECT path, text FROM skill_files WHERE skill_id = ? ORDER BY path').all(id) as SkillFile[];
  }
  private toSkill(r: SkillRow): Skill {
    return {
      id: r.id, name: r.name, description: r.description, body: r.body, enabled: r.enabled === 1, origin: r.origin, version: r.version,
      createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
      lastLoadedAt: r.last_loaded_at, lastLoadedBy: r.last_loaded_by, files: this.files(r.id),
    };
  }

  /** A live skill (not deleted). */
  get(id: string): Skill | undefined {
    const r = this.db.prepare('SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL').get(id) as SkillRow | undefined;
    return r ? this.toSkill(r) : undefined;
  }
  byName(name: string): Skill | undefined {
    const r = this.db.prepare('SELECT * FROM skills WHERE name = ? AND deleted_at IS NULL').get(name) as SkillRow | undefined;
    return r ? this.toSkill(r) : undefined;
  }
  list(onlyOn = false): Skill[] {
    return (this.db.prepare(`SELECT * FROM skills WHERE deleted_at IS NULL${onlyOn ? ' AND enabled = 1' : ''} ORDER BY name`).all() as SkillRow[]).map((r) => this.toSkill(r));
  }

  /** Writes the skill as given (a new row when `id` is unknown), its files, and a version row, in the caller's transaction. */
  write(s: { id: string; name: string; description: string; body: string; files: SkillFile[]; version: number; origin: string; enabled: boolean }, by: string): void {
    const t = this.ts();
    const exists = this.db.prepare('SELECT 1 FROM skills WHERE id = ?').get(s.id) !== undefined;
    if (exists) {
      this.db.prepare('UPDATE skills SET name = ?, description = ?, body = ?, version = ?, enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(s.name, s.description, s.body, s.version, s.enabled ? 1 : 0, t, by, s.id);
    } else {
      this.db.prepare(`INSERT INTO skills(id, name, description, body, enabled, origin, version, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.name, s.description, s.body, s.enabled ? 1 : 0, s.origin, s.version, t, by, t, by);
    }
    this.db.prepare('DELETE FROM skill_files WHERE skill_id = ?').run(s.id);
    const file = this.db.prepare('INSERT INTO skill_files(skill_id, path, text) VALUES (?, ?, ?)');
    for (const f of s.files) file.run(s.id, f.path, f.text);
    this.db.prepare('INSERT INTO skill_versions(skill_id, version, name, description, body, files, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.version, s.name, s.description, s.body, JSON.stringify(s.files), t, by);
  }

  setEnabled(id: string, on: boolean, by: string): void {
    this.db.prepare('UPDATE skills SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(on ? 1 : 0, this.ts(), by, id);
  }
  remove(id: string): void {
    this.db.prepare('UPDATE skills SET deleted_at = ?, enabled = 0 WHERE id = ?').run(this.ts(), id);
  }
  recordLoad(id: string, by: string): void {
    this.db.prepare('UPDATE skills SET last_loaded_at = ?, last_loaded_by = ? WHERE id = ?').run(this.ts(), by, id);
  }

  versions(id: string): SkillVersion[] {
    return (this.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(id) as { version: number; name: string; description: string; body: string; files: string; saved_at: string; saved_by: string }[])
      .map((r) => ({ version: r.version, name: r.name, description: r.description, body: r.body, files: JSON.parse(r.files) as SkillFile[], savedAt: r.saved_at, savedBy: r.saved_by }));
  }

  private toProposal(r: ProposalRow): SkillProposal {
    return { id: r.id, skillId: r.skill_id, name: r.name, description: r.description, body: r.body, files: JSON.parse(r.files) as SkillFile[], baseVersion: r.base_version, proposedBy: r.proposed_by, proposedAt: r.proposed_at, status: r.status };
  }
  addProposal(p: Omit<SkillProposal, 'id' | 'proposedAt' | 'status'>): SkillProposal {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO skill_proposals(id, skill_id, name, description, body, files, base_version, proposed_by, proposed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, p.skillId, p.name, p.description, p.body, JSON.stringify(p.files), p.baseVersion, p.proposedBy, this.ts());
    return this.proposal(id)!;
  }
  proposal(id: string): SkillProposal | undefined {
    const r = this.db.prepare('SELECT * FROM skill_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return r ? this.toProposal(r) : undefined;
  }
  pendingProposals(): SkillProposal[] {
    return (this.db.prepare("SELECT * FROM skill_proposals WHERE status = 'pending' ORDER BY proposed_at, id").all() as ProposalRow[]).map((r) => this.toProposal(r));
  }
  resolveProposal(id: string, status: SkillProposal['status']): void {
    this.db.prepare('UPDATE skill_proposals SET status = ? WHERE id = ?').run(status, id);
  }
}
