/**
 * Shared skills (round 2 §17c): the owner's how-tos, written once in the brain and loaded by every assistant. Skills
 * have their own tables, not pages, so they reach assistants only through load_profile (names and short descriptions), list_skills and load_skill, and only when the
 * owner turned them on. Assistants propose; the owner adds or applies.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { SayableError, type Say } from '../i18n/errors.js';
import { BRAINAI_NAME, posesAsBrainAI } from '../memory/types.js';
import { findSecret } from '../memory/secrets.js';
import { MAX_BODY } from '../pages/types.js';
import { SkillStore } from './store.js';
import {
  MAX_PENDING_PROPOSALS, MAX_SKILL_BYTES, MAX_SKILL_DESCRIPTION, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, MAX_SKILL_NAME, SKILL_NAME_RE, skillFilePathOk,
  type Skill, type SkillFile, type SkillProposal, type SkillVersion,
} from './types.js';

export class SkillError extends SayableError {
  constructor(public code: 'invalid' | 'not_found' | 'secret_detected' | 'changed', message: string, say?: Say) {
    super(message, say);
    this.name = 'SkillError';
  }
}

export interface SkillInput { name: string; description: string; body: string; files?: SkillFile[] }

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

export class SkillService {
  private readonly store: SkillStore;
  constructor(db: DB, now: Clock) {
    this.store = new SkillStore(db, now);
  }

  /** Checks one skill's text; returns it trimmed the way it is stored. Throws SkillError. */
  private check(input: SkillInput, selfId?: string): Required<SkillInput> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_SKILL_NAME || !SKILL_NAME_RE.test(name)) {
      throw new SkillError('invalid', `A skill's name is lowercase letters, digits and single hyphens, at most ${MAX_SKILL_NAME} characters (like release-notes).`, { key: 'err.skill.nameRule', params: { max: MAX_SKILL_NAME } });
    }
    const taken = this.store.byName(name);
    if (taken && taken.id !== selfId) throw new SkillError('invalid', `A skill named ${name} already exists.`, { key: 'err.skill.nameTaken', params: { name } });
    const description = input.description.trim();
    if (description.length === 0 || description.length > MAX_SKILL_DESCRIPTION) {
      throw new SkillError('invalid', `A skill's description says when to use it, in 1 to ${MAX_SKILL_DESCRIPTION} characters.`, { key: 'err.skill.descRule', params: { max: MAX_SKILL_DESCRIPTION } });
    }
    const body = input.body.replace(/\s+$/, '');
    if (body.length > MAX_BODY) throw new SkillError('invalid', `A skill's text is at most ${MAX_BODY.toLocaleString('en-GB')} characters.`, { key: 'err.skill.bodyMax', params: { max: MAX_BODY } });
    const files = input.files ?? [];
    if (files.length > MAX_SKILL_FILES) throw new SkillError('invalid', `A skill holds at most ${MAX_SKILL_FILES} files.`, { key: 'err.skill.tooManyFiles', params: { max: MAX_SKILL_FILES } });
    const seen = new Set<string>();
    let total = 0;
    for (const f of files) {
      if (f.path.length === 0 || f.path.length > 200 || !skillFilePathOk(f.path)) {
        throw new SkillError('invalid', `“${f.path}” is not a file path a skill can hold: use folders and names of letters, digits, dots, hyphens and underscores, like references/palette.md.`, { key: 'err.skill.badPath', params: { path: f.path } });
      }
      if (seen.has(f.path)) throw new SkillError('invalid', `${f.path} is there twice.`, { key: 'err.skill.pathTwice', params: { path: f.path } });
      seen.add(f.path);
      if (f.text.includes('\u0000')) throw new SkillError('invalid', 'Skills hold text files only.', { key: 'err.skill.textOnly' });
      if (bytes(f.text) > MAX_SKILL_FILE_BYTES) throw new SkillError('invalid', `${f.path} is over ${MAX_SKILL_FILE_BYTES / 1024} KB.`, { key: 'err.skill.fileTooBig', params: { path: f.path, max: MAX_SKILL_FILE_BYTES / 1024 } });
      total += bytes(f.text);
    }
    // A file can't also be a folder of another one (a and a/b.md), nor differ from another only in case (A.txt and
    // a.txt): a Mac's disk ignores case, so the export and the sync couldn't write both (audit F08).
    const folded = [...seen].map((p) => p.toLowerCase());
    if (new Set(folded).size !== folded.length) throw new SkillError('invalid', 'Two file paths differ only in upper and lower case.', { key: 'err.skill.caseClash' });
    for (const p of folded) if (folded.some((q) => q.startsWith(`${p}/`))) throw new SkillError('invalid', `${p} is both a file and a folder.`, { key: 'err.skill.fileAndFolder', params: { path: p } });
    if (total > MAX_SKILL_BYTES) throw new SkillError('invalid', `A skill's files add up to at most ${MAX_SKILL_BYTES / 1024} KB.`, { key: 'err.skill.totalBig', params: { max: MAX_SKILL_BYTES / 1024 } });
    for (const [where, text] of [['the skill', `${description}\n${body}`] as const, ...files.map((f) => [f.path, f.text] as const)]) {
      const found = findSecret(text);
      if (found) throw new SkillError('secret_detected', `Not saved: ${where} looks like it holds a secret (${found.reason}).`, { key: 'err.skill.secret', params: { where, reason: found.reason } });
    }
    return { name, description, body, files: [...files].sort((a, b) => a.path.localeCompare(b.path)) };
  }

  private must(id: string): Skill {
    const s = this.store.get(id);
    if (!s) throw new SkillError('not_found', 'No such skill.', { key: 'err.skill.noSuch' });
    return s;
  }

  create(input: SkillInput, by: string, origin = 'here'): Skill {
    const id = randomUUID();
    return this.store.atomic(() => {
      const s = this.check(input);
      this.store.write({ id, ...s, version: 1, origin, enabled: false }, by);
      return this.must(id);
    });
  }

  update(id: string, input: { base: number; name?: string; description?: string; body?: string; files?: SkillFile[] }, by: string): Skill {
    return this.store.atomic(() => {
      const cur = this.must(id);
      if (input.base !== cur.version) throw new SkillError('changed', `This skill changed meanwhile (now version ${cur.version}).`, { key: 'err.skill.changedMeanwhile', params: { version: cur.version } });
      const s = this.check({ name: input.name ?? cur.name, description: input.description ?? cur.description, body: input.body ?? cur.body, files: input.files ?? cur.files }, id);
      this.store.write({ id, ...s, version: cur.version + 1, origin: cur.origin, enabled: cur.enabled }, by);
      return this.must(id);
    });
  }

  setEnabled(id: string, on: boolean, by: string): Skill {
    this.must(id);
    this.store.setEnabled(id, on, by);
    return this.must(id);
  }

  remove(id: string, _by: string): void {
    this.must(id);
    this.store.remove(id);
  }

  /** Deleted skills, newest deletion first: they can be brought back (see `undelete`). */
  deleted(): (Skill & { deletedAt: string })[] { return this.store.deleted(); }
  deletedOne(id: string): (Skill & { deletedAt: string }) | undefined { return this.store.deletedOne(id); }

  /**
   * Brings a deleted skill back, with its text, files and history, switched Off: a skill is instructions assistants
   * follow, so one that returns never reaches them again until the owner turns it On. Refused when a skill with the
   * same name was made since.
   */
  undelete(id: string, by: string): Skill {
    const gone = this.store.deletedOne(id);
    if (!gone) throw new SkillError('not_found', 'No such skill.', { key: 'err.skill.noSuch' });
    if (this.store.byName(gone.name)) throw new SkillError('invalid', `A skill named ${gone.name} already exists.`, { key: 'err.skill.nameTaken', params: { name: gone.name } });
    this.store.undelete(id, by);
    return this.must(id);
  }

  get(id: string): Skill | undefined { return this.store.get(id); }
  byName(name: string): Skill | undefined { return this.store.byName(name); }
  list(): Skill[] { return this.store.list(); }
  listOn(): Skill[] { return this.store.list(true); }
  versions(id: string): SkillVersion[] { return this.store.versions(id); }

  restore(id: string, version: number, by: string): Skill {
    const cur = this.must(id);
    const v = this.store.versions(id).find((x) => x.version === version);
    if (!v) throw new SkillError('not_found', `No version ${version} of this skill.`, { key: 'err.skill.noVersion', params: { version } });
    return this.update(id, { base: cur.version, name: v.name, description: v.description, body: v.body, files: v.files }, by);
  }

  recordLoad(id: string, by: string): void { this.store.recordLoad(id, by); }

  /** SKILL.md as Claude Code reads it: frontmatter name and description, then the body. */
  skillMd(s: Pick<Skill, 'name' | 'description' | 'body'>): string {
    // Always a JSON string, which is a valid YAML double-quoted scalar: [WIP], - x, yes or 123 never misparse.
    return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`;
  }

  // ---- Proposals ----

  /** An assistant's new skill, or a change to one: it waits for the owner. One per (name, proposer). */
  propose(input: SkillInput, by: string): SkillProposal {
    if (posesAsBrainAI(by)) throw new SkillError('invalid', 'Not sent: that connection name is kept for BrainAI itself.', { key: 'err.skill.nameReserved' });
    return this.send(input, by, false);
  }

  /** A skill BrainAI ships, offered to the owner (src/skills/builtin.ts only; no tool or route reaches it). Marked built-in by the server. */
  proposeBuiltin(input: SkillInput): SkillProposal {
    return this.send(input, BRAINAI_NAME, true);
  }

  private send(input: SkillInput, by: string, builtin: boolean): SkillProposal {
    return this.store.atomic(() => {
      const existing = this.store.byName(input.name.trim());
      const s = this.check(input, existing?.id);
      // One waiting proposal per (name, proposer, origin): an assistant never replaces a built-in offer, nor the other way round.
      const mine = this.store.pendingProposals().filter((p) => p.name === s.name && p.proposedBy === by && p.builtin === builtin);
      for (const p of mine) this.store.resolveProposal(p.id, 'rejected');
      if (this.store.pendingProposals().length >= MAX_PENDING_PROPOSALS) {
        throw new SkillError('invalid', `Not sent: ${MAX_PENDING_PROPOSALS} skill proposals already wait for the owner.`, { key: 'err.skill.tooManyProposals', params: { max: MAX_PENDING_PROPOSALS } });
      }
      return this.store.addProposal({ skillId: existing?.id ?? null, ...s, baseVersion: existing?.version ?? null, proposedBy: by, builtin });
    });
  }

  pendingProposals(): SkillProposal[] { return this.store.pendingProposals(); }
  proposal(id: string): SkillProposal | undefined { return this.store.proposal(id); }

  private pending(id: string): SkillProposal {
    const p = this.store.proposal(id);
    if (!p || p.status !== 'pending') throw new SkillError('not_found', 'This proposal was already answered.', { key: 'err.skill.proposalAnswered' });
    return p;
  }

  /** A new-skill proposal becomes a skill, Off or On. */
  addProposal(id: string, on: boolean): Skill {
    return this.store.atomic(() => {
      const p = this.pending(id);
      if (p.skillId !== null) throw new SkillError('invalid', 'This proposal changes an existing skill: apply it instead.', { key: 'err.skill.proposalChangesExisting' });
      const s = this.create(p, 'owner', `proposed:${p.proposedBy}`);
      if (on) this.store.setEnabled(s.id, true, 'owner');
      this.store.resolveProposal(id, 'added');
      return this.must(s.id);
    });
  }

  /** A change proposal applied to its skill, which keeps its On/Off. A skill changed since needs `confirmChanged`. */
  applyProposal(id: string, confirmChanged = false): Skill {
    return this.store.atomic(() => {
      const p = this.pending(id);
      if (p.skillId === null) throw new SkillError('invalid', 'This proposal is a new skill: add it instead.', { key: 'err.skill.proposalIsNew' });
      const cur = this.must(p.skillId);
      if (p.baseVersion !== cur.version && !confirmChanged) {
        throw new SkillError('changed', `The skill changed since this was proposed (version ${p.baseVersion} → ${cur.version}).`, { key: 'err.skill.changedSince', params: { from: String(p.baseVersion), to: cur.version } });
      }
      const s = this.update(cur.id, { base: cur.version, name: p.name, description: p.description, body: p.body, files: p.files }, `owner (from ${p.proposedBy})`);
      this.store.resolveProposal(id, 'applied');
      return s;
    });
  }

  /** Undo a rejection: the proposal waits again. */
  reopenRejected(id: string): void {
    const p = this.store.proposal(id);
    if (!p || p.status !== 'rejected') throw new SkillError('invalid', 'That proposal was not rejected.', { key: 'err.skill.notRejected' });
    const waiting = this.store.pendingProposals();
    if (waiting.some((w) => w.name === p.name && w.proposedBy === p.proposedBy)) {
      throw new SkillError('invalid', `That can no longer be undone: ${p.proposedBy} sent a newer proposal for "${p.name}", which waits in the Inbox.`, { key: 'err.skill.undoNewer', params: { by: p.proposedBy, name: p.name } });
    }
    if (waiting.length >= MAX_PENDING_PROPOSALS) {
      throw new SkillError('invalid', `That can no longer be undone: ${MAX_PENDING_PROPOSALS} skill proposals already wait in the Inbox. Answer some first.`, { key: 'err.skill.undoFull', params: { max: MAX_PENDING_PROPOSALS } });
    }
    this.store.resolveProposal(id, 'pending');
  }

  rejectProposal(id: string): void {
    this.pending(id);
    this.store.resolveProposal(id, 'rejected');
  }
}
