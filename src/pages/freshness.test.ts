import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshnessWorld } from '../testing/freshnessWorld.js';

const owner = { type: 'owner' } as const;
const MAIN = 'wildlog — wine cellar iPhone app';
export const MAIN_BODY = [
  'An iPhone app for the wine cellar.',
  '## What it does\nKeeps every bottle with where it sits.',
  '## Stack and where it lives\nSwiftUI, SwiftData, iCloud.',
  '## Run, build and deploy\nXcode, then TestFlight.',
  '## Key decisions\n- 2026-10-12 Offline first.\n- 2026-10-14 Bottles by region.',
  '## Gotchas and lessons\nCloudKit is slow to sync.',
].join('\n\n');
const RUNBOOK = 'wildlog — TestFlight runbook';
const RUNBOOK_BODY = 'How to ship a build.\n\n## Archive\nProduct, Archive.\n\n## Upload\nOrganizer, Distribute.';

async function world(opts: { sectionMatch?: number | null } = {}) {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z', opts);
  w.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const main = await w.page('2026-10-21T09:00:00.000Z', MAIN, 'wildlog', MAIN_BODY);
  const runbook = await w.page('2026-10-22T09:00:00.000Z', RUNBOOK, 'wildlog', RUNBOOK_BODY);
  return { ...w, main, runbook };
}
const three = (w: Awaited<ReturnType<typeof world>>) => [
  w.decision('2026-10-28T10:00:00.000Z', 'wildlog labels use Avenir', 'wildlog'),
  w.decision('2026-10-30T10:00:00.000Z', 'wildlog photos go to iCloud', 'wildlog'),
  w.decision('2026-11-01T10:00:00.000Z', 'wildlog drinking windows are set by hand', 'wildlog'),
];

test('the main page is the oldest "<project> — " page with Key decisions; a runbook never is', async () => {
  const w = await world();
  assert.equal(w.pages.freshness.mainPage('wildlog'), w.main.id);
  await w.page('2026-10-25T09:00:00.000Z', 'wildlog — notes', 'wildlog', 'Notes.\n\n## Key decisions\n- 2026-10-25 x');
  assert.equal(w.pages.freshness.mainPage('wildlog'), w.main.id);
  w.registry.create('inflow', { state: 'open', area: 'apps' }, 'owner');
  await w.page('2026-10-02T09:00:00.000Z', 'inflow — runbook', 'inflow', 'Steps.\n\n## Upload\nx');
  const player = await w.page('2026-10-03T09:00:00.000Z', 'inflow — player', 'inflow', 'Player.\n\n## Key decisions\n- 2026-10-03 x');
  await w.page('2026-10-01T09:00:00.000Z', 'Inflow notes', 'inflow', 'No prefix.\n\n## Key decisions\n- 2026-10-01 x');
  assert.equal(w.pages.freshness.mainPage('inflow'), player.id);
});

test('a project with one page uses it, a project with two pages and no Key decisions has none', async () => {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('minipc', { state: 'open', area: 'home' }, 'owner');
  const only = await w.page('2026-10-02T09:00:00.000Z', 'The mini PC', 'minipc', 'A box.\n\n## Setup\nx');
  assert.equal(w.pages.freshness.mainPage('minipc'), only.id);
  await w.page('2026-10-03T09:00:00.000Z', 'minipc — backups', 'minipc', 'Backups.\n\n## Restic\nx');
  assert.equal(w.pages.freshness.mainPage('minipc'), null);
  assert.equal(w.pages.freshness.mainPage('nothing'), null);
});

test('three decisions saved after the page flag it, since the third one\'s time', async () => {
  const w = await world();
  const ds = three(w);
  const f = w.pages.freshness.forPage(w.main)!;
  assert.equal(f.decisions.length, 3);
  assert.deepEqual(f.decisions.map((d) => d.why), ['new', 'new', 'new']);
  assert.deepEqual(f.decisions.map((d) => d.id), ds.map((d) => d.id));
  assert.equal(f.decisions[0]!.text, 'wildlog labels use Avenir');
  assert.equal(f.decisions[0]!.by, 'Claude Code');
  assert.equal(f.since, '2026-11-01T10:00:00.000Z');
  assert.equal(f.main, true);
  assert.equal(f.project, 'wildlog');
  assert.deepEqual(f.caughtUp, w.main.caughtUp);
  assert.deepEqual(f.linked, []);
});

