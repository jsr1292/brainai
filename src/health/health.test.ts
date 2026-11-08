import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainHealth, FRESH_DAYS, MAX_REASONS, type HealthInput } from './health.js';

const now = new Date('2026-11-08T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

const good = (): HealthInput => ({
  projects: [
    { name: 'homelab', lastUpdate: daysAgo(2), hasStatus: true, hasRoadmap: true },
    { name: 'wildlog', lastUpdate: daysAgo(10), hasStatus: true, hasRoadmap: true },
  ],
  outOfDatePages: [],
  profileFacts: 4,
  apps: [{ name: 'Claude Code', setup: 'current', href: '/settings/setup/claude-code' }],
  backups: { ok: true, problems: [] },
  waiting: { approvals: 0, disagreements: 0, overdue: [], discussions: [] },
});

test('a brain with everything in order is 100 on all three, with nothing to do', () => {
  const h = brainHealth(good(), now);
  for (const part of [h.upToDate, h.ready, h.waiting]) {
    assert.equal(part.score, 100);
    assert.deepEqual(part.reasons, []);
  }
});

test('an empty new brain does not divide by zero and asks for something about you', () => {
  const h = brainHealth({ projects: [], outOfDatePages: [], profileFacts: 0, apps: [], backups: null, waiting: { approvals: 0, disagreements: 0, overdue: [], discussions: [] } }, now);
  assert.equal(h.upToDate.score, 100);
  assert.equal(h.ready.score, 0);
  assert.deepEqual(h.ready.reasons, [{ text: 'Nothing about you yet: add a fact to your profile', href: '/facts?kind=profile' }]);
  assert.equal(h.waiting.score, 100);
});

test('up to date: the share of open projects updated in the last 30 days; pages behind newer decisions count against it', () => {
  const input = good();
  input.projects.push({ name: 'old-one', lastUpdate: daysAgo(FRESH_DAYS + 15), hasStatus: true, hasRoadmap: true });
  input.projects.push({ name: 'never', lastUpdate: null, hasStatus: false, hasRoadmap: false });
  input.outOfDatePages = [{ id: 'p1', title: 'homelab — the mini PC' }];
  const h = brainHealth(input, now);
  assert.equal(h.upToDate.score, 40); // 2 fresh of 5
  assert.deepEqual(h.upToDate.reasons, [
    { text: 'never has no status yet', href: '/?project=never#panel' },
    { text: 'old-one was last updated 45 days ago', href: '/?project=old-one#panel' },
    { text: 'Page "homelab — the mini PC" may be out of date', href: '/pages/p1' },
  ]);
});

test('ready: each check is an equal share — profile, each project\'s status and roadmap, each app\'s setup text, backups', () => {
  const input = good();
  input.projects[1] = { ...input.projects[1]!, hasRoadmap: false };
  input.apps.push({ name: 'Codex', setup: 'older', href: '/settings/setup/codex' });
  input.backups = { ok: false, problems: ['No nightly backup since 3 Nov'] };
  const h = brainHealth(input, now);
  assert.equal(h.ready.score, 50); // profile, homelab, Claude Code pass; wildlog, Codex, backups fail
  assert.deepEqual(h.ready.reasons, [
    { text: 'wildlog has no roadmap', href: '/?project=wildlog#panel' },
    { text: 'Codex runs an older setup text', href: '/settings/setup/codex' },
    { text: 'Backups: No nightly backup since 3 Nov', href: '/settings#health' },
  ]);
});

test('ready: no backup status (the desktop app, or a server without the backup jobs) is not counted against it', () => {
  const input = good();
  input.backups = null;
  assert.equal(brainHealth(input, now).ready.score, 100);
});

test('waiting on you: 100 less 10 for each thing, never below 0, each with where to deal with it', () => {
  const input = good();
  input.waiting = {
    approvals: 2, disagreements: 1,
    overdue: [{ project: 'homelab', text: 'swap the disk', due: '2026-11-03' }],
    discussions: [{ id: 'd1', title: 'Pick a DB' }],
  };
  const h = brainHealth(input, now);
  assert.equal(h.waiting.score, 50);
  assert.deepEqual(h.waiting.reasons, [
    { text: '2 changes wait for your approval', href: '/approvals' },
    { text: '2 facts disagree', href: '/disagreements' },
    { text: 'homelab: "swap the disk" was due 3 Nov', href: '/?project=homelab#panel' },
    { text: 'Pick a DB waits on you', href: '/discussions/d1' },
  ]);
  input.waiting.approvals = 30;
  assert.equal(brainHealth(input, now).waiting.score, 0);
});

test('a part lists at most five reasons, then how many more', () => {
  const input = good();
  input.projects = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, lastUpdate: daysAgo(40 + i), hasStatus: true, hasRoadmap: true }));
  const r = brainHealth(input, now).upToDate.reasons;
  assert.equal(r.length, MAX_REASONS + 1);
  assert.deepEqual(r.at(-1), { text: 'and 3 more', href: '/' });
  assert.equal(r[0]!.text, 'p7 was last updated 47 days ago');
});

test('a part with something to fix never reads 100', () => {
  const input = good();
  input.projects = Array.from({ length: 199 }, (_, i) => ({ name: `p${i}`, lastUpdate: daysAgo(1), hasStatus: true, hasRoadmap: true }));
  input.projects.push({ name: 'old', lastUpdate: daysAgo(90), hasStatus: true, hasRoadmap: true });
  const h = brainHealth(input, now);
  assert.equal(h.upToDate.score, 99);
  assert.equal(h.upToDate.reasons.length, 1);
});

test("an app that hasn't reported its setup text yet is said so, not called older", () => {
  const input = good();
  input.apps.push({ name: 'Grok', setup: 'unknown', href: '/settings/setup/grok' });
  assert.deepEqual(brainHealth(input, now).ready.reasons, [{ text: "Grok hasn't reported its setup text yet", href: '/settings/setup/grok' }]);
});
