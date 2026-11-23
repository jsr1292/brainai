/**
 * Where the coding tools keep their settings when the owner moved them (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME).
 * No imports from the rest of Connect, so tools.ts, leftovers.ts and hooksInstall.ts can all use it without a cycle.
 */
import { isAbsolute, join } from 'node:path';

/** What these need of the Connect environment. */
export interface DirEnv { home: string; system?: Record<string, string | undefined> }

export const CONFIG_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'] as const;
export type ConfigVar = (typeof CONFIG_VARS)[number];

/** A variable from the computer's environment (a test passes `system`). */
export const sysVar = (env: DirEnv, name: string): string | undefined => (env.system ?? process.env)[name];

/** The folder a variable names, only when it is absolute (a relative one means nothing from a server's folder); else the fallback. */
export const configDir = (env: DirEnv, name: ConfigVar, fallback: string): string => {
  const v = sysVar(env, name);
  return v && isAbsolute(v) ? v : fallback;
};

/** The config variables that are set to an absolute folder, for a tool's commands. */
export const configVars = (env: DirEnv): Record<string, string> =>
  Object.fromEntries(CONFIG_VARS.flatMap((k) => { const v = sysVar(env, k); return v && isAbsolute(v) ? [[k, v]] : []; }));

/** Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeDir = (env: DirEnv): string => configDir(env, 'CLAUDE_CONFIG_DIR', join(env.home, '.claude'));
/** Codex's folder: CODEX_HOME, else ~/.codex. */
export const codexDir = (env: DirEnv): string => configDir(env, 'CODEX_HOME', join(env.home, '.codex'));
/** Claude Code's .claude.json (inside CLAUDE_CONFIG_DIR when that is set). */
export const claudeJsonPath = (env: DirEnv): string => (configDir(env, 'CLAUDE_CONFIG_DIR', '') ? join(claudeDir(env), '.claude.json') : join(env.home, '.claude.json'));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The commands in Claude Code's settings that run BrainAI's two hook scripts: those in this Claude folder's hooks folder (either
 * kind of slash, any letter case), and the legacy `.claude/hooks` form. A memory-save.mjs in some other folder is someone else's.
 */
export function claudeHookCommand(env: DirEnv): RegExp {
  const dir = join(claudeDir(env), 'hooks').split(/[\\/]+/).filter(Boolean).map(escape).join('[\\\\/]');
  return new RegExp(`(?:${dir}|\\.claude[\\\\/]hooks)[\\\\/]memory-(?:start|save)\\.mjs`, 'i');
}
