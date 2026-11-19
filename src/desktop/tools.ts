/**
 * The coding tools on the owner's Mac, and Connect / Disconnect for each (D3). Runs in the server, in local mode,
 * as the owner. Rules: BrainAI is added as a server named `brainai` (never touching one named `memory` or anything else),
 * a tool that already points at another BrainAI is left alone unless the owner presses Replace, every file is backed
 * up before it is changed, and the rules go in only once the server entry worked.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findBlock, putBlock, removeBlock, strayBrain } from './rulesBlock.js';
import { thisComputer } from './computer.js';
import { BRIDGE_KEY_FILE } from './claudeBridge.js';
import { hasHooks, hooksState, installHooks, removeToolHooks } from './hooksInstall.js';

export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'claude-desktop';
export interface ToolEnv {
  home: string;
  /** Where to look for the tools' commands (the owner's login-shell PATH, from the app). */
  path: string;
  mcpUrl: string;
  /** The setup text for a tool, wrapped in its markers (setupText(slug, mcpUrl, overlay)). */
  rules: (slug: string) => string;
  /** Where apps are installed (/Applications). */
  apps?: string;
  /** More environment for the tools' commands (tests). */
  extraEnv?: Record<string, string>;
  /** The computer's platform (tests pass win32 on a Mac); default process.platform. */
  platform?: NodeJS.Platform;
  /** Windows: where the system variables come from (default this server's own environment). */
  system?: Record<string, string | undefined>;
  /** Claude's desktop app: the path of claude_desktop_config.json (default: where the app keeps it on this computer). */
  claudeConfig?: string;
  /** Claude's desktop app: what its entry runs (the running server's own Node and cli.js) and where the bridge looks. */
  bridge?: { node: string; cli: string; dataDir: string; portFile: string };
  /** Claude's desktop app: a new key on its own grant, and taking it back. Wired by the routes, local mode only. */
  issueKey?: () => { grantId: string; token: string };
  revokeKey?: (grantId: string) => void;
  /** Claude's desktop app: whether a key's grant still works here (not revoked, made for this address). Wired by the routes. */
  keyLive?: (grantId: string) => boolean;
  /** Ends the OAuth sign-in of every live grant whose app name starts with the tool's name; returns how many. Wired by the routes. */
  endSignIns?: (toolName: string) => number;
  /** B1: where the built hook scripts are (dist/hooks). Without it Connect installs no save reminders. */
  hooksDir?: string;
}
export interface ToolState {
  id: ToolId; name: string; installed: boolean;
  state: 'not-connected' | 'connected' | 'other-brainai';
  /** For other-brainai: what it points at now. */
  detail?: string;
  /** The one step after Connect: how the tool signs in. */
  signIn: string;
  /** For a connected tool: it has signed in (an OAuth grant exists). false: added, one step left. Filled in by the web layer. */
  signedIn?: boolean;
  /** Save reminders (hooks): on, off, or none (this tool has no hook BrainAI can use). */
  hooks?: 'on' | 'off' | 'none';
}
export type Outcome = { ok: true; signIn: string; ended?: number; /** Something about the save reminders the owner should know (not added, or Codex's one-time trust). */ hooksNote?: string } | { ok: false; reason: string };

const NAME = 'brainai';
const TIMEOUT_MS = 30_000;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

const platformOf = (env: ToolEnv): NodeJS.Platform => env.platform ?? process.platform;
/** What a Windows tool needs from the system to find its home, its settings and a temp folder (D6). */
const WINDOWS_VARS = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT'] as const;

/**
 * A tool's command on the PATH, as the computer's own shell finds it: on the Mac an executable file in a ':'
 * separated list; on Windows each ';' separated folder tried with each PATHEXT extension (npm installs .cmd shims).
 */
export function findCommand(name: string, env: ToolEnv): string | null {
  if (platformOf(env) === 'win32') {
    const exts = (env.system ?? process.env).PATHEXT || '.COM;.EXE;.BAT;.CMD';
    for (const dir of env.path.split(';')) {
      if (!dir) continue;
      for (const ext of exts.split(';').filter(Boolean)) {
        const file = join(dir, name + ext.toLowerCase());
        if (existsSync(file)) return file;
      }
    }
    return null;
  }
  for (const dir of env.path.split(':')) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return null;
}

/** Only these characters ever reach the Windows command prompt: no quoting, no expansion, nothing to inject. */
const SAFE_ARG = /^[A-Za-z0-9.:/_=@-]+$/;

/**
 * How to start a found command. Node runs a Windows .cmd or .bat only through the command prompt, so those get it,
 * with the path quoted and only arguments from a fixed safe set (anything else is refused, never quoted in); every
 * other command runs directly, with no shell.
 */
