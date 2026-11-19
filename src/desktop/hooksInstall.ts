/**
 * The save reminders that Connect installs for the coding tools that have hooks (B1): Claude Code (SessionStart, Stop,
 * PreCompact), Codex (Stop, PostToolUse) and Cursor (stop, postToolUse). OpenCode, Grok Build and Claude's desktop app
 * have no hook BrainAI can use (docs/CLIENTS.md says why). The same rules as the rest of Connect: the owner's config is
 * parsed first and never rewritten when it is not plain JSON, it is backed up beside itself before the first change,
 * only entries that name BrainAI's own scripts are ever added, updated or removed, and a failure is a note, never a
 * failed Connect. The scripts come from `env.hooksDir` (the built src/hooks); without it nothing is installed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { t } from '../i18n/core.js';
import { removeHooks, matcherFor, withoutOurHooks, writeAtomic } from './leftovers.js';
import { findCommand, type ToolEnv, type ToolId } from './tools.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Wiring {
  /** The config file holding the tool's hooks. */
  config: (env: ToolEnv) => string;
  /** Built script (in hooksDir) -> where it is installed. */
  scripts: (env: ToolEnv) => { from: string; to: string }[];
  /** Which commands in the config are BrainAI's. */
  ours: RegExp;
  /** Cursor keeps flat entries ({command}) under each event; the others nest them ({hooks:[{type,command}]}). */
  flat: boolean;
  /** event -> the script (an installed file name) and the argument it is run with. */
  events: { event: string; script: string; arg?: string }[];
}

const claudeHooks = (env: ToolEnv) => join(env.home, '.claude', 'hooks');
const brainHooks = (env: ToolEnv) => join(env.home, '.brainai', 'hooks');
const NUDGE_SCRIPT = { from: 'memoryNudge.js', to: 'memory-nudge.mjs' };
const NUDGE_ONLY = /\.brainai[\\/]hooks[\\/]memory-nudge\.mjs/;

const WIRING: Partial<Record<ToolId, Wiring>> = {
  'claude-code': {
    config: (env) => join(env.home, '.claude', 'settings.json'),
    scripts: (env) => [{ from: 'memoryStart.js', to: join(claudeHooks(env), 'memory-start.mjs') }, { from: 'memorySave.js', to: join(claudeHooks(env), 'memory-save.mjs') }],
    ours: /\.claude[\\/]hooks[\\/]memory-(?:start|save)\.mjs/, flat: false,
    events: [{ event: 'SessionStart', script: 'memory-start.mjs' }, { event: 'Stop', script: 'memory-save.mjs' }, { event: 'PreCompact', script: 'memory-save.mjs' }],
  },
  codex: {
    config: (env) => join(env.home, '.codex', 'hooks.json'),
    scripts: (env) => [{ from: NUDGE_SCRIPT.from, to: join(brainHooks(env), NUDGE_SCRIPT.to) }],
    ours: NUDGE_ONLY, flat: false,
    events: [{ event: 'PostToolUse', script: 'memory-nudge.mjs', arg: 'codex' }, { event: 'Stop', script: 'memory-nudge.mjs', arg: 'codex' }],
  },
  cursor: {
    config: (env) => join(env.home, '.cursor', 'hooks.json'),
    scripts: (env) => [{ from: NUDGE_SCRIPT.from, to: join(brainHooks(env), NUDGE_SCRIPT.to) }],
    ours: NUDGE_ONLY, flat: true,
    events: [{ event: 'postToolUse', script: 'memory-nudge.mjs', arg: 'cursor' }, { event: 'stop', script: 'memory-nudge.mjs', arg: 'cursor' }],
  },
};

