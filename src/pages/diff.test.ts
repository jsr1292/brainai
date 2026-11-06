import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSections, diffBodies } from './diff.js';

test('diffBodies marks added and removed lines and folds long unchanged stretches', () => {
  const same = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const before = [...same, 'old ending'].join('\n');
  const after = ['new first', ...same, 'new ending'].join('\n');
  assert.deepEqual(diffBodies(before, after), [
    { kind: 'added', text: 'new first' },
    { kind: 'same', text: 'line 1' },
    { kind: 'same', text: 'line 2' },
    { kind: 'skipped', count: 6 },
    { kind: 'same', text: 'line 9' },
    { kind: 'same', text: 'line 10' },
    { kind: 'removed', text: 'old ending' },
    { kind: 'added', text: 'new ending' },
  ]);
  assert.deepEqual(diffBodies('a\nb', 'a\nb'), [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
  assert.deepEqual(diffBodies('', 'one'), [{ kind: 'added', text: 'one' }]);
});

test('a version that rewrote a long list is shown as replaced, without a line-by-line diff that would stall the server', () => {
  // 3300 short lines, every other one rewritten: an edit distance in the thousands, which a full line diff takes
  // most of a second to work out on the request thread, holding up every other request meanwhile.
  const before = Array.from({ length: 3300 }, (_, i) => `* bottle ${i}`);
  const after = before.map((l, i) => (i % 2 ? l.replace('* ', '- ') : l));
  const lines = diffBodies(['# Cellar', ...before, 'Last line'].join('\n'), ['# Cellar', ...after, 'Last line'].join('\n'));
  // The unchanged first and last lines stay; everything between is shown as removed, then added.
  assert.deepEqual(lines.slice(0, 2), [{ kind: 'same', text: '# Cellar' }, { kind: 'same', text: '* bottle 0' }]);
  assert.deepEqual(lines.at(-1), { kind: 'same', text: 'Last line' });
  const middle = lines.slice(2, -1);
  assert.deepEqual(middle.map((l) => l.kind), [...before.slice(1).map(() => 'removed'), ...after.slice(1).map(() => 'added')]);
  assert.deepEqual(middle.slice(0, 2), [{ kind: 'removed', text: '* bottle 1' }, { kind: 'removed', text: '* bottle 2' }]);
  assert.deepEqual(middle.at(-1), { kind: 'added', text: '- bottle 3299' });

  // A small edit to the same long page still gets the real line diff.
  const edited = [...before];
  edited[1500] = '* bottle 1500, drunk';
  assert.deepEqual(diffBodies(before.join('\n'), edited.join('\n')).filter((l) => l.kind !== 'same' && l.kind !== 'skipped'), [
    { kind: 'removed', text: '* bottle 1500' },
    { kind: 'added', text: '* bottle 1500, drunk' },
  ]);
});

test('changedSections names changed, added and removed sections in page order, capped at three', () => {
  const before = 'Lead.\n## Stack\nOld.\n## Gotchas\nSame.\n## Old part\nGone soon.';
  const after = 'Lead.\n## Stack\nNew.\n## Gotchas\nSame.\n## Run\nAdded.';
  assert.equal(changedSections(before, after), 'Stack changed · Old part removed · Run added');
  assert.equal(changedSections('Lead.', 'New lead.'), 'Introduction changed');
  const many = (x: string) => ['## A', x, '## B', x, '## C', x, '## D', x, '## E', x].join('\n');
  assert.equal(changedSections(many('1'), many('2')), 'A changed · B changed · C changed · +2 more');
  assert.equal(changedSections('', 'Lead.\n## A\nx'), 'created');
});

test('a title-only change says no text changes', () => {
  assert.equal(changedSections('Lead.\n## A\nx', 'Lead.\n## A\nx'), 'no text changes');
});
