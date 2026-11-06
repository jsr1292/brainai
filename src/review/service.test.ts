import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewWorld, type ReviewWorld } from '../testing/reviewWorld.js';
import type { FolderSource } from '../projects/service.js';
import { ReviewService } from './service.js';
import type { TidySummary } from '../memory/tidy.js';
import { reviewView } from '../web/reviewViews.js';

// These tests are about the owner's calendar in Berlin; the app's own default zone is UTC.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

function service(w: ReviewWorld, o: { folders?: FolderSource; tidy?: () => TidySummary } = {}) {
  const lines: string[] = [];
  const s = new ReviewService({
    store: w.reviews, memories: w.store, service: w.service, registry: w.registry, folders: o.folders ?? w.folders, pages: w.pages,
    growth: w.growth, grants: () => w.grants, tidy: o.tidy,
  }, w.now, (line) => lines.push(line));
  return { s, lines };
}
/** A brain whose first memory is on 1 Oct, with a Personal finances step and an assistant's save in the week of 26 Oct. */
function world(now = '2026-11-03T07:14:00Z'): ReviewWorld {
  const w = reviewWorld('2026-10-01T10:00:00Z');
  w.save('2026-10-01T10:00:00Z', { content: 'first', project: 'wildlog' });
  const fin = w.save('2026-10-20T10:00:00Z', { kind: 'roadmap', content: 'Now: taxes', project: 'finances' });
  w.edit('2026-10-28T10:00:00Z', fin.id, 'Done: pay (2026-10-28)\nNow: taxes');
  w.registry.setInfo('finances', { area: 'personal' }, 'owner');
  w.save('2026-10-29T10:00:00Z', { content: 'a decision', project: 'wildlog', by: 'Claude' });
  w.at(now);
  return w;
}

test('last week on Tuesday 3 Nov 08:14 and at Monday 2 Nov 00:00 exactly is 26 Oct', () => {
  const w = world();
  assert.equal(service(w).s.lastMonday(), '2026-10-26');
  w.at('2026-11-01T23:00:00Z');
  assert.equal(service(w).s.lastMonday(), '2026-10-26');
  w.at('2026-11-01T22:59:59Z');
  assert.equal(service(w).s.lastMonday(), '2026-10-19');
  assert.equal(service(w).s.earliestMonday(), '2026-09-28');
});

test('locate sends a weekday to its Monday, this week to now, and refuses the future, the time before the first memory and a bad date', () => {
  const { s } = service(world());
  assert.deepEqual(s.locate('2026-10-28'), { to: 'week', monday: '2026-10-26', redirect: true });
  assert.deepEqual(s.locate('2026-10-26'), { to: 'week', monday: '2026-10-26', redirect: false });
  assert.deepEqual(s.locate('2026-11-03'), { to: 'now', redirect: true });
  assert.deepEqual(s.locate('2026-11-02'), { to: 'now', redirect: true });
  for (const bad of ['2026-11-09', '2026-09-27', '2026-02-30', 'soon', '2026-9-28']) assert.deepEqual(s.locate(bad), { to: 'none' }, bad);
  assert.deepEqual(s.locate('2026-09-28'), { to: 'week', monday: '2026-09-28', redirect: false });
});

test('a week is built once and kept as it stood', () => {
  const w = world();
  const { s, lines } = service(w);
  const first = s.ensure('2026-10-26', 'owner')!;
  w.save('2026-10-30T10:00:00Z', { content: 'saved late', project: 'wildlog' });
  w.at('2026-11-03T09:00:00Z');
  const again = s.ensure('2026-10-26', 'owner')!;
  assert.equal(again.builtAt, first.builtAt);
  assert.deepEqual(again.body, first.body);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^weekly review 2026-10-26 built in \d+ ms$/);
  assert.equal(s.ensure('2026-11-02', 'owner'), undefined, 'this week is never stored');
  assert.equal(s.ensure('2026-09-21', 'owner'), undefined, 'before the first memory');
});

test('a build that fails stores nothing', () => {
  const w = world();
  const { s } = service(w, { folders: { match: () => { throw new Error('report unreadable'); } } });
  assert.throws(() => s.ensure('2026-10-26', 'owner'), /report unreadable/);
  assert.equal(w.reviews.get('2026-10-26'), undefined);
});

test('an assistant\'s first request still builds the whole week', () => {
  const w = world();
  const { s } = service(w);
  const r = s.ensure('2026-10-26', 'Reader')!;
  assert.equal(r.builtBy, 'Reader');
  assert.ok(r.body.projects.some((p) => p.project === 'finances'));
  assert.ok(r.body.digest.writers.some((x) => x.name === 'Claude'));
  const view = s.present(r, 'last', { kind: 'owner' });
  assert.ok(view.moved.some((m) => m.project === 'finances'));
  assert.ok(view.digest!.writers.length > 0);
  const read = s.present(r, 'last', { kind: 'read', projects: ['wildlog'] });
  assert.ok(!read.moved.some((m) => m.project === 'finances'));
});

test('open and dismiss keep the first time, and answer false for a week not stored', () => {
  const w = world();
  const { s } = service(w);
  s.ensure('2026-10-26', 'owner');
  s.ensure('2026-10-19', 'owner');
  assert.equal(s.open('2026-10-26'), true);
  const opened = w.reviews.get('2026-10-26')!.openedAt;
  w.at('2026-11-03T10:00:00Z');
  assert.equal(s.open('2026-10-26'), true);
  assert.equal(w.reviews.get('2026-10-26')!.openedAt, opened);
  assert.equal(s.dismiss('2026-10-19'), true);
  assert.equal(w.reviews.get('2026-10-26')!.dismissedAt, null);
  assert.equal(s.open('2026-09-28'), false);
  assert.equal(s.dismiss('2026-09-28'), false);
});

