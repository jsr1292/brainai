import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewWorld, type ReviewWorld } from '../testing/reviewWorld.js';
import { buildReview, liveWindow, windowFor } from './build.js';

// These tests are about the owner's calendar in Berlin; the app's own default zone is UTC.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

const START = 'Done: design (2026-10-09)\nNow: Brain round 1 (4/8)\nNext: pages\nWaiting on you: late one (by 2026-11-01); next week one (by 2026-11-08); later one (by 2026-11-09); undated one';
const WAIT = 'Waiting on you: late one (by 2026-11-01); next week one (by 2026-11-08); later one (by 2026-11-09); undated one';

/** brainai's roadmap through the week of 26 Oct, built on 3 Nov. */
function mcpWeek(): ReviewWorld {
  const w = reviewWorld('2026-10-10T10:00:00Z');
  const r = w.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: START, project: 'brainai' });
  w.edit('2026-10-27T10:00:00Z', r.id, `Done: design (2026-10-09); Pages: reading view and editor (2026-10-27)\nNow: Brain round 1 (5/8)\nNext: pages\n${WAIT}`);
  w.edit('2026-10-30T10:00:00Z', r.id, `Done: design (2026-10-09); Page tools (2026-10-30)\nNow: Brain round 1 (5/8)\nNext: pages\n${WAIT}`);
  w.edit('2026-10-31T10:00:00Z', r.id, `Done: design (2026-10-09); Page tools (2026-10-30)\nNow: Brain round 1 (7/8)\nNext: pages\n${WAIT}`);
  w.edit('2026-11-02T10:00:00Z', r.id, `Done: design (2026-10-09); Page tools (2026-10-30); Too late (2026-11-02)\nNow: Brain round 1 (7/8)\nNext: pages\n${WAIT}`);
  w.at('2026-11-03T07:14:00Z');
  return w;
}

test('moved keeps steps dated inside the week from every version, also one trimmed later in the week', () => {
  const w = mcpWeek();
  const p = buildReview(w.sources(), windowFor('2026-10-26')).projects.find((x) => x.project === 'brainai')!;
  assert.deepEqual(p.done, [{ text: 'Pages: reading view and editor', date: '2026-10-27' }, { text: 'Page tools', date: '2026-10-30' }]);
});

test('progress shows from and to only when the Now step and total match at both ends', () => {
  const w = mcpWeek();
  const p = buildReview(w.sources(), windowFor('2026-10-26')).projects.find((x) => x.project === 'brainai')!;
  assert.deepEqual(p.progress, { now: 'Brain round 1', from: 4, to: 7, total: 8 });

  const v = reviewWorld('2026-10-10T10:00:00Z');
  const a = v.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: 'Done: x (2026-10-27)\nNow: Brain round 1 (4/5)', project: 'a' });
  v.edit('2026-10-28T10:00:00Z', a.id, 'Done: x (2026-10-27)\nNow: Brain round 2 (2/5)');
  const b = v.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: 'Done: y (2026-10-27)\nNow: Brain round 1 (4/5)', project: 'b' });
  v.edit('2026-10-28T10:00:00Z', b.id, 'Done: y (2026-10-27)\nNow: Brain round 1');
  const c = v.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: 'Done: z (2026-10-27)\nNow: Brain round 1', project: 'c' });
  v.edit('2026-10-28T10:00:00Z', c.id, 'Done: z (2026-10-27)\nNow: Brain round 1 (3/5)');
  v.at('2026-11-03T07:14:00Z');
  const body = buildReview(v.sources(), windowFor('2026-10-26'));
  const of = (name: string) => body.projects.find((x) => x.project === name)!.progress;
  assert.deepEqual(of('a'), { now: 'Brain round 2', from: null, to: 2, total: 5 });
  assert.equal(of('b'), null);
  assert.deepEqual(of('c'), { now: 'Brain round 1', from: null, to: 3, total: 5 });
});

