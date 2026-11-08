import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Health } from '../health/health.js';
import { healthRow } from './healthViews.js';

const fine = { score: 100, reasons: [] };
const row = (h: Health) => healthRow(h)?.value ?? null;

test('the For you row never repeats a row For you already has (approvals, disagreements, discussions)', () => {
  const waiting = { score: 50, reasons: [
    { text: '4 changes wait for your approval', href: '/approvals' },
    { text: '2 facts disagree', href: '/disagreements' },
    { text: 'Pick a DB waits on you', href: '/discussions/d1' },
  ] };
  assert.equal(row({ upToDate: fine, ready: fine, waiting }), null);
  const withOverdue = { ...waiting, reasons: [...waiting.reasons, { text: 'homelab: "swap the disk" was due 3 Nov', href: '/?project=homelab#panel' }] };
  assert.match(row({ upToDate: fine, ready: fine, waiting: withOverdue })!, /<b>Brain health<\/b>: homelab: &quot;swap the disk&quot; was due 3 Nov/);
});

test('the lowest part under 70 speaks first; at 70 and above there is no row', () => {
  const upToDate = { score: 60, reasons: [{ text: 'homelab was last updated 45 days ago', href: '/?project=homelab#panel' }] };
  const ready = { score: 40, reasons: [{ text: 'Nothing about you yet: add a fact to your profile', href: '/facts?kind=profile' }] };
  assert.match(row({ upToDate, ready, waiting: fine })!, /Nothing about you yet/);
  assert.equal(row({ upToDate: { ...upToDate, score: 70 }, ready: fine, waiting: fine }), null);
});
