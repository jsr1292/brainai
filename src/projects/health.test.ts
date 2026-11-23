import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoadmap } from '../memory/roadmap.js';
import { projectHealth, reasonText, waitingNow, type HealthInput } from './health.js';

const TODAY = '2026-11-23';
/** A day as an instant at noon UTC, safe in every zone near UTC. */
const at = (day: string): string => `${day}T12:00:00.000Z`;
const base = (over: Partial<HealthInput> = {}, roadmap?: string): HealthInput => ({
  state: 'open', roadmap: parseRoadmap(roadmap ?? 'Done: a step (2026-11-20)\nNow: the thing'), statusAt: at('2026-11-21'), createdAt: at('2026-06-01'), notPushed: null, ...over,
});
const health = (over: Partial<HealthInput> = {}, roadmap?: string) => projectHealth(base(over, roadmap), TODAY);

test('only open projects get a label', () => {
  for (const state of ['idea', 'parked', 'done', 'archived'] as const) assert.equal(health({ state }, 'Now: x\nWaiting on you: y (by 2026-11-01)'), null, state);
  assert.equal(health()?.state, 'on_track');
  assert.deepEqual(health()?.reasons, []);
});

test('needs_you: a dated waiting item that is late or due within 3 days, inclusive', () => {
  const w = (due: string) => health({}, `Now: x\nWaiting on you: sign it (by ${due})`);
  assert.equal(w('2026-11-20')?.state, 'needs_you', 'late');
  assert.equal(w('2026-11-23')?.state, 'needs_you', 'today');
  assert.equal(w('2026-11-26')?.state, 'needs_you', 'exactly 3 days');
  assert.equal(w('2026-11-27')?.state, 'on_track', '4 days is not soon');
  assert.deepEqual(w('2026-11-20')?.reasons, [{ kind: 'needs_you', text: 'sign it', due: '2026-11-20', days: -3 }]);
  assert.deepEqual(w('2026-11-26')?.reasons, [{ kind: 'needs_you', text: 'sign it', due: '2026-11-26', days: 3 }]);
});

test('an undated waiting item never counts', () => {
  assert.equal(health({}, 'Now: x\nWaiting on you: reply to Sam; call the bank')?.state, 'on_track');
});

test('every qualifying waiting item is its own reason', () => {
  const h = health({}, 'Now: x\nWaiting on you: a (by 2026-11-01); b; c (by 2026-11-25); d (by 2026-12-30)');
  assert.deepEqual(h?.reasons.map((r) => r.kind === 'needs_you' && r.text), ['a', 'c']);
  assert.equal(waitingNow(h), 2);
  assert.equal(waitingNow(null), 0);
});

test('at_risk: work only on the Mac, from the caller\'s trusted report', () => {
  const h = health({ notPushed: { count: 2, uncommitted: 0 } });
  assert.equal(h?.state, 'at_risk');
  assert.deepEqual(h?.reasons, [{ kind: 'at_risk', count: 2, uncommitted: 0 }]);
  assert.deepEqual(health({ notPushed: { count: 0, uncommitted: 4 } })?.reasons, [{ kind: 'at_risk', count: 0, uncommitted: 4 }]);
  assert.equal(health({ notPushed: null })?.state, 'on_track', 'a stale or missing report says nothing');
});

test('stuck: no Done step and no status for more than 14 days, with a Now or Next still there', () => {
  const stuck = (over: Partial<HealthInput>, roadmap: string) => health(over, roadmap);
  const old = '2026-11-01';
  assert.equal(stuck({ statusAt: at(old) }, `Done: x (${old})\nNow: y`)?.state, 'stuck');
  // Exactly 14 days (2026-11-09) is not older than 14.
  assert.equal(stuck({ statusAt: at('2026-11-09') }, 'Done: x (2026-11-09)\nNow: y')?.state, 'on_track', 'both exactly 14 days');
  assert.equal(stuck({ statusAt: at('2026-11-08') }, 'Done: x (2026-11-08)\nNow: y')?.state, 'stuck', '15 days');
  // Either one fresh keeps it moving.
  assert.equal(stuck({ statusAt: at(old) }, 'Done: x (2026-11-20)\nNow: y')?.state, 'on_track', 'recent Done');
  assert.equal(stuck({ statusAt: at('2026-11-22') }, `Done: x (${old})\nNow: y`)?.state, 'on_track', 'recent status');
  assert.equal(stuck({ statusAt: at('2026-11-09') }, `Done: x (${old})\nNow: y`)?.state, 'on_track', 'status exactly 14 days, Done older');
  assert.equal(stuck({ statusAt: at(old) }, 'Done: x (2026-11-09)\nNow: y')?.state, 'on_track', 'Done exactly 14 days, status older');
  // Undated Done steps say nothing about when.
  assert.equal(stuck({ statusAt: at(old) }, 'Done: x\nNow: y')?.state, 'stuck');
  assert.deepEqual(stuck({ statusAt: at(old) }, `Done: x (${old})\nNext: write it up; ship it`)?.reasons, [{ kind: 'stuck', days: 22, next: 'write it up' }]);
});

