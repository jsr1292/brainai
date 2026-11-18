/**
 * Skills BrainAI ships (B1): each is offered to the owner once, as a skill proposal from "BrainAI" in the Inbox. Only the
 * owner adds or applies a skill, so nothing here turns itself on. The text lives in src/skills/builtin/*.md.
 */
import { readFileSync } from 'node:fs';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { SkillError, type SkillService } from './service.js';
import { parseSkillMd } from './sync.js';

export const BUILTIN_SKILLS = ['harvest-session', 'import-project-folders'] as const;

/** A built-in skill's name, description and body, read from its markdown file. */
export function builtinSkill(name: string): { name: string; description: string; body: string } {
  const p = parseSkillMd(readFileSync(new URL(`./builtin/${name}.md`, import.meta.url), 'utf8'));
  return { name: p.name ?? name, description: p.description, body: p.body };
}

/**
 * Proposes each built-in skill to the owner, once. Not when a skill with that name exists already (the owner's own, or one
 * added from an earlier offer), and not again after an offer was answered or rejected: a remembered offer, not a
 * check of the Inbox. Returns the names proposed now. Never throws: a start must not fail over a skill.
 */
export function offerBuiltinSkills(db: DB, skills: SkillService, now: Clock): string[] {
  const offered: string[] = [];
  for (const name of BUILTIN_SKILLS) {
    try {
      if (db.prepare('SELECT 1 FROM builtin_skills_offered WHERE name = ?').get(name)) continue;
      // Remembered once proposed (or once there is nothing to propose); a proposal that could not be sent is tried again next start.
      const remember = () => db.prepare('INSERT INTO builtin_skills_offered(name, offered_at) VALUES (?, ?)').run(name, now().toISOString());
      if (skills.byName(name)) { remember(); continue; }
      skills.proposeBuiltin(builtinSkill(name));
      remember();
      offered.push(name);
    } catch (e) {
      if (!(e instanceof SkillError)) console.warn(`The ${name} skill was not offered:`, e instanceof Error ? e.message : e);
    }
  }
  return offered;
}
