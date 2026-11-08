/**
 * The coding tools on the owner's Mac, and Connect / Disconnect for each (D3). Runs in the server, in local mode,
 * as the owner. Rules: BrainAI is added as a server named `brainai` (never touching one named `memory` or anything else),
 * a tool that already points at another BrainAI is left alone unless the owner presses Replace, every file is backed
 * up before it is changed, and the rules go in only once the server entry worked.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findBlock, putBlock, removeBlock, strayBrain } from './rulesBlock.js';
import { thisComputer } from './computer.js';

export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor';
export interface ToolEnv {
  home: string;
  /** Where to look for the tools' commands (the owner's login-shell PATH, from the app). */
  path: string;
  mcpUrl: string;
  /** The setup text for a tool, wrapped in its markers (setupText(slug, 'personal', mcpUrl, overlay)). */
  rules: (slug: string) => string;
  /** Where apps are installed (/Applications). */
  apps?: string;
  /** More environment for the tools' commands (tests). */
  extraEnv?: Record<string, string>;
  /** The computer's platform (tests pass win32 on a Mac); default process.platform. */
  platform?: NodeJS.Platform;
  /** Windows: where the system variables come from (default this server's own environment). */
  system?: Record<string, string | undefined>;
}
export interface ToolState {
  id: ToolId; name: string; installed: boolean;
  state: 'not-connected' | 'connected' | 'other-brainai';
  /** For other-brainai: what it points at now. */
  detail?: string;
  /** The one step after Connect: how the tool signs in. */
  signIn: string;
}
export type Outcome = { ok: true; signIn: string } | { ok: false; reason: string };

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

interface Tool {
  id: ToolId; name: string; slug: string;
  installed(env: ToolEnv): boolean;
  /** Where its brainai server points now (null: none), or an error when its config cannot be read safely. */
  server(env: ToolEnv): Promise<string | null | { refuse: string }>;
  add(env: ToolEnv): Promise<string | null>;
  remove(env: ToolEnv): Promise<string | null>;
  rulesFile(env: ToolEnv): string | null;
  signIn: string;
  after?(env: ToolEnv): void;
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
    const servers = { ...c.json.mcpServers };
    delete servers[NAME];
    writeWithBackup(c.path, `${JSON.stringify({ ...c.json, mcpServers: servers }, null, 2)}\n`);
    return null;
  },
  // Cursor's rules live in its own settings, not a file.
  rulesFile: () => null,
  signIn: 'Cursor asks you to sign in the first time it uses BrainAI. Paste the rules below into Cursor › Settings › Rules.',
};

const TOOLS: Tool[] = [claudeCode, codex, opencode, cursor];

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
  if (l.server !== null && l.server !== env.mcpUrl) {
    return { state: 'other-brainai', detail: l.server === NO_ADDRESS ? `it has a brainai entry that is not this one (${NO_ADDRESS})` : `its brainai server points at ${hostOf(l.server)}` };
  }
  // A block that does not name this BrainAI exactly (another host, or wording BrainAI cannot read) belongs to another brain.
  if (l.block && l.block.host !== ours) return { state: 'other-brainai', detail: `its rules are for ${l.block.host ? `the BrainAI at ${l.block.host}` : 'another brain'}` };
  if (l.stray !== null) return { state: 'other-brainai', detail: `its instructions describe another brain${l.stray ? ` (${l.stray})` : ''}` };
  const rulesOk = tool.rulesFile(env) === null || l.block?.host === ours;
  return { state: l.server === env.mcpUrl && rulesOk ? 'connected' : 'not-connected' };
}

export async function toolStates(env: ToolEnv): Promise<ToolState[]> {
  const out: ToolState[] = [];
  for (const tool of TOOLS) {
    const installed = tool.installed(env);
    const base = { id: tool.id, name: tool.name, installed, signIn: tool.signIn };
    if (!installed) { out.push({ ...base, state: 'not-connected' }); continue; }
    out.push({ ...base, ...stateFrom(tool, env, await look(tool, env)) });
  }
  return out;
}

export async function connect(id: ToolId, env: ToolEnv, opts: { replace?: boolean }): Promise<Outcome> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return { ok: false, reason: `${tool?.name ?? id} is not installed on ${thisComputer()}.` };
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
  return { ok: true, signIn: tool.signIn };
}

export async function disconnect(id: ToolId, env: ToolEnv): Promise<Outcome> {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool || !tool.installed(env)) return { ok: false, reason: `${tool?.name ?? id} is not installed on ${thisComputer()}.` };
  const l = await look(tool, env);
  if (l.refuse) return { ok: false, reason: l.refuse };
  if (stateFrom(tool, env, l).state === 'other-brainai') return { ok: false, reason: `${tool.name} uses another BrainAI: BrainAI leaves it as it is.` };
  if (l.server === env.mcpUrl) {
    const removed = await tool.remove(env);
    if (removed) return { ok: false, reason: removed };
  }
  const file = tool.rulesFile(env);
  const text = file ? read(file) : null;
  try {
    if (file && text !== null && findBlock(text)?.host === hostOf(env.mcpUrl)) writeWithBackup(file, removeBlock(text));
  } catch (e) {
    return { ok: false, reason: `BrainAI could not write ${file}: ${(e as Error).message}` };
  }
  return { ok: true, signIn: '' };
}