export function commandLine(file: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; shell: boolean } | null {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    if (/["%]/.test(file) || !args.every((a) => SAFE_ARG.test(a))) return null;
    return { file: `"${file}"`, args, shell: true };
  }
  return { file, args, shell: false };
}

function onPath(env: ToolEnv, cmd: string): boolean {
  return findCommand(cmd, env) !== null;
}

/** A tool's environment: its PATH and home, and on Windows the system variables it needs; nothing else of BrainAI's. */
export function childEnv(env: ToolEnv): NodeJS.ProcessEnv {
  if (platformOf(env) === 'win32') {
    const sys = env.system ?? process.env;
    const picked = Object.fromEntries(WINDOWS_VARS.flatMap((k) => (sys[k] !== undefined ? [[k, sys[k]!]] : [])));
    return { ...picked, Path: env.path, ...env.extraEnv };
  }
  return { PATH: env.path, HOME: env.home, ...env.extraEnv };
}

interface Ran { code: number; stdout: string; stderr: string; timedOut: boolean }

/** One command, no shell, never waiting for input, 30 s at most. */
function run(env: ToolEnv, cmd: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const found = findCommand(cmd, env);
    if (!found) return resolve({ code: 127, stdout: '', stderr: `${cmd} was not found`, timedOut: false });
    const line = commandLine(found, args, platformOf(env));
    if (!line) return resolve({ code: 1, stdout: '', stderr: `BrainAI would not pass these values to ${cmd} through the command prompt`, timedOut: false });
    const child = execFile(line.file, line.args, { env: childEnv(env), shell: line.shell, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed });
    });
    child.stdin?.end();
  });
}

/** Why a command failed, in a few words. */
const why = (r: Ran) => (r.timedOut ? 'it did not answer within 30 s' : `${r.stdout}${r.stderr}`.trim().slice(0, 200) || `it stopped with code ${r.code}`);
/** The CLIs' own words for "there is no server by that name": only then is it safe to add one. */
const notFound = (r: Ran) => /No MCP server named/i.test(`${r.stdout}${r.stderr}`);
/** An entry named brainai that has no address (a bridge or a command): someone else's, never ours. */
const NO_ADDRESS = 'an entry without an address';

