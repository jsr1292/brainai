import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { Supersession } from '../memory/supersessions.js';
import type { Memory } from '../memory/types.js';
import type { PageService } from './service.js';
import type { SkillService } from '../skills/service.js';

const MAX_FILE = 80;
const README = `# Brain export

Every page and fact in the brain, as plain Markdown, written each night by scripts/export-brain.sh and committed
only when something changed. The git history shows what changed and when.

* \`pages/<area>/<project>/<title>.md\`: one page per file, with its title, id, version and last change at the top.
  Pages without a project are in \`_area\`.
* \`facts/<project>.md\`: each project's roadmap, then its statuses (newest first), then its decisions (oldest first),
  then the replaced facts, each with what replaced it.
  \`_profile.md\` holds the owner's profile and \`_no-project.md\` the facts without a project.

This is a copy for reading and searching; the brain itself is the source. Changes made here are not read back.

Pictures are not in this repository. They are in the nightly backups under \`images/\`. Copy that folder here to see them.

Skills are under \`skills/\`, one folder each, readable by Claude Code as they are.
`;

/**
 * A page body with its picture addresses pointing at the backups' \`images/<2 hex>/\` folder, from a file \`depth\`
 * folders deep. Code (fenced blocks) stays as written. Picture files never enter git, so Delete for good holds.
 */
export function exportBody(body: string, depth: number): string {
  const rel = '../'.repeat(depth);
  const to = (id: string, ext: string) => `${rel}images/${id.slice(0, 2)}/${id}.${ext}`;
  let fence: { ch: string; len: number } | null = null;
  return body.split('\n').map((line) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) { fence = { ch: f[1]![0]!, len: f[1]!.length }; return line; }
      if (f[1]![0] === fence.ch && f[1]!.length >= fence.len && line.trim() === f[1]) { fence = null; return line; }
    }
    if (fence !== null) return line;
    return line
      .replace(/\]\(\/images\/([0-9a-f]{24})\.(jpg|png|webp|gif)(?=[\s)])/g, (_m, id: string, ext: string) => `](${to(id, ext)}`)
      .replace(/^( {0,3}\[[^\]]+\]:\s*)\/images\/([0-9a-f]{24})\.(jpg|png|webp|gif)(?=\s|$)/, (_m, head: string, id: string, ext: string) => `${head}${to(id, ext)}`);
  }).join('\n');
}

/** A page title as a file name: accents removed, lowercase, other runs as "-", at most 80 characters, unique. */
export function fileName(title: string, taken: Set<string>): string {
  const base = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_FILE).replace(/-+$/, '') || 'page';
  let name = `${base}.md`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.md`;
  taken.add(name);
  return name;
}

const day = (iso: string) => iso.slice(0, 10);
const factBlock = (m: Memory) => `### ${m.kind} · ${day(m.updatedAt)} · ${m.id}\n\n${m.content.replace(/\s+$/, '')}\n`;

/** A replaced fact, with the day it was replaced and the fact that replaced it. */
const replacedBlock = (r: { m: Memory; row: Supersession }) =>
  `### ${r.m.kind} · ${day(r.m.updatedAt)} · ${r.m.id} · replaced ${day(r.row.createdAt)} by ${r.row.newId}\n\n${r.m.content.replace(/\s+$/, '')}\n`;

/** `replaced` ends the file under "## Replaced", oldest replacement first, so the nightly diff only grows at the end. */
function factFile(title: string, ms: Memory[], replaced: { m: Memory; row: Supersession }[] = []): string {
  const byOldest = (a: Memory, b: Memory) => a.createdAt.localeCompare(b.createdAt);
  const byNewest = (a: Memory, b: Memory) => b.updatedAt.localeCompare(a.updatedAt);
  const ordered = [
    ...ms.filter((m) => m.kind === 'roadmap'),
    ...ms.filter((m) => m.kind === 'summary').sort(byNewest),
    ...ms.filter((m) => m.kind === 'decision').sort(byOldest),
    ...ms.filter((m) => m.kind === 'profile').sort(byOldest),
  ];
  const head = `# ${title}\n\n${ordered.map(factBlock).join('\n')}`;
  if (replaced.length === 0) return head;
  const olds = [...replaced].sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt) || a.row.id - b.row.id).map(replacedBlock).join('\n');
  return `${head}${ordered.length > 0 ? '\n' : ''}## Replaced\n\n${olds}`;
}

