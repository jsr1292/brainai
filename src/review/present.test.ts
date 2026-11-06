import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewWorld, type ReviewWorld } from '../testing/reviewWorld.js';
import { buildReview, windowFor } from './build.js';
import { presentReview, type PresentContext, type ReviewKind, type Scope } from './present.js';
import type { ProjectWeek, ReviewBody } from './types.js';

const W26 = '2026-10-26';
const NOW = '2026-11-03T07:14:00Z';
const owner: Scope = { kind: 'owner' };
const ctx = (w: ReviewWorld): PresentContext => ({
  registry: w.registry, service: w.service, memories: w.store, pages: w.pages, growth: w.growth, reviews: w.reviews, now: w.now(),
});
const show = (w: ReviewWorld, scope: Scope = owner, kind: ReviewKind = 'last', body?: ReviewBody) =>
  presentReview({ monday: W26, body: body ?? buildReview(w.sources(), windowFor(W26)), builtAt: '2026-11-02T07:14:00.000Z' }, kind, scope, ctx(w));
const roadmap = (w: ReviewWorld, project: string, at: string, content: string) => w.save(at, { kind: 'roadmap', content, project });
const strength = (w: ReviewWorld, id: string, at: string) => {
  w.db.prepare(`INSERT INTO observations(id, kind, area, project, summary, embedding, created_at, created_by, last_evidence_at)
    VALUES (?, 'strength', 'reviewing', 'cairn', 'Caught the double count', x'00', ?, 'Claude', ?)`).run(id, at, at);
  w.db.prepare("INSERT INTO observation_evidence(observation_id, what, added_by, added_at) VALUES (?, 'w', 'Claude', ?)").run(id, at);
};

/** The mockup's week in small: wildlog, cairn, homeassistant, energy going quiet, a Personal finances. */
function fullWeek(): ReviewWorld {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  w.save('2026-10-15T10:00:00Z', { content: 'energy compares tariffs', project: 'energy' });
  const wine = roadmap(w, 'wildlog', '2026-10-20T10:00:00Z', 'Done: setup (2026-10-20)\nNow: Release 0.2.2 (4/8)\nNext: release\nWaiting on you: Run release (by 2026-10-25); undated thing');
  w.edit('2026-10-28T10:00:00Z', wine.id, 'Done: TestFlight build (2026-10-28)\nNow: Release 0.2.2 (5/8)\nNext: release\nWaiting on you: Run release (by 2026-10-25); undated thing');
  w.edit('2026-10-31T10:00:00Z', wine.id, 'Done: TestFlight build (2026-10-28); Label scan (2026-10-30); Cellar map sorting (2026-10-31)\nNow: Release 0.2.2 (7/8)\nNext: release\nWaiting on you: Run release (by 2026-10-25); undated thing');
  const mcp = roadmap(w, 'cairn', '2026-10-20T10:00:00Z', 'Now: round 1');
  w.edit('2026-10-31T11:00:00Z', mcp.id, 'Done: a (2026-10-27); b (2026-10-28); c (2026-10-29); d (2026-10-30); e (2026-10-31)\nNow: round 1');
  const ha = roadmap(w, 'homeassistant', '2026-10-20T10:00:00Z', 'Now: heating');
  w.edit('2026-10-29T10:00:00Z', ha.id, 'Done: zigbee (2026-10-27); heating (2026-11-01)\nNow: heating');
  const fin = roadmap(w, 'finances', '2026-10-20T10:00:00Z', 'Now: taxes');
  w.edit('2026-10-28T12:00:00Z', fin.id, 'Done: pay taxes (2026-10-28)\nNow: taxes');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.save('2026-10-28T13:00:00Z', { content: 'Label photos stay on the phone', project: 'wildlog' });
  w.save('2026-10-29T13:00:00Z', { content: 'Budget in a spreadsheet', project: 'finances' });
  w.save('2026-10-30T13:00:00Z', { content: 'Dark mode is Graphite', project: 'cairn' });
  strength(w, 'o1', '2026-10-29T10:00:00.000Z');
  w.grants.push({ clientName: 'Grok Build', createdAt: '2026-10-29T09:00:00.000Z' });
  w.at(NOW);
  return w;
}

