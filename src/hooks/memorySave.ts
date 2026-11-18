// Claude Code Stop and PreCompact hook: on Stop, after a stretch of work with nothing saved to the shared memory, it stops Claude once and
// asks it to save or update the project's status. Installed as ~/.claude/hooks/memory-save.mjs
// (scripts/install-claude-code-hooks.sh); it must only import Node built-ins, because it runs on its own.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How many changes (edits, writes, shell commands) since the last save earn a reminder. */
export const WORK_THRESHOLD = 12;
const WORK = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);
const SAVE = /^mcp__.+__(remember|update_memory|suggest_memories)$/;
const STATE_DAYS = 7;

/** The one reminder text, the same in every tool's hook (src/hooks/memoryNudge.ts repeats it; a test keeps them equal). */
export const NUDGE = 'Shared memory check: if decisions were made or the status changed in this session and are not saved yet, '
  + 'save them now with remember (update the project\'s status rather than adding another), or run the harvest-session skill '
  + 'to suggest them for the owner\'s approval. If nothing lasting happened, carry on.';
const REASON = NUDGE;
/** PreCompact: its stdout is read by the model that writes the compaction summary (code.claude.com/docs/en/hooks: "your stdout becomes instructions for the compaction summary"), so the reminder is phrased as a to-do for what comes after. */
export const COMPACT_NOTE = `Put this in the compaction summary as a to-do for the next turn: ${NUDGE}`;
/** Work since the last save that earns a note at compaction (compaction itself already says the session is long). */
const COMPACT_THRESHOLD = 3;

/** Tool names used in a Claude Code transcript (JSON lines), in order. Lines it does not understand are skipped. */
export function readToolUses(transcript: string): string[] {
  const names: string[] = [];
  for (const line of transcript.split('\n')) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = (entry as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && part.type === 'tool_use' && typeof part.name === 'string') names.push(part.name);
    }
  }
  return names;
}

/**
 * Whether to stop Claude with a reminder. `nudgedAt` is how many tool uses the transcript had at the last reminder,
 * so each stretch of work is reminded about once. Never blocks a stop that a stop hook already caused.
 */
export function saveNudge(s: { tools: string[]; stopHookActive: boolean; nudgedAt: number }): { block: boolean; reason?: string; nudgedAt: number } {
  if (s.stopHookActive) return { block: false, nudgedAt: s.nudgedAt };
  let lastSave = -1;
  s.tools.forEach((t, i) => { if (SAVE.test(t)) lastSave = i; });
  const from = Math.max(lastSave + 1, s.nudgedAt);
  const work = s.tools.slice(from).filter((t) => WORK.has(t)).length;
  if (work < WORK_THRESHOLD) return { block: false, nudgedAt: s.nudgedAt };
  return { block: true, reason: REASON, nudgedAt: s.tools.length };
}

/** What a PreCompact hook prints (plain stdout becomes instructions for the summary), or '' when little work is unsaved. */
export function compactNote(tools: string[]): string {
  let lastSave = -1;
  tools.forEach((t, i) => { if (SAVE.test(t)) lastSave = i; });
  return tools.slice(lastSave + 1).filter((t) => WORK.has(t)).length >= COMPACT_THRESHOLD ? COMPACT_NOTE : '';
}

/** Deletes this hook's own state files (memory-save-*.json) older than a week: never any other file in the folder. */
export function pruneState(dir: string, now: number): void {
  for (const f of readdirSync(dir)) {
    if (!/^memory-save-.*\.json$/.test(f)) continue;
    const p = join(dir, f);
    try { if (now - statSync(p).mtimeMs > STATE_DAYS * 86_400_000) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
}

function main(): void {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as { session_id?: string; transcript_path?: string; stop_hook_active?: boolean; hook_event_name?: string };
    if (input.hook_event_name === 'PreCompact') {
      if (input.transcript_path) process.stdout.write(compactNote(readToolUses(readFileSync(input.transcript_path, 'utf8'))));
      return;
    }
    if (input.stop_hook_active || !input.transcript_path) return;
    const dir = join(homedir(), '.claude', 'hooks', 'state');
    mkdirSync(dir, { recursive: true });
    pruneState(dir, Date.now());
    const stateFile = join(dir, `memory-save-${(input.session_id ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '')}.json`);
    let nudgedAt = 0;
    try { nudgedAt = Number((JSON.parse(readFileSync(stateFile, 'utf8')) as { nudgedAt?: number }).nudgedAt) || 0; } catch { /* first stop */ }
    const r = saveNudge({ tools: readToolUses(readFileSync(input.transcript_path, 'utf8')), stopHookActive: false, nudgedAt });
    if (!r.block) return;
    writeFileSync(stateFile, JSON.stringify({ nudgedAt: r.nudgedAt }));
    process.stdout.write(JSON.stringify({ decision: 'block', reason: r.reason }));
  } catch {
    // A reminder is never worth breaking the session: on any error, let Claude stop.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
