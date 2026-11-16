/**
 * What the owner's other BrainAI setup may have left on this computer, and that removing BrainAI takes away only when it
 * is this brain's own: the Claude Code hooks, and the Mac's folder report. Each looks at whose it is first and keeps
 * what belongs to another brain.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK_FILES = ['memory-start.mjs', 'memory-save.mjs'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Only our two scripts in ~/.claude/hooks: team-memory-save.mjs, or a memory-save.mjs elsewhere, is someone else's. */
const OURS = /\.claude[\\/]hooks[\\/]memory-(?:start|save)\.mjs/;
const namesOurs = (command: unknown) => typeof command === 'string' && OURS.test(command);

/** A `hooks` value without the commands that name our scripts; null when nothing in it did. */
function withoutOurHooks(hooks: Json): Json | null {
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

const LEFT = "Claude Code's BrainAI hooks were left in place: BrainAI couldn't confirm no other brain uses them (~/.claude/hooks/memory-start.mjs, memory-save.mjs)";

/**
 * Deletes ~/.claude/hooks/memory-start.mjs and memory-save.mjs and the settings.json hooks that run them; every other
 * hook and key stays. settings.json is rewritten first and the scripts deleted only once that worked, so a hook entry
 * never points at a missing script; if it cannot be read or written, nothing is deleted and `kept` says what to remove
 * by hand. Not while a brain may still use them (`stillConnected`).
 */
export function removeHooks(env: { home: string }, stillConnected: boolean): { removed: string[]; kept: string | null } {
  if (stillConnected) return { removed: [], kept: `${LEFT}.` };
  const settings = join(env.home, '.claude', 'settings.json');
  const byHand = (why: string) => ({ removed: [], kept: `Claude Code's BrainAI hooks were left in place: ${why}. Remove the entries naming memory-start.mjs and memory-save.mjs from ~/.claude/settings.json, then delete those two files in ~/.claude/hooks, by hand.` });
  let rewritten = false;
  if (existsSync(settings)) {
    try {
      const json = JSON.parse(readFileSync(settings, 'utf8')) as unknown;
      if (!isObject(json)) return byHand('settings.json is not a JSON object');
      if (isObject(json.hooks)) {
        const next = withoutOurHooks(json.hooks);
        if (next) {
          const { hooks: _old, ...others } = json;
          writeFileSync(settings, `${JSON.stringify(Object.keys(next).length > 0 ? { ...others, hooks: next } : others, null, 2)}\n`);
          rewritten = true;
        }
      }
    } catch (e) {
      return byHand(`BrainAI could not update settings.json (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const removed: string[] = [];
  try {
    for (const name of HOOK_FILES) {
      const file = join(env.home, '.claude', 'hooks', name);
      if (existsSync(file)) { rmSync(file, { force: true }); removed.push(`.claude/hooks/${name}`); }
    }
  } catch (e) {
    return { removed, kept: `Claude Code's hook scripts could not be deleted (${e instanceof Error ? e.message : String(e)}): delete memory-start.mjs and memory-save.mjs in ~/.claude/hooks by hand.` };
  }
  if (rewritten) removed.push('.claude/settings.json (the hooks that run them)');
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
    return { removed: false, kept: `The folder report on this Mac reports to another brain${url ? ` (${url})` : ''}, so it stays.` };
  }
  try { launchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${LABEL}`]); } catch { /* it was not running */ }
  rmSync(plist, { force: true });
  rmSync(join(env.home, '.config', 'brain', 'device-token'), { force: true });
  return { removed: true, kept: null };
}
