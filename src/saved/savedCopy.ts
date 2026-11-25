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
import { archiveError, checkArchive, liveCounts, moveAcrossDisks, packArchive } from './archive.js';
import { busy } from '../busyMarker.js';
import { t } from '../i18n/core.js';
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
  const summary = t('data.factsAndPages', { facts: t('data.facts', { count: i.facts }), pages: t('data.pages', { count: i.pages }) });
  const lines = [
    t('data.readme.title', { day: i.day }),
    '',
    t('data.readme.summary', { day: i.day, summary }),
    '',
    t('data.readme.private'),
    '',
    `* ${t('data.readme.archive', { file: `brainai-saved-${i.day}.tar.gz` })}`,
    `* ${t('data.readme.markdown')}`,
    '',
    t('data.readme.restore'),
    `* ${t('data.readme.app', { choice: t('setup.name.haveFolder') })}`,
    `* ${t('data.readme.server')}`,
  ];
  if (i.originals.length > 0) lines.push('', t('data.readme.originals'), ...i.originals.map((o) => `* Original tool settings/${o}`));
  if (i.handled?.length) lines.push('', t('data.readme.handled'), ...i.handled.map((h) => `* ${h}`));
  if (i.checklist.length > 0) lines.push('', t('data.readme.checklist'), ...i.checklist.map((c) => `* ${c}`));
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
export function makeSavedCopy(
  d: SaveDeps, parentDir: string, now: Date, checklist: string[], opts?: { afterPack?: () => void },
): Promise<{ folder: string; archive: string; day: string; facts: number; pages: number }> {
  return busy('saving a copy', () => makeSavedCopyWork(d, parentDir, now, checklist, opts));
}

async function makeSavedCopyWork(
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
      if (!check.ok) throw archiveError(check);
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
    const rel = relative(home, file);
    // A file outside the home folder (a redirected APPDATA, another drive) gets a flat name that cannot climb out of the folder.
    const outside = rel === '' || rel.startsWith('..') || isAbsolute(rel);
    const below = outside ? `outside-home-${file.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '')}` : rel.split(sep).join('/');
    const dest = join(folder, 'Original tool settings', ...below.split('/'));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    moveAcrossDisks(file, dest);
    moved.push(below);
  }
  return moved;
}
