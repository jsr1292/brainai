/** Values from a crafted saved file, as they appear in messages. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { plain, shown } from './shown.js';
import { restoredRowsProblem } from './rowChecks.js';
import { checkArchive } from './archive.js';
import { handTar } from './testArchives.js';

const CRAFTED = `\u001b[2J\u001b]0;pwned\u0007${'x'.repeat(10_000)}`;
const noControl = (s: string) => assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f]/);

test('a quoted value is cut near 80 characters, ends in an ellipsis and holds no raw control character', () => {
  const s = shown(CRAFTED);
  assert.ok(s.length < 100, `${s.length}`);
  assert.ok(s.endsWith('…"'));
  noControl(s);
  assert.equal(shown('../../x'), '"../../x"', 'a short value is only quoted');
  assert.equal(shown('a\nb'), '"a\\nb"');
});

test('a crafted column value gives a short message with no raw control character', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-shown-'));
  try {
    const c = new Database(join(dir, 'memory.db'));
    c.exec('CREATE TABLE skills(id TEXT, name TEXT)');
    c.prepare('INSERT INTO skills VALUES (?, ?)').run('s1', CRAFTED);
    c.close();
    const problem = restoredRowsProblem(join(dir, 'memory.db'))!;
    assert.ok(problem.startsWith('skills.name: '));
    assert.ok(problem.length < 200, `${problem.length}`);
    noControl(problem);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a long entry name in a saved file is quoted and cut in the refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-shown-'));
  try {
    const r = await checkArchive(handTar(join(dir, 'a.tar.gz'), `../${'y'.repeat(90)}`));
    assert.equal(r.ok, false);
    const reason = (r as { reason: string }).reason;
    assert.ok(reason.length < 200, `${reason.length}`);
    assert.match(reason, /\("\.\.\/y+…"\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('C1 controls and bidi controls are escaped too, one case per range', () => {
  const cases: [string, string][] = [
    ['\u007f', '\\u007f'], ['\u009b', '\\u009b'], ['\u0080', '\\u0080'], ['\u009f', '\\u009f'],
    ['\u061c', '\\u061c'], ['\u200e', '\\u200e'], ['\u200f', '\\u200f'],
    ['\u202a', '\\u202a'], ['\u202e', '\\u202e'], ['\u2066', '\\u2066'], ['\u2069', '\\u2069'],
  ];
  for (const [raw, escaped] of cases) {
    assert.equal(shown(`a${raw}b`), `"a${escaped}b"`);
    assert.equal(plain(`a${raw}b`), `a${escaped}b`);
  }
  assert.equal(plain('é and … stay'), 'é and … stay');
  assert.ok(plain('q'.repeat(1000)).length <= 301);
});

test('shown source spells bidi controls with escapes', () => {
  const source = readFileSync(new URL('./shown.ts', import.meta.url), 'utf8');
  assert.equal(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(source), false);
});