test('two newer decisions do not flag the page', async () => {
  const w = await world();
  w.decision('2026-10-28T10:00:00.000Z', 'a', 'wildlog');
  w.decision('2026-10-30T10:00:00.000Z', 'b', 'wildlog');
  assert.equal(w.pages.freshness.forPage(w.main), null);
  assert.equal(w.pages.freshness.reasons(w.main).decisions.length, 2);
});

test('a decision whose text changed counts as changed, from its first change', async () => {
  const w = await world();
  const old = w.decision('2026-10-15T10:00:00.000Z', 'wildlog stores photos on the phone', 'wildlog');
  w.edit('2026-10-27T10:00:00.000Z', old.id, 'wildlog stores photos in iCloud');
  w.edit('2026-10-29T10:00:00.000Z', old.id, 'wildlog stores photos in iCloud Drive');
  w.decision('2026-10-28T10:00:00.000Z', 'a', 'wildlog');
  w.decision('2026-10-30T10:00:00.000Z', 'b', 'wildlog');
  const f = w.pages.freshness.forPage(w.main)!;
  assert.deepEqual(f.decisions.map((d) => [d.id === old.id ? 'old' : d.text, d.why, d.at]), [
    ['old', 'changed', '2026-10-27T10:00:00.000Z'], ['a', 'new', '2026-10-28T10:00:00.000Z'], ['b', 'new', '2026-10-30T10:00:00.000Z'],
  ]);
  assert.equal(f.decisions[0]!.text, 'wildlog stores photos in iCloud Drive');
  assert.equal(f.since, '2026-10-30T10:00:00.000Z');
});

test('A→B→A, a relabel, and a delete undone by a restore never count', async () => {
  const w = await world();
  const a = w.decision('2026-10-15T10:00:00.000Z', 'A', 'wildlog');
  const b = w.decision('2026-10-16T10:00:00.000Z', 'B', 'wildlog');
  const c = w.decision('2026-10-17T10:00:00.000Z', 'C', 'wildlog');
  w.edit('2026-10-25T10:00:00.000Z', a.id, 'A2');
  w.edit('2026-10-26T10:00:00.000Z', a.id, 'A');
  w.relabel('2026-10-27T10:00:00.000Z', b.id, { tags: ['ios'] });
  w.remove('2026-10-28T10:00:00.000Z', c.id);
  w.bringBack('2026-10-29T10:00:00.000Z', c.id);
  assert.deepEqual(w.pages.freshness.reasons(w.main).decisions, []);
});

test('statuses, roadmaps and profile facts never count; a decision tagged status never counts', async () => {
  const w = await world();
  w.decision('2026-10-28T10:00:00.000Z', 'wildlog status: build 12 is out', 'wildlog', { kind: 'summary' });
  w.decision('2026-10-28T11:00:00.000Z', 'Now: widgets', 'wildlog', { kind: 'roadmap' });
  w.decision('2026-10-28T12:00:00.000Z', 'Prefers short answers', null, { kind: 'profile' });
  w.decision('2026-10-28T13:00:00.000Z', 'wildlog is on build 12', 'wildlog', { tags: ['status'] });
  assert.deepEqual(w.pages.freshness.reasons(w.main).decisions, []);
});

test('a replaced decision is not counted; the decision that replaced it counts as new', async () => {
  const w = await world();
  const a = w.decision('2026-10-28T10:00:00.000Z', 'wildlog labels use Futura', 'wildlog');
  const b = w.decision('2026-10-29T10:00:00.000Z', 'wildlog labels use Avenir', 'wildlog');
  w.replace('2026-10-29T10:00:00.000Z', a.id, b.id);
  assert.deepEqual(w.pages.freshness.reasons(w.main).decisions.map((d) => [d.id, d.why]), [[b.id, 'new']]);
});

test('a decision the page links to is never counted as new', async () => {
  const w = await world();
  const [a] = three(w);
  await w.pages.saveSection(w.main.id, { base: 1, anchor: 'run-build-and-deploy', text: `## Run, build and deploy\nXcode, then TestFlight. [[fact:${a!.id}]]` }, 'Claude Code');
  const p = w.pages.get(w.main.id)!;
  assert.equal(p.caughtUp.at, w.main.caughtUp.at);
  assert.deepEqual(w.pages.freshness.reasons(p).decisions.map((d) => d.id).includes(a!.id), false);
  assert.equal(w.pages.freshness.forPage(p), null);
});