/** Started and left running (a sign-in that opens the browser and waits for the owner). */
function startDetached(env: ToolEnv, cmd: string, args: string[]): void {
  try {
    const found = findCommand(cmd, env);
    const line = found ? commandLine(found, args, platformOf(env)) : null;
    if (!line) return;
    const child = spawn(line.file, line.args, { env: childEnv(env), shell: line.shell, windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* the page still says how to sign in by hand */ }
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Writes a file, keeping the owner's original beside it as <name>.brainai-backup. The first backup is never overwritten,
 * so after Replace and Disconnect the original rules are still there.
 */
function writeWithBackup(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.brainai-backup`)) copyFileSync(path, `${path}.brainai-backup`);
  writeFileSync(path, text);
}

export interface Tool {
  id: ToolId; name: string; slug: string;
  installed(env: ToolEnv): boolean;
  /** Where its brainai server points now (null: none), or an error when its config cannot be read safely. */
  server(env: ToolEnv): Promise<string | null | { refuse: string }>;
  add(env: ToolEnv): Promise<string | null>;
  remove(env: ToolEnv): Promise<string | null>;
  rulesFile(env: ToolEnv): string | null;
  signIn: string;
  after?(env: ToolEnv): void;
  /** For other-brainai: how to say what its server entry is (default: the host it points at). */
  otherDetail?(server: string): string;
  /** Why Connect cannot work from here (before anything is changed), or null. */
  blocked?(env: ToolEnv): string | null;
  /** Whatever else it holds of this brain outside its server entry (a key file). */
  extraTraces?(env: ToolEnv): boolean;
  /** Runs after Disconnect, whether or not an entry was there. */
  cleanup?(env: ToolEnv): void;
}

const claudeCode: Tool = {
  id: 'claude-code', name: 'Claude Code', slug: 'claude-code',
  installed: (env) => onPath(env, 'claude'),
  async server(env) {
    const r = await run(env, 'claude', ['mcp', 'get', NAME]);
    if (r.code !== 0) return notFound(r) ? null : { refuse: `Claude Code did not answer clearly (${why(r)}).` };
    return /^\s*URL:\s*(\S+)/m.exec(r.stdout)?.[1] ?? NO_ADDRESS;
  },
  async add(env) {
    const r = await run(env, 'claude', ['mcp', 'add', '--transport', 'http', '--scope', 'user', NAME, env.mcpUrl]);
    return r.code === 0 ? null : `Claude Code could not add BrainAI: ${why(r)}`;
  },
  async remove(env) {
    const r = await run(env, 'claude', ['mcp', 'remove', NAME, '-s', 'user']);
    return r.code === 0 ? null : `Claude Code could not remove BrainAI: ${why(r)}`;
  },
  rulesFile: (env) => join(env.home, '.claude', 'CLAUDE.md'),
  signIn: 'In Claude Code, type /mcp, choose brainai and Authenticate; your browser asks you to Allow.',
};

/**
 * config.toml with BrainAI's server table approving its tools, or null when there is nothing to add. The file's own
 * line ends are kept (a config.toml edited on Windows uses CRLF).
 */
export function withCodexApproval(text: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `[mcp_servers.${NAME}]`);
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  if (lines.slice(at + 1, end).some((l) => /^\s*default_tools_approval_mode\s*=/.test(l))) return null;
  let insert = end;
  while (insert > at + 1 && lines[insert - 1]!.trim() === '') insert--;
  lines.splice(insert, 0, 'default_tools_approval_mode = "approve"');
  return lines.join(eol);
}

/** Codex asks before every tool call unless its server table says otherwise (as the Windows installer sets it). */
function approveCodexTools(env: ToolEnv): void {
  const path = join(env.home, '.codex', 'config.toml');
  const text = read(path);
  const next = text === null ? null : withCodexApproval(text);
  if (next !== null) writeWithBackup(path, next);
}

const codex: Tool = {
  id: 'codex', name: 'Codex', slug: 'codex',
  installed: (env) => onPath(env, 'codex'),
  async server(env) {
    const r = await run(env, 'codex', ['mcp', 'get', NAME, '--json']);
    if (r.code !== 0) return notFound(r) ? null : { refuse: `Codex did not answer clearly (${why(r)}).` };
    try { return (JSON.parse(r.stdout) as { transport?: { url?: string } }).transport?.url ?? NO_ADDRESS; } catch { return { refuse: 'Codex answered in a way BrainAI could not read.' }; }
  },
  async add(env) {
    const r = await run(env, 'codex', ['mcp', 'add', NAME, '--url', env.mcpUrl]);
    if (r.code !== 0) return `Codex could not add BrainAI: ${why(r)}`;
    approveCodexTools(env);
    return null;
  },
  async remove(env) {
    const r = await run(env, 'codex', ['mcp', 'remove', NAME]);
    return r.code === 0 ? null : `Codex could not remove BrainAI: ${why(r)}`;
  },
  rulesFile: (env) => join(env.home, '.codex', 'AGENTS.md'),
  signIn: 'Your browser opens to sign Codex in: click Allow. If it did not, run codex mcp login brainai in a terminal.',
  after: (env) => startDetached(env, 'codex', ['mcp', 'login', NAME]),
};

const OPENCODE_DIR = (env: ToolEnv) => join(env.home, '.config', 'opencode');
const MANUAL_OPENCODE = 'OpenCode keeps its settings in a file BrainAI will not rewrite (comments, or not plain JSON): add it by hand from Settings › Set up an app › OpenCode.';

/** opencode.json parsed, or why it cannot be changed safely. */
function openCodeConfig(env: ToolEnv): { path: string; json: Record<string, unknown> } | { refuse: string } {
  const dir = OPENCODE_DIR(env);
  const path = join(dir, 'opencode.json');
  const text = read(path);
  if (text === null) {
    if (existsSync(join(dir, 'opencode.jsonc'))) return { refuse: MANUAL_OPENCODE };
    return { path, json: {} };
  }
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { refuse: MANUAL_OPENCODE };
    return { path, json: json as Record<string, unknown> };
  } catch {
    return { refuse: MANUAL_OPENCODE };
  }
}

const opencode: Tool = {
  id: 'opencode', name: 'OpenCode', slug: 'opencode',
  installed: (env) => onPath(env, 'opencode') || existsSync(OPENCODE_DIR(env)),
  async server(env) {
    const c = openCodeConfig(env);
    if ('refuse' in c) return { refuse: c.refuse };
    const entry = (c.json.mcp as Record<string, { url?: string }> | undefined)?.[NAME];
    return entry === undefined ? null : entry.url ?? NO_ADDRESS;
  },
  async add(env) {
    const c = openCodeConfig(env);
    if ('refuse' in c) return c.refuse;
    const mcp = { ...(c.json.mcp as Record<string, unknown> | undefined), [NAME]: { type: 'remote', url: env.mcpUrl, enabled: true } };
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcp }, null, 2)}\n`);
    return null;
  },
  async remove(env) {
    const c = openCodeConfig(env);
    if ('refuse' in c) return c.refuse;
    const mcp = { ...(c.json.mcp as Record<string, unknown> | undefined) };
    delete mcp[NAME];
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcp }, null, 2)}\n`);
    return null;
  },
  rulesFile: (env) => join(OPENCODE_DIR(env), 'AGENTS.md'),
  signIn: 'In a terminal, run opencode mcp auth brainai; your browser asks you to Allow.',
};

function cursorConfig(env: ToolEnv): { path: string; json: { mcpServers?: Record<string, unknown> } & Record<string, unknown> } | { refuse: string } {
  const path = join(env.home, '.cursor', 'mcp.json');
  const text = read(path);
  if (text === null) return { path, json: {} };
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    return { path, json: json as Record<string, unknown> };
  } catch {
    return { refuse: "Cursor's ~/.cursor/mcp.json is not plain JSON: BrainAI will not rewrite it." };
  }
}

const cursor: Tool = {
  id: 'cursor', name: 'Cursor', slug: 'claude-code',
  installed: (env) => existsSync(join(env.apps ?? '/Applications', 'Cursor.app')) || existsSync(join(env.home, '.cursor')),
  async server(env) {
    const c = cursorConfig(env);
    if ('refuse' in c) return { refuse: c.refuse };
    const entry = c.json.mcpServers?.[NAME] as { url?: string } | undefined;
    return entry === undefined ? null : entry.url ?? NO_ADDRESS;
  },
  async add(env) {
    const c = cursorConfig(env);
    if ('refuse' in c) return c.refuse;
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: { ...c.json.mcpServers, [NAME]: { url: env.mcpUrl } } }, null, 2)}\n`);
    return null;
  },
  async remove(env) {
    const c = cursorConfig(env);
    if ('refuse' in c) return c.refuse;
    // Nothing of ours there: leave the file (or its absence) alone.
    if (c.json.mcpServers?.[NAME] === undefined) return null;
    const servers = { ...c.json.mcpServers };
    delete servers[NAME];
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: servers }, null, 2)}\n`);
    return null;
  },
  // Cursor's rules live in its own settings, not a file.
  rulesFile: () => null,
  signIn: 'Cursor asks you to sign in the first time it uses BrainAI. Paste the rules below into Cursor › Settings › Rules.',
};

const GEMINI_DIR = (env: ToolEnv) => join(env.home, '.gemini');
const MANUAL_GEMINI = "Gemini CLI's ~/.gemini/settings.json is not plain JSON (comments, or a mistake): BrainAI will not rewrite it. Add it by hand from Settings › Set up an app › Gemini CLI.";

/** ~/.gemini/settings.json parsed, or why it cannot be changed safely. Everything but mcpServers.brainai is kept as it is. */
function geminiConfig(env: ToolEnv): { path: string; json: { mcpServers?: Record<string, unknown> } & Record<string, unknown> } | { refuse: string } {
  const path = join(GEMINI_DIR(env), 'settings.json');
  const text = read(path);
  if (text === null) return { path, json: {} };
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    const servers = (json as { mcpServers?: unknown }).mcpServers;
    if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('mcpServers is not an object');
    return { path, json: json as Record<string, unknown> };
  } catch {
    return { refuse: MANUAL_GEMINI };
  }
}

/**
 * Google's Gemini CLI. Remote Streamable HTTP servers use `httpUrl` (`url` is for SSE), per its MCP documentation. Written
 * to the file like Cursor and OpenCode, not through `gemini mcp add`, which has no way to read an entry back. Untested
 * against a real Gemini CLI. No save reminders: see docs/CLIENTS.md.
 */
const gemini: Tool = {
  id: 'gemini', name: 'Gemini CLI', slug: 'gemini-cli',
  installed: (env) => onPath(env, 'gemini'),
  async server(env) {
    const c = geminiConfig(env);
    if ('refuse' in c) return { refuse: c.refuse };
    const entry = c.json.mcpServers?.[NAME] as { httpUrl?: unknown } | undefined;
    if (entry === undefined) return null;
    // An entry with only `url` is an SSE server: not ours, whatever it points at.
    return typeof entry === 'object' && entry !== null && typeof entry.httpUrl === 'string' ? entry.httpUrl : NO_ADDRESS;
  },
  async add(env) {
    const c = geminiConfig(env);
    if ('refuse' in c) return c.refuse;
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: { ...c.json.mcpServers, [NAME]: { httpUrl: env.mcpUrl } } }, null, 2)}\n`);
    return null;
  },
  async remove(env) {
    const c = geminiConfig(env);
    if ('refuse' in c) return c.refuse;
    // Nothing of ours there: leave the file (or its absence) alone.
    if (c.json.mcpServers?.[NAME] === undefined) return null;
    const servers = { ...c.json.mcpServers };
    delete servers[NAME];
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: servers }, null, 2)}\n`);
    return null;
  },
  rulesFile: (env) => join(GEMINI_DIR(env), 'GEMINI.md'),
  signIn: 'In Gemini CLI, type /mcp auth brainai; your browser asks you to Allow.',
};

const NEEDS_AGAIN = 'needs connecting again';
/** server() for an entry that is this brain's own but no longer works (moved program, revoked or missing key). */
const OWN_STALE = 'own entry that needs connecting again';
const ON_A_DISK_IMAGE = /^\/Volumes\/|\/AppTranslocation\//;
const CLAUDE_QUIT = 'Quit Claude completely (⌘Q on the Mac; on Windows, quit it from the tray icon) and open it again.';

/** Where Claude's desktop app keeps its settings. */
export function claudeConfigPath(env: ToolEnv): string {
  if (env.claudeConfig) return env.claudeConfig;
  if (platformOf(env) === 'win32') {
    const appData = (env.system ?? process.env).APPDATA || join(env.home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(env.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

function claudeDesktopConfig(env: ToolEnv): { path: string; json: { mcpServers?: Record<string, unknown> } & Record<string, unknown> } | { refuse: string } {
  const path = claudeConfigPath(env);
  const text = read(path);
  if (text === null) return { path, json: {} };
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    const servers = (json as { mcpServers?: unknown }).mcpServers;
    if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('not an object');
    return { path, json: json as Record<string, unknown> };
  } catch {
    return { refuse: "Claude's claude_desktop_config.json is not plain JSON: BrainAI will not rewrite it." };
  }
}

/** The grant in the key file, or null. */
function storedGrant(env: ToolEnv): string | null {
  if (!env.bridge) return null;
  try {
    const key = JSON.parse(readFileSync(join(env.bridge.dataDir, BRIDGE_KEY_FILE), 'utf8')) as { grant?: unknown; token?: unknown };
    return typeof key.grant === 'string' && key.grant !== '' && typeof key.token === 'string' && key.token !== '' ? key.grant : null;
  } catch { return null; }
}

/** Takes the stored key back (revoked, file deleted). A revoke that fails (already gone) never stops the rest. */
function dropKey(env: ToolEnv): void {
  if (!env.bridge) return;
  const grant = storedGrant(env);
  if (grant) { try { env.revokeKey?.(grant); } catch { /* already revoked or gone */ } }
  rmSync(join(env.bridge.dataDir, BRIDGE_KEY_FILE), { force: true });
}

/** Whether two paths are the same place: realpath when both exist, and on Windows case and a leading \\?\\ do not matter. */
export function samePath(a: string, b: string, platform: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const [x, y] = existsSync(a) && existsSync(b) ? [real(a), real(b)] : [a, b];
  if (platform !== 'win32') return x === y;
  const norm = (p: string) => p.replace(/^\\\\\?\\/, '').toLowerCase();
  return norm(x) === norm(y);
}

const claudeDesktop: Tool = {
  id: 'claude-desktop', name: 'Claude (desktop app)', slug: 'claude-code',
  installed: (env) => existsSync(join(env.apps ?? '/Applications', 'Claude.app')) || existsSync(dirname(claudeConfigPath(env))),
  async server(env) {
    const c = claudeDesktopConfig(env);
    if ('refuse' in c) return { refuse: c.refuse };
    const entry = c.json.mcpServers?.[NAME] as { command?: unknown; args?: unknown } | undefined;
    if (entry === undefined) return null;
    const args = Array.isArray(entry.args) ? entry.args : [];
    const cli = args[0];
    if (typeof entry.command !== 'string' || typeof cli !== 'string' || args[1] !== 'claude-bridge') return NO_ADDRESS;
    const theirData = (entry as { env?: { BRAINAI_DATA_DIR?: unknown } }).env?.BRAINAI_DATA_DIR;
    const platform = platformOf(env);
    const ownData = !!env.bridge && typeof theirData === 'string' && samePath(theirData, env.bridge.dataDir, platform);
    // The app was moved (or removed): its program is gone, so the entry cannot start.
    if (!existsSync(entry.command) || !existsSync(cli)) return ownData ? OWN_STALE : NEEDS_AGAIN;
    if (!env.bridge || (!ownData && !samePath(cli, env.bridge.cli, platform))) return `another BrainAI (${cli})`;
    // Connected means the key works: the file is there and its grant is live.
    const grant = storedGrant(env);
    return grant !== null && (env.keyLive?.(grant) ?? true) ? env.mcpUrl : OWN_STALE;
  },
  async add(env) {
    if (!env.bridge || !env.issueKey) return "BrainAI cannot connect Claude's desktop app from here.";
    const c = claudeDesktopConfig(env);
    if ('refuse' in c) return c.refuse;
    const keyFile = join(env.bridge.dataDir, BRIDGE_KEY_FILE);
    dropKey(env); // a key left from an earlier connection
    let key: { grantId: string; token: string };
    try { key = env.issueKey(); } catch (e) { return `BrainAI could not make a key for Claude: ${(e as Error).message}`; }
    try {
      mkdirSync(env.bridge.dataDir, { recursive: true });
      writeFileSync(keyFile, JSON.stringify({ grant: key.grantId, token: key.token }), { mode: 0o600 });
      chmodSync(keyFile, 0o600);
      const entry = { command: env.bridge.node, args: [env.bridge.cli, 'claude-bridge'], env: { BRAINAI_DATA_DIR: env.bridge.dataDir, BRAINAI_PORT_FILE: env.bridge.portFile } };
      writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: { ...c.json.mcpServers, [NAME]: entry } }, null, 2)}\n`);
    } catch (e) {
      try { env.revokeKey?.(key.grantId); } catch { /* nothing more to do */ }
      rmSync(keyFile, { force: true });
      return `BrainAI could not write ${c.path}: ${(e as Error).message}`;
    }
    return null;
  },
  async remove(env) {
    const c = claudeDesktopConfig(env);
    if ('refuse' in c) return c.refuse;
    // Nothing of ours there: leave the file (or its absence) alone.
    if (c.json.mcpServers?.[NAME] === undefined) return null;
    const servers = { ...c.json.mcpServers };
    delete servers[NAME];
    try { writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: servers }, null, 2)}\n`); } catch (e) { return `BrainAI could not write ${c.path}: ${(e as Error).message}`; }
    dropKey(env);
    return null;
  },
  // Its instructions come from BrainAI's own MCP instructions; Claude's app has no rules file.
  rulesFile: () => null,
  signIn: CLAUDE_QUIT,
  otherDetail: (server) => server,
  blocked: (env) => (env.bridge && (ON_A_DISK_IMAGE.test(env.bridge.node) || ON_A_DISK_IMAGE.test(env.bridge.cli)) ? 'Move BrainAI to Applications first, then connect Claude.' : null),
  extraTraces: (env) => !!env.bridge && existsSync(join(env.bridge.dataDir, BRIDGE_KEY_FILE)),
  cleanup: (env) => dropKey(env),
};

const TOOLS: Tool[] = [claudeCode, codex, opencode, cursor, gemini, claudeDesktop];

interface Look {
  server: string | null; refuse?: string;
  /** The block in its instructions: absent, or present with the host it names (null: unreadable). */
  block: { host: string | null } | null;
  /** Brain wording outside any block (its host, "" when unreadable), or null. */
  stray: string | null;
}

async function look(tool: Tool, env: ToolEnv): Promise<Look> {
  const s = await tool.server(env);
  const file = tool.rulesFile(env);
  const text = file ? read(file) ?? '' : '';
  const found = findBlock(text);
  const block = found ? { host: found.host } : null;
  const stray = strayBrain(text);
  if (s !== null && typeof s === 'object') return { server: null, refuse: s.refuse, block, stray };
  return { server: s, block, stray };
}

function stateFrom(tool: Tool, env: ToolEnv, l: Look): Pick<ToolState, 'state' | 'detail'> {
  const ours = hostOf(env.mcpUrl);
  if (l.server === OWN_STALE) return { state: 'not-connected', detail: NEEDS_AGAIN };
  if (l.server !== null && l.server !== env.mcpUrl) {
    if (tool.otherDetail && l.server !== NO_ADDRESS) return { state: 'other-brainai', detail: tool.otherDetail(l.server) };
    return { state: 'other-brainai', detail: l.server === NO_ADDRESS ? `it has a brainai entry that is not this one (${NO_ADDRESS})` : `its brainai server points at ${hostOf(l.server)}` };
  }
  // A block that does not name this BrainAI exactly (another host, or wording BrainAI cannot read) belongs to another brain.
  if (l.block && l.block.host !== ours) return { state: 'other-brainai', detail: `its rules are for ${l.block.host ? `the BrainAI at ${l.block.host}` : 'another brain'}` };
  if (l.stray !== null) return { state: 'other-brainai', detail: `its instructions describe another brain${l.stray ? ` (${l.stray})` : ''}` };
  const rulesOk = tool.rulesFile(env) === null || l.block?.host === ours;
  return { state: l.server === env.mcpUrl && rulesOk ? 'connected' : 'not-connected' };
}

/** Each look starts a CLI (slow on Windows), so the tools are looked at together; the list keeps the order of TOOLS. `tools` is a seam for tests. */
export async function toolStates(env: ToolEnv, tools: Tool[] = TOOLS): Promise<ToolState[]> {
  return Promise.all(tools.map(async (tool): Promise<ToolState> => {
    const installed = tool.installed(env);
    const base = { id: tool.id, name: tool.name, installed, signIn: tool.signIn };
    if (!installed) return { ...base, state: 'not-connected' };
    return { ...base, ...stateFrom(tool, env, await look(tool, env)), hooks: hooksState(tool.id, env) };
  }));
}

/**
 * Whether the BrainAI plugin for Claude Code is installed: Claude Code records installed plugins as "<name>@<marketplace>"
 * in ~/.claude/plugins/installed_plugins.json. The plugin brings its own server entry, save reminders and instructions, so
 * the desktop Connect must not add a second set.
 */
export function brainPluginInstalled(env: ToolEnv): boolean {
  try {
    const text = read(join(env.home, '.claude', 'plugins', 'installed_plugins.json'));
    const plugins = text === null ? null : (JSON.parse(text) as { plugins?: Record<string, unknown> }).plugins;
    return !!plugins && typeof plugins === 'object' && Object.keys(plugins).some((k) => k.startsWith('brainai@') && Array.isArray(plugins[k]) && (plugins[k] as unknown[]).length > 0);
  } catch {
    return false;
  }
}

export async function connect(id: ToolId, env: ToolEnv, opts: { replace?: boolean }): Promise<Outcome> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return { ok: false, reason: `${tool?.name ?? id} is not installed on ${thisComputer()}.` };
  const blocked = tool.blocked?.(env);
  if (blocked) return { ok: false, reason: blocked };
  if (id === 'claude-code' && brainPluginInstalled(env)) {
    return { ok: true, signIn: 'The BrainAI plugin is already installed in Claude Code, so nothing was added here: the plugin brings its own connection, save reminders and instructions. In Claude Code, type /mcp, choose brainai and Authenticate. To connect from here instead, uninstall the plugin first.' };
  }
  const l = await look(tool, env);
  if (l.refuse) return { ok: false, reason: l.refuse };
  const s = stateFrom(tool, env, l);
  const file = tool.rulesFile(env);
  // Brain wording outside the markers cannot be replaced safely: nobody can tell where it ends.
  if (l.stray !== null) {
    return { ok: false, reason: `${tool.name} already uses another brain: ${s.detail}. BrainAI will not change wording it did not write: edit ${file} yourself (remove the other brain's lines), then press Connect.` };
  }
  if (s.state === 'other-brainai' && !opts.replace) {
    return { ok: false, reason: `${tool.name} already uses another BrainAI (${s.detail}). Press Replace to use this one instead.` };
  }
  let added = false;
  if (l.server !== env.mcpUrl) {
    if (l.server !== null) {
      const removed = await tool.remove(env);
      if (removed) return { ok: false, reason: removed };
    }
    const failed = await tool.add(env);
    if (failed) return { ok: false, reason: failed };
    added = true;
  }
  // The rules only once the server entry worked; if they cannot be written, the entry is taken back.
  if (file) {
    try {
      writeWithBackup(file, putBlock(read(file) ?? '', env.rules(tool.slug)));
    } catch (e) {
      if (added) await tool.remove(env);
      return { ok: false, reason: `BrainAI could not write ${file}: ${(e as Error).message}` };
    }
  }
  tool.after?.(env);
  const hooksNote = installHooks(tool.id, env);
  return { ok: true, signIn: tool.signIn, ...(hooksNote ? { hooksNote } : {}) };
}

