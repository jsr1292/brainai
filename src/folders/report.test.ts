import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderKey, parseReport, ReportError, stripCredentials } from './report.js';

const bad = (re: RegExp) => (e: unknown) => e instanceof ReportError && re.test(e.message);

test('parseReport accepts a good report and fills defaults', () => {
  const f = parseReport({ folders: [
    { name: 'wildlog', git: true, branch: 'main', uncommitted: 2, unpushed: 1, lastCommit: '2026-11-03T10:00:00+01:00', remotes: ['ssh://owner@192.0.2.10/home/owner/git/wildlog.git'] },
    { name: 'carpeta sin título', git: false },
  ] });
  assert.deepEqual(f[1], { name: 'carpeta sin título', git: false, branch: null, uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] });
  assert.equal(f[0].unpushed, 1);
  assert.equal(f[0].lastCommit, '2026-11-03T10:00:00+01:00');
});

test('parseReport refuses 301 folders, a name with a slash, a string count, a bad date and 11 remotes', () => {
  assert.throws(() => parseReport({ folders: Array.from({ length: 301 }, (_, i) => ({ name: `f${i}`, git: false })) }), bad(/at most 300 folders/));
  assert.throws(() => parseReport({ folders: [{ name: 'a/b', git: false }] }), bad(/name/));
  assert.throws(() => parseReport({ folders: [{ name: '', git: false }] }), bad(/name/));
  assert.throws(() => parseReport({ folders: [{ name: 'x', git: true, uncommitted: '3' }] }), bad(/uncommitted/));
  assert.throws(() => parseReport({ folders: [{ name: 'x', git: true, unpushed: -1 }] }), bad(/unpushed/));
  assert.throws(() => parseReport({ folders: [{ name: 'x', git: true, lastCommit: 'yesterday' }] }), bad(/lastCommit/));
  assert.throws(() => parseReport({ folders: [{ name: 'x', git: true, remotes: Array.from({ length: 11 }, () => 'r') }] }), bad(/remotes/));
  assert.throws(() => parseReport({ folders: [{ name: 'x', git: 'yes' }] }), bad(/git/));
  assert.throws(() => parseReport({ nope: [] }), bad(/folders/));
  assert.throws(() => parseReport(null), bad(/folders/));
});

test('stripCredentials removes user and token from https remotes and keeps ssh remotes', () => {
  assert.equal(stripCredentials('https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789AB@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(stripCredentials('https://ghp_abc@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(stripCredentials('ssh://owner@192.0.2.10/home/owner/git/a.git'), 'ssh://192.0.2.10/home/owner/git/a.git');
  assert.equal(stripCredentials('git@github.com:x/y.git'), 'git@github.com:x/y.git');
  const stored = parseReport({ folders: [{ name: 'x', git: true, remotes: ['https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789AB@github.com/x/y.git'] }] });
  assert.deepEqual(stored[0].remotes, ['https://github.com/x/y.git']);
});

test('folderKey lowercases and turns spaces and underscores into dashes', () => {
  assert.equal(folderKey('  Pine Lodge '), 'pine-lodge');
  assert.equal(folderKey('Puzzle_club'), 'puzzle-club');
  assert.equal(folderKey('CsvMerge'), 'csvmerge');
});

test('parseReport keeps an unknown count as null, so a git that did not answer never reads as clean', () => {
  const [f] = parseReport({ folders: [{ name: 'bigrepo', git: true, branch: 'main', uncommitted: null, unpushed: null }] });
  assert.deepEqual([f!.uncommitted, f!.unpushed], [null, null]);
});
