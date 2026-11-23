/**
 * Where the coding tools are looked for. `toolPathFor` is the pure list the app builds for Connect (server.rs windows_tool_path)
 * and the uninstaller uses: the session's PATH first, then where npm, installers and winget put command-line tools.
 *
 * On Windows the server also keeps the list current (`refreshToolPath`): the app hands the server a PATH once, when it starts,
 * so a tool installed later (or a Node whose installer added a folder) was "not found" until BrainAI was quit and opened again.
 * The server re-reads the person's and the system's environment from the registry whenever the Tools page, a Connect, a
 * Disconnect or Remove looks for tools. The Mac keeps the PATH its login shell gave at start: a new tool there lands in a
 * folder already on it, and findCommand looks at the disk on every call.
 */
import { execFile } from 'node:child_process';
import type { ToolEnv } from './tools.js';

interface Folders { home: string; appData?: string; localAppData?: string; programFiles?: string }

/** The usual install folders after the PATH (Windows). A variable that is not set is skipped, never guessed. */
function windowsFallbackFolders(i: Folders): string[] {
  return [
    ...(i.appData ? [`${i.appData}\\npm`] : []),
    `${i.home}\\.local\\bin`,
    ...(i.localAppData ? [`${i.localAppData}\\Microsoft\\WinGet\\Links`] : []),
    ...(i.programFiles ? [`${i.programFiles}\\nodejs`] : []),
  ];
}

/** The same list the app builds for Connect. On Windows ';' separated; elsewhere ':' and only ~/.local/bin is added. */
export function toolPathFor(i: { platform: NodeJS.Platform; path: string | undefined; home: string; appData?: string; localAppData?: string; programFiles?: string }): string {
  const win = i.platform === 'win32';
  const parts = (i.path ?? '').split(win ? ';' : ':').filter(Boolean);
  if (win) return [...parts, ...windowsFallbackFolders(i)].join(';');
  parts.push(`${i.home}/.local/bin`);
  return parts.join(':');
}

/** Every `name REG_SZ|REG_EXPAND_SZ value` line of `reg query` output. */
export function parseReg(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined && m[2] !== '') out[m[1]] = m[2];
  }
  return out;
}

/** The Path value in `reg query <key> /v Path` (or whole-key) output, or null. */
export function pathFromReg(output: string): string | null {
  const v = parseReg(output);
  const key = Object.keys(v).find((k) => k.toLowerCase() === 'path');
  return key ? v[key]! : null;
}

/** %NAME% replaced from the variables (names compare without case on Windows); an unknown one stays as written. Two passes: a variable may name another. */
export function expandVars(text: string, vars: Record<string, string | undefined>): string {
  const lower = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  const once = (s: string) => s.replace(/%([^%;]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
  return once(once(text));
}

export interface PathParts {
  /** The registry's system and user Path (unexpanded), when they could be read. */
  system: string | null; user: string | null;
  /** The PATH this run already has. */
  current: string;
  /** For %VAR% in the registry values and the fallback folders: the registry's own variables over the environment's. */
  vars: Record<string, string | undefined>;
  home: string;
}

/** The Windows tool PATH: system, user, what the run had, then the usual folders (the same ones toolPathFor adds). No duplicates. */
export function composeWindowsPath(p: PathParts): string {
  const v = (k: string) => Object.entries(p.vars).find(([n, val]) => n.toLowerCase() === k.toLowerCase() && val)?.[1];
  const parts = [
    ...[p.system, p.user].flatMap((x) => (x ? expandVars(x, p.vars).split(';') : [])),
    ...p.current.split(';'),
    ...windowsFallbackFolders({ home: p.home, appData: v('APPDATA'), localAppData: v('LOCALAPPDATA'), programFiles: v('ProgramFiles') }),
  ];
  const seen = new Set<string>();
  return parts.map((x) => x.trim()).filter((x) => {
    const key = x.replace(/[\\/]+$/, '').toLowerCase();
    if (!x || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(';');
}

const USER_KEY = 'HKCU\\Environment';
const SYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const READ_MS = 2_000;

/**
 * `reg query <key>` through the command prompt after `chcp 65001`: reg.exe writes the console's code page when its output is
 * piped (the OEM one by default), so asking for UTF-8 first and decoding as UTF-8 keeps accented folder names right. Called by
 * its absolute path so nothing named reg.exe in a PATH folder runs instead.
 */
function regQuery(key: string, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    try {
      const reg = `${env.SystemRoot || env.windir || 'C:\\Windows'}\\System32\\reg.exe`;
      const cmd = `${env.SystemRoot || env.windir || 'C:\\Windows'}\\System32\\cmd.exe`;
      execFile(cmd, ['/d', '/s', '/c', `"chcp 65001>nul & "${reg}" query "${key}""`], { windowsHide: true, windowsVerbatimArguments: true, timeout: READ_MS, encoding: 'utf8' }, (err, stdout) => resolve(err ? {} : parseReg(String(stdout))));
    } catch { resolve({}); }
  });
}

export interface RegistryRead { system: string | null; user: string | null; vars?: Record<string, string> }

async function readRegistry(): Promise<RegistryRead> {
  const [system, user] = await Promise.all([regQuery(SYSTEM_KEY, process.env), regQuery(USER_KEY, process.env)]);
  const pathOf = (v: Record<string, string>) => Object.entries(v).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? null;
  // The user's variables win over the system's, which win over the process environment (Windows' own order).
  return { system: pathOf(system), user: pathOf(user), vars: { ...system, ...user } };
}

let latest: string | null = null;
/** The PATH the run started with, captured once: every composition starts from it, so a folder dropped from the registry Path drops out. */
let startPath: string | null = null;
let at = 0;
let inflight: Promise<void> | null = null;
const FRESH_MS = 5_000;

/**
 * Re-reads the environment (Windows only; a read, failed or not, is kept for 5 s and shared by simultaneous callers) and sets
 * `env.path`. A failed read leaves the PATH as it was. `read` is a seam for tests.
 */
export async function refreshToolPath(env: ToolEnv, read: () => Promise<RegistryRead> = readRegistry, now: () => number = Date.now): Promise<void> {
  if ((env.platform ?? process.platform) !== 'win32') return;
  if (!(at !== 0 && now() - at < FRESH_MS)) {
    inflight ??= (async () => {
      try {
        const r = await read();
        if (r.system !== null || r.user !== null) {
          startPath ??= env.path;
          latest = composeWindowsPath({ system: r.system, user: r.user, current: startPath, vars: { ...process.env, ...(env.system ?? {}), ...(r.vars ?? {}) }, home: env.home });
        }
      } catch { /* the PATH stays as it was */ }
      finally { at = now(); inflight = null; }
    })();
    await inflight;
  }
  if (latest !== null) env.path = latest;
}

/** Uses the last Path read, when there is one (an env built after a refresh). */
export function applyToolPath(env: ToolEnv): void {
  if (latest !== null && (env.platform ?? process.platform) === 'win32') env.path = latest;
}

/** For tests: forgets the kept Path. */
export function forgetToolPath(): void { latest = null; startPath = null; at = 0; inflight = null; }
