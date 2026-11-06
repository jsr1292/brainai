import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRoadmap, formatRoadmap, keepTicked, parseRoadmap } from './roadmap.js';

test('a roadmap reads as Now, Next, Later and the items waiting on the owner', () => {
  const r = parseRoadmap('Now: design refresh, tasks 3–15\nNext: final review, merge, install\nWaiting on you: device checklist; reinstall before the profiles expire (by 2026-10-27)');
  assert.equal(r.now, 'design refresh, tasks 3–15');
  assert.equal(r.next, 'final review, merge, install');
  assert.equal(r.later, null);
  assert.deepEqual(r.waiting, [
    { text: 'device checklist', due: null },
    { text: 'reinstall before the profiles expire', due: '2026-10-27' },
  ]);
});

test('labels are matched without regard to case or extra spaces, and lines can continue', () => {
  const r = parseRoadmap('now:  stage 1 planner\n  still observing\nLATER : car charging\nwaiting on you:   ');
  assert.equal(r.now, 'stage 1 planner still observing');
  assert.equal(r.later, 'car charging');
  assert.deepEqual(r.waiting, []);
});

test('checkRoadmap accepts the four labels once each and explains the shape otherwise', () => {
  assert.equal(checkRoadmap('Now: a\nNext: b\nLater: c\nWaiting on you: d'), null);
  assert.match(checkRoadmap('Here is the plan: do things')!, /Now:/);
  assert.match(checkRoadmap('Now: a\nNow: b')!, /once/);
  assert.match(checkRoadmap('Later: someday')!, /Now: or Next:/);
});

test('a roadmap\'s Done line lists finished steps with their dates, and Now can carry a progress count', () => {
  const r = parseRoadmap('Done: tools merged (2026-10-20); design plan (2026-10-20); tasks 1–8 (2026-10-21)\nNow: design refresh, task 9 in review (8/15)\nNext: merge');
  assert.deepEqual(r.done, [
    { text: 'tools merged', date: '2026-10-20' },
    { text: 'design plan', date: '2026-10-20' },
    { text: 'tasks 1–8', date: '2026-10-21' },
  ]);
  assert.equal(r.now, 'design refresh, task 9 in review');
  assert.deepEqual(r.progress, { done: 8, total: 15 });
  assert.equal(parseRoadmap('Now: x').progress, null);
  assert.deepEqual(parseRoadmap('Done: undated step\nNow: x').done, [{ text: 'undated step', date: null }]);
  assert.equal(checkRoadmap('Done: a (2026-10-20)\nNow: b'), null);
});

test('a progress count is read from the end of Now, empty or impossible dates are not dates, and empty done steps are dropped', () => {
  const r = parseRoadmap('Done: (2026-10-20); step one (2026-13-45); step two (2026-10-21)\nNow: a (1/2) then b (3/4)');
  assert.deepEqual(r.done, [{ text: 'step one (2026-13-45)', date: null }, { text: 'step two', date: '2026-10-21' }]);
  assert.deepEqual(r.progress, { done: 3, total: 4 });
  assert.equal(r.now, 'a (1/2) then b');
});

test('Next and Later can list several steps separated by semicolons', () => {
  const r = parseRoadmap('Now: x\nNext: review; merge; install on the iPhone\nLater: stage 3 (car charging)');
  assert.deepEqual(r.nextSteps, ['review', 'merge', 'install on the iPhone']);
  assert.deepEqual(r.laterSteps, ['stage 3 (car charging)']);
  assert.equal(r.next, 'review; merge; install on the iPhone');
  assert.deepEqual(parseRoadmap('Now: x').laterSteps, []);
});

