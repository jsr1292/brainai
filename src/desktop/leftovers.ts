/**
 * What the owner's other BrainAI setup may have left on this computer, and that removing BrainAI takes away only when it
 * is this brain's own: the Claude Code hooks, and the Mac's folder report. Each looks at whose it is first and keeps
 * what belongs to another brain.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { t } from '../i18n/core.js';
import { claudeDir, claudeHookCommand, type DirEnv } from './configDirs.js';
import { jsonText, readJsonFile, readTextFile } from './configFile.js';

const RETRY = ['EPERM', 'EACCES', 'EBUSY'];
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Writes a config in one step: a temp file in the same directory, renamed over the real file (a symlink is followed, so
 * it stays a symlink), so a crash never leaves half a config. The file keeps its permissions. On Windows a rename over a
 * file another program has open (Claude, an editor, antivirus) fails for a moment: it is tried again a few times (about
 * 1.5 s in all), then the text is written into the file itself, which still works when the file only blocks being replaced.
 * The temp file never stays. `rename` and `sleep` are seams for tests.
 */
export function writeAtomic(path: string, text: string, o: { platform?: NodeJS.Platform; rename?: typeof renameSync; sleep?: (ms: number) => void } = {}): void {
  const rename = o.rename ?? renameSync;
  const sleep = o.sleep ?? sleepSync;
  let target = path;
  try { target = realpathSync(path); } catch { /* new file */ }
  const tmp = join(dirname(target), `.${basename(target)}.brainai-${process.pid}.tmp`);
  let mode: number | undefined;
  try { mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    for (let attempt = 0; ; attempt++) {
      try { rename(tmp, target); break; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if ((o.platform ?? process.platform) !== 'win32' || !RETRY.includes(code)) throw e;
        if (attempt >= 5) {
          // Into the file itself. If that fails half way, the original bytes are put back before the error goes on.
          let original: Buffer | null = null;
          try { original = readFileSync(target); } catch { /* a new file */ }
          try { writeFileSync(target, text); } catch (w) {
            if (original) { try { writeFileSync(target, original); } catch { /* nothing more can be done */ } }
            throw w;
          }
          break;
        }
        sleep(100 * 2 ** attempt > 400 ? 400 : 100 * 2 ** attempt);
      }
    }
  } finally {
    // Best effort: a temp file that cannot be deleted (a scanner holds it) never turns a finished write into an error.
    try { rmSync(tmp, { force: true }); } catch { sleep(50); try { rmSync(tmp, { force: true }); } catch { /* left behind, harmless */ } }
  }
}

const HOOK_FILES = ['memory-start.mjs', 'memory-save.mjs'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Only our two scripts in Claude Code's hooks folder: team-memory-save.mjs, or a memory-save.mjs elsewhere, is someone else's. */
const OURS = /\.claude[\\/]hooks[\\/]memory-(?:start|save)\.mjs/i;
export const matcherFor = (re: RegExp) => (command: unknown): boolean => typeof command === 'string' && re.test(command);

/** A `hooks` value without the commands that name our scripts; null when nothing in it did. */
export function withoutOurHooks(hooks: Json, namesOurs: (command: unknown) => boolean = (c) => typeof c === 'string' && OURS.test(c)): Json | null {
  let changed = false;
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept: unknown[] = [];
    for (const g of groups) {
      if (isObject(g) && namesOurs(g.command)) { changed = true; continue; }
      if (isObject(g) && Array.isArray(g.hooks)) {
        const inner = g.hooks.filter((h) => !(isObject(h) && namesOurs(h.command)));
        if (inner.length !== g.hooks.length) {
          changed = true;
          if (inner.length === 0) continue;
          kept.push({ ...g, hooks: inner });
          continue;
        }
      }
      kept.push(g);
    }
    if (kept.length > 0) out[event] = kept;
    else if (groups.length > 0) changed = true;
    else out[event] = groups;
  }
  return changed ? out : null;
}

/** Claude's folder as the owner knows it: ~/.claude, or the folder CLAUDE_CONFIG_DIR names. */
const shownDir = (env: DirEnv) => (claudeDir(env) === join(env.home, '.claude') ? '~/.claude' : claudeDir(env));

/** Whether either hook script exists or settings.json names one (a settings.json that cannot be read counts as yes). */
function hooksPresent(env: DirEnv, settings: string, ours: RegExp): boolean {
  if (HOOK_FILES.some((name) => existsSync(join(claudeDir(env), 'hooks', name)))) return true;
  if (!existsSync(settings)) return false;
  try { const f = readTextFile(settings); return f === 'utf16' || (f !== null && ours.test(f.text)); } catch { return true; }
}

