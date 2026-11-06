import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weekOf } from './memory/digest.js';
import { dayWithWeekday, localDay, longDate, ownerTimeZone, shortDay, timeOfDay, zoneOffsetMs } from './timezone.js';

// The other tests here are about Berlin's calendar; the default (UTC) has its own test below.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

const saved = process.env.OWNER_TIMEZONE;
const restore = () => {
  if (saved === undefined) delete process.env.OWNER_TIMEZONE;
  else process.env.OWNER_TIMEZONE = saved;
};

test("the owner zone defaults to this machine's zone (UTC in Docker without TZ) and follows OWNER_TIMEZONE when it changes", (t) => {
  t.after(restore);
  delete process.env.OWNER_TIMEZONE;
  assert.equal(ownerTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  process.env.OWNER_TIMEZONE = 'Europe/Berlin';
  assert.equal(localDay(new Date('2026-11-01T23:30:00Z')), '2026-11-02');
  assert.equal(weekOf(new Date('2026-11-01T23:30:00Z')).monday, '2026-11-02');
  process.env.OWNER_TIMEZONE = 'America/New_York';
  assert.equal(localDay(new Date('2026-11-01T23:30:00Z')), '2026-11-01');
  assert.equal(weekOf(new Date('2026-11-01T23:30:00Z')).monday, '2026-10-26');
});

test('dates and times are written in the owner zone', (t) => {
  t.after(restore);
  process.env.OWNER_TIMEZONE = 'Europe/Berlin';
  assert.equal(dayWithWeekday('2026-10-29T10:00:00Z'), 'Thursday 29 Oct');
  assert.equal(timeOfDay('2026-11-02T07:14:00Z'), '08:14');
  assert.equal(shortDay('2025-12-31T12:00:00Z', new Date('2026-11-03T00:00:00Z')), '31 Dec 2025');
});

test('the zone offset follows summer time', (t) => {
  t.after(restore);
  process.env.OWNER_TIMEZONE = 'Europe/Berlin';
  assert.equal(zoneOffsetMs(Date.parse('2026-07-01T12:00:00Z')), 2 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse('2026-11-01T12:00:00Z')), 3_600_000);
});

test('longDate names the weekday, day and month on the owner\'s clock', (t) => {
  t.after(restore);
  process.env.OWNER_TIMEZONE = 'Europe/Berlin';
  assert.equal(longDate(new Date('2026-11-04T09:00:00Z')), 'Wednesday 4 November');
  assert.equal(longDate(new Date('2026-11-04T23:30:00Z')), 'Thursday 5 November');
});