test('late is due on or before Sunday, after is the next Monday to Sunday, the rest are counted', () => {
  const w = mcpWeek();
  const p = buildReview(w.sources(), windowFor('2026-10-26')).projects.find((x) => x.project === 'brainai')!;
  assert.deepEqual(p.waiting, [{ text: 'late one', due: '2026-11-01', when: 'late' }, { text: 'next week one', due: '2026-11-08', when: 'after' }]);
  assert.equal(p.dated, 3);
  assert.equal(p.undated, 1);
});

test('a project marked done keeps its steps but has no waiting items', () => {
  const w = mcpWeek();
  w.registry.setState('brainai', 'done', 'owner');
  const p = buildReview(w.sources(), windowFor('2026-10-26')).projects.find((x) => x.project === 'brainai')!;
  assert.equal(p.done.length, 2);
  assert.deepEqual(p.waiting, []);
  assert.deepEqual([p.dated, p.undated], [0, 0]);
});

test('a roadmap deleted and replaced by a new one mid-week gives steps from both', () => {
  const w = reviewWorld('2026-10-10T10:00:00Z');
  const old = w.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: 'Done: first (2026-10-27)\nNow: a', project: 'wildlog' });
  w.at('2026-10-28T10:00:00Z');
  w.store.softDelete(old.id, 'owner');
  w.save('2026-10-28T11:00:00Z', { kind: 'roadmap', content: 'Done: second (2026-10-29)\nNow: b', project: 'wildlog' });
  w.at('2026-11-03T07:14:00Z');
  const p = buildReview(w.sources(), windowFor('2026-10-26')).projects.find((x) => x.project === 'wildlog')!;
  assert.deepEqual(p.done.map((d) => d.text), ['first', 'second']);
});

test('so far keeps steps up to today and waiting late now or due in the next 7 days', () => {
  const w = reviewWorld('2026-10-10T10:00:00Z');
  w.save('2026-10-10T10:00:00Z', {
    kind: 'roadmap', project: 'wildlog',
    content: 'Done: old (2026-11-01); monday (2026-11-02); tuesday (2026-11-03)\nNow: x\nWaiting on you: late (by 2026-11-02); today (by 2026-11-03); soon (by 2026-11-10); far (by 2026-11-11)',
  });
  w.at('2026-11-03T07:14:00Z');
  const win = liveWindow(new Date('2026-11-03T07:14:00Z'));
  assert.deepEqual([win.monday, win.today, win.dueUntil, win.live, win.end.toISOString()], ['2026-11-02', '2026-11-03', '2026-11-10', true, '2026-11-03T07:14:00.000Z']);
  const p = buildReview(w.sources(), win).projects.find((x) => x.project === 'wildlog')!;
  assert.deepEqual(p.done.map((d) => d.text), ['monday', 'tuesday']);
  assert.deepEqual(p.waiting.map((x) => [x.text, x.when]), [['late', 'late'], ['today', 'after'], ['soon', 'after']]);
});