test('all builds at most 12 missing weeks per call', () => {
  const w = reviewWorld('2026-07-14T10:00:00Z');
  w.save('2026-07-14T10:00:00Z', { content: 'first', project: 'wildlog' });
  w.at('2026-11-03T07:14:00Z');
  const { s } = service(w);
  const first = s.all('owner');
  assert.equal(first.length, 16);
  assert.equal(first[0]!.monday, '2026-10-26');
  assert.equal(first.at(-1)!.monday, '2026-07-13');
  assert.equal(first.filter((x) => x.review).length, 12);
  assert.equal(w.reviews.mondays().length, 12);
  assert.equal(s.all('owner').filter((x) => x.review).length, 16);
});

test('changing the zone keeps stored weeks and builds the next one in the new zone', (t) => {
  const saved = process.env.OWNER_TIMEZONE;
  t.after(() => { if (saved === undefined) delete process.env.OWNER_TIMEZONE; else process.env.OWNER_TIMEZONE = saved; });
  delete process.env.OWNER_TIMEZONE;
  const w = world();
  const { s } = service(w);
  s.ensure('2026-10-19', 'owner');
  s.ensure('2026-10-26', 'owner');
  const before = w.reviews.mondays().map((m) => w.reviews.get(m)!.builtAt);
  process.env.OWNER_TIMEZONE = 'America/New_York';
  w.at('2026-11-10T12:00:00Z');
  assert.equal(s.lastMonday(), '2026-11-02');
  assert.ok(s.ensure(s.lastMonday(), 'owner'));
  assert.deepEqual(w.reviews.mondays(), ['2026-11-02', '2026-10-26', '2026-10-19']);
  assert.deepEqual(['2026-10-26', '2026-10-19'].map((m) => w.reviews.get(m)!.builtAt), before);
});

test('so far is never stored', () => {
  const w = world();
  const { s } = service(w);
  const r = s.soFar();
  assert.equal(r.monday, '2026-11-02');
  assert.equal(r.builtAt, '2026-11-03T07:14:00.000Z');
  assert.deepEqual(w.reviews.mondays(), []);
});

const tidy: TidySummary = { duplicates: 1, statuses: [], overlaps: 0, stale: 0, gone: 0 };

test('ensure never runs the Tidy checks', () => {
  const w = world();
  let calls = 0;
  const { s } = service(w, { tidy: () => { calls++; return tidy; } });
  assert.equal(s.ensure(s.lastMonday(), 'owner')!.body.tidy, null);
  assert.equal('tidy' in s.ensure('2026-10-19', 'owner')!.body, false);
  s.all('owner');
  assert.equal('tidy' in s.soFar().body, false);
  assert.equal(calls, 0);
  const without = service(world()).s;
  assert.equal('tidy' in without.ensure(without.lastMonday(), 'owner')!.body, false);
});

test("last week's Tidy summary is worked out once, outside the transaction", (t) => {
  const w = world();
  let inside = false;
  const atomic = w.reviews.atomic.bind(w.reviews);
  t.mock.method(w.reviews, 'atomic', <T>(fn: () => T): T => atomic(() => {
    inside = true;
    try { return fn(); } finally { inside = false; }
  }));
  const calls: boolean[] = [];
  const { s } = service(w, { tidy: () => { calls.push(inside); return tidy; } });
  const r = s.withTidy(s.ensure(s.lastMonday(), 'owner')!);
  assert.deepEqual(calls, [false]);
  assert.deepEqual(r.body.tidy, tidy);
  assert.deepEqual(w.reviews.get(r.monday)!.body.tidy, tidy);
  assert.deepEqual(s.withTidy(r), r);
  const older = s.ensure('2026-10-19', 'owner')!;
  assert.equal(s.withTidy(older), older);
  const pending = { ...r, body: { ...r.body, tidy: null } };
  w.at('2026-11-10T10:00:00Z');
  assert.equal(s.withTidy(pending), pending, 'a pending week that is no longer last stays untouched');
  assert.deepEqual(calls, [false]);
});

test('only the owner sees last week’s stored Tidy summary, after the safety notes', () => {
  const w = world();
  w.grants.push({ clientName: 'Test assistant', createdAt: '2026-10-29T09:00:00Z' });
  const { s } = service(w, { tidy: () => tidy });
  const r = s.withTidy(s.ensure(s.lastMonday(), 'owner')!);
  const options = { work: false, prev: null, next: null, back: '/review' };
  const owner = s.present(r, 'last', { kind: 'owner' });
  assert.deepEqual(owner.tidy, tidy);
  const body = reviewView(owner, options).value;
  assert.match(body, /<p class="tidy-line">2 facts look like duplicates\. <a href="\/facts\/tidy">Tidy up<\/a><\/p>/);
  assert.ok(body.indexOf('class="tidy-line"') > body.indexOf('revoke it in'));
  for (const scope of [{ kind: 'full' }, { kind: 'read', projects: ['wildlog'] }] as const) {
    assert.equal(s.present(r, 'last', scope.kind === 'read' ? { ...scope, projects: [...scope.projects] } : scope).tidy, null);
  }
  for (const kind of ['older', 'now'] as const) assert.equal(s.present(r, kind, { kind: 'owner' }).tidy, null);
  const legacy = { ...r, body: { ...r.body } };
  delete legacy.body.tidy;
  assert.equal(s.withTidy(legacy), legacy);
  assert.doesNotMatch(reviewView(s.present(legacy, 'last', { kind: 'owner' }), options).value, /tidy-line/);
  assert.doesNotMatch(reviewView({ ...owner, tidy: { ...tidy, duplicates: 0 } }, options).value, /tidy-line/);
});
