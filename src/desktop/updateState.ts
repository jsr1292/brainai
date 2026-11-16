/** The update the desktop app has found, as it tells the server (src-tauri writes update.json; the server only reads it). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** <dataDir>/update.json, written only by the desktop app (atomic: temp file + rename). Absent = no update known. */
export interface UpdateFile {
  current: string;            // the running app's version, e.g. "1.3.0"
  version: string;            // the newer version, e.g. "1.3.1"
  notes: string;              // the release's notes, plain text with "- " lines; untrusted
  state: 'available' | 'backing-up' | 'downloading' | 'installing' | 'failed' | 'blocked';
  percent?: number;           // 0–100 while downloading
  problem?: string;           // a plain sentence, for failed and blocked
}

const STATES: readonly string[] = ['available', 'backing-up', 'downloading', 'installing', 'failed', 'blocked'];
const MAX_NOTES = 1500;
const LATER_FILE = 'update-later';

/** x.y.z compared as numbers; anything else counts as 0. Negative: a is older. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** null: absent, invalid, or a version not newer than the running server's. */
export function readUpdate(dataDir: string, serverVersion: string): UpdateFile | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dataDir, 'update.json'), 'utf8')); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.current !== 'string' || typeof r.version !== 'string' || typeof r.notes !== 'string' || typeof r.state !== 'string') return null;
  if (!STATES.includes(r.state)) return null;
  if (compareVersions(r.version, serverVersion) <= 0) return null;
  const u: UpdateFile = { current: r.current, version: r.version, notes: r.notes.slice(0, MAX_NOTES), state: r.state as UpdateFile['state'] };
  if (typeof r.percent === 'number' && Number.isFinite(r.percent)) u.percent = Math.max(0, Math.min(100, Math.round(r.percent)));
  if (typeof r.problem === 'string') u.problem = r.problem;
  return u;
}

/** The version the owner chose "Later" for. */
export function laterVersion(dataDir: string): string | null {
  try { return readFileSync(join(dataDir, LATER_FILE), 'utf8').trim() || null; } catch { return null; }
}

export function setLater(dataDir: string, version: string): void {
  writeFileSync(join(dataDir, LATER_FILE), version);
}

/** What the card says. The title is the headline of an available update; text is the progress or problem line. */
export function updateLine(u: UpdateFile): { title: string; text: string; busy: boolean; failed: boolean } {
  const title = `BrainAI ${u.version} is ready (you have ${u.current})`;
  switch (u.state) {
    case 'backing-up': return { title, text: 'Making a backup of your brain first…', busy: true, failed: false };
    case 'downloading': return { title, text: `Downloading BrainAI ${u.version}…${u.percent === undefined ? '' : ` ${u.percent}%`}`, busy: true, failed: false };
    case 'installing': return { title, text: 'Installing… BrainAI reopens by itself in a moment.', busy: true, failed: false };
    case 'failed': return { title, text: `The update did not finish: ${u.problem ?? 'something went wrong.'} BrainAI ${u.current} is still running.`, busy: false, failed: true };
    case 'blocked': return { title, text: u.problem ?? 'The update cannot start right now.', busy: false, failed: false };
    default: return { title, text: '', busy: false, failed: false };
  }
}
