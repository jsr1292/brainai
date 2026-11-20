import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearJustUpdated, laterVersion, readJustUpdated, sideUpdate, offsiteNudgeDue, offsiteNudgeHidden, readUpdate, readUpdateCheck, setLater, setOffsiteLater, updateCheckProblem, updateLine, type UpdateFile } from './updateState.js';

const dir = () => mkdtempSync(join(tmpdir(), 'brainai-update-'));
const write = (d: string, v: unknown) => writeFileSync(join(d, 'update.json'), typeof v === 'string' ? v : JSON.stringify(v));
const file = (o: Partial<UpdateFile> = {}): UpdateFile => ({ current: '1.3.0', version: '1.3.1', notes: '- one', state: 'available', ...o });

test('readUpdate is null for no file, broken JSON, an unknown state, and a version not newer', () => {
  const d = dir();
  assert.equal(readUpdate(d, '1.3.0'), null);
  write(d, '{nope');
  assert.equal(readUpdate(d, '1.3.0'), null);
  write(d, file({ state: 'exploding' as never }));
  assert.equal(readUpdate(d, '1.3.0'), null);
  write(d, file({ version: '1.3.0' }));
  assert.equal(readUpdate(d, '1.3.0'), null);
  write(d, file({ version: '1.2.9' }));
  assert.equal(readUpdate(d, '1.3.0'), null);
});

test('readUpdate compares versions as numbers, not strings', () => {
  const d = dir();
  write(d, file());
  assert.equal(readUpdate(d, '1.3.0')?.version, '1.3.1');
  write(d, file({ version: '1.10.0' }));
  assert.equal(readUpdate(d, '1.9.0')?.version, '1.10.0');
});

test('notes are cut to 1,500 characters', () => {
  const d = dir();
  write(d, file({ notes: 'x'.repeat(5000) }));
  assert.equal(readUpdate(d, '1.3.0')?.notes.length, 1500);
});

test('setLater and laterVersion round-trip', () => {
  const d = dir();
  assert.equal(laterVersion(d), null);
  setLater(d, '1.3.1');
  assert.equal(laterVersion(d), '1.3.1');
});

test('updateLine says each state in plain words', () => {
  assert.deepEqual(updateLine(file()), { title: 'BrainAI 1.3.1 is ready (you have 1.3.0)', text: '', busy: false, failed: false });
  assert.equal(updateLine(file({ state: 'backing-up' })).text, 'Making a backup of your brain first…');
  assert.equal(updateLine(file({ state: 'backing-up' })).busy, true);
  assert.equal(updateLine(file({ state: 'downloading', percent: 40 })).text, 'Downloading BrainAI 1.3.1… 40%');
  assert.equal(updateLine(file({ state: 'installing' })).text, 'Installing… BrainAI reopens by itself in a moment.');
  const failed = updateLine(file({ state: 'failed', problem: 'No space left.' }));
  assert.equal(failed.text, 'The update did not finish: No space left. BrainAI 1.3.0 is still running.');
  assert.equal(failed.failed, true);
  assert.equal(failed.busy, false);
  assert.equal(updateLine(file({ state: 'blocked', problem: 'Close the other BrainAI first.' })).text, 'Close the other BrainAI first.');
});

// ---- update-check.json: what the app's last checks found ----

const DAY = 86_400;
const checkFile = (d: string, v: unknown) => writeFileSync(join(d, 'update-check.json'), typeof v === 'string' ? v : JSON.stringify(v));

test('readUpdateCheck is null for no file, broken JSON, or nothing useful; it keeps only valid fields', () => {
  const d = dir();
  assert.equal(readUpdateCheck(d), null);
  checkFile(d, '{nope');
  assert.equal(readUpdateCheck(d), null);
  checkFile(d, []);
  assert.equal(readUpdateCheck(d), null);
  checkFile(d, { lastOkAt: 'yesterday', failingSince: -5, lastError: 7 });
  assert.deepEqual(readUpdateCheck(d), {});
  checkFile(d, { lastOkAt: 100, failingSince: 200, lastError: 'x'.repeat(900) });
  assert.deepEqual(readUpdateCheck(d), { lastOkAt: 100, failingSince: 200, lastError: 'x'.repeat(300) });
});

