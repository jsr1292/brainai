import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weekRange, weekRangeLong, weekRangeWithYear, weekSentence, type SentenceFacts } from './sentence.js';

const f = (steps: [string, number, boolean?][], rest: Partial<SentenceFacts> = {}): SentenceFacts =>
  ({ steps: steps.map(([project, n, nameable = true]) => ({ project, n, nameable })), late: 0, dated: 0, quiet: [], somethingElse: false, ...rest });
const page = { lead: true, soFar: false };

test('the sentence follows the fixed patterns, with digits and at most two names in the lead', () => {
  const four = f([['cairn', 5], ['wildlog', 3], ['homeassistant', 2], ['minipc', 1]], { late: 2, dated: 4, quiet: ['energy'] });
  assert.equal(weekSentence(four, page), 'A good week for cairn and wildlog: 11 steps done across 4 projects. 2 things are late, and energy went quiet.');
  assert.equal(weekSentence(four, { lead: false, soFar: false }), '11 steps done across 4 projects. 2 things are late, and energy went quiet.');
  assert.equal(weekSentence(f([['wildlog', 3]], { late: 1, dated: 1 }), page), '3 steps done, all in wildlog. 1 thing is late.');
  assert.equal(weekSentence(f([['finances', 1, false]]), page), '1 step done.');
  assert.equal(weekSentence(f([['health', 4, false]]), page), '4 steps done.');
  assert.equal(weekSentence(f([['health', 5, false], ['wildlog', 4]]), page), 'A good week for wildlog: 9 steps done across 2 projects.');
  assert.equal(weekSentence(f([['wildlog', 5]]), page), '5 steps done, all in wildlog.');
  assert.equal(weekSentence(f([], { late: 1, dated: 1, somethingElse: true }), page), 'No roadmap steps were done. 1 thing is late.');
  assert.equal(weekSentence(f([['wildlog', 1]], { quiet: ['energy', 'castle3d'] }), page), '1 step done, in wildlog. energy and castle3d went quiet.');
  assert.equal(weekSentence(f([], { quiet: ['a', 'b', 'c'], somethingElse: true }), page), 'No roadmap steps were done. 3 projects went quiet.');
  assert.equal(weekSentence(f([]), page), 'A quiet week. Nothing moved.');
  assert.equal(weekSentence(f([['cairn', 2], ['wildlog', 1]], { dated: 1 }), { lead: true, soFar: true }), 'So far: 3 steps done across 2 projects. Nothing is late.');
  assert.equal(weekSentence(f([]), { lead: true, soFar: true }), 'So far: nothing has moved yet.');
  assert.equal(weekSentence(f([['wildlog', 2]], { dated: 2, quiet: ['energy'] }), page), '2 steps done, all in wildlog. Nothing is late, and energy went quiet.');
  assert.equal(weekSentence(f([['a', 4], ['b', 4], ['c', 3]]), page), 'A good week for a and b: 11 steps done across 3 projects.');
});

test('week ranges read as days, with the year only where it is needed', () => {
  assert.equal(weekRange('2026-10-26'), '26 Oct – 1 Nov');
  assert.equal(weekRange('2026-10-19'), '19 – 25 Oct');
  assert.equal(weekRange('2025-12-29'), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(weekRangeWithYear('2026-10-26'), '26 Oct – 1 Nov 2026');
  assert.equal(weekRangeWithYear('2026-10-19'), '19 – 25 Oct 2026');
  assert.equal(weekRangeWithYear('2025-12-29'), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(weekRangeLong('2026-10-26'), 'Monday 26 October – Sunday 1 November 2026');
  assert.equal(weekRangeLong('2026-11-02', '2026-11-03'), 'Monday 2 – Tuesday 3 November 2026');
  assert.equal(weekRangeLong('2026-10-12'), 'Monday 12 – Sunday 18 October 2026');
  assert.equal(weekRangeLong('2025-12-29'), 'Monday 29 December 2025 – Sunday 4 January 2026');
  assert.equal(weekRangeLong('2026-11-02', '2026-11-02'), 'Monday 2 November 2026');
});
