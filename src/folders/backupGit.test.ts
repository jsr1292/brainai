import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '../../scripts/backup-git.sh');

function dirs(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'brain-gitbackup-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'git');
  mkdirSync(root);
  for (const name of ['wildlog.git', 'castle3d.git']) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, name)]);
  return { base, root, a: join(base, 'ssd', 'git-backups'), b: join(base, 'nas', 'git-backups') };
}
/** STATUS_FILE defaults to a throwaway path, so no test ever writes the real one. */
const run = (env: Record<string, string>) => spawnSync('bash', [SCRIPT], { env: { ...process.env, SKIP_MOUNT_CHECK: '1', STATUS_FILE: join(tmpdir(), `gitbk-status-${process.pid}.json`), ...env }, encoding: 'utf8' });

test('backup-git.sh copies every bare repo to each copy dir and removes what was deleted', (t) => {
  const { root, a, b } = dirs(t);
  const env = { GIT_DIR_ROOT: root, COPY_DIRS: `${a} ${b}` };
  const first = run(env);
  assert.equal(first.status, 0, first.stderr);
  for (const d of [a, b]) {
    assert.ok(existsSync(join(d, 'wildlog.git', 'HEAD')), d);
    assert.ok(existsSync(join(d, 'castle3d.git', 'HEAD')), d);
  }
  assert.match(first.stdout + first.stderr, /copied/);
  rmSync(join(root, 'castle3d.git'), { recursive: true });
  assert.equal(run(env).status, 0);
  assert.ok(!existsSync(join(a, 'castle3d.git')));
  assert.ok(existsSync(join(a, 'wildlog.git', 'HEAD')));
});

test('backup-git.sh refuses to copy from a missing or empty repo folder, so it never wipes the backups', (t) => {
  const { base, root, a } = dirs(t);
  assert.equal(run({ GIT_DIR_ROOT: root, COPY_DIRS: a }).status, 0);
  const empty = join(base, 'empty');
  mkdirSync(empty);
  for (const r of [join(base, 'missing'), empty]) {
    const res = run({ GIT_DIR_ROOT: r, COPY_DIRS: a });
    assert.notEqual(res.status, 0, r);
    assert.ok(existsSync(join(a, 'wildlog.git', 'HEAD')), 'the backup is untouched');
  }
});

test('backup-git.sh skips a copy dir whose drive is not mounted', (t) => {
  const { root, base } = dirs(t);
  const res = spawnSync('bash', [SCRIPT], { env: { ...process.env, GIT_DIR_ROOT: root, COPY_DIRS: join(base, 'not-a-mount', 'git-backups') }, encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'every copy failed');
  assert.match(res.stdout + res.stderr, /not mounted/);
});

test('backup-git.sh writes its status file, ok or failed', (t) => {
  const { base, root, a } = dirs(t);
  const statusFile = join(base, 'git-backup-status.json');
  assert.equal(run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile }).status, 0);
  const ok = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(ok.ok, true);
  assert.match(ok.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(run({ GIT_DIR_ROOT: join(base, 'missing'), COPY_DIRS: a, STATUS_FILE: statusFile }).status, 0);
  const bad = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /no repos/);
});

test('a partial git copy says which place failed', (t) => {
  const { base, root, a } = dirs(t);
  const statusFile = join(base, 'st.json');
  const blocked = join(base, 'blocked');
  writeFileSync(blocked, 'a file, not a folder');
  run({ GIT_DIR_ROOT: root, COPY_DIRS: `${a} ${join(blocked, 'git-backups')}`, STATUS_FILE: statusFile });
  const st = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(st.ok, false);
  assert.match(st.detail, /blocked\/git-backups/);
});

test('backup-git.sh refuses to mirror when several repos in a copy are gone from ~/git, so a re-created ~/git never wipes the copies', (t) => {
  const { base, root, a } = dirs(t);
  const statusFile = join(base, 'st.json');
  assert.equal(run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile }).status, 0);
  // ~/git lost, then re-created holding only the brain export.
  rmSync(root, { recursive: true });
  mkdirSync(root);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'brain-export.git')]);
  const res = run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile });
  assert.notEqual(res.status, 0, res.stdout);
  assert.ok(existsSync(join(a, 'wildlog.git', 'HEAD')), 'the copy keeps wildlog');
  assert.ok(existsSync(join(a, 'castle3d.git', 'HEAD')), 'the copy keeps castle3d');
  const st = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(st.ok, false);
  assert.match(st.detail, /castle3d\.git/);
  assert.match(st.detail, /wildlog\.git/);
  assert.equal(run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile, ALLOW_MANY_GONE: '1' }).status, 0, 'unless the owner says the removal is meant');
  assert.ok(!existsSync(join(a, 'wildlog.git')));
});

test('a repo that fails git fsck is not copied over its good copy, and the run says which', (t) => {
  const { base, root, a } = dirs(t);
  const work = join(base, 'work');
  mkdirSync(work);
  const g = (...args: string[]) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: work, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'one');
  spawnSync('git', ['clone', '-q', '--bare', work, join(root, 'notes.git')]);
  const statusFile = join(base, 'st.json');
  assert.equal(run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile }).status, 0);
  // Corrupt the source: one object lost.
  const blob = g('rev-parse', 'HEAD:a.txt').stdout.trim();
  const object = join(root, 'notes.git', 'objects', blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(object));
  rmSync(object);
  const res = run({ GIT_DIR_ROOT: root, COPY_DIRS: a, STATUS_FILE: statusFile });
  assert.notEqual(res.status, 0);
  assert.ok(existsSync(join(a, 'notes.git', 'objects', blob.slice(0, 2), blob.slice(2))), 'the good copy keeps the object');
  assert.ok(existsSync(join(a, 'wildlog.git', 'HEAD')), 'the healthy repos are still copied');
  const st = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(st.ok, false);
  assert.match(st.detail, /notes\.git/);
  assert.match(st.detail, /fsck/);
});

test('backup-git.sh with no copy folders set says so and succeeds, like the nightly backup: the repos stay in ~/git', (t) => {
  const { base, root } = dirs(t);
  const statusFile = join(base, 'git-backup-status.json');
  const res = run({ GIT_DIR_ROOT: root, COPY_DIRS: '', GIT_COPY_DIRS: '', STATUS_FILE: statusFile });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no copy folders set \(GIT_COPY_DIRS in overlay\/scripts\.env\): the repos stay in .* only/);
  const status = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(status.ok, true);
  assert.match(status.detail, /no copy folders set/);
});

test('a new server with no repos yet and no copy folders is not a failure either', (t) => {
  const { base } = dirs(t);
  const statusFile = join(base, 'status2.json');
  const res = run({ GIT_DIR_ROOT: join(base, 'no-such-git'), COPY_DIRS: '', GIT_COPY_DIRS: '', STATUS_FILE: statusFile });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).ok, true);
});