export async function disconnect(id: ToolId, env: ToolEnv): Promise<Outcome> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return { ok: false, reason: `${tool?.name ?? id} is not installed on ${thisComputer()}.` };
  const l = await look(tool, env);
  if (l.refuse) return { ok: false, reason: l.refuse };
  if (stateFrom(tool, env, l).state === 'other-brainai') {
    tool.cleanup?.(env); // our own key is ours whatever the entry says; the entry itself is left alone
    return { ok: false, reason: `${tool.name} uses another BrainAI: BrainAI leaves it as it is.` };
  }
  if (l.server === env.mcpUrl || l.server === OWN_STALE) {
    const removed = await tool.remove(env);
    if (removed) return { ok: false, reason: removed };
  }
  tool.cleanup?.(env);
  const file = tool.rulesFile(env);
  const text = file ? read(file) : null;
  try {
    if (file && text !== null && findBlock(text)?.host === hostOf(env.mcpUrl)) writeWithBackup(file, removeBlock(text));
  } catch (e) {
    return { ok: false, reason: `BrainAI could not write ${file}: ${(e as Error).message}` };
  }
  // The desktop app's key is a grant that cleanup already revoked; every other tool signed in with OAuth.
  const ended = tool.id === 'claude-desktop' ? 0 : (env.endSignIns?.(tool.name) ?? 0);
  // The save reminders go with the connection (Claude Code's not while another brain may still use them).
  const hooksNote = hasHooks(tool.id) ? removeToolHooks(tool.id, env, tool.id === 'claude-code' ? await claudeCodeHasBrainEntry(env) : otherBrainEntry(tool.id, env)) : null;
  return { ok: true, signIn: '', ended, ...(hooksNote ? { hooksNote } : {}) };
}