test('a decision saved the same second as Outline\'s date is not newer, a millisecond later it is', async () => {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  w.at('2026-11-01T08:00:00.000Z');
  const p = await w.pages.create({ title: MAIN, project: 'wildlog', body: MAIN_BODY }, 'Outline import', { importedAt: '2026-10-21T09:00:00Z' });
  const same = w.decision('2026-10-21T09:00:00.000Z', 'same second', 'wildlog');
  const later = w.decision('2026-10-21T09:00:00.001Z', 'a millisecond later', 'wildlog');
  assert.deepEqual(w.pages.freshness.reasons(p).decisions.map((d) => d.id), [later.id]);
  assert.ok(!w.pages.freshness.reasons(p).decisions.some((d) => d.id === same.id));
});

test('a decision moved to another project counts there, and no longer on the old project\'s page', async () => {
  const w = await world();
  w.registry.create('inflow', { state: 'open', area: 'apps' }, 'owner');
  const player = await w.page('2026-10-21T09:00:00.000Z', 'inflow — player', 'inflow', 'Player.\n\n## Key decisions\n- 2026-10-03 x');
  const before = w.decision('2026-10-15T10:00:00.000Z', 'saved before both pages', 'wildlog');
  const ds = three(w);
  w.relabel('2026-11-02T10:00:00.000Z', ds[2]!.id, { project: 'inflow' });
  w.relabel('2026-11-02T11:00:00.000Z', before.id, { project: 'inflow' });
  assert.deepEqual(w.pages.freshness.reasons(w.main).decisions.map((d) => d.id), [ds[0]!.id, ds[1]!.id]);
  assert.equal(w.pages.freshness.forPage(w.main), null);
  assert.deepEqual(w.pages.freshness.reasons(player).decisions.map((d) => [d.id, d.why]), [[ds[2]!.id, 'new']]);
});

test('after a merge, decisions saved under the alias count on the real project\'s main page', async () => {
  const w = await world();
  w.registry.create('cellar', { state: 'open', area: 'apps' }, 'owner');
  w.decision('2026-10-28T10:00:00.000Z', 'cellar one', 'cellar');
  w.decision('2026-10-29T10:00:00.000Z', 'cellar two', 'cellar');
  w.at('2026-10-30T09:00:00.000Z');
  w.service.addAlias('cellar', 'wildlog', owner);
  w.decision('2026-10-31T10:00:00.000Z', 'saved under the alias', 'cellar');
  const f = w.pages.freshness.forPage(w.main)!;
  assert.deepEqual(f.decisions.map((d) => d.text), ['cellar one', 'cellar two', 'saved under the alias']);
  assert.equal(f.since, '2026-10-31T10:00:00.000Z');
});

test('pages of an archived project never flag', async () => {
  const w = await world();
  three(w);
  w.registry.setState('wildlog', 'archived', 'owner');
  assert.equal(w.pages.freshness.forPage(w.main), null);
});

test('forPages answers every page, and a deleted page is null', async () => {
  const w = await world();
  three(w);
  const start = await w.page('2026-11-02T09:00:00.000Z', 'How this brain is organised', null, 'Facts and pages.');
  const m = w.pages.freshness.forPages([w.main, w.runbook, start]);
  assert.deepEqual([...m.keys()], [w.main.id, w.runbook.id, start.id]);
  assert.equal(m.get(w.main.id)!.decisions.length, 3);
  assert.equal(m.get(w.runbook.id), null);
  assert.equal(m.get(start.id), null);
  w.pages.remove(w.main.id, 'owner');
  assert.equal(w.pages.freshness.forPages([w.pages.get(w.main.id)!]).get(w.main.id), null);
});

// ---- Linked facts (Task 4) ----

const withLink = (body: string, ...ids: string[]) => body.replace('## Gotchas and lessons', `See ${ids.map((id) => `[[fact:${id}]]`).join(' and ')}.\n\n## Gotchas and lessons`);