/** Every live page and fact as Markdown files, keyed by their path in the export. No dates outside the content. */
export function exportTree(d: { pages: PageService; memoryStore: MemoryStore; memories: MemoryService; skills?: SkillService }, _now: Date): Map<string, string> {
  const tree = new Map<string, string>([['README.md', README], ['.gitignore', '/images/\n']]);
  const taken = new Map<string, Set<string>>();
  const pages = [...d.pages.list()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const p of pages) {
    const area = d.pages.areaOf(p) ?? 'unsorted';
    // Under the real project, as its facts are: a page filed under a name since merged away follows the merge.
    const project = p.project === null ? null : d.memories.projectNamed(p.project);
    const folder = `pages/${area}/${project ?? '_area'}`;
    if (!taken.has(folder)) taken.set(folder, new Set());
    const front = [
      '---', `title: ${JSON.stringify(p.title)}`, `id: ${p.id}`, `project: ${project ?? ''}`, `area: ${area}`,
      `version: ${p.version}`, `updated: ${p.updatedAt}`, `updated_by: ${JSON.stringify(p.updatedBy)}`, '---', '',
    ].join('\n');
    const path = `${folder}/${fileName(p.title, taken.get(folder)!)}`;
    tree.set(path, `${front}\n${exportBody(p.body.replace(/\s+$/, ''), path.split('/').length - 1)}\n`);
  }
  // Skills (§17c), On or Off, as Claude Code reads them: skills/<name>/SKILL.md and their files.
  for (const s of d.skills?.list() ?? []) {
    tree.set(`skills/${s.name}/SKILL.md`, d.skills!.skillMd(s));
    for (const f of s.files) tree.set(`skills/${s.name}/${f.path}`, f.text.endsWith('\n') ? f.text : `${f.text}\n`);
  }
  // Replaced facts are exported too (section 16), at the end of their project's file.
  const all = d.memoryStore.list({ replaced: 'include' });
  const profile = all.filter((m) => m.kind === 'profile');
  if (profile.length > 0) tree.set('facts/_profile.md', factFile('Profile', profile));
  const byProject = new Map<string, { current: Memory[]; replaced: { m: Memory; row: Supersession }[] }>();
  for (const m of all.filter((x) => x.kind !== 'profile')) {
    const key = m.project ?? '';
    const group = byProject.get(key) ?? byProject.set(key, { current: [], replaced: [] }).get(key)!;
    const row = d.memoryStore.supersessions.liveFor(m.id);
    if (row) group.replaced.push({ m, row }); else group.current.push(m);
  }
  for (const [project, g] of byProject) {
    tree.set(project === '' ? 'facts/_no-project.md' : `facts/${project}.md`, factFile(project === '' ? 'Facts without a project' : project, g.current, g.replaced));
  }
  return tree;
}

/** Files under a folder, never following a symlink (a link could point outside the export). */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

/** Real folders under a folder, deepest first; symlinks are left alone. */
function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => [...folders(join(dir, e.name)), join(dir, e.name)]);
}

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/**
 * Writes the tree into `dir`: only files whose content changed, and removes .md files under pages/ and facts/ that are
 * gone. Never through a link (audit F05): a top folder that is a link is left alone, a file whose path has a link on
 * the way is not written, and a file that is itself a link is replaced by a real file. `skipped` names what was left.
 */
export function writeTree(dir: string, tree: Map<string, string>): { written: number; removed: number; skipped: string[] } {
  let written = 0;
  let removed = 0;
  const skipped: string[] = [];
  const linkedTops = new Set(['pages', 'facts', 'skills'].filter((top) => isLink(join(dir, top))));
  /** Whether a folder between `dir` and this file is a link. */
  const linkOnTheWay = (path: string): boolean => {
    let at = dir;
    for (const part of path.split('/').slice(0, -1)) { at = join(at, part); if (isLink(at)) return true; }
    return false;
  };
  skipped.push(...linkedTops);
  // Remove first, then write: a skill's folder can become a file of the same name (ref/b.md, then ref).
  for (const top of ['pages', 'facts', 'skills'].filter((t) => !linkedTops.has(t))) {
    for (const file of walk(join(dir, top))) {
      // A skill's folder holds any text file (scripts/run.sh, palette.json): under skills/ every file not exported goes.
      if ((top === 'skills' || file.endsWith('.md')) && !tree.has(relative(dir, file).split('\\').join('/'))) {
        unlinkSync(file);
        removed++;
      }
    }
    // Folders left empty by a removed page go too.
    for (const f of folders(join(dir, top))) if (readdirSync(f).length === 0) rmdirSync(f);
  }
  for (const [path, content] of tree) {
    if (linkedTops.has(path.split('/')[0]!)) continue;
    if (linkOnTheWay(path)) { skipped.push(path); continue; }
    const full = join(dir, path);
    if (isLink(full)) unlinkSync(full);
    else if (existsSync(full) && readFileSync(full, 'utf8') === content) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    written++;
  }
  return { written, removed, skipped };
}