/**
 * The `.brainai-backup` files BrainAI made beside the owner's originals (CLAUDE.md, Codex's config.toml and AGENTS.md,
 * OpenCode's opencode.json and AGENTS.md, Cursor's mcp.json, Gemini CLI's settings.json and GEMINI.md, the hook files of Codex and Cursor; not Claude Code's settings.json backup, see dropSettingsBackup) that exist now, as absolute paths. Removing BrainAI
 * moves them into the saved folder, so the owner's originals are kept in one place.
 */
export function backupFiles(env: ToolEnv): string[] {
  const originals = [
    join(env.home, '.claude', 'CLAUDE.md'),
    join(env.home, '.codex', 'config.toml'),
    join(env.home, '.codex', 'AGENTS.md'),
    join(OPENCODE_DIR(env), 'opencode.json'),
    join(OPENCODE_DIR(env), 'AGENTS.md'),
    join(env.home, '.cursor', 'mcp.json'),
    join(GEMINI_DIR(env), 'settings.json'),
    join(GEMINI_DIR(env), 'GEMINI.md'),
    join(env.home, '.codex', 'hooks.json'),
    join(env.home, '.cursor', 'hooks.json'),
    claudeConfigPath(env),
  ];
  return originals.map((f) => `${f}.brainai-backup`).filter((f) => existsSync(f));
}

