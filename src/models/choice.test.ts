import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChoice, writeChoice, type ModelChoice } from './choice.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'choice-'));

test('a choice round-trips through models.json in the data folder', () => {
  const dir = tmp();
  assert.equal(readChoice(dir), null, 'no file: no choice yet');
  const c: ModelChoice = { search: 'gemma', rerank: 'mminilm' };
  writeChoice(dir, c);
  assert.ok(existsSync(join(dir, 'models.json')));
  assert.deepEqual(readChoice(dir), c);
  const online: ModelChoice = { search: 'e5', rerank: 'online', online: { model: 'example/rerank-small' } };
  writeChoice(dir, online);
  assert.deepEqual(readChoice(dir), online);
  writeChoice(dir, { search: 'e5', rerank: null });
  assert.deepEqual(readChoice(dir), { search: 'e5', rerank: null });
  assert.deepEqual(readdirSync(dir), ['models.json'], 'no temp file left behind');
});

test('a half-written temp file (a crash mid-write) leaves the last good choice in force', () => {
  const dir = tmp();
  writeChoice(dir, { search: 'e5', rerank: 'mminilm' });
  writeFileSync(join(dir, 'models.json.tmp'), '{"search":"gem');
  assert.deepEqual(readChoice(dir), { search: 'e5', rerank: 'mminilm' });
  writeChoice(dir, { search: 'gemma', rerank: null });
  assert.deepEqual(readChoice(dir), { search: 'gemma', rerank: null }, 'the next write goes through');
});

test('a damaged or unknown models.json reads as no choice, never as an error', () => {
  const dir = tmp();
  for (const bad of ['', '{"search":"gem', 'null', '[]', '{"search":"bert","rerank":null}', '{"search":"e5","rerank":"other"}', '{"search":"e5"}',
    '{"search":"e5","rerank":"online","online":{"model":7}}']) {
    writeFileSync(join(dir, 'models.json'), bad);
    assert.equal(readChoice(dir), null, bad);
  }
});

test('writeChoice refuses a choice it could not read back', () => {
  const dir = tmp();
  assert.throws(() => writeChoice(dir, { search: 'bert', rerank: null } as unknown as ModelChoice), /not a model choice/);
  assert.equal(existsSync(join(dir, 'models.json')), false);
});