test('life areas are never in Went quiet, Back after a while or the sentence, and their steps show after the others', () => {
  const w = reviewWorld('2026-09-01T10:00:00Z');
  const fin = roadmap(w, 'finances', '2026-09-01T10:00:00Z', 'Now: taxes');
  w.edit('2026-10-28T10:00:00Z', fin.id, 'Done: pay (2026-10-28)\nNow: taxes');
  roadmap(w, 'health', '2026-10-16T10:00:00Z', 'Done: a (2026-10-28); b (2026-10-29); c (2026-10-30); d (2026-10-31)\nNow: cleanups');
  const wine = roadmap(w, 'wildlog', '2026-10-20T10:00:00Z', 'Now: release');
  w.edit('2026-10-31T10:00:00Z', wine.id, 'Done: x (2026-10-28); y (2026-10-29); z (2026-10-30)\nNow: release');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.registry.setInfo('health', { area: 'personal' }, 'owner');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  assert.ok(body.projects.find((p) => p.project === 'health')!.quiet, 'the stored body keeps it (full scope)');
  assert.ok(body.projects.find((p) => p.project === 'finances')!.back);
  const view = show(w, owner, 'last', body);
  const names = (c: { shown: { project: string }[]; folded: { project: string }[] }) => [...c.shown, ...c.folded].map((x) => x.project);
  assert.deepEqual([names(view.quiet), names(view.back)], [[], []]);
  assert.doesNotMatch(view.sentence, /finances|health/);
  assert.doesNotMatch(view.lineSentence, /finances|health/);
  assert.equal(view.sentence, 'A good week for wildlog: 8 steps done across 3 projects.');
  assert.equal(view.moved[0]!.project, 'wildlog');
  assert.deepEqual(view.moved.slice(-2).map((m) => m.project).sort(), ['finances', 'health']);
  assert.ok(view.moved.slice(-2).every((m) => m.lifeArea));

  w.registry.pin('health', 'owner');
  const pinned = show(w, owner, 'last', body);
  assert.deepEqual(names(pinned.quiet), ['health']);
  assert.match(pinned.sentence, /health/);
});

test('a read-only grant on wildlog sees nothing of other projects, counts included', () => {
  const w = fullWeek();
  const view = show(w, { kind: 'read', projects: ['wildlog'] });
  assert.doesNotMatch(JSON.stringify(view), /cairn|homeassistant|energy|finances|Grok/);
  assert.equal(view.sentence, '3 steps done, all in wildlog. 1 thing is late.');
  assert.equal(view.growth, null);
  assert.equal(view.digest, null);
  assert.deepEqual([view.safety.shown, view.safety.folded], [[], []]);
  assert.deepEqual(view.decided.shown.map((d) => d.project), ['wildlog']);
});

test('Full sees Personal and growth but no assistant table and no safety notes', () => {
  const w = fullWeek();
  const view = show(w, { kind: 'full' });
  assert.ok(view.moved.some((m) => m.project === 'finances'));
  assert.equal(view.growth!.strength!.id, 'o1');
  assert.equal(view.digest, null);
  assert.equal(view.safety.shown.length, 0);
  const mine = show(w, owner);
  assert.ok(mine.digest!.writers.length > 0);
  assert.deepEqual(mine.safety.shown.map((s) => s.kind), ['connected']);
  assert.equal(mine.sentence, 'A good week for cairn and wildlog: 11 steps done across 4 projects. 1 thing is late, and energy went quiet.');
  const wine = mine.moved.find((m) => m.project === 'wildlog')!;
  assert.deepEqual(wine.progress, { now: 'Release 0.2.2', from: 4, to: 7, total: 8 });
  assert.deepEqual(mine.moved.map((m) => m.project), ['cairn', 'wildlog', 'homeassistant', 'finances']);
  assert.deepEqual(mine.decided.shown.map((d) => d.project), ['cairn', 'wildlog', 'finances'], 'newest first, life areas after');
});

