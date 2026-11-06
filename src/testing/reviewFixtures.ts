import type { AppDeps } from '../web/app.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;

/** Moves the test app's clock to `iso` (it only goes forward). */
export function clockTo(deps: AppDeps, advance: (ms: number) => void, iso: string): void {
  const ms = Date.parse(iso) - deps.now().getTime();
  if (ms < 0) throw new Error(`the clock is already past ${iso}`);
  advance(ms);
}

/**
 * The week of 26 Oct – 1 Nov 2026 on a test app started at 2026-10-18T08:00Z: energy's one fact on 18 Oct (it goes
 * quiet that week), wildlog's roadmap from 20 Oct with one item due 25 Oct and three steps done 27–31 Oct, (4/8) →
 * (7/8), a decision and an observation with evidence that week. Ends at `end` (default Tuesday 3 Nov 08:14 in Berlin).
 */
export async function seedWildlogWeek(deps: AppDeps, advance: (ms: number) => void, end = '2026-11-03T07:14:00Z'): Promise<void> {
  const to = (iso: string) => clockTo(deps, advance, iso);
  to('2026-10-18T10:00:00Z');
  await deps.service.remember({ kind: 'decision', content: 'energy compares the winter tariffs', project: 'energy', newProject: true }, ai);
  to('2026-10-20T10:00:00Z');
  const r = await deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Done: setup (2026-10-20)\nNow: Release 0.2.2 (4/8)\nNext: release\nWaiting on you: Run ./scripts/release.sh 0.2.2 (by 2026-10-25)', newProject: true }, ai) as { memory: { id: string } };
  to('2026-10-31T10:00:00Z');
  await deps.service.update(r.memory.id, { content: 'Done: TestFlight build 0.2.2 (2026-10-28); Label scan on the phone (2026-10-30); Cellar map sorting (2026-10-31)\nNow: Release 0.2.2 (7/8)\nNext: release\nWaiting on you: Run ./scripts/release.sh 0.2.2 (by 2026-10-25)' }, ai);
  to('2026-10-31T11:00:00Z');
  const d = await deps.service.remember({ kind: 'decision', content: 'Label photos stay on the phone, with no cloud text reading.', project: 'wildlog' }, ai);
  if (d.status !== 'saved') throw new Error(`the decision was not saved: ${d.status}`);
  await deps.growth.note({ kind: 'strength', area: 'reviewing', what: 'Caught that the label scan counted drafts twice', project: 'wildlog' }, 'Claude Code');
  to(end);
}
