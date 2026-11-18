/** Shared skills (round 2 §17c). */
export interface SkillFile { path: string; text: string }

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  /** 'here' (the owner wrote it), 'proposed:<connection>' (an assistant proposed it) or, from S4, 'device:<id>'. */
  origin: string;
  version: number;
  createdAt: string; createdBy: string; updatedAt: string; updatedBy: string;
  lastLoadedAt: string | null; lastLoadedBy: string | null;
  files: SkillFile[];
}

export interface SkillVersion { version: number; name: string; description: string; body: string; files: SkillFile[]; savedAt: string; savedBy: string }

export interface SkillProposal {
  id: string;
  /** The skill a change is for; null for a new skill. */
  skillId: string | null;
  name: string; description: string; body: string; files: SkillFile[];
  /** The skill's version when the change was proposed; null for a new skill. */
  baseVersion: number | null;
  proposedBy: string; proposedAt: string;
  /** Set only by the server for a skill BrainAI ships; no actor can set it, so it (not the proposer's name) marks a built-in offer. */
  builtin: boolean;
  status: 'pending' | 'added' | 'applied' | 'rejected';
}

export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_PENDING_PROPOSALS = 20;
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/**
 * Whether a skill file path is one a skill can hold: folders and names of letters, digits, dots, hyphens and underscores,
 * no dot-led segment (.git, .hidden, ..), and no skill.md in any case (it would overwrite SKILL.md on a Mac).
 */
export const skillFilePathOk = (path: string): boolean =>
  path.toLowerCase() !== 'skill.md' && path.split('/').every((p) => FILE_SEGMENT_RE.test(p) && !p.startsWith('.'));