test('waiting items match the live roadmap by itemKey', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const r = roadmap(w, 'wildlog', '2026-10-20T10:00:00Z', 'Now: x\nWaiting on you: Ticked (by 2026-10-25); Rewritten (by 2026-10-26); Moved (by 2026-10-27); Steady (by 2026-11-04)');
  const other = roadmap(w, 'pavlova', '2026-10-20T10:00:00Z', 'Now: y\nWaiting on you: Finish (by 2026-10-25)');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  w.edit('2026-11-03T08:00:00Z', r.id, 'Done: ticked (by 2026-10-25) (2026-11-03)\nNow: x\nWaiting on you: Steady (by 2026-11-04); Rewritten as new (by 2026-10-26); Moved (by 2026-11-20)');
  w.registry.setState('pavlova', 'done', 'owner');
  void other;
  const view = show(w, owner, 'last', body);
  const state = (text: string) => [...view.waiting.late.shown, ...view.waiting.after.shown].find((x) => x.text === text)!.wait;
  assert.deepEqual(state('Ticked'), { live: false, state: 'done' });
  assert.deepEqual(state('Rewritten'), { live: false, state: 'gone' });
  assert.deepEqual(state('Moved'), { live: true, index: 2, text: 'Moved' });
  assert.deepEqual(state('Steady'), { live: true, index: 0, text: 'Steady' });
  assert.deepEqual(state('Finish'), { live: false, state: 'finished' });
});

test('a project merged since shows under its current name and ticks go to it', () => {
  const w = reviewWorld('2026-10-12T10:00:00Z');
  w.save('2026-10-12T10:00:00Z', { content: 'inflow fact', project: 'inflow' });
  roadmap(w, 'coyote', '2026-10-20T10:00:00Z', 'Now: bottle\nWaiting on you: Order corks (by 2026-10-30)');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  w.service.moveProject('coyote', 'inflow', { type: 'owner' });
  w.service.addAlias('coyote', 'inflow', { type: 'owner' });
  const view = show(w, owner, 'last', body);
  const row = view.waiting.late.shown[0]!;
  assert.equal(row.project, 'inflow');
  assert.deepEqual(row.wait, { live: true, index: 0, text: 'Order corks' });
  assert.doesNotMatch(JSON.stringify(view), /coyote/);
});

test('two stored rows that now resolve to one project show as one', () => {
  const w = reviewWorld('2026-10-12T10:00:00Z');
  w.save('2026-10-12T10:00:00Z', { content: 'coyote fact', project: 'coyote' });
  w.save('2026-10-12T10:00:00Z', { content: 'inflow fact', project: 'inflow' });
  w.at(NOW);
  const empty: Omit<ProjectWeek, 'project'> = { done: [], progress: null, pages: [], chips: [], waiting: [], dated: 0, undated: 0, quiet: null, back: null, notPushed: null };
  const body: ReviewBody = {
    format: 1, monday: W26, decisions: [], growth: null, safety: [], quietFromFactsOnly: false,
    digest: { totals: { saved: 0, changed: 0, deleted: 0 }, writers: [], lookupsSince: null },
    projects: [
      { ...empty, project: 'coyote', done: [{ text: 'pour', date: '2026-10-28' }], progress: { now: 'Bottling', from: null, to: 2, total: 5 }, chips: ['parked'] },
      { ...empty, project: 'inflow', done: [{ text: 'Pour', date: '2026-10-28' }, { text: 'label', date: '2026-10-30' }], progress: { now: 'Bottling', from: null, to: 4, total: 5 }, chips: ['new-project'] },
    ],
  };
  w.reviews.insert({ monday: W26, body, builtAt: 'x', builtBy: 'owner' });
  w.service.moveProject('coyote', 'inflow', { type: 'owner' });
  w.service.addAlias('coyote', 'inflow', { type: 'owner' });
  const view = show(w, owner, 'last', w.reviews.get(W26)!.body);
  assert.equal(view.moved.length, 1);
  const card = view.moved[0]!;
  assert.equal(card.project, 'inflow');
  assert.deepEqual(card.done.map((d) => d.text.toLowerCase()), ['pour', 'label']);
  assert.equal(card.progress!.to, 4);
  assert.deepEqual(card.chips, ['new-project', 'parked']);
  assert.equal(view.sentence, '2 steps done, all in inflow.');
});

