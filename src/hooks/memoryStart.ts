// Claude Code SessionStart hook: tells a new session to load the owner's profile and the briefing for the project
// it was opened in. Installed as ~/.claude/hooks/memory-start.mjs (scripts/install-claude-code-hooks.sh); it must
// only import Node built-ins, because it runs on its own outside this repo.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A checkout kept inside a project's .worktrees or .claude/worktrees folder belongs to that project. */
const WORKTREE_FOLDER = /^(.+?)\/(?:\.worktrees|\.claude\/worktrees)\/[^/]+(?:\/|$)/;

/**
 * The shared-memory project name for a folder: its git repository's folder name, else its own; none at home or root.
 * `gitTop` is the main checkout of the repository (repoRoot), so a worktree is named after its project, not its branch.
 */
export function projectNameFor(cwd: string, gitTop: string | null, home: string): string | null {
  let dir = resolve(gitTop ?? cwd);
  const nested = WORKTREE_FOLDER.exec(dir);
  if (nested) dir = nested[1]!;
  if (dir === resolve(home) || dir === '/') return null;
  // macOS hands back accented names decomposed ("i" + combining accent): drop the accent marks, not the letters.
  const name = basename(dir).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return name === '' ? null : name;
}

/** What the session is told, as context the model sees but the owner does not. */
export function startContext(source: string, project: string | null): string {
  const again = source === 'compact'
    ? 'The conversation was just compacted. If the owner\'s profile or the project briefing is no longer in your context, load it again: '
    : 'Shared memory: before your first reply, ';
  const brief = project === null
    ? 'call the memory tool load_profile.'
    : `call the memory tools load_profile and project_brief with project "${project}" (this session is in the folder ${project}). If project_brief finds no such project, use the closest name it suggests when that is clearly the same project; otherwise carry on without a briefing. Save this session's memories under project "${project}" (or the name the briefing used).`;
  return `${again}${brief} If the memory tools are missing or fail, tell the owner right away.`;
}

/**
 * The folder of the repository's main checkout: in a linked worktree, show-toplevel is the worktree's own folder, so
 * the main one is found from the shared .git folder. Null outside a repository.
 */
export function repoRoot(cwd: string): string | null {
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let top: string;
  try {
    top = git('rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
  if (top === '') return null;
  try {
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    // A submodule's or a bare repository's shared folder is not "<checkout>/.git": keep the checkout itself.
    return basename(common) === '.git' ? dirname(common) : top;
  } catch {
    return top;
  }
}

function main(): void {
  let input: { cwd?: string; source?: string } = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')) as typeof input; } catch { /* run with defaults */ }
  const cwd = input.cwd ?? process.cwd();
  const project = projectNameFor(cwd, repoRoot(cwd), homedir());
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: startContext(input.source ?? 'startup', project) } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
