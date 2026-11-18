// Stop-time reminder for Codex CLI and Cursor (docs/CLIENTS.md has the hook APIs and where each is documented): after a
// stretch of work with nothing saved to the shared memory, it asks the agent once to save or to run the harvest-session
// skill. Neither tool gives a stable transcript format, so work is counted from each tool's PostToolUse event.
// Installed as ~/.brainai/hooks/memory-nudge.mjs (Settings > Tools on this computer, or scripts/install-claude-code-hooks.sh);
// run as `node memory-nudge.mjs codex` or `node memory-nudge.mjs cursor`. It must only import Node built-ins.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Work calls since the last save that earn a reminder (the same as Claude Code's, src/hooks/memorySave.ts). */
export const WORK_THRESHOLD = 12;
/** The one reminder text: the same words in every tool's hook (a test keeps this equal to memorySave.ts's). */
export const NUDGE = 'Shared memory check: if decisions were made or the status changed in this session and are not saved yet, '
  + 'save them now with remember (update the project\'s status rather than adding another), or run the harvest-session skill '
  + 'to suggest them for the owner\'s approval. If nothing lasting happened, carry on.';
const SAVE = /(?:^|__|[.:/])(?:remember|update_memory|suggest_memories)$/;
/** Calls that change nothing: reading, searching, planning. Everything else counts as work. */
const QUIET = /read|grep|glob|search|list|view|fetch|find|^ls$|todo|plan|think/i;
const STATE_DAYS = 7;

export type Tool = 'codex' | 'cursor';

/** A tool call's effect on the count since the last save: 0 resets it, 1 adds work, null leaves it. */
export function countFor(toolName: string): 'save' | 'change' | null {
  if (SAVE.test(toolName)) return 'save';
  return QUIET.test(toolName) ? null : 'change';
}

/** What to print on stdout for a stop: Codex continues with a block reason, Cursor auto-sends a follow-up message. */
export function stopOutput(tool: Tool): string {
  return JSON.stringify(tool === 'codex' ? { decision: 'block', reason: NUDGE } : { followup_message: NUDGE });
}

export interface HookInput {
  hook_event_name?: string; session_id?: string; conversation_id?: string; tool_name?: string; stop_hook_active?: boolean;
}

/** One event in: the new count, and the text to print (null: nothing). */
export function handle(tool: Tool, input: HookInput, work: number): { work: number; out: string | null } {
  const event = (input.hook_event_name ?? '').toLowerCase();
  if (event === 'posttooluse') {
    const c = countFor(input.tool_name ?? '');
    return { work: c === 'save' ? 0 : c === 'change' ? work + 1 : work, out: null };
  }
  if (event === 'stop' && !input.stop_hook_active && work >= WORK_THRESHOLD) return { work: 0, out: stopOutput(tool) };
  return { work, out: null };
}

/** Deletes this hook's own state files (nudge-*.json) older than a week: never any other file in the folder. */
export function pruneState(dir: string, now: number): void {
  for (const f of readdirSync(dir)) {
    if (!/^nudge-.*\.json$/.test(f)) continue;
    const p = join(dir, f);
    try { if (now - statSync(p).mtimeMs > STATE_DAYS * 86_400_000) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
}

function main(): void {
  try {
    const tool = process.argv[2] === 'cursor' ? 'cursor' : 'codex';
    const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
    const dir = join(homedir(), '.brainai', 'hooks', 'state');
    mkdirSync(dir, { recursive: true });
    pruneState(dir, Date.now());
    const id = (input.session_id ?? input.conversation_id ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '');
    const file = join(dir, `nudge-${tool}-${id}.json`);
    let work = 0;
    try { work = Number((JSON.parse(readFileSync(file, 'utf8')) as { work?: number }).work) || 0; } catch { /* first event */ }
    const r = handle(tool, input, work);
    if (r.work !== work) writeFileSync(file, JSON.stringify({ work: r.work }));
    if (r.out !== null) process.stdout.write(r.out);
  } catch {
    // A reminder is never worth breaking the session: on any error, print nothing.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