test('one changed fact the page links to flags it, any kind and any project, Start here included', async () => {
  const w = freshnessWorld('2026-10-01T09:00:00.000Z');
  w.registry.create('minipc', { state: 'open', area: 'home' }, 'owner');
  const status = w.decision('2026-10-10T09:00:00.000Z', 'minipc runs Proxmox 8', 'minipc', { kind: 'summary' });
  const start = await w.page('2026-10-21T09:00:00.000Z', 'How this brain is organised', null, `Facts and pages. The server: [[fact:${status.id}]]`);
  assert.equal(w.pages.freshness.forPage(start), null);
  w.edit('2026-11-02T10:00:00.000Z', status.id, 'minipc runs Proxmox 9');
  const f = w.pages.freshness.forPage(start)!;
  assert.deepEqual(f.linked, [{ id: status.id, why: 'changed', at: '2026-11-02T10:00:00.000Z', text: 'minipc runs Proxmox 9', isDecision: false, replacedBy: null }]);
  assert.equal(f.since, '2026-11-02T10:00:00.000Z');
  assert.equal(f.project, null);
});

test('a linked fact replaced after the page counts as replaced, and points at the fact that holds now', async () => {
  const w = await world();
  const old = w.decision('2026-10-14T10:00:00.000Z', 'wildlog groups bottles by region', 'wildlog');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, old.id) }, 'Claude Code');
  const next = w.decision('2026-11-02T10:00:00.000Z', 'wildlog groups bottles by grape', 'wildlog');
  w.replace('2026-11-02T10:00:00.000Z', old.id, next.id);
  assert.deepEqual(w.pages.freshness.forPage(p)!.linked.map((l) => [l.id, l.why, l.replacedBy, l.isDecision]), [[old.id, 'replaced', next.id, true]]);
  const newer = w.decision('2026-11-03T10:00:00.000Z', 'wildlog groups bottles by grape and year', 'wildlog');
  w.replace('2026-11-03T10:00:00.000Z', next.id, newer.id);
  const l = w.pages.freshness.forPage(p)!.linked[0]!;
  assert.deepEqual([l.replacedBy, l.at], [newer.id, '2026-11-02T10:00:00.000Z']);
});

test('a replacement undone since does not count, and one made before the page was brought up to date does not either', async () => {
  const w = await world();
  const a = w.decision('2026-10-14T10:00:00.000Z', 'A', 'wildlog');
  const b = w.decision('2026-10-15T10:00:00.000Z', 'B', 'wildlog');
  const c = w.decision('2026-10-16T10:00:00.000Z', 'C', 'wildlog');
  const d = w.decision('2026-10-17T10:00:00.000Z', 'D', 'wildlog');
  w.replace('2026-10-18T10:00:00.000Z', c.id, d.id);
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, a.id, c.id) }, 'Claude Code');
  const row = w.replace('2026-10-28T10:00:00.000Z', a.id, b.id);
  w.undoReplace('2026-10-29T10:00:00.000Z', row);
  assert.deepEqual(w.pages.freshness.reasons(p).linked, []);
  assert.equal(w.pages.freshness.forPage(p), null);
});

test('a linked fact deleted after the page counts as removed; deleted and brought back, it does not', async () => {
  const w = await world();
  const a = w.decision('2026-10-14T10:00:00.000Z', 'A', 'wildlog');
  const b = w.decision('2026-10-15T10:00:00.000Z', 'B', 'wildlog');
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, a.id, b.id) }, 'Claude Code');
  w.remove('2026-10-28T10:00:00.000Z', a.id);
  w.remove('2026-10-29T10:00:00.000Z', b.id);
  w.bringBack('2026-10-30T10:00:00.000Z', b.id);
  assert.deepEqual(w.pages.freshness.forPage(p)!.linked.map((l) => [l.id, l.why, l.at]), [[a.id, 'removed', '2026-10-28T10:00:00.000Z']]);
});

test('a removed linked fact keeps the page flagged after an edit to another section', async () => {
  const w = await world();
  const x = w.decision('2026-10-14T10:00:00.000Z', 'X', 'wildlog');
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, x.id) }, 'Claude Code');
  w.remove('2026-10-28T10:00:00.000Z', x.id);
  w.at('2026-10-29T10:00:00.000Z');
  const q = await w.pages.saveSection(p.id, { base: p.version, anchor: 'run-build-and-deploy', text: '## Run, build and deploy\nXcode 17.' }, 'Grok');
  assert.equal((w.db.prepare("SELECT count(*) AS n FROM page_links WHERE from_page = ? AND kind = 'fact'").get(p.id) as { n: number }).n, 0, 'page_links lost the deleted fact');
  assert.equal(q.caughtUp.at, p.caughtUp.at);
  assert.deepEqual(w.pages.freshness.forPage(q)!.linked.map((l) => [l.id, l.why]), [[x.id, 'removed']]);
});