test('a deleted decision, a deleted page and a disagreed observation drop out of an old week', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  w.save('2026-10-20T10:00:00Z', { content: 'wildlog exists', project: 'wildlog' });
  const d = w.save('2026-10-28T10:00:00Z', { content: 'A decision', project: 'wildlog' });
  w.db.prepare(`INSERT INTO pages(id, title, title_key, project, body, version, created_at, created_by, updated_at, updated_by)
    VALUES ('11111111-1111-1111-1111-111111111111', 'T', 't', 'wildlog', 'b', 1, 'x', 'c', 'x', 'c')`).run();
  w.db.prepare("INSERT INTO page_versions(page_id, version, title, project, body, saved_at, saved_by) VALUES ('11111111-1111-1111-1111-111111111111', 1, 'T', 'wildlog', 'b', '2026-10-28T10:00:00.000Z', 'c')").run();
  strength(w, 'o1', '2026-10-29T10:00:00.000Z');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  const before = show(w, owner, 'last', body);
  assert.equal(before.decided.shown.length, 1);
  assert.equal(before.moved[0]!.pagesUpdated, 1);
  assert.ok(before.growth!.strength);
  w.store.softDelete(d.id, 'owner');
  w.db.prepare("UPDATE pages SET deleted_at = 'x'").run();
  w.growth.react('o1', 'disagree');
  const after = show(w, owner, 'last', body);
  assert.equal(after.decided.shown.length, 0);
  assert.equal(after.moved.length, 0);
  assert.equal(after.growth, null);
  assert.equal(after.empty, true);
});

test('caps: every list folds the rest and the numbers count everything', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const ids = Array.from({ length: 5 }, (_, i) => w.save(`2026-10-2${7 + (i % 3)}T10:0${i}:00Z`, { content: `decision ${i}`, project: 'p1' }).id);
  // Quiet and back projects still hold a fact, or the presenter drops them as emptied.
  for (const name of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'b1', 'b2', 'b3', 'b4']) w.save('2026-10-20T10:00:00Z', { content: 'fact', project: name });
  w.at(NOW);
  const empty: Omit<ProjectWeek, 'project'> = { done: [], progress: null, pages: [], chips: [], waiting: [], dated: 0, undated: 0, quiet: null, back: null, notPushed: null };
  const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `s${i}`, date: '2026-10-28' }));
  const projects: ProjectWeek[] = [];
  const fresh = (project: string): ProjectWeek => ({ ...empty, project, waiting: [] });
  for (let i = 1; i <= 7; i++) projects.push({ ...fresh(`p${i}`), done: steps(i === 1 ? 5 : 1) });
  for (let i = 1; i <= 7; i++) projects[i - 1]!.waiting.push({ text: `late ${i}`, due: '2026-10-25', when: 'late' });
  for (let i = 1; i <= 6; i++) projects[i - 1]!.waiting.push({ text: `after ${i}`, due: '2026-11-04', when: 'after' });
  for (let i = 1; i <= 8; i++) projects.push({ ...fresh(`q${i}`), quiet: { lastTouched: '2026-10-15T10:00:00.000Z', next: null } });
  for (let i = 1; i <= 4; i++) projects.push({ ...fresh(`b${i}`), back: { quietDays: 20 + i } });
  for (const p of projects) p.dated = p.waiting.length;
  const body: ReviewBody = {
    format: 1, monday: W26, projects, decisions: ids.reverse(), growth: null, quietFromFactsOnly: false,
    digest: { totals: { saved: 0, changed: 0, deleted: 0 }, writers: [], lookupsSince: null },
    safety: [1, 2, 3, 4].map((i) => ({ kind: 'connected' as const, client: `C${i}`, at: '2026-10-29T10:00:00.000Z' })),
  };
  const v = show(w, owner, 'last', body);
  assert.deepEqual([v.moved.length, v.movedMore.length], [5, 2]);
  assert.deepEqual([v.moved[0]!.done.length, v.moved[0]!.moreSteps], [3, 2]);
  assert.deepEqual([v.decided.shown.length, v.decided.folded.length], [3, 2]);
  assert.deepEqual([v.waiting.late.shown.length, v.waiting.late.folded.length], [5, 2]);
  assert.deepEqual([v.waiting.after.shown.length, v.waiting.after.folded.length], [5, 1]);
  assert.deepEqual([v.quiet.shown.length, v.quiet.folded.length], [5, 3]);
  assert.deepEqual([v.back.shown.length, v.back.folded.length], [3, 1]);
  assert.deepEqual([v.safety.shown.length, v.safety.folded.length], [3, 1]);
  assert.equal(v.sentence, 'A good week for p1: 11 steps done across 7 projects. 7 things are late, and 8 projects went quiet.');
});

