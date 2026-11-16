/**
 * The commands an assistant that opens a discussion runs to ask the others, by default in the app (goal 3): one for each
 * of Claude Code and Codex that is connected to this brain and whose command is on the computer.
 */
import { findCommand, toolStates, type ToolEnv, type ToolId } from './tools.js';

const COMMANDS: Partial<Record<ToolId, { name: string; command: string; line: string }>> = {
  'claude-code': { name: 'Claude Code', command: 'claude', line: 'claude -p "{prompt}" --allowedTools mcp__brainai' },
  codex: { name: 'Codex', command: 'codex', line: 'codex exec --skip-git-repo-check "{prompt}"' },
};

export function defaultAskCommands(connected: ToolId[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(COMMANDS) as [ToolId, NonNullable<(typeof COMMANDS)[ToolId]>][]) {
    if (connected.includes(id)) out[c.name] = c.line;
  }
  return out;
}

/** Looks at the computer now: tools connected to this brain whose command is found. */
export async function askCommandsFor(env: ToolEnv): Promise<Record<string, string>> {
  const states = await toolStates(env);
  const ready = states.filter((s) => s.state === 'connected' && COMMANDS[s.id] && findCommand(COMMANDS[s.id]!.command, env) !== null);
  return defaultAskCommands(ready.map((s) => s.id));
}

export type AskCommandsReader = (() => Record<string, string>) & {
  /** Looks now and resolves once the answer is in (the app calls it at startup and after Connect or Disconnect). */
  refresh: () => Promise<void>;
};

/**
 * A synchronous reader for the MCP server: gives the last look, and when it is older than `ttlMs` (a minute) starts a new
 * one in the background (toolStates reads files and the PATH), so a session start never waits for it. `refresh()` looks
 * at once, so the app can prime it at startup and update it right after a tool is connected or disconnected.
 * A look that fails keeps the last good answer and is logged at most once per `ttlMs`.
 */
export function cachedAskCommands(env: ToolEnv, opts: { ttlMs?: number; now?: () => number; look?: (env: ToolEnv) => Promise<Record<string, string>>; log?: (e: unknown) => void } = {}): AskCommandsReader {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const look = opts.look ?? askCommandsFor;
  const log = opts.log ?? ((e: unknown) => console.error('Looking for the tools that can ask each other failed:', e));
  let value: Record<string, string> = {};
  let at = -Infinity;
  let lastLogged = -Infinity;
  let running: Promise<void> | null = null;
  const start = (): Promise<void> => {
    at = now();
    const p: Promise<void> = look(env).then((v) => { value = v; }).catch((e) => {
      if (now() - lastLogged >= ttl) { lastLogged = now(); try { log(e); } catch { /* logging must not fail a session */ } }
    }).finally(() => { if (running === p) running = null; });
    running = p;
    return p;
  };
  const read = (() => {
    if (!running && now() - at >= ttl) void start();
    return value;
  }) as AskCommandsReader;
  // After a Connect the look must see the new state, so one that is already running is followed by a fresh one.
  read.refresh = () => (running ? running.then(() => start()) : start());
  return read;
}