test('updateCheckProblem speaks only when checks kept failing for two days', () => {
  const failing = 1_763_251_200 + 43_200; // 2025-11-16T12:00:00Z
  const at = (secs: number) => new Date(secs * 1000);
  const since = new Date(failing * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  assert.equal(updateCheckProblem(null, at(failing)), null);
  assert.equal(updateCheckProblem({ lastOkAt: failing }, at(failing + 9 * DAY)), null);
  assert.equal(updateCheckProblem({ failingSince: failing, lastFailAt: failing + 2 * DAY - 1 }, at(failing + 9 * DAY)), null);
  const p = updateCheckProblem({ failingSince: failing, lastFailAt: failing + 2 * DAY, lastError: 'Could not fetch a valid release JSON from the remote' }, at(failing + 2 * DAY));
  assert.equal(p?.since, since);
  assert.equal(p?.error, 'Could not fetch a valid release JSON from the remote');
  assert.equal(updateCheckProblem({ failingSince: failing, lastFailAt: failing + 3 * DAY }, at(failing + 3 * DAY))?.error, undefined);
  // One failure, then the laptop was off for days: no retry has failed yet, so no warning.
  assert.equal(updateCheckProblem({ failingSince: failing, lastFailAt: failing }, at(failing + 3 * DAY)), null);
  // An old file without lastFailAt says nothing.
  assert.equal(updateCheckProblem({ failingSince: failing }, at(failing + 9 * DAY)), null);
  // A clock that moved backwards is not a failure of days.
  assert.equal(updateCheckProblem({ failingSince: failing + 5 * DAY, lastFailAt: failing }, at(failing)), null);
});

test('readUpdateCheck keeps lastFailAt when it is a time', () => {
  const d = dir();
  checkFile(d, { failingSince: 200, lastFailAt: 900 });
  assert.deepEqual(readUpdateCheck(d), { failingSince: 200, lastFailAt: 900 });
  checkFile(d, { failingSince: 200, lastFailAt: 'soon' });
  assert.deepEqual(readUpdateCheck(d), { failingSince: 200 });
});

// ---- the off-site nudge on Home ----

const NOW = new Date('2026-11-20T10:00:00Z');
const nudge = (o: Partial<Parameters<typeof offsiteNudgeDue>[0]> = {}) => offsiteNudgeDue({
  localMode: true, offsiteSet: false, gitSet: false, firstMemoryAt: '2026-11-10T09:00:00Z', now: NOW, ...o,
});

test('the off-site nudge shows only for an app brain at least three days old with no off-site folder and no git copy', () => {
  assert.equal(nudge(), true);
  assert.equal(nudge({ localMode: false }), false);
  assert.equal(nudge({ offsiteSet: true }), false);
  assert.equal(nudge({ gitSet: true }), false);
  assert.equal(nudge({ firstMemoryAt: null }), false);
  assert.equal(nudge({ firstMemoryAt: 'garbage' }), false);
  assert.equal(nudge({ firstMemoryAt: '2026-11-17T10:00:01Z' }), false);
  assert.equal(nudge({ firstMemoryAt: '2026-11-17T10:00:00Z' }), true);
});

test('Later hides the off-site nudge for 30 days', () => {
  const d = dir();
  assert.equal(offsiteNudgeHidden(d, NOW), false);
  setOffsiteLater(d, NOW);
  assert.equal(offsiteNudgeHidden(d, NOW), true);
  assert.equal(offsiteNudgeHidden(d, new Date(NOW.getTime() + 29 * DAY * 1000)), true);
  assert.equal(offsiteNudgeHidden(d, new Date(NOW.getTime() + 30 * DAY * 1000)), false);
  writeFileSync(join(d, 'offsite-later'), 'junk');
  assert.equal(offsiteNudgeHidden(d, NOW), false);
});

test('readUpdate reads the ready state (downloaded, waiting for a restart)', () => {
  const d = dir();
  write(d, file({ state: 'ready' }));
  assert.equal(readUpdate(d, '1.3.0')?.state, 'ready');
});

test('the ready line tells the owner to restart to finish, and is not busy', () => {
  const l = updateLine(file({ state: 'ready' }));
  assert.equal(l.text, 'Restart to finish. It takes a few seconds.');
  assert.equal(l.busy, false);
  assert.equal(l.failed, false);
});

test('the sidebar says something only while downloading or ready', () => {
  assert.deepEqual(sideUpdate(file({ state: 'downloading', percent: 42 })), { state: 'downloading', percent: 42 });
  assert.deepEqual(sideUpdate(file({ state: 'downloading' })), { state: 'downloading' }, 'no percent known yet');
  assert.deepEqual(sideUpdate(file({ state: 'ready' })), { state: 'ready' });
  for (const state of ['available', 'backing-up', 'installing', 'failed', 'blocked'] as const) assert.equal(sideUpdate(file({ state })), null, state);
  assert.equal(sideUpdate(null), null);
});

test('just-updated.json reads its version and notes, ignores a broken or newer one, and is cleared by clearJustUpdated', () => {
  const d = dir();
  assert.equal(readJustUpdated(d, '1.7.2'), null, 'absent');
  const put = (v: unknown) => writeFileSync(join(d, 'just-updated.json'), typeof v === 'string' ? v : JSON.stringify(v));
  put('{nope');
  assert.equal(readJustUpdated(d, '1.7.2'), null, 'broken');
  put({ version: '1.7.2' });
  assert.equal(readJustUpdated(d, '1.7.2'), null, 'no notes field');
  put({ version: '1.7.3', notes: '- x' });
  assert.equal(readJustUpdated(d, '1.7.2'), null, 'newer than the running server: not this update');
  assert.equal(existsSync(join(d, 'just-updated.json')), false, 'a file of another version is deleted');
  put({ version: '1.7.1', notes: '- x' });
  assert.equal(readJustUpdated(d, '1.7.2'), null, 'an older one is stale too');
  assert.equal(existsSync(join(d, 'just-updated.json')), false);
  put({ version: '1.7.2', notes: '- Faster search' });
  assert.deepEqual(readJustUpdated(d, '1.7.2'), { version: '1.7.2', notes: '- Faster search' });
  put({ version: '1.7.2', notes: 'x'.repeat(5000) });
  assert.equal(readJustUpdated(d, '1.7.2')?.notes.length, 1500);
  clearJustUpdated(d);
  assert.equal(readJustUpdated(d, '1.7.2'), null);
  clearJustUpdated(d); // nothing there: no error
});
