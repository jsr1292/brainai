/**
 * Looking for a saved copy in a folder the owner picked (desktop recovery): the newest saved archive or dated backup
 * file directly inside it (never deeper), checked, with how many of a backup's pictures sit beside it. Nothing here
 * changes the folder or the brain.
 */
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { kindOfFile } from './backupFile.js';
import { besidePicture, checked, restorablePictures } from './restore.js';

const BACKUP = /^memory-(\d{4}-\d{2}-\d{2})\.db$/;
/** BrainAI's own archive names, with the " (1)" a browser adds to a second download. */
const ARCHIVE = /^brainai-(?:saved|move)-(\d{4}-\d{2}-\d{2})(?: \(\d+\))?\.tar\.gz$/;
/** How many of the newest candidates are tried before giving up. */
const TRIES = 5;
/** The folders BrainAI itself makes ("BrainAI saved 2026-11-23", "... (2)"): looked into one level down when the chosen folder holds no copy. */
const SAVED_FOLDER = /^BrainAI saved \d{4}-\d{2}-\d{2}(?: \(\d+\))?$/;
/** How many such folders are looked into (the newest by name). */
const FOLDERS = 10;

export type Found = {
  path: string; name: string; kind: 'archive' | 'database';
  /** The day in the file's name (YYYY-MM-DD). */
  date: string;
  facts: number; pages: number;
  /** Pictures of a backup the copy could bring (live, or left out by an earlier restore) and how many files sit beside it; null for an archive (it carries its own) or a copy with no pictures. */
  pictures: { total: number; found: number } | null;
  /** The newest candidate, when it could not be used and an older one was taken instead (with the checker's reason). */
  skipped: { name: string; why: string } | null;
  /** Proves the confirm is for this choice and this file as it was: a random token, and the file's size and mtime. */
  token: string; size: number; mtimeMs: number;
};

/** why: none (no candidate), invalid (the newest ones are not usable copies), unreadable (the folder or its files could not be read). */
export class NothingFound extends Error {
  constructor(readonly why: 'none' | 'invalid' | 'unreadable', message: string) { super(message); }
}

type Candidate = { path: string; name: string; kind: 'archive' | 'database'; date: string; mtime: number; /** The folder the file sits in (the pictures of a backup are looked for beside it). */ dir: string };

function stat(p: string) { try { const s = lstatSync(p); return s.isFile() ? s : null; } catch { return null; } }

/** Candidates directly inside `folder`, newest first: by the date in the name, same-day ties by mtime. Throws NothingFound('unreadable') when the folder cannot be read. */
export function candidates(folder: string): Candidate[] {
  let names: string[];
  try { names = readdirSync(folder); } catch (e) { throw new NothingFound('unreadable', e instanceof Error ? e.message : String(e)); }
  const out: Candidate[] = [];
  for (const name of names) {
    const path = join(folder, name);
    const kind = BACKUP.test(name) ? 'database' as const : ARCHIVE.test(name) ? 'archive' as const : null;
    if (!kind) continue;
    const st = stat(path);
    if (!st || kindOfFile(path) !== kind) continue;
    out.push({ path, name, kind, date: (BACKUP.exec(name) ?? ARCHIVE.exec(name))![1]!, mtime: st.mtimeMs, dir: folder });
  }
  return out.sort(newestFirst);
}

function newestFirst(a: Candidate, b: Candidate): number { return b.date.localeCompare(a.date) || b.mtime - a.mtime || b.name.localeCompare(a.name); }

/** Candidates inside the saved folders (named like BrainAI's own) directly inside `folder`; a folder that cannot be read is skipped, a link is never followed. */
function candidatesBelow(folder: string): Candidate[] {
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  const out: Candidate[] = [];
  for (const name of names.filter((n) => SAVED_FOLDER.test(n)).sort().reverse().slice(0, FOLDERS)) {
    const sub = join(folder, name);
    try { if (!lstatSync(sub).isDirectory()) continue; out.push(...candidates(sub)); } catch { /* skipped */ }
  }
  return out.sort(newestFirst);
}

/** Counts a backup's pictures and those with a file beside it, on a copy of the database (the source is never opened). */
function pictureCounts(file: string, folder: string): { total: number; found: number } | null {
  let tmp: string | undefined;
  let db: Database.Database | undefined;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'brainai-find-'));
    const copy = join(tmp, 'm.db');
    copyFileSync(file, copy);
    db = new Database(copy, { readonly: true });
    const rows = restorablePictures(db);
    if (rows.length === 0) return null;
    return { total: rows.length, found: rows.filter((r) => besidePicture(folder, r) !== null).length };
  } catch (e) {
    throw new NothingFound('unreadable', e instanceof Error ? e.message : String(e));
  } finally {
    db?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Finds, checks and counts the newest usable copy in `folder`. Throws NothingFound, never anything else. */
export async function findCopy(folder: string): Promise<Found> {
  let list = candidates(folder);
  // The owner may have picked the folder that holds the saved folders (Documents, say): one level down, only BrainAI's own names.
  if (list.length === 0) list = candidatesBelow(folder);
  if (list.length === 0) throw new NothingFound('none', 'No saved copy found');
  // The newest candidate's reason is the one worth saying; a copy from a newer BrainAI is never skipped for an older one.
  let first: { name: string; why: string } | null = null;
  for (const c of list.slice(0, TRIES)) {
    let result;
    try { result = await checked(c.path); } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const newest = first === null;
      first ??= { name: c.name, why };
      if (newest && /newer BrainAI/.test(why)) break;
      continue;
    }
    const st = stat(c.path);
    if (!st) { first ??= { name: c.name, why: 'the file went away' }; continue; }
    return {
      path: c.path, name: basename(c.path), kind: c.kind, date: c.date,
      facts: result.counts.facts, pages: result.counts.pages,
      pictures: c.kind === 'database' ? pictureCounts(c.path, c.dir) : null,
      skipped: first, token: randomBytes(16).toString('hex'), size: st.size, mtimeMs: st.mtimeMs,
    };
  }
  throw new NothingFound('invalid', first?.why ?? 'no usable copy');
}
