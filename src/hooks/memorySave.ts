// Claude Code Stop hook: after a stretch of work with nothing saved to the shared memory, it stops Claude once and
// asks it to save or update the project's status. Installed as ~/.claude/hooks/memory-save.mjs
// (scripts/install-claude-code-hooks.sh); it must only import Node built-ins, because it runs on its own.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How many changes (edits, writes, shell commands) since the last save earn a reminder. */
export const WORK_THRESHOLD = 12;
const WORK = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);
const SAVE = /^mcp__.+__(remember|update_memory)$/;
const STATE_DAYS = 7;

const REASON = 'Shared memory check: you have done a stretch of work since anything was last saved to the shared memory. '
  + 'If a step finished, something was decided, or the plan changed, save it now with the memory tools; for a status, '
  + 'update the existing status rather than adding another, and update the project\'s roadmap if what is left changed. '
  + 'If nothing lasting happened, stop without saving.';

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

function main(): void {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as { session_id?: string; transcript_path?: string; stop_hook_active?: boolean };
    if (input.stop_hook_active || !input.transcript_path) return;
    const dir = join(homedir(), '.claude', 'hooks', 'state');
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > STATE_DAYS * 86_400_000) rmSync(p, { force: true });
    }
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