test('the summer-time week ends at Monday 00:00 local', () => {
  assert.equal(windowFor('2026-10-19').end.toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(windowFor('2026-10-19').start.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.deepEqual([windowFor('2026-10-26').today, windowFor('2026-10-26').dueUntil], ['2026-11-02', '2026-11-08']);
  const w = reviewWorld('2026-10-10T10:00:00Z');
  w.save('2026-10-10T10:00:00Z', { kind: 'roadmap', content: 'Done: sunday (2026-10-25); monday (2026-10-26)\nNow: x', project: 'wildlog' });
  w.at('2026-11-03T07:14:00Z');
  const p = buildReview(w.sources(), windowFor('2026-10-19')).projects.find((x) => x.project === 'wildlog')!;
  assert.deepEqual(p.done.map((d) => d.text), ['sunday']);
});

// ---- Task 4: quiet, back, chips, pages, decisions, growth, the Mac and the digest ----

const W26 = '2026-10-26';
const quietOf = (w: ReviewWorld, name: string, monday = W26) => buildReview(w.sources(), windowFor(monday)).projects.find((p) => p.project === name);
const migrationRow = (w: ReviewWorld, name: string, state: string, at: string, by = 'migration') =>
  w.db.prepare(`INSERT INTO projects(name, state, state_changed_at, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(name, state, at, at, by, at, by);
const folder = (name: string, o: { unpushed?: number; uncommitted?: number; lastCommit: string }) => ({ name, git: true, branch: 'main', uncommitted: o.uncommitted ?? 0, unpushed: o.unpushed ?? 0, lastCommit: o.lastCommit, remotes: [] });

test('went quiet: touched 10 days before the start and not since', () => {
  const w = reviewWorld('2026-10-15T23:00:00Z');
  w.save('2026-10-15T23:00:00Z', { kind: 'roadmap', content: 'Now: tariffs\nNext: compare winter tariffs; call', project: 'energy' });
  w.at('2026-11-03T07:14:00Z');
  assert.deepEqual(quietOf(w, 'energy')!.quiet, { lastTouched: '2026-10-15T23:00:00.000Z', next: 'compare winter tariffs' });
});

test('a project already quiet before the week, an idea, and one marked done before the end are not listed', () => {
  const w = reviewWorld('2026-10-01T10:00:00Z');
  w.save('2026-10-01T10:00:00Z', { content: 'old', project: 'longquiet' });
  w.at('2026-10-15T10:00:00Z');
  w.registry.create('someidea', { state: 'idea' }, 'owner');
  w.save('2026-10-15T10:00:00Z', { content: 'idea fact', project: 'someidea' });
  w.save('2026-10-15T10:00:00Z', { content: 'fact', project: 'finished' });
  w.at('2026-10-28T10:00:00Z');
  w.registry.setState('finished', 'done', 'owner');
  w.save('2026-10-15T10:00:00Z', { content: 'control', project: 'control' });
  w.at('2026-11-03T07:14:00Z');
  const body = buildReview(w.sources(), windowFor(W26));
  const quiet = body.projects.filter((p) => p.quiet).map((p) => p.project);
  assert.deepEqual(quiet, ['control']);
});

test('a change made after the week doesn\'t undo its quiet when the week is built later', () => {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  w.save('2026-10-15T10:00:00Z', { content: 'fact', project: 'energy' });
  w.save('2026-11-05T10:00:00Z', { content: 'later', project: 'energy' });
  w.at('2026-11-10T10:00:00Z');
  assert.equal(quietOf(w, 'energy')!.quiet!.lastTouched, '2026-10-15T10:00:00.000Z');
});

test('the Mac\'s commit counts only from a report that came inside the week or within 24 hours', () => {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  w.save('2026-10-15T10:00:00Z', { content: 'fact', project: 'energy' });
  const { device } = w.devices.create('Mac');
  w.at('2026-11-02T01:00:00Z');
  w.devices.storeReport(device.id, [folder('energy', { unpushed: 3, lastCommit: '2026-10-29T23:00:00Z' })]);
  w.at('2026-11-03T07:14:00Z');
  const p = quietOf(w, 'energy')!;
  assert.equal(p.quiet, null);
  assert.deepEqual(p.notPushed, { count: 3, receivedAt: '2026-11-02T01:00:00.000Z' });
  assert.equal(buildReview(w.sources(), windowFor(W26)).quietFromFactsOnly, false);

  w.at('2026-11-03T05:00:00Z');
  w.devices.storeReport(device.id, [folder('energy', { unpushed: 3, lastCommit: '2026-10-29T23:00:00Z' })]);
  w.at('2026-11-03T07:14:00Z');
  const late = buildReview(w.sources(), windowFor(W26));
  const q = late.projects.find((x) => x.project === 'energy')!;
  assert.equal(q.quiet!.lastTouched, '2026-10-15T10:00:00.000Z');
  assert.equal(q.notPushed, null);
  assert.equal(late.quietFromFactsOnly, true);
});

test('weekly review flags uncommitted work older than a day, as the project chip does', () => {
  const w = reviewWorld('2026-10-15T10:00:00Z');
  w.save('2026-10-15T10:00:00Z', { content: 'fact', project: 'energy' });
  w.save('2026-10-15T10:00:00Z', { content: 'fact', project: 'larder' });
  const { device } = w.devices.create('Mac');
  w.at('2026-11-02T01:00:00Z');
  w.devices.storeReport(device.id, [
    folder('energy', { uncommitted: 3, lastCommit: '2026-10-30T23:00:00Z' }),
    folder('larder', { uncommitted: 2, lastCommit: '2026-11-01T23:00:00Z' }),
  ]);
  w.at('2026-11-03T07:14:00Z');
  const r = buildReview(w.sources(), windowFor(W26));
  assert.deepEqual(r.projects.find((x) => x.project === 'energy')!.notPushed, { count: 0, uncommitted: 3, receivedAt: '2026-11-02T01:00:00.000Z' });
  assert.equal(r.projects.find((x) => x.project === 'larder')?.notPushed ?? null, null, 'committed 2 hours before the report: work in progress');
});

test('back after a while counts the quiet days before the first change this week', () => {
  const w = reviewWorld('2026-09-21T10:00:00Z');
  w.save('2026-09-21T10:00:00Z', { content: 'start', project: 'castle3d' });
  w.save('2026-10-28T10:00:00Z', { content: 'again', project: 'castle3d' });
  w.save('2026-10-29T10:00:00Z', { content: 'and again', project: 'castle3d' });
  w.at('2026-11-03T07:14:00Z');
  const p = quietOf(w, 'castle3d')!;
  assert.deepEqual(p.back, { quietDays: 37 });
  assert.equal(p.quiet, null);
});

test('chips come from the registry\'s latest state, so a change reversed since isn\'t shown', () => {
  const w = reviewWorld('2026-10-01T10:00:00Z');
  w.save('2026-10-01T10:00:00Z', { content: 'x', project: 'reversed' });
  w.save('2026-10-01T10:00:00Z', { content: 'x', project: 'pine-lodge' });
  w.at('2026-10-27T10:00:00Z');
  w.registry.create('karst-ride-timer', { state: 'idea' }, 'owner');
  w.save('2026-10-27T11:00:00Z', { content: 'x', project: 'energy-tariffs' });
  w.at('2026-10-28T10:00:00Z');
  w.registry.setState('reversed', 'parked', 'owner');
  w.at('2026-10-29T10:00:00Z');
  w.registry.setState('reversed', 'open', 'owner');
  w.at('2026-10-30T10:00:00Z');
  w.registry.setState('pine-lodge', 'done', 'owner');
  w.at('2026-11-03T07:14:00Z');
  const body = buildReview(w.sources(), windowFor(W26));
  const chips = Object.fromEntries(body.projects.filter((p) => p.chips.length > 0).map((p) => [p.project, p.chips]));
  assert.deepEqual(chips, { 'energy-tariffs': ['new-project'], 'karst-ride-timer': ['new-idea'], 'pine-lodge': ['marked-done'] });
  assert.deepEqual([body.growth!.finished, body.growth!.started], [1, 2]);
});

test('rows made by migration 13 are never new, started or state changes', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  migrationRow(w, 'old', 'done', '2026-10-27T10:00:00.000Z');
  w.at('2026-11-03T07:14:00Z');
  const b = buildReview(w.sources(), windowFor(W26));
  assert.equal(b.projects.find((p) => p.project === 'old'), undefined);
  assert.deepEqual([b.growth!.finished, b.growth!.started], [0, 0]);
  w.at('2026-10-29T10:00:00Z');
  w.registry.setState('old', 'parked', 'owner');
  w.at('2026-11-03T07:14:00Z');
  const c = buildReview(w.sources(), windowFor(W26));
  assert.deepEqual(c.projects.find((p) => p.project === 'old')!.chips, ['parked']);
  assert.equal(c.growth!.finished, 0);
});

test('a migration row\'s created_at is not a touch, so a dormant project doesn\'t go quiet two weeks after the migration', () => {
  const w = reviewWorld('2026-09-10T10:00:00Z');
  w.save('2026-09-10T10:00:00Z', { content: 'long ago', project: 'dormant' });
  w.db.prepare("DELETE FROM projects WHERE name = 'dormant'").run();
  migrationRow(w, 'dormant', 'open', '2026-11-03T10:00:00.000Z');
  w.at('2026-11-24T10:00:00Z');
  assert.equal(quietOf(w, 'dormant', '2026-11-16')?.quiet ?? null, null);

  const v = reviewWorld('2026-11-03T10:00:00Z');
  migrationRow(v, 'fresh', 'open', '2026-11-03T10:00:00.000Z', 'owner');
  v.at('2026-11-24T10:00:00Z');
  assert.equal(quietOf(v, 'fresh', '2026-11-16')!.quiet!.lastTouched, '2026-11-03T10:00:00.000Z');
});

test('a project finished before the migration is never quiet or back in an older week', () => {
  for (const state of ['done', 'open']) {
    const w = reviewWorld('2026-09-01T10:00:00Z');
    w.save('2026-09-01T10:00:00Z', { content: 'last fact', project: 'finished' });
    w.db.prepare("DELETE FROM projects WHERE name = 'finished'").run();
    migrationRow(w, 'finished', state, '2026-11-03T10:00:00.000Z');
    w.at('2026-11-24T10:00:00Z');
    const p = quietOf(w, 'finished', '2026-09-14');
    if (state === 'done') assert.deepEqual([p?.quiet ?? null, p?.back ?? null], [null, null]);
    else assert.equal(p!.quiet!.lastTouched, '2026-09-01T10:00:00.000Z');
  }
});

test('facts saved under an alias count toward the current project', () => {
  const w = reviewWorld('2026-10-12T10:00:00Z');
  w.save('2026-10-12T10:00:00Z', { content: 'inflow plays from Jellyfin', project: 'inflow' });
  const r = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', content: 'Now: bottling', project: 'coyote' });
  w.edit('2026-10-28T10:00:00Z', r.id, 'Done: pour (2026-10-28)\nNow: bottling');
  w.at('2026-11-05T10:00:00Z');
  w.service.moveProject('coyote', 'inflow', { type: 'owner' });
  w.service.addAlias('coyote', 'inflow', { type: 'owner' });
  w.at('2026-11-06T10:00:00Z');
  const body = buildReview(w.sources(), windowFor(W26));
  assert.equal(body.projects.find((p) => p.project === 'coyote'), undefined);
  const inflow = body.projects.find((p) => p.project === 'inflow')!;
  assert.deepEqual([inflow.quiet, inflow.back], [null, null]);
  assert.deepEqual(inflow.done, [{ text: 'pour', date: '2026-10-28' }]);
});

test('pages saved this week are grouped by project, each page once', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  w.db.prepare(`INSERT INTO pages(id, title, title_key, project, body, version, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 'brainai', 'b', 2, 'x', 'c', 'x', 'c')`).run('p1', 'A', 'a');
  w.db.prepare(`INSERT INTO pages(id, title, title_key, project, body, version, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 'brainai', 'b', 1, 'x', 'c', 'x', 'c')`).run('p2', 'B', 'b');
  const v = w.db.prepare("INSERT INTO page_versions(page_id, version, title, project, body, saved_at, saved_by) VALUES (?, ?, 'T', ?, 'b', ?, 'c')");
  v.run('p1', 1, 'brainai', '2026-10-27T10:00:00.000Z');
  v.run('p1', 2, 'brainai', '2026-10-28T10:00:00.000Z');
  v.run('p2', 1, 'brainai', '2026-10-29T10:00:00.000Z');
  v.run('p2', 2, null, '2026-10-30T10:00:00.000Z');
  w.at('2026-11-03T07:14:00Z');
  assert.deepEqual(quietOf(w, 'brainai')!.pages, ['p1', 'p2']);
});

test('decisions saved this week, statuses and roadmaps left out, newest first', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const a = w.save('2026-10-27T10:00:00Z', { content: 'first', project: 'wildlog' });
  w.save('2026-10-28T10:00:00Z', { kind: 'summary', content: 'status', project: 'wildlog' });
  w.save('2026-10-28T11:00:00Z', { kind: 'roadmap', content: 'Now: x', project: 'wildlog' });
  const b = w.save('2026-10-30T10:00:00Z', { content: 'second', project: null });
  w.save('2026-11-02T10:00:00Z', { content: 'next week', project: 'wildlog' });
  w.at('2026-11-03T07:14:00Z');
  assert.deepEqual(buildReview(w.sources(), windowFor(W26)).decisions, [b.id, a.id]);
});

test('growth keeps the strength and the improve with the most evidence this week; work mode keeps none', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const obs = w.db.prepare(`INSERT INTO observations(id, kind, area, summary, embedding, created_at, created_by, last_evidence_at)
    VALUES (?, ?, 'reviewing', 's', x'00', 'x', 'c', 'x')`);
  obs.run('s1', 'strength'); obs.run('s2', 'strength'); obs.run('i1', 'improve'); obs.run('i2', 'improve');
  const ev = w.db.prepare("INSERT INTO observation_evidence(observation_id, what, added_by, added_at) VALUES (?, 'w', 'c', ?)");
  ev.run('s1', '2026-10-27T10:00:00.000Z'); ev.run('s1', '2026-10-28T10:00:00.000Z');
  ev.run('s2', '2026-10-27T10:00:00.000Z'); ev.run('s2', '2026-10-27T11:00:00.000Z'); ev.run('s2', '2026-10-27T12:00:00.000Z');
  ev.run('i1', '2026-10-27T10:00:00.000Z'); ev.run('i2', '2026-10-29T10:00:00.000Z');
  ev.run('s1', '2026-11-03T10:00:00.000Z'); ev.run('s1', '2026-11-03T11:00:00.000Z');
  w.at('2026-11-03T07:14:00Z');
  const g = buildReview(w.sources(), windowFor(W26)).growth!;
  assert.deepEqual([g.strength, g.improve], ['s2', 'i2'], 'most evidence; a tie goes to the later one');
  assert.equal(buildReview(w.sources({ growth: false }), windowFor(W26)).growth, null);
});

test('digest totals, writer rows and safety flags are stored, so a grant deleted later still shows', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const m = w.save('2026-10-27T10:00:00Z', { content: 'to delete', project: 'wildlog', by: 'Claude' });
  w.save('2026-10-28T10:00:00Z', { content: 'kept', project: 'wildlog', by: 'owner' });
  w.at('2026-10-29T10:00:00Z');
  w.store.softDelete(m.id, 'Grok');
  w.grants.push({ clientName: 'Grok Build', createdAt: '2026-10-29T09:00:00.000Z' });
  w.at('2026-11-03T07:14:00Z');
  const b = buildReview(w.sources(), windowFor(W26));
  assert.deepEqual(b.digest.totals, { saved: 2, changed: 0, deleted: 1 });
  assert.deepEqual(b.digest.writers.map((x) => x.name).sort(), ['Claude', 'Grok', 'owner']);
  assert.deepEqual(b.safety, [
    { kind: 'connected', client: 'Grok Build', at: '2026-10-29T09:00:00.000Z' },
    { kind: 'deleted-by-ai', by: 'Grok', at: '2026-10-29T10:00:00.000Z', memoryId: m.id },
  ]);
  w.grants.length = 0;
  assert.equal(JSON.parse(JSON.stringify(b)).safety.length, 2);
});

test('the body stores replaced-others as a safety flag', () => {
  const w = reviewWorld('2026-10-20T10:00:00Z');
  const old = w.save('2026-10-20T10:00:00Z', { content: 'wildlog uses Core Data', project: 'wildlog', by: 'owner' });
  const now = w.save('2026-10-27T10:00:00Z', { content: 'wildlog uses SwiftData', project: 'wildlog', by: 'Claude Code' });
  w.at('2026-10-28T10:00:00Z');
  const row = w.store.supersessions.add(old.id, now.id, 'Claude Code');
  w.at('2026-11-03T07:14:00Z');
  const b = buildReview(w.sources(), windowFor(W26));
  assert.deepEqual(b.safety, [{ kind: 'replaced-others', by: 'Claude Code', author: 'owner', at: row.createdAt, memoryId: old.id }]);
  assert.equal(b.digest.totals.changed, 1);
});
