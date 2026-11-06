import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETUP_VERSION, loadSetupOverlay } from './setup/texts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const haveGit = git(repoRoot, '--version').status === 0;
const inGitCheckout = haveGit && git(repoRoot, 'rev-parse', '--is-inside-work-tree').stdout.trim() === 'true';

test('a symlinked node_modules (as in a git worktree) is ignored and never committed', { skip: !haveGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-hygiene-'));
  try {
    assert.equal(git(dir, 'init', '-q').status, 0);
    copyFileSync(join(repoRoot, '.gitignore'), join(dir, '.gitignore'));
    const realModules = join(dir, 'elsewhere', 'node_modules');
    mkdirSync(realModules, { recursive: true });
    symlinkSync(realModules, join(dir, 'node_modules'));
    assert.equal(git(dir, 'add', '-A').status, 0);
    const staged = git(dir, 'diff', '--cached', '--name-only').stdout.split('\n');
    assert.ok(!staged.includes('node_modules'), `node_modules symlink got staged: ${staged.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository does not track a node_modules entry', { skip: !inGitCheckout }, () => {
  const tracked = git(repoRoot, 'ls-files', '--', 'node_modules').stdout.trim();
  assert.equal(tracked, '', `node_modules is tracked: ${tracked}`);
});

test('a stranger finds a README, licence, security note, changelog and examples at the top of the repository', () => {
  for (const file of ['README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', '.env.example', 'overlay.example/setup.json',
    'overlay.example/scripts.env', 'docs/ARCHITECTURE.md', '.github/workflows/check.yml']) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} is missing`);
  }
  assert.match(readFileSync(join(repoRoot, 'LICENSE'), 'utf8'), /^MIT License/);
});

test('every setting the app or docker-compose.yml reads is explained in .env.example', () => {
  const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
  const config = readFileSync(join(repoRoot, 'src', 'config.ts'), 'utf8');
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const names = new Set([
    ...[...config.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    'OWNER_TIMEZONE',
  ]);
  assert.ok(names.size >= 15, `found only ${names.size} settings: the pattern is wrong`);
  for (const name of names) assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), `${name} is not in .env.example`);
});

test('the overlay example is valid: setup.json parses and scripts.env is KEY=value lines', () => {
  const setup = loadSetupOverlay(join(repoRoot, 'overlay.example'));
  assert.ok(setup && setup.version >= SETUP_VERSION, 'overlay.example/setup.json should load, with a version at least the built-in one');
  for (const line of readFileSync(join(repoRoot, 'overlay.example', 'scripts.env'), 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    assert.match(line, /^[A-Z_][A-Z0-9_]*=/, line);
  }
});

test('.env.example holds no tunnel token', () => {
  const line = readFileSync(join(repoRoot, '.env.example'), 'utf8').split('\n').find((l) => l.startsWith('TUNNEL_TOKEN='));
  assert.equal(line, 'TUNNEL_TOKEN=');
});

test('every picture the README shows is in the repository, and every one has a description', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const pictures = [...readme.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  assert.ok(pictures.length >= 6, `pictures: ${pictures.length}`);
  for (const [, alt, path] of pictures) {
    assert.ok(alt!.trim().length >= 10, `${path} needs a description`);
    assert.ok(existsSync(join(repoRoot, path!)), `${path} is missing`);
  }
});
