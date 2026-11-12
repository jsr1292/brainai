/** B10: the time a question asks about, read from its words (English and Spanish), as days in Europe/Paris. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factDates, parseTimeRange } from './timeRange.js';

// Days are the owner's (OWNER_TIMEZONE, as everywhere in the app); these tests are written for Paris.
process.env.OWNER_TIMEZONE = 'Europe/Paris';
// Tuesday 10 November 2026, midday in Paris.
const NOW = new Date('2026-11-10T11:00:00Z');
const r = (q: string, now = NOW) => parseTimeRange(q, now);
const range = (from: string, to: string) => ({ from, to });

test('today and yesterday, in both languages', () => {
  assert.deepEqual(r('what did we decide today?'), range('2026-11-10', '2026-11-10'));
  assert.deepEqual(r('¿qué decidimos hoy?'), range('2026-11-10', '2026-11-10'));
  assert.deepEqual(r('what changed yesterday'), range('2026-11-09', '2026-11-09'));
  assert.deepEqual(r('qué cambió ayer'), range('2026-11-09', '2026-11-09'));
});

test('this week runs from Monday to today; last week is the Monday to Sunday before', () => {
  assert.deepEqual(r('what did we do this week'), range('2026-11-09', '2026-11-10'));
  assert.deepEqual(r('qué hicimos esta semana'), range('2026-11-09', '2026-11-10'));
  assert.deepEqual(r('what did we decide last week about backups'), range('2026-11-02', '2026-11-08'));
  assert.deepEqual(r('¿qué decidimos la semana pasada?'), range('2026-11-02', '2026-11-08'));
});

test('this month and last month', () => {
  assert.deepEqual(r('anything new this month'), range('2026-11-01', '2026-11-10'));
  assert.deepEqual(r('algo nuevo este mes'), range('2026-11-01', '2026-11-10'));
  assert.deepEqual(r('what happened last month'), range('2026-10-01', '2026-10-31'));
  assert.deepEqual(r('qué pasó el mes pasado'), range('2026-10-01', '2026-10-31'));
});

test('in a month: the most recent one not in the future, or the year given', () => {
  assert.deepEqual(r('what did we do in October'), range('2026-10-01', '2026-10-31'));
  assert.deepEqual(r('¿qué hicimos en octubre?'), range('2026-10-01', '2026-10-31'));
  assert.deepEqual(r('in December'), range('2025-12-01', '2025-12-31'));
  assert.deepEqual(r('in December', new Date('2027-01-15T10:00:00Z')), range('2026-12-01', '2026-12-31'));
  assert.deepEqual(r('in October 2025'), range('2025-10-01', '2025-10-31'));
  assert.deepEqual(r('en octubre de 2025'), range('2025-10-01', '2025-10-31'));
  assert.deepEqual(r('in feb'), range('2026-02-01', '2026-02-28'));
});

test('since and before a month or a date', () => {
  assert.deepEqual(r('what changed since October'), range('2026-10-01', '2026-11-10'));
  assert.deepEqual(r('qué cambió desde octubre'), range('2026-10-01', '2026-11-10'));
  assert.deepEqual(r('since 2026-11-03'), range('2026-11-03', '2026-11-10'));
  assert.deepEqual(r('before October'), range('1970-01-01', '2026-09-30'));
  assert.deepEqual(r('antes de octubre'), range('1970-01-01', '2026-09-30'));
  assert.deepEqual(r('desde el 3 de noviembre'), range('2026-11-03', '2026-11-10'));
});

test('N days or weeks ago, give or take two days, never past today', () => {
  assert.deepEqual(r('what did we decide 3 days ago'), range('2026-11-05', '2026-11-09'));
  assert.deepEqual(r('qué decidimos hace 3 días'), range('2026-11-05', '2026-11-09'));
  assert.deepEqual(r('two weeks ago'), null, 'numbers in words are not read');
  assert.deepEqual(r('2 weeks ago'), range('2026-10-25', '2026-10-29'));
  assert.deepEqual(r('hace 2 semanas'), range('2026-10-25', '2026-10-29'));
  assert.deepEqual(r('1 day ago'), range('2026-11-07', '2026-11-10'));
});

test('recently means the last 14 days', () => {
  for (const q of ['what did we change recently', 'lately', 'qué cambiamos últimamente', 'recientemente']) {
    assert.deepEqual(r(q), range('2026-10-28', '2026-11-10'), q);
  }
});

test('a single day: ISO, "3 Nov", "3 de noviembre"; a day with no year is the most recent one not in the future', () => {
  assert.deepEqual(r('what happened on 2026-11-03'), range('2026-11-03', '2026-11-03'));
  assert.deepEqual(r('what happened on 3 Nov'), range('2026-11-03', '2026-11-03'));
  assert.deepEqual(r('qué pasó el 3 de noviembre'), range('2026-11-03', '2026-11-03'));
  assert.deepEqual(r('what happened on 20 Nov'), range('2025-11-20', '2025-11-20'));
});

test('no time words, no range', () => {
  for (const q of ['what is the NAS password policy', 'since we moved to docker, how do backups run', 'how do I march the files', 'may I see the roadmap', 'the 30 day retention rule']) {
    assert.equal(r(q), null, q);
  }
});

test('the day is Paris\'s: half past midnight in Paris is already the next day', () => {
  assert.deepEqual(r('today', new Date('2026-11-09T23:30:00Z')), range('2026-11-10', '2026-11-10'));
});

test('factDates: the day it was saved plus every ISO date in its text and keys, once each', () => {
  const dates = factDates({ createdAt: '2026-12-01T09:00:00.000Z', content: 'Moved the NAS (2026-11-09); checked again 2026-11-09.', keys: 'migration 2026-10-01 2026-13-45' });
  assert.deepEqual(dates.sort(), ['2026-10-01', '2026-11-09', '2026-12-01']);
});

// ---- Final review fixes ----
test('a year written after the day is used, not guessed', () => {
  assert.deepEqual(r('what happened on 3 March 2025'), range('2025-03-03', '2025-03-03'));
  assert.deepEqual(r('qué pasó el 3 de noviembre de 2025'), range('2025-11-03', '2025-11-03'));
  assert.deepEqual(r('since 3 Nov 2025'), range('2025-11-03', '2026-11-10'));
  assert.deepEqual(r('What did Caroline do on 8 May, 2023?'), range('2023-05-08', '2023-05-08'));
});

test('since or desde a relative time runs from its start up to today', () => {
  assert.deepEqual(r('what changed since last week'), range('2026-11-02', '2026-11-10'));
  assert.deepEqual(r('qué cambió desde la semana pasada'), range('2026-11-02', '2026-11-10'));
  assert.deepEqual(r('since yesterday'), range('2026-11-09', '2026-11-10'));
  assert.deepEqual(r('desde ayer'), range('2026-11-09', '2026-11-10'));
  assert.deepEqual(r('since last month'), range('2026-10-01', '2026-11-10'));
  assert.deepEqual(r('antes de ayer'), range('2026-11-08', '2026-11-08'));
  assert.deepEqual(r('qué pasó anteayer'), range('2026-11-08', '2026-11-08'));
  assert.deepEqual(r('what did we do in the last week'), range('2026-11-04', '2026-11-10'));
  assert.deepEqual(r('in the past month'), range('2026-10-12', '2026-11-10'));
});

test('ordinary sentences with a number and a month-like word are not dates', () => {
  for (const q of ['which of the 3 may need an upgrade', 'these 2 may conflict', 'version 1 may break the build', 'the top 5 mar scores', 'issue 12 sep',
    'nadamos en mar abierto', '¿qué usamos hoy en día para las copias?', 'hoy por hoy usamos restic', 'hoy día es así']) {
    assert.equal(r(q), null, q);
  }
  // A day with its lead word or its year still is one.
  assert.deepEqual(r('what happened on 3 may'), range('2026-05-03', '2026-05-03'));
  assert.deepEqual(r('el 3 de mayo'), range('2026-05-03', '2026-05-03'));
  assert.deepEqual(r('3 May 2025'), range('2025-05-03', '2025-05-03'));
});

test('the day follows the owner\'s time zone setting', () => {
  const was = process.env.OWNER_TIMEZONE;
  process.env.OWNER_TIMEZONE = 'America/New_York';
  try {
    // 03:00 UTC on 10 November is still 9 November in New York.
    assert.deepEqual(r('today', new Date('2026-11-10T03:00:00Z')), range('2026-11-09', '2026-11-09'));
  } finally { process.env.OWNER_TIMEZONE = was; }
});
