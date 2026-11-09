/** scripts/publish/release.sh: a gated snapshot of the private repo's HEAD becomes one commit and tag on the public repo. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const release = join(repoRoot, 'scripts', 'publish', 'release.sh');
const haveGit = spawnSync('git', ['--version']).status === 0;
// The release script run by these tests never inherits a publisher from whoever runs them (a real release sets one).
const { PUBLISH_NAME: _name, PUBLISH_EMAIL: _email, ...callerEnv } = process.env;
const WORD = ['Zan', 'zibar', 'quux'].join('');
const AUTHOR = { PUBLISH_NAME: 'publisher', PUBLISH_EMAIL: 'publisher@users.noreply.example' };

function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const priv = join(dir, 'private');
  const write = (path: string, content: string) => { mkdirSync(dirname(join(priv, path)), { recursive: true }); writeFileSync(join(priv, path), content); };
  mkdirSync(priv);
  git(priv, 'init', '-q', '-b', 'main');
  write('README.md', '# A brain\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('docs/superpowers/plans/p.md', 'a private plan\n');
  write('CHANGELOG.md', '# Changelog\n\n## 1.0.1 (2026-11-07)\n\n- A fix.\n\n## 1.0.0 (2026-11-06)\n\nThe first.\n');
  write('package.json', '{ "name": "brain", "version": "1.0.1" }\n');
  git(priv, 'add', '-A');
  git(priv, 'commit', '-qm', 'private history');
  // The public repo: one commit already, as on GitHub.
  const pubSeed = join(dir, 'pubseed');
  mkdirSync(pubSeed);
  git(pubSeed, 'init', '-q', '-b', 'main');
  writeFileSync(join(pubSeed, 'README.md'), '# A brain\n');
  writeFileSync(join(pubSeed, 'old.ts'), 'gone in the next release\n');
  git(pubSeed, 'add', '-A');
  git(pubSeed, 'commit', '-qm', 'BrainAI 1.0.0');
  git(pubSeed, 'tag', 'v1.0.0');
  const pub = join(dir, 'public.git');
  git(dir, 'clone', '-q', '--bare', pubSeed, pub);
  const denylist = join(dir, 'denylist.txt');
  writeFileSync(denylist, `${WORD}\n`);
  return {
    priv, pub, git, write,
    dir, denylist,
    run: (version: string, env: Record<string, string> = AUTHOR, ...extra: string[]) => {
      const list = extra.find((e) => e.startsWith('list=')); const opts = extra.filter((e) => !e.startsWith('list='));
      const r = spawnSync('bash', [release, list ? list.slice(5) : denylist, pub, version, '--no-tests', ...opts], { cwd: priv, encoding: 'utf8', env: { ...callerEnv, ...env } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    pubFiles: () => git(pub, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean).sort(),
    pubLog: () => git(pub, 'log', '--format=%s|%an|%ae', 'main').split('\n'),
  };
}

test('a release puts exactly the checked tree on the public repo as one commit, tagged, by the publisher', { skip: !haveGit }, (t) => {
  const w = world(t);
  writeFileSync(join(w.priv, 'uncommitted.txt'), 'not committed, never published');
  const r = w.run('1.0.1');
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.pubFiles(), ['CHANGELOG.md', 'README.md', 'package.json', 'src/a.ts']);
  assert.deepEqual(w.pubLog(), ['BrainAI 1.0.1|publisher|publisher@users.noreply.example', 'BrainAI 1.0.0|t|t@example.com']);
  assert.equal(w.git(w.pub, 'rev-parse', 'v1.0.1^{commit}'), w.git(w.pub, 'rev-parse', 'main'));
});

test('a release whose tree fails the check publishes nothing', { skip: !haveGit }, (t) => {
  const w = world(t);
  w.write('src/b.ts', `// ${WORD}\n`);
  w.git(w.priv, 'add', '-A');
  w.git(w.priv, 'commit', '-qm', 'oops');
  const before = w.git(w.pub, 'rev-parse', 'main');
  const r = w.run('1.0.1');
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.out, new RegExp(WORD));
  assert.equal(w.git(w.pub, 'rev-parse', 'main'), before);
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v1.0.1'], { cwd: w.pub }).status, 1);
});

test('a release is refused without a changelog entry, for a version already out, with a bad version or no publisher', { skip: !haveGit }, (t) => {
  const w = world(t);
  const before = w.git(w.pub, 'rev-parse', 'main');
  for (const [version, env, why] of [
    ['1.0.2', AUTHOR, /CHANGELOG\.md has no "## 1\.0\.2" entry/],
    ['1.0.0', AUTHOR, /v1\.0\.0 is already on the public repo/],
    ['1.0', AUTHOR, /version like 1\.2\.3/],
    ['1.0.1', {}, /PUBLISH_NAME and PUBLISH_EMAIL/],
  ] as const) {
    const r = w.run(version, env as Record<string, string>);
    assert.equal(r.status, 2, `${version}: ${r.out}`);
    assert.match(r.out, why);
  }
  assert.equal(w.git(w.pub, 'rev-parse', 'main'), before);
});

test('--dry-run checks and builds the commit but pushes nothing', { skip: !haveGit }, (t) => {
  const w = world(t);
  const before = w.git(w.pub, 'rev-parse', 'main');
  const r = w.run('1.0.1', AUTHOR, '--dry-run');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Dry run: nothing pushed/);
  assert.equal(w.git(w.pub, 'rev-parse', 'main'), before);
});

test('a force-tracked file that .gitignore matches still reaches the public commit: the commit is exactly the checked tree', { skip: !haveGit }, (t) => {
  const w = world(t);
  w.write('.gitignore', 'dist/\n');
  w.write('dist/keep.js', 'kept on purpose\n');
  w.git(w.priv, 'add', '-A', '--force');
  w.git(w.priv, 'commit', '-qm', 'tracked build file');
  const r = w.run('1.0.1');
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.pubFiles(), ['.gitignore', 'CHANGELOG.md', 'README.md', 'dist/keep.js', 'package.json', 'src/a.ts']);
});

test('a relative denylist path is the one beside the caller, never a file inside the cloned tree', { skip: !haveGit }, (t) => {
  const w = world(t);
  w.write('denylist.txt', 'nothing-relevant\n');
  w.write('src/b.ts', `// ${WORD}\n`);
  w.git(w.priv, 'add', '-A');
  w.git(w.priv, 'commit', '-qm', 'a tracked decoy list and a leak');
  const r = spawnSync('bash', [release, '../denylist.txt', w.pub, '1.0.1', '--no-tests'], { cwd: w.priv, encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("the caller's git hooks and signing never touch the public commit", { skip: !haveGit }, (t) => {
  const w = world(t);
  const hooks = join(w.dir, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "Signed-off-by: The Owner <owner@example.com>" >> "$1"\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  const cfg = join(w.dir, 'gitconfig');
  writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgSign = true\n`);
  const r = w.run('1.0.1', { ...AUTHOR, GIT_CONFIG_GLOBAL: cfg });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(w.git(w.pub, 'log', '-1', '--format=%B', 'main'), /Signed-off-by/);
});

test('uncommitted edits to the gate itself stop a release', { skip: !haveGit }, (t) => {
  // The gate that runs is the caller's working copy of scripts/publish: run from a private repo whose gate is edited.
  const w = world(t);
  w.write('scripts/publish/check-public-tree.sh', '#!/usr/bin/env bash\nexit 0\n');
  w.git(w.priv, 'add', '-A');
  w.git(w.priv, 'commit', '-qm', 'a gate');
  writeFileSync(join(w.priv, 'scripts/publish/check-public-tree.sh'), '#!/usr/bin/env bash\necho edited; exit 0\n');
  writeFileSync(join(w.priv, 'scripts/publish/release.sh'), readFileSync(release));
  const r = spawnSync('bash', [join(w.priv, 'scripts/publish/release.sh'), w.denylist, w.pub, '1.0.1', '--no-tests'], { cwd: w.priv, encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /uncommitted changes to the gate/);
});

test('a release needs a denylist with words in it: an empty one (as on a fork) is refused before anything is cloned', { skip: !haveGit }, (t) => {
  const w = world(t);
  writeFileSync(w.denylist, '# nothing\n\n');
  const r = w.run('1.0.1');
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /The denylist has no words/);
});

test("a release is refused when package.json (or the desktop app's tauri.conf.json) names another version", { skip: !haveGit }, (t) => {
  const w = world(t);
  const before = w.git(w.pub, 'rev-parse', 'main');
  w.write('package.json', '{ "name": "brain", "version": "1.0.0" }\n');
  w.git(w.priv, 'commit', '-qam', 'forgot the bump');
  const r = w.run('1.0.1', AUTHOR);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /package\.json says 1\.0\.0, not 1\.0\.1/);
  w.write('package.json', '{ "name": "brain", "version": "1.0.1" }\n');
  w.write('desktop/src-tauri/tauri.conf.json', '{ "productName": "Brain", "version": "1.0.0" }\n');
  w.git(w.priv, 'add', '-A');
  w.git(w.priv, 'commit', '-qm', 'forgot the desktop bump');
  const d = w.run('1.0.1', AUTHOR);
  assert.equal(d.status, 2, d.out);
  assert.match(d.out, /desktop\/src-tauri\/tauri\.conf\.json says 1\.0\.0, not 1\.0\.1/);
  assert.equal(w.git(w.pub, 'rev-parse', 'main'), before);
});
