import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'windows', 'vcruntime.sh');
const run = (args: string[], env: Record<string, string>) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });

test('vcruntime.sh --list names the five runtime files BrainAI ships', () => {
  const r = run(['--list'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll']);
});

test('a package that is not the pinned one is refused, naming the expected SHA-256, and nothing is staged', () => {
  const root = mkdtempSync(join(tmpdir(), 'vcruntime-test-'));
  try {
    const fake = join(root, 'fake.exe');
    writeFileSync(fake, 'not Microsoft');
    const dest = join(root, 'dest');
    mkdirSync(dest);
    const r = run([dest], { VC_CACHE: join(root, 'cache'), VC_REDIST_URL: `file://${fake}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b/);
    assert.deepEqual(readdirSync(dest), []);
    assert.ok(!existsSync(join(root, 'cache', 'VC_redist.x64.exe')), 'a bad download is never kept in the cache');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the pin check runs before anything needs cabextract, so a wrong package is named even without it', () => {
  const root = mkdtempSync(join(tmpdir(), 'vcruntime-test-'));
  try {
    const fake = join(root, 'fake.exe');
    writeFileSync(fake, 'not Microsoft');
    const r = spawnSync('/bin/bash', [SCRIPT, join(root, 'dest')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, VC_CACHE: join(root, 'cache'), VC_REDIST_URL: `file://${fake}` } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