/**
 * ~/.claude/settings.json.brainai-backup holds the owner's whole settings, which can include env tokens, so Remove never
 * copies it into the saved folder (often iCloud-synced). Called after Claude Code's hooks are gone from settings.json:
 * the backup is deleted (settings.json keeps the owner's later changes) and the returned line says so; null if none.
 */
export function dropSettingsBackup(env: ToolEnv): string | null {
  const file = join(env.home, '.claude', 'settings.json.brainai-backup');
  if (!existsSync(file)) return null;
  try { rmSync(file, { force: true }); } catch (e) { return `~/.claude/settings.json.brainai-backup was left where it is (it can hold tokens; delete it by hand): ${(e as Error).message}`; }
  return 'Claude Code: BrainAI deleted its backup of ~/.claude/settings.json (it can hold tokens, so it is not in this folder). Your settings.json keeps everything except BrainAI\'s save reminders.';
}

/** Whether Codex's or Cursor's config names another brain's `memory` server, whose hooks may share BrainAI's script. */
function otherBrainEntry(id: ToolId, env: ToolEnv): boolean {
  const file = id === 'codex' ? join(env.home, '.codex', 'config.toml') : id === 'cursor' ? join(env.home, '.cursor', 'mcp.json') : null;
  const text = file ? read(file) : null;
  return text !== null && /\[mcp_servers\.memory\]|"memory"\s*:/.test(text);
}