/** Whether BrainAI can install reminders for this tool at all. */
export const hasHooks = (id: ToolId): boolean => WIRING[id] !== undefined;

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
function writeWithBackup(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.brainai-backup`)) copyFileSync(path, `${path}.brainai-backup`);
  writeAtomic(path, text);
}

/** The tool's hook config parsed, or why it cannot be changed safely. */
function readConfig(path: string): { json: Json } | { refuse: string } {
  const text = read(path);
  if (text === null) return { json: {} };
  try {
    const json = JSON.parse(text) as unknown;
    if (!isObject(json) || (json.hooks !== undefined && !isObject(json.hooks))) throw new Error('not an object');
    return { json };
  } catch {
    return { refuse: `${path} is not plain JSON: BrainAI will not rewrite it` };
  }
}

const quote = (s: string) => `"${s}"`;
/**
 * `node` when it is on the PATH (as docs/CLIENTS.md and the install script do, so a Node update does not break the hook);
 * this server's own Node by absolute path only as the fallback. Cursor's desktop app runs hook commands through PowerShell on
 * Windows (https://cursor.com/docs/hooks), where a quoted command needs the call operator: `& "C:\node.exe" "script"`.
 * A bare `node "script"` works in PowerShell and cmd alike. Codex's docs do not say which shell it uses on Windows, so its
 * fallback stays plain-quoted.
 */
const commandFor = (env: ToolEnv, id: ToolId, script: string, dir: string, arg?: string): string => {
  const bare = findCommand('node', env) !== null;
  const interpreter = bare ? 'node' : `${id === 'cursor' && (env.platform ?? process.platform) === 'win32' ? '& ' : ''}${quote(process.execPath)}`;
  return `${interpreter} ${quote(join(dir, script))}${arg ? ` ${arg}` : ''}`;
};

/** The program a saved command starts with: `node` bare, or the quoted absolute path (after PowerShell's `& `). */
function interpreterOf(command: string): string {
  const c = command.replace(/^&\s+/, '');
  return c.startsWith('"') ? c.slice(1, c.indexOf('"', 1)) : c.split(/\s+/)[0] ?? '';
}

/** Adds or updates the entry for one event; true when the config changed. */
function put(hooks: Json, w: Wiring, event: string, command: string): boolean {
  const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const mine = matcherFor(w.ours);
  let found = false;
  let changed = false;
  const next = groups.map((g) => {
    if (w.flat && isObject(g) && mine(g.command)) { found = true; if (g.command !== command) { changed = true; return { ...g, command }; } return g; }
    if (!w.flat && isObject(g) && Array.isArray(g.hooks)) {
      const inner = g.hooks.map((h) => {
        if (isObject(h) && mine(h.command)) { found = true; if (h.command !== command) { changed = true; return { ...h, command }; } }
        return h;
      });
      return inner.some((h, i) => h !== (g.hooks as unknown[])[i]) ? { ...g, hooks: inner } : g;
    }
    return g;
  });
  if (!found) { next.push(w.flat ? { command } : { hooks: [{ type: 'command', command }] }); changed = true; }
  if (changed) hooks[event] = next;
  return changed;
}

/** Whether every reminder of this tool is wired up now: 'none' when the tool has no hooks BrainAI can use. */
export function hooksState(id: ToolId, env: ToolEnv): 'on' | 'off' | 'none' {
  const w = WIRING[id];
  if (!w) return 'none';
  const c = readConfig(w.config(env));
  if ('refuse' in c || !isObject(c.json.hooks)) return 'off';
  const hooks = c.json.hooks;
  const mine = matcherFor(w.ours);
  const ourCommands = (event: string): string[] => (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).flatMap((g) => {
    if (!isObject(g)) return [];
    const inner = Array.isArray(g.hooks) ? g.hooks.filter(isObject).map((h) => h.command) : [];
    return [g.command, ...inner].filter((c): c is string => mine(c));
  });
  // The interpreter in the saved command has to exist still (a Node that was moved or uninstalled leaves a hook that never runs).
  const runs = (command: string) => { const i = interpreterOf(command); return i === 'node' ? findCommand('node', env) !== null : existsSync(i); };
  return w.events.every((e) => { const c = ourCommands(e.event); return c.length > 0 && c.every(runs); }) && w.scripts(env).every((s) => existsSync(s.to)) ? 'on' : 'off';
}

/** Installs the reminders; null when done (or when this tool, or this install, has none), else a note for the owner. */
export function installHooks(id: ToolId, env: ToolEnv): string | null {
  const w = WIRING[id];
  if (!w || !env.hooksDir) return null;
  const name = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' }[id as 'claude-code' | 'codex' | 'cursor'];
  const scripts = w.scripts(env);
  const missing = scripts.find((s) => !existsSync(join(env.hooksDir!, s.from)));
  if (missing) return t('tools.hooks.missing', { name: name ?? id, file: missing.from });
  const c = readConfig(w.config(env));
  if ('refuse' in c) return t('tools.hooks.refused', { name: name ?? id, why: c.refuse });
  if (isObject(c.json.hooks)) {
    const odd = w.events.find((e) => (c.json.hooks as Json)[e.event] !== undefined && !Array.isArray((c.json.hooks as Json)[e.event]));
    if (odd) return t('tools.hooks.shape', { name: name ?? id, config: w.config(env), event: odd.event });
  }
  try {
    for (const s of scripts) { mkdirSync(dirname(s.to), { recursive: true }); copyFileSync(join(env.hooksDir, s.from), s.to); }
    const hooks: Json = isObject(c.json.hooks) ? { ...c.json.hooks } : {};
    let changed = false;
    for (const e of w.events) changed = put(hooks, w, e.event, commandFor(env, id, e.script, dirname(scripts.find((s) => s.to.endsWith(e.script))!.to), e.arg)) || changed;
    if (changed || read(w.config(env)) === null) {
      writeWithBackup(w.config(env), `${JSON.stringify({ ...(id === 'cursor' && c.json.version === undefined ? { version: 1 } : {}), ...c.json, hooks }, null, 2)}\n`);
    }
  } catch (e) {
    return t('tools.hooks.failed', { name: name ?? id, why: e instanceof Error ? e.message : String(e) });
  }
  return id === 'codex' ? t('tools.hooks.codexTrust') : null;
}

/**
 * Takes the reminders back: only entries and scripts that are BrainAI's. Claude Code's go through removeHooks (the same
 * as Remove BrainAI uses; `otherBrain`: a brain may still use them). Returns a note when something was left.
 */
export function removeToolHooks(id: ToolId, env: ToolEnv, otherBrain = false): string | null {
  const w = WIRING[id];
  if (!w) return null;
  if (id === 'claude-code') return removeHooks(env, otherBrain).kept;
  const path = w.config(env);
  const c = readConfig(path);
  if ('refuse' in c) return t('tools.hooks.removeByHand', { why: c.refuse });
  if (otherBrain) return t('tools.hooks.leftInPlace');
  try {
    if (isObject(c.json.hooks)) {
      const next = withoutOurHooks(c.json.hooks, matcherFor(w.ours));
      if (next) {
        const { hooks: _old, ...others } = c.json;
        const left = Object.keys(next).length > 0;
        const empty = !left && Object.keys(others).every((k) => k === 'version');
        // A hooks.json BrainAI created (no backup was ever made of it) that now holds nothing is deleted; any other goes back to
        // what it was, without our entries.
        if (empty && !existsSync(`${path}.brainai-backup`)) rmSync(path, { force: true });
        else writeWithBackup(path, `${JSON.stringify(left ? { ...others, hooks: next } : others, null, 2)}\n`);
      }
    }
    // The script is shared by Codex and Cursor: deleted only once neither config names it. The other config's raw text is
    // searched, so one BrainAI cannot parse (comments, say) still counts as using it.
    const stillUsed = (['codex', 'cursor'] as const).some((other) => other !== id && (read(WIRING[other]!.config(env)) ?? '').includes('memory-nudge.mjs'));
    if (!stillUsed) for (const s of w.scripts(env)) rmSync(s.to, { force: true });
  } catch (e) {
    return t('tools.hooks.removeFailed', { why: e instanceof Error ? e.message : String(e) });
  }
  return null;
}
