/**
 * The saved folder: `BrainAI saved <day>/` with the archive (the one file that brings everything back), the same
 * memories as plain Markdown, and a README. The archive is checked and its counts compared with the live brain, so a
 * folder is only left behind when it is whole.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DB } from '../db.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { PageService } from '../pages/service.js';
import { exportTree, writeTree } from '../pages/exportTree.js';
import type { SkillService } from '../skills/service.js';
import { checkArchive, liveCounts, moveAcrossDisks, packArchive } from './archive.js';
import { plural } from '../web/dashboardViews.js';

export interface SaveDeps { db: DB; dataDir: string; pages: PageService; memoryStore: MemoryStore; memories: MemoryService; skills: SkillService }

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

function inside(child: string, parent: string): boolean {
  const rel = relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Creates `<parent>/BrainAI saved <day>`, or `... (2)`, `(3)` when it is there: the mkdir itself claims the name. */
function claimFolder(parentDir: string, day: string): string {
  mkdirSync(parentDir, { recursive: true });
  for (let n = 1; ; n++) {
    const folder = join(parentDir, n === 1 ? `BrainAI saved ${day}` : `BrainAI saved ${day} (${n})`);
    try {
      mkdirSync(folder, { mode: 0o700 });
      chmodSync(folder, 0o700);
      return folder;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** "1 fact and 2 pages": how every place that reports a saved copy counts it. */
export const factsAndPages = (facts: number, pages: number): string => `${plural(facts, 'fact', 'facts')} and ${plural(pages, 'page', 'pages')}`;

export function savedReadme(i: { day: string; facts: number; pages: number; checklist: string[]; originals: string[]; /** Files BrainAI dealt with itself instead of copying here (they can hold tokens). */ handled?: string[] }): string {
  const lines = [
    `BrainAI saved ${i.day}`,
    '',
    `This folder is a saved copy of your BrainAI memory from ${i.day}: ${factsAndPages(i.facts, i.pages)}.`,
    '',
    'It holds every memory in plain text: keep it private.',
    '',
    `* ${'brainai-saved-' + i.day}.tar.gz: everything, in the one file BrainAI can bring back.`,
    '* Markdown/: the same pages and facts as plain text files you can read with any editor.',
    '',
    'To bring it back:',
    '* The BrainAI app: Open BrainAI and choose I have a saved BrainAI folder.',
    '* A server: docs/RUNBOOK.md, Coming back from a saved copy.',
  ];
  if (i.originals.length > 0) lines.push('', 'Your original tool settings (as they were before BrainAI changed them):', ...i.originals.map((o) => `* Original tool settings/${o}`));
  if (i.handled?.length) lines.push('', 'Not copied into this folder (they can hold secrets):', ...i.handled.map((h) => `* ${h}`));
  if (i.checklist.length > 0) lines.push('', 'Things BrainAI could not remove:', ...i.checklist.map((c) => `* ${c}`));
  return lines.join('\n') + '\n';
}

/** Writes README.txt whole (never appended to), so the final checklist and originals replace any earlier version. */
export function writeReadme(folder: string, i: { day: string; facts: number; pages: number; checklist: string[]; originals: string[]; /** Files BrainAI dealt with itself instead of copying here (they can hold tokens). */ handled?: string[] }): void {
  writeFileSync(join(folder, 'README.txt'), savedReadme(i), { mode: 0o600 });
}

/**
 * Makes the saved folder. The archive's counts must equal the live counts read before and again after packing; if the
 * brain moved in between it is packed once more, and a second miss throws and removes the half-made folder.
 * `opts.afterPack` is a test seam, called after each pack.
 */
export async function makeSavedCopy(
  d: SaveDeps, parentDir: string, now: Date, checklist: string[], opts?: { afterPack?: () => void },
): Promise<{ folder: string; archive: string; day: string; facts: number; pages: number }> {
  if (inside(parentDir, d.dataDir)) throw new Error('Choose a folder outside the BrainAI data folder: the saved copy must not live inside what it saves.');
  // The local date, as the moving file and the nightly backup name theirs.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const folder = claimFolder(parentDir, day);
  try {
    const archive = join(folder, `brainai-saved-${day}.tar.gz`);
    let counts: { facts: number; pages: number } | null = null;
    for (let attempt = 0; attempt < 2 && counts === null; attempt++) {
      const before = liveCounts(d.db);
      await packArchive(d.db, d.dataDir, archive, now);
      opts?.afterPack?.();
      const after = liveCounts(d.db);
      const check = await checkArchive(archive);
      if (!check.ok) throw new Error(check.reason);
      const same = (a: { facts: number; pages: number }) => a.facts === check.facts && a.pages === check.pages;
      if (same(before) && same(after)) counts = { facts: check.facts, pages: check.pages };
    }
    if (counts === null) throw new Error('The brain changed while saving; try again.');
    writeTree(join(folder, 'Markdown'), exportTree({ pages: d.pages, memoryStore: d.memoryStore, memories: d.memories, skills: d.skills }, now));
    writeReadme(folder, { day, ...counts, checklist, originals: [] });
    return { folder, archive, day, ...counts };
  } catch (e) {
    rmSync(folder, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Moves each existing file into `<folder>/Original tool settings/`, keeping its path below `home` as the name. Returns
 * the ones moved (paths below home). It does not touch README: the caller writes that again with the final list.
 */
export function moveIntoSaved(folder: string, files: string[], home: string = homedir()): string[] {
  const moved: string[] = [];
  for (const file of files) {
    let stat;
    try { stat = lstatSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    const below = relative(home, file).split(sep).join('/');
    const dest = join(folder, 'Original tool settings', ...below.split('/'));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    moveAcrossDisks(file, dest);
    moved.push(below);
  }
  return moved;
}