/**
 * What a tool holds of this brain: its brainai server entry or rules block ('yes'), nothing ('no'), or a configuration
 * BrainAI will not read ('unreadable': it cannot say, and cannot rewrite it either).
 */
export async function tracesOfThisBrain(id: ToolId, env: ToolEnv): Promise<'yes' | 'no' | 'unreadable'> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return 'no';
  const l = await look(tool, env);
  if (l.refuse !== undefined) return 'unreadable';
  return l.server === env.mcpUrl || l.server === OWN_STALE || l.block?.host === hostOf(env.mcpUrl) || tool.extraTraces?.(env) ? 'yes' : 'no';
}

/** A brain entry (`brainai` or `memory`) in ~/.claude.json, at the top or under any project; true when unreadable. */
function claudeJsonHasBrain(env: ToolEnv): boolean {
  const file = join(env.home, '.claude.json');
  if (!existsSync(file)) return false;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    const has = (m?: Record<string, unknown>) => !!m && typeof m === 'object' && (NAME in m || 'memory' in m);
    return has(json.mcpServers) || Object.values(json.projects ?? {}).some((p) => has(p?.mcpServers));
  } catch { return true; }
}

/**
 * Whether Claude Code may still have a brain: an MCP server named `brainai` or `memory`, asked of `claude` and read from
 * ~/.claude.json. True unless that is certain not to be so: Claude Code not found, no clear answer or a timeout count
 * as yes, because the hooks are only deleted when nobody could be using them.
 */
