import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const WORKTREE_FOLDER = /^(.+?)\/(?:\.worktrees|\.claude\/worktrees)\/[^/]+(?:\/|$)/;
function projectNameFor(cwd, gitTop, home) {
  let dir = resolve(gitTop ?? cwd);
  const nested = WORKTREE_FOLDER.exec(dir);
  if (nested) dir = nested[1];
  if (dir === resolve(home) || dir === "/") return null;
  const name = basename(dir).normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name === "" ? null : name;
}
function startContext(source, project) {
  const again = source === "compact" ? "The conversation was just compacted. If the owner's profile or the project briefing is no longer in your context, load it again: " : "Shared memory: before your first reply, ";
  const brief = project === null ? "call the memory tool load_profile." : `call the memory tools load_profile and project_brief with project "${project}" (this session is in the folder ${project}). If project_brief finds no such project, use the closest name it suggests when that is clearly the same project; otherwise carry on without a briefing. Save this session's memories under project "${project}" (or the name the briefing used).`;
  return `${again}${brief} If the memory tools are missing or fail, tell the owner right away.`;
}
function repoRoot(cwd) {
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  let top;
  try {
    top = git("rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
  if (top === "") return null;
  try {
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    return basename(common) === ".git" ? dirname(common) : top;
  } catch {
    return top;
  }
}
function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
  }
  const cwd = input.cwd ?? process.cwd();
  const project = projectNameFor(cwd, repoRoot(cwd), homedir());
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: startContext(input.source ?? "startup", project) } }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
export {
  projectNameFor,
  repoRoot,
  startContext
};