test('a week with nothing in it is empty, and a week whose only content is a life area\'s step is not', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  w.at(NOW);
  const none = show(w);
  assert.equal(none.empty, true);
  assert.equal(none.sentence, 'A quiet week. Nothing moved.');
  const fin = roadmap(w, 'finances', '2026-10-20T10:00:00Z', 'Now: taxes');
  w.edit('2026-10-28T10:00:00Z', fin.id, 'Done: pay (2026-10-28)\nNow: taxes');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.at(NOW);
  const one = show(w);
  assert.equal(one.empty, false);
  assert.equal(one.sentence, '1 step done.');
  assert.equal(one.lineSentence, '1 step done.');
});

test('a read-only grant names projects exactly: one merged away since reads nothing, as everywhere else', () => {
  const w = reviewWorld('2026-10-12T10:00:00Z');
  w.save('2026-10-12T10:00:00Z', { content: 'inflow fact', project: 'inflow' });
  const r = roadmap(w, 'coyote', '2026-10-20T10:00:00Z', 'Now: bottle');
  w.edit('2026-10-28T10:00:00Z', r.id, 'Done: pour (2026-10-28)\nNow: bottle');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  w.service.moveProject('coyote', 'inflow', { type: 'owner' });
  const view = show(w, { kind: 'read', projects: ['coyote'] }, 'last', body);
  assert.deepEqual(view.moved, []);
  assert.equal(view.empty, true);
});

test('chips read in their fixed order, and items that can still be ticked come before the ones that changed since', () => {
  const w = reviewWorld('2026-10-01T10:00:00Z');
  w.save('2026-10-01T10:00:00Z', { content: 'aaa', project: 'aaa' });
  roadmap(w, 'minipc', '2026-10-20T10:00:00Z', 'Now: x\nWaiting on you: Check the export (by 2026-11-04)');
  const energy = roadmap(w, 'energy', '2026-10-20T10:00:00Z', 'Now: y\nWaiting on you: Send the photo (by 2026-11-03)');
  w.at('2026-10-28T10:00:00Z');
  w.registry.setState('aaa', 'parked', 'owner');
  w.registry.create('zzz', { state: 'idea' }, 'owner');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  w.edit('2026-11-03T08:00:00Z', energy.id, 'Now: y');
  const view = show(w, owner, 'last', body);
  assert.deepEqual(view.chips.map((c) => c.chip), ['new-idea', 'parked']);
  assert.deepEqual(view.waiting.after.shown.map((x) => x.text), ['Check the export', 'Send the photo']);
});