test('a removed linked fact keeps the page flagged after another page is created or renamed under a title it links to', async () => {
  const w = await world();
  const x = w.decision('2026-10-14T10:00:00.000Z', 'X', 'wildlog');
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, x.id).replace('Xcode, then TestFlight.', 'Xcode, then [[TestFlight runbook]].') }, 'Claude Code');
  w.remove('2026-10-28T10:00:00.000Z', x.id);
  const tf = await w.page('2026-10-29T10:00:00.000Z', 'TestFlight runbook', null, 'Steps.');
  assert.deepEqual(w.pages.freshness.forPage(w.pages.get(p.id)!)!.linked.map((l) => [l.id, l.why]), [[x.id, 'removed']]);
  await w.pages.save(tf.id, { base: 1, title: 'TF steps', body: 'Steps.' }, 'owner');
  await w.pages.save(tf.id, { base: 2, title: 'TestFlight runbook', body: 'Steps.' }, 'owner');
  assert.deepEqual(w.pages.freshness.forPage(w.pages.get(p.id)!)!.linked.map((l) => [l.id, l.why]), [[x.id, 'removed']]);
});

test('one reason per linked fact: removed before replaced before changed', async () => {
  const w = await world();
  const a = w.decision('2026-10-14T10:00:00.000Z', 'A', 'wildlog');
  const b = w.decision('2026-10-15T10:00:00.000Z', 'B', 'wildlog');
  const n = w.decision('2026-10-16T10:00:00.000Z', 'N', 'wildlog');
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, a.id, b.id) }, 'Claude Code');
  w.edit('2026-10-26T10:00:00.000Z', a.id, 'A2');
  w.replace('2026-10-27T10:00:00.000Z', a.id, n.id);
  w.remove('2026-10-28T10:00:00.000Z', a.id);
  w.edit('2026-10-26T11:00:00.000Z', b.id, 'B2');
  const m = w.decision('2026-10-27T11:00:00.000Z', 'M', 'wildlog');
  w.replace('2026-10-27T11:00:00.000Z', b.id, m.id);
  assert.deepEqual(w.pages.freshness.reasons(p).linked.map((l) => [l.id, l.why]), [[b.id, 'replaced'], [a.id, 'removed']]);
});

test('with 2 decisions and a linked change, the flag is up from the linked change\'s time', async () => {
  const w = await world();
  const x = w.decision('2026-10-14T10:00:00.000Z', 'X', 'wildlog', { kind: 'summary' });
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, x.id) }, 'Claude Code');
  w.decision('2026-10-28T10:00:00.000Z', 'a', 'wildlog');
  w.decision('2026-10-30T10:00:00.000Z', 'b', 'wildlog');
  w.edit('2026-11-02T10:00:00.000Z', x.id, 'X2');
  const f = w.pages.freshness.forPage(p)!;
  assert.equal(f.decisions.length, 2);
  assert.equal(f.since, '2026-11-02T10:00:00.000Z');
});

test('a read-only scope that can read only 2 of 3 newer decisions sees no flag at all', async () => {
  const w = await world();
  const [, , third] = three(w);
  const canRead = (m: { id: string }) => m.id !== third!.id;
  assert.equal(w.pages.freshness.forPage(w.main, { canRead }), null);
  assert.ok(!w.pages.freshness.reasons(w.main, { canRead }).decisions.some((d) => d.id === third!.id));
  assert.equal(w.pages.freshness.forPage(w.main)!.since, '2026-11-01T10:00:00.000Z');
});