const FORMAT_CASES = [
  'Done: tools merged (2026-10-20); design plan (2026-10-20)\nNow: design refresh, task 9 in review (8/15)\nNext: final review, merge, install on the iPhone\nLater: dark mode pass\nWaiting on you: device checklist; reinstall before the profiles expire (by 2026-10-27)',
  'Next: review; merge; install on the iPhone',
  'Done: undated step; dated step (2026-10-21)\nnow:  stage 1 planner\n  still observing (2/5)\nLATER : car charging;\n  solar panels\nwaiting on you:   first item\n  continued (by 2026-11-10)',
];

test('formatRoadmap round-trips', () => {
  for (const x of FORMAT_CASES) assert.deepEqual(parseRoadmap(formatRoadmap(parseRoadmap(x))), parseRoadmap(x));
  assert.equal(formatRoadmap(parseRoadmap(FORMAT_CASES[1]!)), 'Next: review; merge; install on the iPhone');
});

test('formatRoadmap output passes checkRoadmap', () => {
  for (const x of FORMAT_CASES) assert.equal(checkRoadmap(formatRoadmap(parseRoadmap(x))), null);
});

test('a waiting item with an impossible due date has no due date', () => {
  const r = parseRoadmap('Now: x\nWaiting on you: thing (by 2025-13-01)');
  assert.deepEqual(r.waiting, [{ text: 'thing (by 2025-13-01)', due: null }]);
});

test('formatRoadmap keeps a Now line that holds only a step count', () => {
  assert.deepEqual(parseRoadmap(formatRoadmap(parseRoadmap('Now: (3/5)\nNext: a'))).progress, { done: 3, total: 5 });
});

test('an assistant can ask again for a step whose earlier tick it keeps in Done', () => {
  const current = 'Done: test on the iPhone (2026-11-02); release 0.3 (2026-11-03)\nNow: release 0.4';
  const next = 'Done: test on the iPhone (2026-11-02); release 0.3 (2026-11-03)\nNow: release 0.4\nWaiting on you: test on the iPhone; approve the store listing';
  assert.equal(keepTicked(current, next), next);
});

test('a copy written before the owner ticked a step again still keeps the new tick', () => {
  // The step came back once already: the assistant's old copy has the earlier tick in Done and the step waiting.
  const current = 'Done: test on the iPhone (2026-11-02); test on the iPhone (2026-11-04)\nNow: release 0.4';
  const next = 'Done: test on the iPhone (2026-11-02)\nNow: release 0.5\nWaiting on you: test on the iPhone; approve the store listing';
  const kept = parseRoadmap(keepTicked(current, next));
  assert.deepEqual(kept.waiting.map((w) => w.text), ['approve the store listing']);
  assert.deepEqual(kept.done.map((d) => d.date), ['2026-11-02', '2026-11-04']);
});

test('filler such as none, N/A or a dash is not read as a step or as something waiting on the owner', () => {
  for (const filler of ['none', 'None.', 'nothing right now', 'Nothing', 'N/A', 'n/a', '-', '—', 'TBD', '(none)', 'none yet']) {
    const r = parseRoadmap(`Now: release 0.4\nNext: ${filler}\nLater: ${filler}\nWaiting on you: ${filler}`);
    assert.deepEqual(r.waiting, [], filler);
    assert.deepEqual(r.nextSteps, [], filler);
    assert.deepEqual(r.laterSteps, [], filler);
    assert.equal(r.next, null, filler);
    assert.equal(r.later, null, filler);
  }
  const r = parseRoadmap('Now: none\nNext: widgets; —\nWaiting on you: sign the form; none');
  assert.equal(r.now, null);
  assert.deepEqual(r.nextSteps, ['widgets']);
  assert.deepEqual(r.waiting, [{ text: 'sign the form', due: null }]);
  // Real steps that merely start with one of those words are kept.
  assert.deepEqual(parseRoadmap('Now: x\nWaiting on you: nothing to add to the form? check it').waiting.length, 1);
  assert.deepEqual(parseRoadmap('Now: x\nNext: none of the old tests should fail').nextSteps, ['none of the old tests should fail']);
});
