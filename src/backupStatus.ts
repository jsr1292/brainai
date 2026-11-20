import { COPY_MAX_DAYS, type CopyState } from './desktop/backupCopy.js';
import { en } from './i18n/en/index.js';
import type { Say } from './i18n/errors.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the last backup runs reported, kept beside the database so the dashboard can show it: the nightly snapshot
 * (scripts/backup.sh on the home server, or the in-app backup with BACKUP_DIR) writes backup-status.json, the weekly
 * off-site copy (scripts/offsite.sh) offsite-status.json. A failure that nobody sees can leave a copy missing for days,
 * so the dashboard warns about each problem.
 */
export interface BackupCopy { where: string; result: 'copied' | 'skipped' | 'failed'; detail?: string }
export interface BackupRun {
  at: string; ok: boolean; copies?: BackupCopy[]; where?: string; error?: string;
  counts?: { facts: number; pages: number; images?: number };
  /** The nightly check of picture files against their rows (round 2 section 12). */
  pictures?: { missing: number; stray: number };
}
/** A nightly job's last run: the git copy (scripts/backup-git.sh) and the Markdown export (scripts/export-brain.sh). */
export interface SimpleRun { at: string; ok: boolean; detail?: string }
export interface BackupStatus { nightly?: BackupRun; offsite?: BackupRun; git?: SimpleRun; export?: SimpleRun }

const FILES = { nightly: 'backup-status.json', offsite: 'offsite-status.json', git: 'git-backup-status.json', export: 'export-status.json' } as const;
/** The git copy and the export run nightly, like the backup. */
const JOB_MAX_HOURS = 26;
const HOUR_MS = 3_600_000;
/** A nightly backup older than this missed a night (it runs at 03:30, so a little over a day). */
const NIGHTLY_MAX_HOURS = 26;
/** The off-site copy runs weekly. */
const OFFSITE_MAX_DAYS = 8;

/** Writes one run's status (to a temporary file, then renamed, so a reader never sees half a file). */
export function writeBackupStatus(dir: string, which: 'nightly' | 'offsite', run: BackupRun): void {
  const path = join(dir, FILES[which]);
  writeFileSync(`${path}.tmp`, JSON.stringify(run));
  renameSync(`${path}.tmp`, path);
}

function readRun(path: string): BackupRun | undefined {
  try {
    const run = JSON.parse(readFileSync(path, 'utf8')) as BackupRun;
    return typeof run?.at === 'string' && typeof run.ok === 'boolean' ? run : undefined;
  } catch {
    return undefined;
  }
}

/** A placeholder the screen replaces with its own words ("see the backup log"). */
const LOG = '';

export function readBackupStatus(dir: string): BackupStatus {
  const nightly = readRun(join(dir, FILES.nightly));
  const offsite = readRun(join(dir, FILES.offsite));
  const git = readRun(join(dir, FILES.git)) as SimpleRun | undefined;
  const exported = readRun(join(dir, FILES.export)) as SimpleRun | undefined;
  return { ...(nightly ? { nightly } : {}), ...(offsite ? { offsite } : {}), ...(git ? { git } : {}), ...(exported ? { export: exported } : {}) };
}

/** Each problem as a sentence for the owner; none means the backups are fine. */
/** `jobs`: also check the git copy and the Markdown export (the nightly scripts on the server). */
export function backupHealth(s: BackupStatus, now: Date, opts: { offsite?: boolean; jobs?: boolean; /** The desktop's second folder: a failed or stale copy is a problem. */ copy?: CopyState } = {}): { ok: boolean; problems: string[]; say: Say[] } {
  const h = backupHealthMain(s, now, opts);
  const c = opts.copy;
  if (c?.kind === 'failed') { h.problems.push(`The copy to the second folder failed: ${en[`backup.why.${c.why}`]}`); h.say.push({ key: 'backup.p.copyFailed', params: { reason: c.why } }); }
  else if (c?.kind === 'old') { h.problems.push(`The last copy to the second folder is more than ${COPY_MAX_DAYS} days old.`); h.say.push({ key: 'backup.p.copyOld', params: { days: COPY_MAX_DAYS } }); }
  return { ...h, ok: h.problems.length === 0 };
}

function backupHealthMain(s: BackupStatus, now: Date, opts: { offsite?: boolean; jobs?: boolean }): { ok: boolean; problems: string[]; say: Say[] } {
  const problems: string[] = [];
  /** The same problems as catalog keys, one for one, for a screen to word in the owner's language. */
  const say: Say[] = [];
  const add = (text: string, s: Say): void => { problems.push(text); say.push(s); };
  const age = (at: string) => now.getTime() - Date.parse(at);
  if (!s.nightly) add('No nightly backup has run yet.', { key: 'backup.p.none' });
  else if (!s.nightly.ok) add(`The nightly backup failed: ${s.nightly.error ?? 'see the backup log'}.`, { key: 'backup.p.failed', params: { error: s.nightly.error ?? LOG } });
  else {
    if (age(s.nightly.at) > NIGHTLY_MAX_HOURS * HOUR_MS) add('The last nightly backup is more than a day old.', { key: 'backup.p.old' });
    for (const c of s.nightly.copies ?? []) {
      if (c.result !== 'copied') add(`The nightly copy to ${c.where} was ${c.result}${c.detail ? `: ${c.detail}` : ''}.`, { key: 'backup.p.copy', params: { where: c.where, result: c.result, detail: c.detail ? `: ${c.detail}` : '' } });
    }
    // A restore would lack these pictures (audit F11): stray files are only reported, missing ones need a look.
    const missing = s.nightly.pictures?.missing ?? 0;
    if (missing > 0) add(`${missing === 1 ? '1 picture the database lists is' : `${missing} pictures the database lists are`} missing from the brain's folder.`, { key: 'backup.p.pictures', params: { count: missing } });
  }
  const jobs = () => {
    if (!opts.jobs) return;
    for (const [run, name] of [[s.git, 'git copy'], [s.export, 'Markdown export']] as const) {
      // Optional: a job that has never run is not set up, which is the owner's choice (Settings lists it as "not yet").
      if (!run) continue;
      if (!run.ok) add(`The ${name} failed${run.detail ? `: ${run.detail}` : ''}.`, { key: 'backup.p.jobFailed', params: { name: name === 'git copy' ? 'git copy' : 'Markdown export', detail: run.detail ? `: ${run.detail}` : '' } });
      else if (age(run.at) > JOB_MAX_HOURS * HOUR_MS) add(`The last ${name} is more than a day old.`, { key: 'backup.p.jobOld', params: { name } });
    }
  };
  if (opts.offsite === false) { jobs(); return { ok: problems.length === 0, problems, say }; }
  if (!s.offsite) { jobs(); return { ok: problems.length === 0, problems, say }; }
  if (!s.offsite.ok) add(`The off-site copy failed: ${s.offsite.error ?? 'see the backup log'}.`, { key: 'backup.p.offFailed', params: { error: s.offsite.error ?? LOG } });
  else if (age(s.offsite.at) > OFFSITE_MAX_DAYS * 24 * HOUR_MS) add(`The last off-site copy is more than ${OFFSITE_MAX_DAYS} days old.`, { key: 'backup.p.offOld', params: { days: OFFSITE_MAX_DAYS } });
  jobs();
  return { ok: problems.length === 0, problems, say };
}
