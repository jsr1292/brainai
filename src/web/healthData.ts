import { copyState } from '../desktop/backupCopy.js';
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import type { ProfileHealth } from './healthViews.js';
import { quietApps, QUIET_WINDOW_DAYS, type QuietApp } from '../health/quietApps.js';
import { brainHealth, type Health, type HealthInput } from '../health/health.js';
import { isLifeArea } from '../projects/service.js';
import { localDay } from '../timezone.js';
import type { AppDeps } from './app.js';
import { needsYouCounts } from './inboxModel.js';
import { connStatuses } from './connStatus.js';

/** What brain health reads (B1), gathered from what the dashboard already knows. */
export function healthInput(d: AppDeps, now: Date): HealthInput {
  // Open projects, as the home lists them: a personal area of life is not work that needs a status.
  const statusAt = d.store.statusTimes();
  const projects = d.registry.list().filter((p) => p.state === 'open' && !isLifeArea(p)).map((p) => {
    const status = statusAt.get(p.name);
    const roadmap = d.service.roadmapOf(p.name);
    const times = [...(status ? [status] : []), ...(roadmap ? [roadmap.updatedAt] : [])].sort();
    return { name: p.name, lastUpdate: times.at(-1) ?? null, hasStatus: status !== undefined, hasRoadmap: roadmap !== undefined };
  });
  const headers = d.pages.headers();
  const flagged = d.pages.flaggedIds(headers);
  const grants = d.provider.listGrants().filter((g) => !g.revokedAt);
  const statuses = connStatuses(d, grants);
  const apps = grants.flatMap((g) => {
    const s = statuses.get(g.id);
    if (!s || s.setup === 'none') return [];
    return [{ name: g.clientName, setup: s.setup, href: s.app ? `/settings/setup/${s.app}` : '/settings#connections' }];
  });
  // Backups: what Settings checks, except on the desktop before its first nightly backup (nothing scheduled yet).
  const backups = (() => {
    if (d.statusDir === undefined) return null;
    const status = readBackupStatus(d.statusDir);
    const copy = d.localMode && d.backupCopy ? copyState(d.backupCopy.folder(), d.backupCopy.lastResult(), now) : undefined;
    const copyBad = copy?.kind === 'failed' || copy?.kind === 'old';
    if (d.localMode && !status.nightly && !copyBad) return null;
    // Before the first nightly backup on the desktop only the second copy can be a problem; the nightly checks wait.
    if (d.localMode && !status.nightly) return backupHealth({ nightly: { at: now.toISOString(), ok: true } }, now, { offsite: false, copy });
    return backupHealth(status, now, { offsite: !d.localMode, jobs: !d.localMode, copy });
  })();
  const today = localDay(now);
  // The same count as the Inbox's badge: approvals include skill proposals.
  const counts = needsYouCounts(d);
  return {
    projects,
    outOfDatePages: headers.filter((h) => flagged.has(h.id)).map((h) => ({ id: h.id, title: h.title })),
    profileFacts: d.store.countCurrent({ kind: 'profile' }),
    apps,
    backups,
    waiting: {
      approvals: counts.approvals,
      disagreements: counts.disagreements,
      overdue: d.service.whatsLeft(now).waiting.filter((w) => w.due !== null && w.due < today).map((w) => ({ project: w.project, text: w.text, due: w.due! })),
      discussions: d.discussions.waitingOnOwner(),
    },
  };
}

export const healthOf = (d: AppDeps, now: Date): Health => brainHealth(healthInput(d, now), now);

/** The profile's size and near-identical entries (A4), worked out only when Brain health renders: a handful of entries, N² is cheap. */
export function profileHealth(d: AppDeps): ProfileHealth {
  const entries = d.service.loadProfile();
  const words = entries.reduce((n, m) => n + (m.content.trim() === '' ? 0 : m.content.trim().split(/\s+/).length), 0);
  // The tidy-up scan's own test (the embedding profile's duplicate threshold, dismissed and disagreeing pairs left out).
  const pairs = d.service.profileDuplicates().map(({ a, b }) => ({ a: { id: a.id, content: a.content }, b: { id: b.id, content: b.content } }));
  return { entries: entries.length, words, pairs };
}

/** Apps that read the memory a lot over the last week and saved nothing (B1). Worked out only when Brain health renders. */
export function quietAppsOf(d: AppDeps, now: Date): QuietApp[] {
  const grants = d.provider.listGrants().filter((g) => !g.revokedAt);
  return quietApps(d.store.toolCalls(new Date(now.getTime() - QUIET_WINDOW_DAYS * 86_400_000), new Date(now.getTime() + 1)), grants.map((g) => g.clientName));
}
