import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the last backup runs reported, kept beside the database so the dashboard can show it: the nightly snapshot
 * (scripts/backup.sh on the home server, or the in-app backup in work mode) writes backup-status.json, the weekly
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

export function readBackupStatus(dir: string): BackupStatus {
  const nightly = readRun(join(dir, FILES.nightly));
  const offsite = readRun(join(dir, FILES.offsite));
  const git = readRun(join(dir, FILES.git)) as SimpleRun | undefined;
  const exported = readRun(join(dir, FILES.export)) as SimpleRun | undefined;
  return { ...(nightly ? { nightly } : {}), ...(offsite ? { offsite } : {}), ...(git ? { git } : {}), ...(exported ? { export: exported } : {}) };
}

/** Each problem as a sentence for the owner; none means the backups are fine. */
/** `jobs`: also check the git copy and the Markdown export (the nightly scripts on the server). */
export function backupHealth(s: BackupStatus, now: Date, opts: { offsite?: boolean; jobs?: boolean } = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const age = (at: string) => now.getTime() - Date.parse(at);
  if (!s.nightly) problems.push('No nightly backup has run yet.');
  else if (!s.nightly.ok) problems.push(`The nightly backup failed: ${s.nightly.error ?? 'see the backup log'}.`);
  else {
    if (age(s.nightly.at) > NIGHTLY_MAX_HOURS * HOUR_MS) problems.push('The last nightly backup is more than a day old.');
    for (const c of s.nightly.copies ?? []) {
      if (c.result !== 'copied') problems.push(`The nightly copy to ${c.where} was ${c.result}${c.detail ? `: ${c.detail}` : ''}.`);
    }
    // A restore would lack these pictures (audit F11): stray files are only reported, missing ones need a look.
    const missing = s.nightly.pictures?.missing ?? 0;
    if (missing > 0) problems.push(`${missing === 1 ? '1 picture the database lists is' : `${missing} pictures the database lists are`} missing from the brain's folder.`);
  }
  const jobs = () => {
    if (!opts.jobs) return;
    for (const [run, name] of [[s.git, 'git copy'], [s.export, 'Markdown export']] as const) {
      // Optional: a job that has never run is not set up, which is the owner's choice (Settings lists it as "not yet").
      if (!run) continue;
      if (!run.ok) problems.push(`The ${name} failed${run.detail ? `: ${run.detail}` : ''}.`);
      else if (age(run.at) > JOB_MAX_HOURS * HOUR_MS) problems.push(`The last ${name} is more than a day old.`);
    }
  };
  if (opts.offsite === false) { jobs(); return { ok: problems.length === 0, problems }; }
  if (!s.offsite) { jobs(); return { ok: problems.length === 0, problems }; }
  if (!s.offsite.ok) problems.push(`The off-site copy failed: ${s.offsite.error ?? 'see the backup log'}.`);
  else if (age(s.offsite.at) > OFFSITE_MAX_DAYS * 24 * HOUR_MS) problems.push(`The last off-site copy is more than ${OFFSITE_MAX_DAYS} days old.`);
  jobs();
  return { ok: problems.length === 0, problems };
}