export async function claudeCodeHasBrainEntry(env: ToolEnv): Promise<boolean> {
  if (!onPath(env, 'claude')) return true;
  if (claudeJsonHasBrain(env)) return true;
  for (const name of [NAME, 'memory']) {
    const r = await run(env, 'claude', ['mcp', 'get', name]);
    if (r.code !== 0 && notFound(r)) continue;
    return true;
  }
  return false;
}

/** Takes back a key this brain left for a tool whose entry belongs to another BrainAI; the entry is not touched. */
export function dropLeftoverKey(id: ToolId, env: ToolEnv): void {
  const tool = TOOLS.find((t) => t.id === id);
  if (tool?.installed(env)) tool.cleanup?.(env);
}

/** Adds the save reminders to a tool that is already connected (the Tools page's "Add save reminders"). */
export async function addReminders(id: ToolId, env: ToolEnv): Promise<Outcome> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return { ok: false, reason: `${tool?.name ?? id} is not installed on ${thisComputer()}.` };
  if (!hasHooks(id)) return { ok: false, reason: `${tool.name} has no hooks BrainAI can use.` };
  if (!env.hooksDir) return { ok: false, reason: 'This BrainAI has no hook scripts to install.' };
  const note = installHooks(id, env);
  return note && !/trust the new hooks/.test(note) ? { ok: false, reason: note } : { ok: true, signIn: '', ...(note ? { hooksNote: note } : {}) };
}
