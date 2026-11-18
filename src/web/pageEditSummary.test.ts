import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageEditSummary } from './pageEditSummary.js';

test('the summary names the section and the first changed line', () => {
  assert.deepEqual(pageEditSummary('Lead.\n\n## Stack\nx\n\n## Notes\nz', 'Lead.\n\n## Stack\nx\n\n## Notes\nZ changed'), { heading: 'Notes', line: 'Z changed' });
  assert.deepEqual(pageEditSummary('Lead.', 'Lead changed.'), { heading: null, line: 'Lead changed.' });
  assert.deepEqual(pageEditSummary('a\n## One\nb', 'a\n## One\nb\n\n## Two\nnew words'), { heading: 'Two', line: 'new words' });
  assert.equal(pageEditSummary('same', 'same'), null);
});

test('removed lines are named by their section; a long line is cut at a word', () => {
  assert.deepEqual(pageEditSummary('## A\none\ntwo', '## A\none'), { heading: 'A', line: 'Removed text' });
  const s = pageEditSummary('x', `${'word '.repeat(60)}`)!;
  assert.ok(s.line!.length <= 112 && s.line!.endsWith('…'));
});
