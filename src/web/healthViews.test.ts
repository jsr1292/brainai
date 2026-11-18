import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Health } from '../health/health.js';
import { healthRow } from './healthViews.js';

const fine = { score: 100, reasons: [] };
const row = (h: Health) => healthRow(h)?.value ?? null;

test('the For you row never repeats a row For you already has (approvals, disagreements, discussions)', () => {
  const waiting = { score: 50, reasons: [
    { text: '4 changes wait for your approval', href: '/approvals' },
    { text: '1 pair of facts disagrees', href: '/disagreements' },
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

import { profileBlock, PROFILE_LARGE_WORDS } from './healthViews.js';

const mem = (id: string, content: string) => ({ id, content });
const prof = (p: Parameters<typeof profileBlock>[0]) => profileBlock(p)?.value ?? '';

test('the profile line gives the entries and the words, and a note only above the large threshold', () => {
  const small = prof({ entries: 1, words: 12, pairs: [] });
  assert.match(small, /Your profile: 1 entry, about 12 words\./);
  assert.doesNotMatch(small, /consider merging/);
  const big = prof({ entries: 80, words: PROFILE_LARGE_WORDS + 1, pairs: [] });
  assert.match(big, /Your profile: 80 entries, about 1,501 words\./);
  assert.match(big, /every assistant reads all of this at the start of every conversation; consider merging or removing entries/);
  assert.doesNotMatch(prof({ entries: 80, words: PROFILE_LARGE_WORDS, pairs: [] }), /consider merging/);
});

test('entries that say nearly the same thing link to both fact pages', () => {
  const s = prof({ entries: 2, words: 10, pairs: [{ a: mem('a1', 'Prefers <b>dark</b> mode'), b: mem('b2', 'Likes dark mode') }] });
  assert.match(s, /Entries that say nearly the same thing/);
  assert.match(s, /<a href="\/memories\/a1">Prefers &lt;b&gt;dark&lt;\/b&gt; mode<\/a>[\s\S]*<a href="\/memories\/b2">Likes dark mode<\/a>/);
});

test('with no profile entries there is no profile line, and with no pairs no near-duplicates line', () => {
  assert.equal(profileBlock({ entries: 0, words: 0, pairs: [] }), null);
  assert.equal(profileBlock(undefined), null);
  assert.doesNotMatch(prof({ entries: 3, words: 30, pairs: [] }), /nearly the same thing/);
});
