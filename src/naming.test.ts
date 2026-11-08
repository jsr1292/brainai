import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The project was called Cairn until 2026-11-08; it is BrainAI now. Only the records of that time keep the old name.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = ['c', 'a', 'i', 'r', 'n'].join('');
const historical = (file: string) =>
  file === 'CHANGELOG.md' || file.startsWith('docs/superpowers/') || file === 'src/naming.test.ts';

test('outside its own git checkout the guard has nothing to check (the publish gate tests a copy without .git)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'naming-'));
  const repo = mkdtempSync(join(tmpdir(), 'naming-repo-'));
  try {
    assert.equal(oldNameFiles(plain), null);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'inner'));
    assert.equal(oldNameFiles(join(repo, 'inner')), null); // inside some other repo: not ours to judge
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// Tracked files saying the old name, or null when dir is not the top of a git checkout (a published copy, a ZIP).
function oldNameFiles(dir: string): string[] | null {
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  if (realpathSync(top) !== realpathSync(dir)) return null;
  try {
    return execFileSync('git', ['grep', '-il', OLD], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e: any) {
    if (e.status === 1) return []; // 1 means no match at all
    throw e;
  }
}

test('nothing outside the historical records says the old name', (t) => {
  const files = oldNameFiles(root);
  if (files === null) return t.skip('not a git checkout');
  assert.deepEqual(files.filter((f) => !historical(f)), []);
});

test('the changelog says the old name only in the 1.0.0 release and the rename line', () => {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const before = text.slice(0, text.indexOf('\n## 1.0.0'));
  const lines = before.split('\n').filter((l) => new RegExp(OLD, 'i').test(l));
  assert.deepEqual(lines, ['- **Cairn is now called BrainAI.** Your memories and settings stay as they are.']);
});