test('a project emptied since (facts moved away or deleted) is never in Went quiet, Back after a while or the sentence', () => {
  const quietNames = (v: ReturnType<typeof show>) => [...v.quiet.shown, ...v.quiet.folded].map((q) => q.project);
  const backNames = (v: ReturnType<typeof show>) => [...v.back.shown, ...v.back.folded].map((q) => q.project);
  const w = reviewWorld('2026-10-10T10:00:00Z');
  // A typo moved to the real project two days later: its history keeps the old name.
  const typo = w.save('2026-10-10T10:00:00Z', { content: 'fact under a typo', project: 'mcpmemroy' });
  w.at('2026-10-12T10:00:00Z');
  w.store.update(typo.id, { content: typo.content, project: 'real', tags: [], embedding: new Float32Array(4), by: 'owner' });
  // A junk project whose only fact was deleted.
  const junk = w.save('2026-10-12T10:00:00Z', { content: 'junk', project: 'junkproj' });
  w.at('2026-10-13T10:00:00Z');
  w.store.softDelete(junk.id, 'owner');
  // A name with no registry row at all, as rows emptied before migration 13 are on the real copy.
  const ghost = w.save('2026-10-13T10:00:00Z', { content: 'ghost', project: 'ghostproj' });
  w.store.softDelete(ghost.id, 'owner');
  w.db.prepare("DELETE FROM projects WHERE name = 'ghostproj'").run();
  // Back after a while for a project emptied after the week it came back in.
  w.save('2026-09-15T10:00:00Z', { content: 'old', project: 'backproj' });
  const again = w.save('2026-10-28T10:00:00Z', { content: 'again', project: 'backproj' });
  w.save('2026-10-12T10:00:00Z', { content: 'a fact in real, moved on 12 Oct too', project: 'real' });
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  for (const name of ['mcpmemroy', 'junkproj', 'ghostproj']) assert.ok(body.projects.find((p) => p.project === name)?.quiet, `${name} is quiet in the stored body`);
  assert.ok(body.projects.find((p) => p.project === 'backproj')?.back);
  w.store.softDelete(again.id, 'owner');
  w.store.list({ project: 'backproj' }).forEach((m) => w.store.softDelete(m.id, 'owner'));

  const view = show(w, owner, 'last', body);
  assert.deepEqual(quietNames(view), ['real']);
  assert.deepEqual(backNames(view), []);
  assert.doesNotMatch(view.sentence, /mcpmemroy|junkproj|ghostproj/);
  assert.doesNotMatch(view.lineSentence, /mcpmemroy|junkproj|ghostproj/);

  // A row the owner set something on still shows, as it does on the home.
  w.registry.setInfo('junkproj', { oneLiner: 'kept on purpose' }, 'owner');
  assert.deepEqual(quietNames(show(w, owner, 'last', body)), ['real', 'junkproj']);
});

test('a week whose only news is a typo project moved away is empty, so there is no Monday line', () => {
  const w = reviewWorld('2026-10-10T10:00:00Z');
  const typo = w.save('2026-10-10T10:00:00Z', { content: 'fact under a typo', project: 'mcpmemroy' });
  w.at('2026-10-12T10:00:00Z');
  w.store.update(typo.id, { content: typo.content, project: 'real', tags: [], embedding: new Float32Array(4), by: 'owner' });
  // real itself was touched recently, so it is neither quiet nor back.
  w.at('2026-10-20T10:00:00Z');
  w.store.update(typo.id, { content: 'touched last week', project: 'real', tags: [], embedding: new Float32Array(4), by: 'owner' });
  w.at(NOW);
  const view = show(w);
  assert.equal(view.empty, true);
  assert.equal(view.sentence, 'A quiet week. Nothing moved.');
});

