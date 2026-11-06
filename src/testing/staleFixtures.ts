import type { Memory } from '../memory/types.js';
import type { Page } from '../pages/types.js';
import type { AppDeps } from '../web/app.js';
import { FAR } from './freshnessWorld.js';

export const WILDLOG_MAIN = 'wildlog — wine cellar iPhone app';

/** The mockup's wildlog page body, its 14 and 19 Oct entries linked to the facts given. */
export const wildlogBody = (cloudkit: string, region: string) => [
  'An iPhone app for the wine cellar: what is in each rack, and when each bottle is ready to drink.',
  '## What it does\n- Add a bottle by reading its label, then pick the rack and slot.\n- Groups the cellar by region, then by producer.',
  '## Stack and where it lives\n- SwiftUI, iOS 18, Swift 6.\n- Sync: CloudKit private database.',
  '## Run, build and deploy\n- Open `wildlog.xcodeproj`, scheme `wildlog`.',
  `## Key decisions\n- 2026-10-12 Offline first: the cellar is in the garage with no signal.\n- 2026-10-14 CloudKit for sync, so there is no server to run. [[fact:${cloudkit}]]\n- 2026-10-19 Bottles grouped by region. [[fact:${region}]]`,
  '## Gotchas and lessons\n- The garage has no signal: test every screen in airplane mode.',
].join('\n\n');

/**
 * The mockup's data on the test app's clock: wildlog's main page brought up to date on 21 Oct, three decisions saved
 * after it (28 Oct, 30 Oct, 1 Nov) and the linked "Bottles grouped by region" fact changed on 2 Nov. The app's clock
 * must start on or before 12 Oct 2026; it ends at `end` (default 3 Nov, 08:00).
 */
export async function seedFlaggedWildlog(deps: AppDeps, advance: (ms: number) => void, opts: { end?: string; decisions?: { at: string; text: string; by?: string; embedding?: Float32Array }[]; linkedChange?: boolean } = {}): Promise<{ page: Page; decisions: Memory[]; region: Memory; cloudkit: Memory; at: (iso: string) => void }> {
  const at = (iso: string) => { const d = Date.parse(iso) - deps.now().getTime(); if (d > 0) advance(d); };
  const fact = (iso: string, text: string, by = 'Claude Code', embedding: Float32Array = FAR) => { at(iso); return deps.store.insert({ kind: 'decision', content: text, project: 'wildlog', tags: [], embedding, by }); };
  if (!deps.registry.get('wildlog')) deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const cloudkit = fact('2026-10-14T09:00:00.000Z', 'wildlog syncs with CloudKit, so there is no server to run.');
  const region = fact('2026-10-19T09:00:00.000Z', 'wildlog groups bottles by region, then by producer.');
  at('2026-10-21T09:00:00.000Z');
  const page = await deps.pages.create({ title: WILDLOG_MAIN, project: 'wildlog', body: wildlogBody(cloudkit.id, region.id) }, 'Claude Code');
  const decisions = (opts.decisions ?? [
    { at: '2026-10-28T10:00:00.000Z', text: 'The “ready now” list sorts by drink-by year, earliest first.', by: 'Claude' },
    { at: '2026-10-30T10:00:00.000Z', text: 'Sync: CloudKit replaced by a local SQLite file with an iCloud Drive copy each night.', by: 'Claude Code' },
    { at: '2026-11-01T10:00:00.000Z', text: 'Barcode scanning uses VisionKit\'s DataScanner; reading the label text was dropped.', by: 'Codex' },
  ]).map((d) => fact(d.at, d.text, d.by, d.embedding));
  at('2026-11-02T10:00:00.000Z');
  if (opts.linkedChange !== false) deps.store.update(region.id, { content: 'Bottles are grouped by cellar rack, not by region. The rack map is the home screen.', project: 'wildlog', tags: [], embedding: FAR, by: 'Claude Code' });
  at(opts.end ?? '2026-11-03T08:00:00.000Z');
  return { page: deps.pages.get(page.id)!, decisions, region: deps.store.get(region.id)!, cloudkit, at };
}