/**
 * Deletes memory-start.mjs and memory-save.mjs in Claude Code's hooks folder (~/.claude/hooks, or inside CLAUDE_CONFIG_DIR)
 * and the settings.json hooks that run them; every other hook and key stays. settings.json is rewritten first and the scripts
 * deleted only once that worked, so a hook entry never points at a missing script; if it cannot be read or written, nothing is
 * deleted and `kept` says what to remove by hand. Not while a brain may still use them (`stillConnected`).
 */
export function removeHooks(env: DirEnv, stillConnected: boolean): { removed: string[]; kept: string | null } {
  const dir = claudeDir(env);
  const settings = join(dir, 'settings.json');
  const ours = claudeHookCommand(env);
  // Nothing of BrainAI's there (Claude Code never installed, or its hooks already gone): nothing was left in place.
  if (!hooksPresent(env, settings, ours)) return { removed: [], kept: null };
  const where = shownDir(env);
  if (stillConnected) return { removed: [], kept: `${t('leftovers.hooks.left', { where: `${where}/hooks/memory-start.mjs, memory-save.mjs` })}.` };
  const byHand = (why: string) => ({ removed: [], kept: t('leftovers.hooks.byHand', { why, settings: `${where}/settings.json`, hooks: `${where}/hooks` }) });
  let rewritten = false;
  if (existsSync(settings)) {
    try {
      const f = readJsonFile(settings);
      if (f !== null && 'refuse' in f) return byHand(f.refuse === 'utf16' ? t('tools.refuse.utf16', { file: settings }) : t('leftovers.hooks.notObject'));
      if (f !== null && isObject(f.json.hooks)) {
        const next = withoutOurHooks(f.json.hooks, matcherFor(ours));
        if (next) {
          const { hooks: _old, ...others } = f.json;
          writeAtomic(settings, jsonText(Object.keys(next).length > 0 ? { ...others, hooks: next } : others, f.bom));
          rewritten = true;
        }
      }
    } catch (e) {
      return byHand(t('leftovers.hooks.updateFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const removed: string[] = [];
  const label = dir === join(env.home, '.claude') ? '.claude' : dir;
  try {
    for (const name of HOOK_FILES) {
      const file = join(dir, 'hooks', name);
      if (existsSync(file)) { rmSync(file, { force: true }); removed.push(`${label}/hooks/${name}`); }
    }
  } catch (e) {
    return { removed, kept: t('leftovers.hooks.deleteFailed', { error: e instanceof Error ? e.message : String(e), hooks: `${where}/hooks` }) };
  }
  if (rewritten) removed.push(`${label}/settings.json (the hooks that run them)`);
  return { removed, kept: null };
}

const PLIST = 'Library/LaunchAgents/org.brain.folder-report.plist';
const LABEL = 'org.brain.folder-report';

const origin = (url: string): string | null => { try { return new URL(url).origin; } catch { return null; } };

/** Runs launchctl; a seam so tests never reach the real one. */
export type Launchctl = (args: string[]) => void;
const realLaunchctl: Launchctl = (args) => { execFileSync('launchctl', args, { stdio: 'ignore', timeout: 15_000 }); };

/**
 * The Mac's folder report (a launchd job that tells a brain which project folders exist), only when it reports to this
 * brain (`ours`: this app's address, or its Reach address). Stops the job, deletes its plist and the device token; one
 * that reports to another brain is kept. Never acts off the Mac.
 */
export function removeFolderReport(
  env: { home: string; platform: NodeJS.Platform }, ours: string[], launchctl: Launchctl = realLaunchctl,
): { removed: boolean; kept: string | null } {
  if (env.platform !== 'darwin') return { removed: false, kept: null };
  const plist = join(env.home, PLIST);
  if (!existsSync(plist)) return { removed: false, kept: null };
  let text: string;
  try { text = readFileSync(plist, 'utf8'); } catch { return { removed: false, kept: null }; }
  const url = /<key>BRAIN_URL<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]?.trim() ?? '';
  const where = origin(url);
  if (!where || !ours.some((o) => origin(o) === where)) {
    return { removed: false, kept: url ? t('leftovers.folderReport.otherWith', { url }) : t('leftovers.folderReport.other') };
  }
  try { launchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${LABEL}`]); } catch { /* it was not running */ }
  rmSync(plist, { force: true });
  rmSync(join(env.home, '.config', 'brain', 'device-token'), { force: true });
  return { removed: true, kept: null };
}
