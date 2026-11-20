import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PASTE_LINES, guessKind, splitCandidates } from './lines.js';
import { fakeGithubToken } from '../testing/fakeSecrets.js';

test('bullets, numbering and dates are stripped and each line becomes a candidate', () => {
  const c = splitCandidates('- Prefers short answers in meetings\n* Lives in Valencia, Spain\n1. Works as a nurse on night shifts\n2) Has two cats called Pip and Moss\n[2025-03-02] Likes dark roast coffee\n• Uses a Mac mini as a home server');
  assert.deepEqual(c.lines, ['Prefers short answers in meetings', 'Lives in Valencia, Spain', 'Works as a nurse on night shifts', 'Has two cats called Pip and Moss', 'Likes dark roast coffee', 'Uses a Mac mini as a home server']);
});

test('empty lines, very short lines, headings and repeats are dropped and counted', () => {
  const c = splitCandidates('Work:\n\n## Preferences\nok\nPrefers tea over coffee\nprefers tea over coffee\n   \n- yes');
  assert.deepEqual(c.lines, ['Prefers tea over coffee']);
  assert.equal(c.skipped, 5);
});

test('a line with a secret is refused and counted, the rest go on', () => {
  const c = splitCandidates('Likes hiking in the mountains\nMy password: hunter2hunter2\nGitHub token ' + fakeGithubToken('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.deepEqual(c.lines, ['Likes hiking in the mountains']);
  assert.equal(c.secrets, 2);
});

test('at most 200 lines are taken, the rest counted', () => {
  const text = Array.from({ length: 230 }, (_, i) => `Candidate fact number ${i} about something`).join('\n');
  const c = splitCandidates(text);
  assert.equal(c.lines.length, MAX_PASTE_LINES);
  assert.equal(c.overCap, 30);
});

test('Windows line breaks and a very long line are handled', () => {
  const c = splitCandidates(`First fact about the owner\r\n${'word '.repeat(400)}`);
  assert.equal(c.lines.length, 2);
  assert.ok(c.lines[1]!.length <= 1000);
});

test('lines about the person are guessed as profile, the rest as decisions', () => {
  for (const l of ['I live in Valencia', "I'm allergic to nuts", 'My sister is called Ana', 'User prefers short answers', 'Prefers dark mode everywhere', 'Name is Alex', 'Lives in Valencia, Spain']) assert.equal(guessKind(l), 'profile', l);
  for (const l of ['Use Postgres for the billing service', 'Itinerary is booked for May', 'Mylar balloons are banned', 'Index the pages table']) assert.equal(guessKind(l), 'decision', l);
});