test('stuck: with no status, the project\'s age counts, and with nothing left to do it is not stuck', () => {
  assert.equal(health({ statusAt: null, createdAt: at('2026-11-01') }, 'Now: y')?.state, 'stuck');
  assert.equal(health({ statusAt: null, createdAt: at('2026-11-09') }, 'Now: y')?.state, 'on_track', 'created exactly 14 days ago');
  assert.equal(health({ statusAt: null, createdAt: at('2026-11-08') }, 'Now: y')?.state, 'stuck', 'created 15 days ago');
  assert.equal(health({ statusAt: null, createdAt: at('2026-11-20') }, 'Now: y')?.state, 'on_track', 'a young project with no status');
  const idle = { statusAt: null, createdAt: at('2026-01-01') };
  assert.equal(health(idle, 'Done: x (2026-02-01)\nLater: someday')?.state, 'on_track', 'only Later left');
  assert.equal(health(idle, 'Done: x (2026-02-01)\nNow: none')?.state, 'on_track', 'filler is not content');
  assert.equal(projectHealth({ ...base(idle), roadmap: null }, TODAY)?.state, 'on_track', 'no roadmap at all');
});

test('several can apply: the state is the first in needs_you > at_risk > stuck, and every reason is listed in that order', () => {
  const h = health({ statusAt: at('2026-10-01'), notPushed: { count: 1, uncommitted: 0 } }, 'Done: x (2026-10-01)\nNow: y\nWaiting on you: z (by 2026-11-24)');
  assert.equal(h?.state, 'needs_you');
  assert.deepEqual(h?.reasons.map((r) => r.kind), ['needs_you', 'at_risk', 'stuck']);
  const two = health({ statusAt: at('2026-10-01'), notPushed: { count: 1, uncommitted: 0 } }, 'Done: x (2026-10-01)\nNow: y');
  assert.equal(two?.state, 'at_risk');
  assert.deepEqual(two?.reasons.map((r) => r.kind), ['at_risk', 'stuck']);
});

test('the owner\'s calendar day decides, not UTC', () => {
  const prev = process.env.OWNER_TIMEZONE;
  process.env.OWNER_TIMEZONE = 'Pacific/Auckland';
  try {
    // 2026-11-08T20:00Z is already 9 Nov in Auckland: exactly 14 days before 23 Nov, so still moving.
    assert.equal(health({ statusAt: '2026-11-08T20:00:00Z' }, 'Done: x (2026-10-01)\nNow: y')?.state, 'on_track');
    process.env.OWNER_TIMEZONE = 'UTC';
    assert.equal(health({ statusAt: '2026-11-08T20:00:00Z' }, 'Done: x (2026-10-01)\nNow: y')?.state, 'stuck');
  } finally {
    if (prev === undefined) delete process.env.OWNER_TIMEZONE; else process.env.OWNER_TIMEZONE = prev;
  }
});

test('reasonText words each reason in plain English', () => {
  assert.equal(reasonText({ kind: 'needs_you', text: 'sign it', due: '2026-11-20', days: -3 }), 'Waiting on the owner and late: "sign it" was due 2026-11-20.');
  assert.equal(reasonText({ kind: 'needs_you', text: 'sign it', due: '2026-11-25', days: 2 }), 'Waiting on the owner: "sign it" is due 2026-11-25.');
  assert.equal(reasonText({ kind: 'at_risk', count: 1, uncommitted: 0 }), "1 commit is only on the owner's Mac.");
  assert.equal(reasonText({ kind: 'at_risk', count: 0, uncommitted: 3 }), "3 uncommitted files are only on the owner's Mac.");
  assert.equal(reasonText({ kind: 'stuck', days: 22, next: 'ship it' }), 'No step finished and no status saved for 22 days, with "ship it" still to do.');
});

test('an area of life can need you but is never stuck', () => {
  const idle = { statusAt: null, createdAt: at('2026-01-01'), lifeArea: true };
  assert.equal(health(idle, 'Now: y')?.state, 'on_track');
  assert.equal(health(idle, 'Now: y\nWaiting on you: pay (by 2026-11-24)')?.state, 'needs_you');
});
