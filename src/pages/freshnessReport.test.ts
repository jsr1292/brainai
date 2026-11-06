import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshnessWorld } from '../testing/freshnessWorld.js';
import { freshnessReport, sectionVerdict } from './freshnessReport.js';

test('the verdict turns matching off with too few pairs, or when most decisions clear the floor, and says which', () => {
  const few = sectionVerdict(Array(10).fill({ nearest: 0.95, second: 0.5, main: true }));
  assert.equal(few.value, null);
  assert.match(few.why, /^no data: 10 pairs \(main 10, other 0\); other pages: no data$/);
  const crowded = sectionVerdict(Array(40).fill({ nearest: 0.9, second: 0.85, main: false }));
  assert.equal(crowded.value, null);
  assert.match(crowded.why, /^no gap: 40 pairs \(main 0, other 40\)$/);
});

test('the verdict keeps the lowest floor that most decisions stay under, with a clear margin and no pile-up at the line', () => {
  const spread = [...Array(36).fill({ nearest: 0.84, second: 0.8, main: true }), ...Array(4).fill({ nearest: 0.91, second: 0.86, main: true })];
  const v = sectionVerdict(spread);
  assert.equal(v.value, 0.88);
  assert.match(v.why, /^40 pairs \(main 40, other 0\), .*; other pages: no data$/);
  // A pile-up right at 0.88 moves the floor up; at every floor, it stays off.
  const piled = [...Array(36).fill({ nearest: 0.84, second: 0.8, main: false }), ...Array(4).fill({ nearest: 0.881, second: 0.8, main: false })];
  assert.equal(sectionVerdict(piled).value, 0.89);
});

const MAIN = 'wildlog — wine cellar iPhone app';
const BODY = 'An app.\n\n## What it does\nKeeps bottles.\n\n## Stack and where it lives\nSwiftUI.\n\n## Key decisions\n- 2026-10-12 Offline first.';

async function world() {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const main = await w.page('2026-10-21T09:00:00.000Z', MAIN, 'wildlog', BODY);
  const runbook = await w.page('2026-10-22T09:00:00.000Z', 'wildlog — TestFlight runbook', 'wildlog', 'Steps.\n\n## Upload\nOrganizer.\n\n## Archive\nXcode.');
  return { ...w, main, runbook, report: (o: Parameters<typeof freshnessReport>[1] = {}) => freshnessReport({ pages: w.pages, memoryStore: w.store, memories: w.service }, o) };
}

test('the spread counts main pages too, and prints main, other and combined', async () => {
  const w = await world();
  w.decision('2026-10-28T10:00:00.000Z', 'wildlog one', 'wildlog');
  w.decision('2026-10-29T10:00:00.000Z', 'wildlog two', 'wildlog');
  w.registry.create('minipc', { state: 'open', area: 'home' }, 'owner');
  await w.page('2026-10-22T09:00:00.000Z', 'minipc — the home server', 'minipc', 'A box.\n\n## Setup\nProxmox.\n\n## Backups\nRestic.\n\n## Key decisions\n- 2026-10-01 x');
  w.decision('2026-10-28T10:00:00.000Z', 'minipc one', 'minipc');
  const lines = w.report();
  assert.ok(lines.includes('spread main: pairs 3'), lines.join('\n'));
  assert.ok(lines.includes('spread other: pairs 2'), lines.join('\n'));
  assert.ok(lines.includes('spread combined: pairs 5'), lines.join('\n'));
  assert.ok(lines.some((l) => /^SECTION_MATCH verdict: off \(no data: 5 pairs \(main 3, other 2\)\)$/.test(l)), lines.join('\n'));
  assert.match(lines[0]!, /^schema \d+; pages 3 \(3 with a project\); unsaved imports 0$/);
  assert.equal(lines[1], 'main page: by rule 2, only page 0, none 0');
  assert.ok(lines.some((l) => /^would flag 0 of 3 \(main 0, other 0\); decisions only 0, linked only 0, both 0$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^at 2 \/ 1: would flag 1 of 3/.test(l)), lines.join('\n'));
});

test('the report prints counts and ids, never titles or fact text, unless asked for names', async () => {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const p = await w.page('2026-10-21T09:00:00.000Z', 'wildlog — SECRETTITLE', 'wildlog', BODY);
  for (const i of [1, 2, 3]) w.decision(`2026-10-2${i + 4}T10:00:00.000Z`, `SECRETTEXT ${i}`, 'wildlog');
  const lines = freshnessReport({ pages: w.pages, memoryStore: w.store, memories: w.service }, {});
  const all = lines.join('\n');
  assert.doesNotMatch(all, /SECRETTITLE|SECRETTEXT|wildlog/);
  assert.ok(all.includes(p.id));
  assert.match(all, /would flag 1 of 1/);
  const named = freshnessReport({ pages: w.pages, memoryStore: w.store, memories: w.service }, { names: true }).join('\n');
  assert.match(named, /SECRETTITLE/);
  assert.doesNotMatch(named, /SECRETTEXT/);
});

test('timings are printed for the page view and the Pages tab when asked', async () => {
  const w = await world();
  for (const i of [1, 2, 3]) w.decision(`2026-10-2${i + 4}T10:00:00.000Z`, `wildlog ${i}`, 'wildlog');
  let pages = 0, homes = 0;
  const lines = w.report({ time: true, render: { page: () => { pages++; return ''; }, home: () => { homes++; return ''; } } });
  assert.ok(lines.some((l) => /^page view: median [\d.]+ ms, max [\d.]+ ms$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^Pages tab: median [\d.]+ ms, max [\d.]+ ms$/.test(l)), lines.join('\n'));
  assert.deepEqual([pages, homes], [23, 23]);
});
