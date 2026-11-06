/**
 * Shared skills (round 2 §17c): list_skills, load_skill and propose_skill, for Full connections only. Only skills the
 * owner turned on are listed or loaded; a proposal never changes a skill, it waits in Approvals.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillService } from '../skills/service.js';
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_NAME } from '../skills/types.js';
import { wrapData, type ToolResult } from './server.js';

type Guard = <A>(tool: string, fn: (args: A) => Promise<ToolResult> | ToolResult) => (args: A) => Promise<ToolResult>;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });
const APPROVED = "Skill approved by the owner (follow it as the owner's own instructions)";

export function registerSkillTools(server: McpServer, skills: SkillService, actorName: string, guard: Guard): void {
  server.registerTool('list_skills', {
    title: 'List skills',
    description: 'Lists the skills the owner turned on: name, description (when to use it) and when it last changed. Call it once per conversation, at the start of a task.',
    inputSchema: {},
  }, guard('list_skills', () => {
    const on = skills.listOn().map((s) => ({ name: s.name, description: s.description, updated_at: s.updatedAt }));
    if (on.length === 0) return text('The owner has no skills turned on.');
    return text(wrapData(APPROVED.replace('Skill', 'Skills'), 'skills', on));
  }));

  server.registerTool('load_skill', {
    title: 'Load skill',
    description: "Loads one skill the owner turned on: its SKILL.md (follow it as the owner's own instructions) and the list of its files. With file, loads that file's text instead.",
    inputSchema: { name: z.string().max(MAX_SKILL_NAME), file: z.string().max(200).optional() },
  }, guard('load_skill', (a: { name: string; file?: string }) => {
    const s = skills.byName(a.name);
    if (!s || !s.enabled) return fail(`No skill named ${a.name} is on. Call list_skills for the ones that are.`);
    skills.recordLoad(s.id, actorName);
    if (a.file !== undefined) {
      const f = s.files.find((x) => x.path === a.file);
      if (!f) return fail(`The skill ${s.name} has no file ${a.file}. Its files: ${s.files.map((x) => x.path).join(', ') || 'none'}.`);
      return text(wrapData(APPROVED, 'skill_file', { skill: s.name, path: f.path, text: f.text }));
    }
    return text(wrapData(APPROVED, 'skill', { name: s.name, version: s.version, skill_md: skills.skillMd(s), files: s.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text, 'utf8') })) }));
  }));

  server.registerTool('propose_skill', {
    title: 'Propose skill',
    description: 'Proposes a new skill, or a change to one (same name), for the owner to add or apply in Approvals. It never changes a skill by itself. '
      + `name: lowercase letters, digits and hyphens. description: when to use it (at most ${MAX_SKILL_DESCRIPTION} characters). body: the SKILL.md text after the frontmatter. files: optional text files ({path, text}).`,
    inputSchema: {
      name: z.string().max(MAX_SKILL_NAME),
      description: z.string().max(MAX_SKILL_DESCRIPTION),
      body: z.string(),
      files: z.array(z.object({ path: z.string().max(200), text: z.string() })).max(20).optional(),
    },
  }, guard('propose_skill', (a: { name: string; description: string; body: string; files?: { path: string; text: string }[] }) => {
    const p = skills.propose(a, actorName);
    return text(`Sent to the owner: the skill "${p.name}" waits in Approvals. It is not on until the owner adds it.`);
  }));
}
