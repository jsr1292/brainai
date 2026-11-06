/** One top-level folder of ~/Projects on the Mac, as the reporter sends it: names and git metadata only. */
export interface FolderState {
  name: string;
  git: boolean;
  branch: string | null;
  /** Changed files; null when git did not answer on the Mac (unknown, which is not 0). */
  uncommitted: number | null;
  /** Commits not on any remote (all of them for a repo with no remote); null when unknown. */
  unpushed: number | null;
  lastCommit: string | null;
  remotes: string[];
  /** When the brain received the report this state came from: set when it is matched, never taken from the reporter. */
  reportedAt?: string;
}

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

export const MAX_FOLDERS = 300;
const MAX_NAME = 120;
const MAX_BRANCH = 200;
const MAX_COUNT = 100_000;
const MAX_REMOTES = 10;
const MAX_REMOTE = 300;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A remote URL without any user, password or token before the host (scp-style `git@host:path` is kept). */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** The name folders and projects are compared by: trimmed, lowercase, spaces and underscores as dashes. */
export function folderKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function count(f: Record<string, unknown>, field: string): number | null {
  const v = f[field];
  if (v === undefined) return 0;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) throw new ReportError(`${field} must be a whole number from 0 to ${MAX_COUNT}, or null when unknown`);
  return v;
}

/** Checks a report and returns its folders; anything malformed is refused whole. */
export function parseReport(body: unknown): FolderState[] {
  const folders = (body as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(folders)) throw new ReportError('The report needs a folders list');
  if (folders.length > MAX_FOLDERS) throw new ReportError(`A report has at most ${MAX_FOLDERS} folders`);
  return folders.map((raw): FolderState => {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (typeof f.name !== 'string' || f.name.trim() === '' || f.name.length > MAX_NAME || f.name.includes('/')) {
      throw new ReportError(`Each folder needs a name of 1 to ${MAX_NAME} characters without "/"`);
    }
    if (typeof f.git !== 'boolean') throw new ReportError('git must be true or false');
    if (f.branch !== undefined && f.branch !== null && (typeof f.branch !== 'string' || f.branch.length > MAX_BRANCH)) throw new ReportError('branch must be text');
    if (f.lastCommit !== undefined && f.lastCommit !== null && (typeof f.lastCommit !== 'string' || !ISO.test(f.lastCommit) || Number.isNaN(Date.parse(f.lastCommit)))) {
      throw new ReportError('lastCommit must be an ISO date');
    }
    const remotes = f.remotes ?? [];
    if (!Array.isArray(remotes) || remotes.length > MAX_REMOTES || remotes.some((r) => typeof r !== 'string' || r.length > MAX_REMOTE)) {
      throw new ReportError(`remotes must be at most ${MAX_REMOTES} texts of up to ${MAX_REMOTE} characters`);
    }
    return {
      name: f.name, git: f.git, branch: (f.branch as string | null | undefined) ?? null,
      uncommitted: count(f, 'uncommitted'), unpushed: count(f, 'unpushed'), lastCommit: (f.lastCommit as string | null | undefined) ?? null,
      remotes: [...new Set((remotes as string[]).map(stripCredentials))],
    };
  });
}
