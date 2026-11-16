import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteKey, readKey, writeKey } from './onlineKey.js';

const dir = () => mkdtempSync(join(tmpdir(), 'brainai-key-'));

test('no key: null; a saved key reads back, mode 600, no temp file left', () => {
  const d = dir();
  assert.equal(readKey(d), null);
  writeKey(d, 'sk-or-made-up-1');
  assert.equal(readKey(d), 'sk-or-made-up-1');
  assert.equal(statSync(join(d, 'openrouter-key')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(d), ['openrouter-key']);
  writeKey(d, 'sk-or-made-up-2');
  assert.equal(readKey(d), 'sk-or-made-up-2');
  assert.equal(statSync(join(d, 'openrouter-key')).mode & 0o777, 0o600);
  rmSync(d, { recursive: true });
});

test('delete removes it, and deleting nothing is fine; an empty file reads as no key', () => {
  const d = dir();
  writeKey(d, 'sk-or-made-up-1');
  deleteKey(d);
  assert.equal(existsSync(join(d, 'openrouter-key')), false);
  deleteKey(d);
  writeFileSync(join(d, 'openrouter-key'), '  \n');
  assert.equal(readKey(d), null);
  rmSync(d, { recursive: true });
});

test('a key that is empty or has spaces or newlines is refused, and an error never holds the key', () => {
  const d = dir();
  for (const bad of ['', '  ', 'two words', 'line\nbreak']) assert.throws(() => writeKey(d, bad), (e: Error) => !e.message.includes(bad.trim() || '\u0000'));
  assert.equal(readKey(d), null);
  rmSync(d, { recursive: true });
});

test('a stale temp file left by a crash never keeps its wider mode: the key is written to a fresh file', () => {
  const d = dir();
  writeFileSync(join(d, 'openrouter-key.tmp'), 'old', { mode: 0o644 });
  writeKey(d, 'sk-or-made-up-3');
  assert.equal(statSync(join(d, 'openrouter-key')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(d), ['openrouter-key']);
  rmSync(d, { recursive: true });
});
