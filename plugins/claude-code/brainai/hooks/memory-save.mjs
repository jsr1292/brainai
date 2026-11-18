import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const WORK_THRESHOLD = 12;
const WORK = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);
const SAVE = /^mcp__.+__(remember|update_memory|suggest_memories)$/;
const STATE_DAYS = 7;
const NUDGE = "Shared memory check: if decisions were made or the status changed in this session and are not saved yet, save them now with remember (update the project's status rather than adding another), or run the harvest-session skill to suggest them for the owner's approval. If nothing lasting happened, carry on.";
const REASON = NUDGE;
const COMPACT_NOTE = `Put this in the compaction summary as a to-do for the next turn: ${NUDGE}`;
const COMPACT_THRESHOLD = 3;
function readToolUses(transcript) {
  const names = [];
  for (const line of transcript.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "tool_use" && typeof part.name === "string") names.push(part.name);
    }
  }
  return names;
}
function saveNudge(s) {
  if (s.stopHookActive) return { block: false, nudgedAt: s.nudgedAt };
  let lastSave = -1;
  s.tools.forEach((t, i) => {
    if (SAVE.test(t)) lastSave = i;
  });
  const from = Math.max(lastSave + 1, s.nudgedAt);
  const work = s.tools.slice(from).filter((t) => WORK.has(t)).length;
  if (work < WORK_THRESHOLD) return { block: false, nudgedAt: s.nudgedAt };
  return { block: true, reason: REASON, nudgedAt: s.tools.length };
}
function compactNote(tools) {
  let lastSave = -1;
  tools.forEach((t, i) => {
    if (SAVE.test(t)) lastSave = i;
  });
  return tools.slice(lastSave + 1).filter((t) => WORK.has(t)).length >= COMPACT_THRESHOLD ? COMPACT_NOTE : "";
}
function pruneState(dir, now) {
  for (const f of readdirSync(dir)) {
    if (!/^memory-save-.*\.json$/.test(f)) continue;
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > STATE_DAYS * 864e5) rmSync(p, { force: true });
    } catch {
    }
  }
}
function main() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (input.hook_event_name === "PreCompact") {
      if (input.transcript_path) process.stdout.write(compactNote(readToolUses(readFileSync(input.transcript_path, "utf8"))));
      return;
    }
    if (input.stop_hook_active || !input.transcript_path) return;
    const dir = join(homedir(), ".claude", "hooks", "state");
    mkdirSync(dir, { recursive: true });
    pruneState(dir, Date.now());
    const stateFile = join(dir, `memory-save-${(input.session_id ?? "unknown").replace(/[^A-Za-z0-9-]/g, "")}.json`);
    let nudgedAt = 0;
    try {
      nudgedAt = Number(JSON.parse(readFileSync(stateFile, "utf8")).nudgedAt) || 0;
    } catch {
    }
    const r = saveNudge({ tools: readToolUses(readFileSync(input.transcript_path, "utf8")), stopHookActive: false, nudgedAt });
    if (!r.block) return;
    writeFileSync(stateFile, JSON.stringify({ nudgedAt: r.nudgedAt }));
    process.stdout.write(JSON.stringify({ decision: "block", reason: r.reason }));
  } catch {
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
export {
  COMPACT_NOTE,
  NUDGE,
  WORK_THRESHOLD,
  compactNote,
  pruneState,
  readToolUses,
  saveNudge
};
