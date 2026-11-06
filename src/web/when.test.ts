/** One date language for the whole app: due dates, late items and past times, in the owner's time zone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueChip, dueLabel, pastLabel, timeAgo } from './when.js';

process.env.OWNER_TIMEZONE = 'Europe/Berlin';

const now = new Date('2026-11-04T10:00:00Z'); // Wednesday, 11:00 in Berlin

test('pastLabel', () => {
  for (const [iso, want] of [['2026-11-04T09:59:30Z', 'just now'], ['2026-11-04T09:48:00Z', '12 min ago'], ['2026-11-04T07:00:00Z', '3 h ago'],
    ['2026-11-03T08:00:00Z', 'yesterday'], ['2026-10-31T10:00:00Z', '4 days ago'], ['2026-10-26T10:00:00Z', '26 Oct'], ['2025-10-26T10:00:00Z', '26 Oct 2025']])
    assert.equal(pastLabel(iso!, now), want, iso);
});

test('pastLabel at the edges', () => {
  assert.equal(pastLabel('2026-11-04T10:03:00Z', now), 'just now', 'a time in the future clamps');
  assert.equal(pastLabel('2026-11-03T22:50:00Z', new Date('2026-11-03T23:10:00Z')), 'yesterday', '23:50 then 00:10 in Berlin');
  // 25 Oct 2026 is the 25-hour day in Berlin (CEST → CET at 03:00). 21:30Z on 24 Oct is 23:30 CEST that day;
  // 09:00Z on 25 Oct is 10:00 CET. 22:30Z on 24 Oct is already 00:30 CEST on 25 Oct, the same local day.
  assert.equal(pastLabel('2026-10-24T21:30:00Z', new Date('2026-10-25T09:00:00Z')), 'yesterday', 'the night the clocks go back');
  assert.equal(pastLabel('2026-10-24T22:30:00Z', new Date('2026-10-25T09:00:00Z')), '10 h ago', 'hours are counted across the 25-hour day');
});

test('dueLabel', () => {
  const t = '2026-11-04';
  assert.deepEqual(dueLabel('2026-11-04', t), { text: 'due today', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-05', t), { text: 'due tomorrow', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-06', t), { text: 'due Fri', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-11', t), { text: 'due 11 Nov', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-20', t), { text: 'due 20 Nov', tone: 'plain' });
  assert.deepEqual(dueLabel('2027-02-03', t), { text: 'due 3 Feb 2027', tone: 'plain' });
  assert.deepEqual(dueLabel('2026-11-03', t), { text: '1 day late', tone: 'late' });
  assert.deepEqual(dueLabel('2026-10-31', t), { text: '4 days late', tone: 'late' });
});

test('rendered times carry ISO only in datetime and title', () => {
  const h = timeAgo('2026-11-03T08:00:00Z', now).value;
  assert.match(h, /^<time datetime="2026-11-03T08:00:00Z" title="[^"]*2026[^"]*">yesterday<\/time>$/);
  assert.equal(dueChip('2026-10-31', '2026-11-04').value, '<span class="chip late"><time class="day" datetime="2026-10-31">4 days late</time></span>');
});
