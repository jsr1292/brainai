import { backupHealth, readBackupStatus } from '../backupStatus.js';
import { brainHealth, type Health, type HealthInput } from '../health/health.js';
import { isStatus } from '../memory/brief.js';
import { isLifeArea } from '../projects/service.js';
import { localDay } from '../timezone.js';
import type { AppDeps } from './app.js';
import { connStatuses } from './connStatus.js';

/** What brain health reads (B1), gathered from what the dashboard already knows. */
export function healthInput(d: AppDeps, now: Date): HealthInput {
  // Open projects, as the home lists them: a personal area of life is not work that needs a status.
  const projects = d.registry.list().filter((p) => p.state === 'open' && !isLifeArea(p)).map((p) => {
    const statuses = d.store.list({ project: p.name }).filter(isStatus);
    const roadmap = d.service.roadmapOf(p.name);
    const times = [...statuses.map((m) => m.updatedAt), ...(roadmap ? [roadmap.updatedAt] : [])].sort();
    return { name: p.name, lastUpdate: times.at(-1) ?? null, hasStatus: statuses.length > 0, hasRoadmap: roadmap !== undefined };
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
    if (d.localMode && !status.nightly) return null;
    return backupHealth(status, now, { offsite: d.mode !== 'work', jobs: d.mode !== 'work' });
  })();
  const today = localDay(now);
  return {
    projects,
    outOfDatePages: headers.filter((h) => flagged.has(h.id)).map((h) => ({ id: h.id, title: h.title })),
    profileFacts: d.store.countCurrent({ kind: 'profile' }),
    apps,
    backups,
    waiting: {
      approvals: d.service.pendingSuggestions().length,
      disagreements: d.service.openDisagreements().length,
      overdue: d.service.whatsLeft(now).waiting.filter((w) => w.due !== null && w.due < today).map((w) => ({ project: w.project, text: w.text, due: w.due! })),
      discussions: d.discussions.waitingOnOwner(),
    },
  };
}

export const healthOf = (d: AppDeps, now: Date): Health => brainHealth(healthInput(d, now), now);