test('a replaced linked fact shows what replaced it only when that fact is readable', async () => {
  const w = await world();
  w.registry.create('homeassistant', { state: 'open', area: 'home' }, 'owner');
  const old = w.decision('2026-10-14T10:00:00.000Z', 'wildlog syncs over CloudKit', 'wildlog', { kind: 'summary' });
  const hidden = w.decision('2026-10-15T10:00:00.000Z', 'hidden', 'homeassistant', { kind: 'summary' });
  w.at('2026-10-25T09:00:00.000Z');
  const p = await w.pages.save(w.main.id, { base: 1, body: withLink(MAIN_BODY, old.id, hidden.id) }, 'Claude Code');
  const next = w.decision('2026-11-02T10:00:00.000Z', 'homeassistant holds it now', 'homeassistant', { kind: 'summary' });
  w.replace('2026-11-02T10:00:00.000Z', old.id, next.id);
  w.edit('2026-11-02T11:00:00.000Z', hidden.id, 'hidden, changed');
  const canRead = (m: { project: string | null }) => m.project === 'wildlog';
  assert.deepEqual(w.pages.freshness.forPage(p, { canRead })!.linked.map((l) => [l.id, l.why, l.replacedBy]), [[old.id, 'replaced', null]]);
  assert.deepEqual(w.pages.freshness.forPage(p)!.linked.map((l) => [l.id, l.replacedBy]), [[old.id, next.id], [hidden.id, null]]);
});

// ---- Meaning matching, section hints and flagged ids (Task 5) ----

const vectorOf = (w: Awaited<ReturnType<typeof world>>, pageId: string, anchor: string) => w.pages.sections(pageId).find((s) => s.anchor === anchor)!.embedding;

test('a runbook flags on three decisions close in meaning to its sections, never on unrelated ones', async () => {
  const w = await world({ sectionMatch: 0.88 });
  three(w);
  assert.deepEqual(w.pages.freshness.reasons(w.runbook).decisions, []);
  const upload = vectorOf(w, w.runbook.id, 'upload');
  const close = ['a', 'b', 'c'].map((x, i) => w.decision(`2026-11-0${i + 1}T12:00:00.000Z`, `close ${x}`, 'wildlog', { embedding: upload }));
  const f = w.pages.freshness.forPage(w.runbook)!;
  assert.deepEqual(f.decisions.map((d) => d.id), close.map((d) => d.id));
  assert.deepEqual(f.decisions.map((d) => d.nearSection), ['upload', 'upload', 'upload']);
  assert.equal(f.main, false);
});

test('with meaning matching off, other pages flag only on linked facts and no hint is given', async () => {
  const w = await world({ sectionMatch: null });
  assert.equal(w.pages.freshness.sectionMatch, null);
  const upload = vectorOf(w, w.runbook.id, 'upload');
  for (const i of [1, 2, 3]) w.decision(`2026-11-0${i}T12:00:00.000Z`, `close ${i}`, 'wildlog', { embedding: upload });
  assert.equal(w.pages.freshness.forPage(w.runbook), null);
  const f = w.pages.freshness.forPage(w.main, { hints: true })!;
  assert.deepEqual(f.decisions.map((d) => d.nearSection), [null, null, null]);
});

test('each counted decision names its single closest section, never Key decisions or the lead', async () => {
  const w = await world({ sectionMatch: 0.88 });
  const stack = vectorOf(w, w.main.id, 'stack-and-where-it-lives');
  w.decision('2026-10-28T10:00:00.000Z', 'near the stack', 'wildlog', { embedding: stack });
  w.decision('2026-10-29T10:00:00.000Z', 'near Key decisions', 'wildlog', { embedding: vectorOf(w, w.main.id, 'key-decisions') });
  w.decision('2026-10-30T10:00:00.000Z', 'near the lead', 'wildlog', { embedding: vectorOf(w, w.main.id, 'top') });
  w.decision('2026-10-31T10:00:00.000Z', 'unrelated', 'wildlog');
  const f = w.pages.freshness.forPage(w.main, { hints: true })!;
  assert.deepEqual(f.decisions.map((d) => [d.text, d.nearSection]), [
    ['near the stack', 'stack-and-where-it-lives'], ['near Key decisions', null], ['near the lead', null], ['unrelated', null],
  ]);
});

test('lists skip section hints on the main page', async () => {
  const w = await world({ sectionMatch: 0.88 });
  const stack = vectorOf(w, w.main.id, 'stack-and-where-it-lives');
  for (const i of [1, 2, 3]) w.decision(`2026-11-0${i}T12:00:00.000Z`, `close ${i}`, 'wildlog', { embedding: stack });
  assert.ok(w.pages.freshness.forPages([w.main]).get(w.main.id)!.decisions.every((d) => d.nearSection === null));
});

test('flaggedIds names only flagged pages', async () => {
  const w = await world();
  three(w);
  assert.deepEqual([...w.pages.flaggedIds([w.main, w.runbook])], [w.main.id]);
  assert.deepEqual([...w.pages.flaggedIds([])], []);
});