test('a decision replaced since stays listed with the day and the current fact', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const d = w.save('2026-10-28T10:00:00Z', { content: 'Labels use Futura', project: 'wildlog' });
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  assert.equal(show(w, owner, 'last', body).decided.shown[0]!.replaced, null);
  const b = w.save('2026-11-04T10:00:00Z', { content: 'Labels use Avenir', project: 'wildlog' });
  const c = w.save('2026-11-05T09:00:00Z', { content: 'Labels use Gill Sans', project: 'wildlog' });
  w.at('2026-11-05T10:00:00Z');
  const row = w.store.supersessions.add(d.id, b.id, 'owner');
  const bc = w.store.supersessions.add(b.id, c.id, 'owner');
  assert.deepEqual(show(w, owner, 'last', body).decided.shown[0]!.replaced, { on: row.createdAt, currentId: c.id });
  w.store.softDelete(c.id, 'owner');
  assert.deepEqual(show(w, owner, 'last', body).decided.shown[0]!.replaced, { on: row.createdAt, currentId: null });
  w.store.supersessions.undo(bc.id, 'owner');
  w.store.supersessions.undo(row.id, 'owner');
  assert.equal(show(w, owner, 'last', body).decided.shown[0]!.replaced, null);
});

test('a read-only scope gets no currentId for a project it can\'t read', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const d = w.save('2026-10-28T10:00:00Z', { content: 'Labels use Futura', project: 'wildlog' });
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  const b = w.save('2026-11-04T10:00:00Z', { content: 'Labels use Avenir', project: 'wildlog' });
  w.store.supersessions.add(d.id, b.id, 'owner');
  w.db.prepare("UPDATE memories SET project = 'minipc' WHERE id = ?").run(b.id);
  const r = show(w, { kind: 'read', projects: ['wildlog'] }, 'last', body).decided.shown[0]!.replaced!;
  assert.equal(r.currentId, null);
  assert.equal(show(w, owner, 'last', body).decided.shown[0]!.replaced!.currentId, b.id);
});

test('the owner\'s safety notes quote the replaced fact', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const old = w.save('2026-10-20T10:00:00Z', { content: 'wildlog uses Core Data', project: 'wildlog', by: 'owner' });
  const now = w.save('2026-10-27T10:00:00Z', { content: 'wildlog uses SwiftData', project: 'wildlog', by: 'Claude Code' });
  w.at('2026-10-28T10:00:00Z');
  w.store.supersessions.add(old.id, now.id, 'Claude Code');
  w.at(NOW);
  const s = show(w).safety.shown.find((f) => f.kind === 'replaced-others')!;
  assert.equal(s.excerpt, 'wildlog uses Core Data');
  assert.deepEqual(show(w, { kind: 'full' }).safety.shown, []);
});

test('a project whose only live fact is replaced is not emptied: it stays in Went quiet', () => {
  const w = reviewWorld('2026-10-13T10:00:00Z');
  const a = w.save('2026-10-13T10:00:00Z', { content: 'zetaproj keeps the old way', project: 'zetaproj' });
  const b = w.save('2026-10-14T10:00:00Z', { content: 'zetaproj keeps the new way', project: 'zetaproj' });
  w.store.supersessions.add(a.id, b.id, 'owner');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  assert.ok(body.projects.find((p) => p.project === 'zetaproj')?.quiet);
  w.store.softDelete(b.id, 'owner');
  w.db.prepare("DELETE FROM projects WHERE name = 'zetaproj'").run();
  const view = show(w, owner, 'last', body);
  assert.deepEqual([...view.quiet.shown, ...view.quiet.folded].map((q) => q.project), ['zetaproj']);
});

test('a safety note about a replacement undone since the review was built is dropped', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const old = w.save('2026-10-20T10:00:00Z', { content: 'wildlog uses Core Data', project: 'wildlog', by: 'owner' });
  const now = w.save('2026-10-27T10:00:00Z', { content: 'wildlog uses SwiftData', project: 'wildlog', by: 'Claude Code' });
  w.at('2026-10-28T10:00:00Z');
  const row = w.store.supersessions.add(old.id, now.id, 'Claude Code');
  w.at(NOW);
  const body = buildReview(w.sources(), windowFor(W26));
  assert.ok(show(w, owner, 'last', body).safety.shown.some((f) => f.kind === 'replaced-others'));
  w.store.supersessions.undo(row.id, 'owner');
  assert.ok(!show(w, owner, 'last', body).safety.shown.some((f) => f.kind === 'replaced-others'));
});
