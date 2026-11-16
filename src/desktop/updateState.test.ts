import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laterVersion, readUpdate, setLater, updateLine, type UpdateFile } from './updateState.js';

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
