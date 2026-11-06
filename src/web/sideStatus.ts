import { backupHealth, readBackupStatus } from '../backupStatus.js';
import type { AppDeps } from './app.js';

/**
 * The desktop sidebar's only live facts (desktop design §7 "Data cost"): does anything need the owner (the orange dot on
 * Projects), and is the backup late (the amber line on Settings). Each is worked out at most once per `ttlMs`, and an
 * approve, reject or decide clears the cache, so the owner's own answer shows at once.
 */
export interface SideStatus { needsYouCount(): number; backupLate(): boolean; invalidate(): void }

export function createSideStatus(d: Pick<AppDeps, 'service' | 'discussions' | 'statusDir' | 'mode' | 'now'> & Partial<Pick<AppDeps, 'skills'>>, ttlMs = 30_000): SideStatus {
  const work = d.mode === 'work';
  let needs: { at: number; value: number } | null = null;
  let late: { at: number; value: boolean } | null = null;
  const stale = (c: { at: number } | null, t: number) => c === null || t > c.at + ttlMs;
  return {
    needsYouCount() {
      // Work mode has no For you approvals or discussions to point at: the dot never shows there.
      if (work) return 0;
      const t = d.now().getTime();
      if (stale(needs, t)) needs = { at: t, value: d.service.pendingSuggestions().length + (d.skills?.pendingProposals().length ?? 0) + d.discussions.waitingOnOwner().length };
      return needs!.value;
    },
    backupLate() {
      if (d.statusDir === undefined) return false;
      const t = d.now().getTime();
      // The same check, with the same options, as the home's backup banner (projectRoutes.ts).
      if (stale(late, t)) late = { at: t, value: !backupHealth(readBackupStatus(d.statusDir), d.now(), { offsite: !work, jobs: !work }).ok };
      return late!.value;
    },
    invalidate() {
      needs = null;
      late = null;
    },
  };
}

/** Set once per app by createApp, next to the page mode. */
let current: SideStatus | null = null;
export function setSideStatus(s: SideStatus | null): void {
  current = s;
}
/** What the sidebar shows; both false when no app set one. */
export function sideStatus(): { needsYou: boolean; backupLate: boolean } {
  return current === null ? { needsYou: false, backupLate: false } : { needsYou: current.needsYouCount() > 0, backupLate: current.backupLate() };
}
export function invalidateSideStatus(): void {
  current?.invalidate();
}
