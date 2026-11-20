import { AsyncLocalStorage } from 'node:async_hooks';
import { sideUpdate, readUpdate, type SideUpdate } from '../desktop/updateState.js';
import { BRAIN_VERSION } from '../version.js';
import { backupHealth, readBackupStatus } from '../backupStatus.js';
import type { AppDeps } from './app.js';
import { inboxCount } from './inboxModel.js';

/**
 * The desktop sidebar's only live facts (desktop design §7 "Data cost"): does anything need the owner (the orange dot on
 * Projects), and is the backup late (the amber line on Settings). Each is worked out at most once per `ttlMs`, and an
 * approve, reject or decide clears the cache, so the owner's own answer shows at once.
 */
export interface SideStatus { needsYouCount(): number; backupLate(): boolean; update(): SideUpdate | null; invalidate(): void; prime(count: number): void }

/** Whether a request came in through the public door (true) or locally (false): the sidebar says nothing about the app's own update unless it is marked local; a render outside a request says nothing. Set by createApp. */
const doorRequest = new AsyncLocalStorage<boolean>();
export const runWithDoorFlag = <T>(viaDoor: boolean, fn: () => T): T => doorRequest.run(viaDoor, fn);

export function createSideStatus(d: Pick<AppDeps, 'service' | 'discussions' | 'statusDir' | 'now' | 'localMode'> & Partial<Pick<AppDeps, 'skills' | 'tidy'>>, ttlMs = 30_000): SideStatus {
  let needs: { at: number; value: number } | null = null;
  let late: { at: number; value: boolean } | null = null;
  const stale = (c: { at: number } | null, t: number) => c === null || t > c.at + ttlMs;
  return {
    needsYouCount() {
      const t = d.now().getTime();
      if (stale(needs, t)) needs = { at: t, value: inboxCount(d) };
      return needs!.value;
    },
    backupLate() {
      if (d.statusDir === undefined) return false;
      const t = d.now().getTime();
      // The same check, with the same options, as the home's backup banner (projectRoutes.ts).
      if (stale(late, t)) late = { at: t, value: !backupHealth(readBackupStatus(d.statusDir), d.now(), { offsite: !d.localMode, jobs: !d.localMode }).ok };
      return late!.value;
    },
    /**
     * The desktop app's update, only while it downloads or waits for a restart. Read afresh every time (a few bytes: the
     * page is rendered on every request, and the download's percent moves), and only in the app on the owner's own computer.
     */
    update() {
      if (!d.localMode || d.statusDir === undefined || doorRequest.getStore() !== false) return null; // fail closed: only a request marked as local sees it
      return sideUpdate(readUpdate(d.statusDir, BRAIN_VERSION));
    },
    invalidate() {
      needs = null;
      late = null;
    },
    /** The Inbox page has just counted what waits: the badge reuses that number. */
    prime(count) {
      needs = { at: d.now().getTime(), value: count };
    },
  };
}

/** Set once per app by createApp. */
let current: SideStatus | null = null;
export function setSideStatus(s: SideStatus | null): void {
  current = s;
}
/** What the sidebar shows: the Inbox count (what waits for the owner) and the backup warning. */
export function sideStatus(): { needsYou: boolean; needsYouCount: number; backupLate: boolean; update: SideUpdate | null } {
  if (current === null) return { needsYou: false, needsYouCount: 0, backupLate: false, update: null };
  const count = current.needsYouCount();
  return { needsYou: count > 0, needsYouCount: count, backupLate: current.backupLate(), update: current.update() };
}
export function primeSideStatus(count: number): void {
  current?.prime(count);
}
export function invalidateSideStatus(): void {
  current?.invalidate();
}
