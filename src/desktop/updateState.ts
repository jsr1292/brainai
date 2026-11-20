import { t } from '../i18n/core.js';
/** The update the desktop app has found, as it tells the server (src-tauri writes update.json; the server only reads it). */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** <dataDir>/update.json, written only by the desktop app (atomic: temp file + rename). Absent = no update known. */
export interface UpdateFile {
  current: string;            // the running app's version, e.g. "1.3.0"
  version: string;            // the newer version, e.g. "1.3.1"
  notes: string;              // the release's notes, plain text with "- " lines; untrusted
  state: 'available' | 'downloading' | 'ready' | 'backing-up' | 'installing' | 'failed' | 'blocked';
  percent?: number;           // 0–100 while downloading
  problem?: string;           // a plain sentence, for failed and blocked
}

const STATES: readonly string[] = ['available', 'downloading', 'ready', 'backing-up', 'installing', 'failed', 'blocked'];
const MAX_NOTES = 1500;
const LATER_FILE = 'update-later';

/** x.y.z compared as numbers; anything else counts as 0. Negative: a is older. */
export function compareVersions(a: string, b: string): number {
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

/**
 * What the desktop sidebar says about an update: only while one downloads (with its percent, when known) or waits for a
 * restart. Available, failed and blocked belong to Home and Settings.
 */
export type SideUpdate = { state: 'downloading'; percent?: number } | { state: 'ready' };
export function sideUpdate(u: UpdateFile | null): SideUpdate | null {
  if (u === null) return null;
  if (u.state === 'downloading') return u.percent === undefined ? { state: 'downloading' } : { state: 'downloading', percent: u.percent };
  return u.state === 'ready' ? { state: 'ready' } : null;
}

/**
 * <dataDir>/just-updated.json, written by the app at the first start after an update (update.json is cleared then): the
 * version it updated to and the release notes (untrusted plain text). Home shows the line until it is dismissed (which
 * deletes the file) or the next version arrives. null: absent, invalid, or not the running version: a file of any other
 * version is stale (a later update, or a downgrade) and is deleted here.
 */
export interface JustUpdated { version: string; notes: string }
export function readJustUpdated(dataDir: string, serverVersion: string): JustUpdated | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dataDir, 'just-updated.json'), 'utf8')); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string' || typeof r.notes !== 'string' || r.version === '') return null;
  if (r.version !== serverVersion) { clearJustUpdated(dataDir); return null; }
  return { version: r.version, notes: r.notes.slice(0, MAX_NOTES) };
}

export function clearJustUpdated(dataDir: string): void {
  try { rmSync(join(dataDir, 'just-updated.json'), { force: true }); } catch { /* nothing to remove */ }
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
  const title = t('update.title', { version: u.version, current: u.current });
  switch (u.state) {
    case 'backing-up': return { title, text: t('update.backingUp'), busy: true, failed: false };
    case 'downloading': return { title, text: t('update.downloading', { version: u.version, percent: u.percent === undefined ? '' : ` ${u.percent}%` }), busy: true, failed: false };
    case 'ready': return { title, text: t('update.ready'), busy: false, failed: false };
    case 'installing': return { title, text: t('update.installing'), busy: true, failed: false };
    case 'failed': return { title, text: t('update.failed', { problem: u.problem ?? t('update.failedDefault'), current: u.current }), busy: false, failed: true };
    case 'blocked': return { title, text: u.problem ?? t('update.blockedDefault'), busy: false, failed: false };
    default: return { title, text: '', busy: false, failed: false };
  }
}

// ---- update-check.json: how the app's checks for a newer release have gone ----

/**
 * <dataDir>/update-check.json, written only by the desktop app (atomic, unix seconds). `failingSince` is set by the
 * first failed check after a good one and cleared by the next good check; `lastFailAt` is the latest failed check;
 * `lastError` is the short reason.
 */
export interface UpdateCheck { lastOkAt?: number; failingSince?: number; lastFailAt?: number; lastError?: string }

const MAX_ERROR = 300;
/** Checks failing for longer than this are worth a line in Settings. */
const CHECK_FAILING_DAYS = 2;

const seconds = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** null: absent or not a JSON object. Fields that are not what they should be are left out. */
export function readUpdateCheck(dataDir: string): UpdateCheck | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dataDir, 'update-check.json'), 'utf8')); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const c: UpdateCheck = {};
  const ok = seconds(r.lastOkAt);
  const since = seconds(r.failingSince);
  if (ok !== undefined) c.lastOkAt = ok;
  if (since !== undefined) c.failingSince = since;
  const lastFail = seconds(r.lastFailAt);
  if (lastFail !== undefined) c.lastFailAt = lastFail;
  if (typeof r.lastError === 'string') c.lastError = r.lastError.slice(0, MAX_ERROR);
  return c;
}

/**
 * What Settings says when checks have been failing for more than two days: the day it started ("16 Nov") and the short
 * reason. The days are counted between the first and the latest failed check, not up to now: one failure and a laptop
 * that stayed off for three days says nothing until a retry has failed too. A file without lastFailAt says nothing.
 */
export function updateCheckProblem(c: UpdateCheck | null, now: Date): { since: string; error?: string } | null {
  if (!c || c.failingSince === undefined || c.lastFailAt === undefined) return null;
  if (c.lastFailAt - c.failingSince < CHECK_FAILING_DAYS * 86_400) return null;
  if (c.lastFailAt * 1000 > now.getTime() + 86_400_000) return null; // a failure from the future: the clock is off
  const since = new Date(c.failingSince * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return { since, ...(c.lastError ? { error: c.lastError } : {}) };
}

// ---- The off-site nudge on Home ----

const NUDGE_FILE = 'offsite-later';
const NUDGE_MIN_AGE_DAYS = 3;
const NUDGE_LATER_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whether Home nudges toward a copy off this disk: the app only, no off-site folder, no git copy, and a brain a few days old. */
export function offsiteNudgeDue(i: { localMode: boolean; offsiteSet: boolean; gitSet: boolean; firstMemoryAt: string | null; now: Date }): boolean {
  if (!i.localMode || i.offsiteSet || i.gitSet || i.firstMemoryAt === null) return false;
  const first = Date.parse(i.firstMemoryAt);
  return Number.isFinite(first) && i.now.getTime() - first >= NUDGE_MIN_AGE_DAYS * DAY_MS;
}

/** "Later" was chosen less than 30 days ago. */
export function offsiteNudgeHidden(dataDir: string, now: Date): boolean {
  try {
    const until = Date.parse(readFileSync(join(dataDir, NUDGE_FILE), 'utf8').trim());
    return Number.isFinite(until) && now.getTime() < until;
  } catch { return false; }
}

export function setOffsiteLater(dataDir: string, now: Date): void {
  writeFileSync(join(dataDir, NUDGE_FILE), new Date(now.getTime() + NUDGE_LATER_DAYS * DAY_MS).toISOString());
}
