import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Tests of scripts/offsite-drill.sh, scripts/hooks/pre-push, scripts/test-and-record.sh and scripts/deploy-minipc.sh with fake ssh, age, npm and curl on PATH: nothing here touches a real server. */
const REPO = process.cwd();
const KEY = 'AGE-SECRET-KEY-FAKEFAKEFAKEFAKE';

function script(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}
/** The environment for a script under test: git's own GIT_DIR and friends (set when this runs inside a hook) would point the scripts' git commands at the real worktree. */
const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE'];
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_VARS) delete e[k];
  return { ...e, ...extra };
}
const sh = (cmd: string, cwd: string, env: Record<string, string> = {}, input?: string) =>
  spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', input, env: cleanEnv(env) });

// ---------------------------------------------------------------- the off-site drill

interface DrillOpts { name?: string; key?: string; liveCounts?: string; corrupt?: boolean; noExport?: boolean; extraEntry?: 'dotdot' | 'absolute' | 'symlink' | 'hardlink' }
function drillSetup(o: DrillOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drill-test-'));
  const bin = join(root, 'bin');
  const tmp = join(root, 'tmp');
  const remote = join(root, 'remote');
  const pack = join(root, 'pack');
  for (const d of [bin, tmp, remote, pack]) mkdirSync(d, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const name = o.name ?? `memory-${today}.tar.gz.age`;
  const dbName = `memory-${today}.db`;
  if (o.corrupt) writeFileSync(join(pack, dbName), 'this is not a database'.repeat(200));
  else {
    const r = spawnSync('sqlite3', [join(pack, dbName), "CREATE TABLE memories(id TEXT, deleted_at TEXT); CREATE TABLE pages(id TEXT, deleted_at TEXT); INSERT INTO memories VALUES ('a',NULL),('b',NULL),('c','2026-01-01'); INSERT INTO pages VALUES ('p',NULL);"]);
    assert.equal(r.status, 0);
  }
  writeFileSync(join(pack, 'memory.md'), '# Shared memory\n');
  if (!o.noExport) { mkdirSync(join(pack, 'brain-export')); writeFileSync(join(pack, 'brain-export', 'README.md'), '# The brain\n'); }
  const files = ['memory.md', dbName, ...(o.noExport ? [] : ['brain-export'])];
  // Hostile entries are built with python's tarfile, so every case runs on any machine.
  const py = `
import tarfile, sys, io
root, out, extra, *files = sys.argv[1:]
with tarfile.open(out, 'w:gz') as t:
    for f in files: t.add(root + '/' + f, arcname=f)
    if extra:
        i = tarfile.TarInfo({'dotdot': '../x', 'absolute': '/tmp/abs-entry'}.get(extra, 'link'))
        if extra == 'symlink': i.type = tarfile.SYMTYPE; i.linkname = '/etc/passwd'
        elif extra == 'hardlink': i.type = tarfile.LNKTYPE; i.linkname = 'memory.md'
        else: i.size = 1
        t.addfile(i, io.BytesIO(b'x') if i.size else None)
`;
  const made = spawnSync('python3', ['-c', py, pack, join(root, 'plain.tar.gz'), o.extraEntry ?? '', ...files]);
  assert.equal(made.status, 0, String(made.stderr));
  // The "encrypted" file is the pack with the key it needs on its first line.
  writeFileSync(join(root, 'enc-header'), `needs:${o.key ?? KEY}\n`);
  spawnSync('sh', ['-c', `cat "${root}/enc-header" "${root}/plain.tar.gz" > "${remote}/${name}"`]);
  // Fake age: -d -i <identity or - for stdin> -o out file. Succeeds only when the identity holds the key the file needs.
  script(bin, 'age', `
while [ $# -gt 0 ]; do case "$1" in -d) shift;; -i) id="$2"; shift 2;; -o) out="$2"; shift 2;; *) in="$1"; shift;; esac; done
echo "age-identity-source: $id" >> "${root}/age-calls"
if [ "$id" = "-" ]; then have="$(cat)"; else have="$(cat "$id")"; fi
want="$(head -n 1 "$in" | sed 's/^needs://')"
[ "$have" = "$want" ] || { echo "no identity matched any of the recipients" >&2; exit 1; }
tail -n +2 "$in" > "$out"`);
  // Fake ssh: answers the commands the drill sends, logging each one.
  script(bin, 'ssh', `
cmd="$(for a in "$@"; do last="$a"; done; printf "%s" "$last")"
printf "%s\\n" "$cmd" >> "${root}/ssh-calls"
case "$cmd" in
  *offsite-drill.json*) cat > "${root}/recorded.json";;
  *"rclone lsf"*) ls -1 "${remote}"; echo "images/";;
  *"rclone cat"*) cat "${remote}/$(echo "$cmd" | sed "s/.*\\/\\([^/']*\\)'.*/\\1/")";;
  *"sqlite3 -readonly"*) printf '${o.liveCounts ?? '3\n1'}\n';;
  *) echo "unexpected ssh command: $cmd" >&2; exit 9;;
esac`);
  const run = (args: string[], input?: string, path = `${bin}:${process.env.PATH}`) => spawnSync('/bin/bash', ['scripts/offsite-drill.sh', ...args], {
    cwd: REPO, encoding: 'utf8', input, env: cleanEnv({ PATH: path, TMPDIR: tmp, DRILL_SSH: 'user@192.0.2.10' }),
  });
  return { root, bin, tmp, run, name, keyFile: join(root, 'key.txt') };
}

test('the off-site drill passes on a good copy: key from stdin, counts compared, temp folder wiped, nothing written to the server', () => {
  const s = drillSetup({ liveCounts: '5\n2' });
  try {
    const r = s.run(['-'], `${KEY}\n`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS/m);
    assert.match(r.stdout, /copy holds 2 facts and 1 pages/);
    assert.match(r.stdout, /live server holds 5 facts and 2 pages/);
    assert.match(r.stdout, /integrity_check: ok/);
    assert.match(r.stdout, /0 day\(s\) old/);
    assert.match(readFileSync(join(s.root, 'age-calls'), 'utf8'), /age-identity-source: -/);
    assert.deepEqual(readdirSync(s.tmp), [], 'the temporary folder is gone');
    assert.ok(!(r.stdout + r.stderr + readFileSync(join(s.root, 'ssh-calls'), 'utf8')).includes(KEY), 'the key is never printed or sent');
    assert.ok(!existsSync(join(s.root, 'recorded.json')), 'without --record nothing is written to the server');
    assert.ok(!/cat >|mv |rm |sudo/.test(readFileSync(join(s.root, 'ssh-calls'), 'utf8')), 'the server only sees read-only commands');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the off-site drill reads the key from a file too, and --record writes the result file on the server, pass or fail', () => {
  const s = drillSetup();
  try {
    writeFileSync(s.keyFile, `${KEY}\n`);
    const r = s.run(['--record', s.keyFile]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rec = JSON.parse(readFileSync(join(s.root, 'recorded.json'), 'utf8'));
    assert.equal(rec.result, 'pass');
    assert.equal(rec.copy, s.name);
    assert.match(rec.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(readdirSync(s.tmp), []);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
  const bad = drillSetup({ key: 'AGE-SECRET-KEY-OTHER' });
  try {
    const r = bad.run(['--record', '-'], `${KEY}\n`);
    assert.equal(r.status, 1);
    const rec = JSON.parse(readFileSync(join(bad.root, 'recorded.json'), 'utf8'));
    assert.equal(rec.result, 'fail', 'a FAIL is recorded too');
    assert.equal(rec.copy, bad.name);
  } finally { rmSync(bad.root, { recursive: true, force: true }); }
});

test('the off-site drill fails with a clear line on a wrong key, a copy older than 8 days, a damaged database and an empty copy, and still wipes its temp folder', () => {
  const cases: { opts: DrillOpts; match: RegExp }[] = [
    { opts: { key: 'AGE-SECRET-KEY-OTHER' }, match: /FAIL +age could not decrypt the copy \(wrong key\?\)/ },
    { opts: { name: 'memory-2020-01-01.tar.gz.age' }, match: /FAIL +the copy is \d+ days old/ },
    { opts: { corrupt: true }, match: /FAIL +database integrity_check said/ },
    { opts: { liveCounts: '3\n1', noExport: true }, match: /warn +brain-export\/ is missing/ },
  ];
  for (const c of cases) {
    const s = drillSetup(c.opts);
    try {
      const r = s.run(['-'], `${KEY}\n`);
      assert.match(r.stdout, c.match, r.stdout + r.stderr);
      if (c.opts.noExport) assert.equal(r.status, 0, 'a missing brain-export is a warning, the database is what matters');
      else { assert.equal(r.status, 1); assert.match(r.stdout, /^FAIL:/m); }
      assert.deepEqual(readdirSync(s.tmp), [], 'temp folder wiped');
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  }
  const s = drillSetup({ liveCounts: '4\n1' });
  try {
    rmSync(join(s.root, 'remote'), { recursive: true });
    mkdirSync(join(s.root, 'remote'));
    const r = s.run(['-'], `${KEY}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no memory-YYYY-MM-DD\.tar\.gz\.age copy/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the off-site drill refuses a pack with a ../ entry, an absolute path, a symlink or a hard link, and warns when the copy holds under 90% of the live facts', () => {
  const cases: ['dotdot' | 'absolute' | 'symlink' | 'hardlink', RegExp][] = [
    ['dotdot', /FAIL +the pack holds unsafe paths/], ['absolute', /FAIL +the pack holds unsafe paths/],
    ['symlink', /FAIL +the pack holds links or special files/], ['hardlink', /FAIL +the pack holds links or special files/],
  ];
  for (const [kind, re] of cases) {
    const d = drillSetup({ extraEntry: kind });
    try {
      const r = d.run(['-'], `${KEY}\n`);
      assert.equal(r.status, 1, kind + r.stdout + r.stderr);
      assert.match(r.stdout, re, kind);
      assert.ok(!existsSync(join(d.root, 'x')) && !existsSync('/tmp/abs-entry'), 'nothing was extracted');
      assert.deepEqual(readdirSync(d.tmp), []);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  }
  const low = drillSetup({ liveCounts: '30\n1' });
  try {
    const r = low.run(['-'], `${KEY}\n`);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /warn +the copy holds less than 90% of the live facts \(2 of 30\)/);
  } finally { rmSync(low.root, { recursive: true, force: true }); }
});

test('the off-site drill fails a copy dated in the future', () => {
  const future = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const d = drillSetup({ name: `memory-${future}.tar.gz.age` });
  try {
    const r = d.run(['-'], `${KEY}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL +the copy is dated .* in the future/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('the off-site drill says to brew install age when age is missing, and takes no action', () => {
  const s = drillSetup();
  try {
    const only = join(s.root, 'nobin');
    mkdirSync(only);
    for (const t of ['ssh']) copyFileSync(join(s.bin, t), join(only, t));
    const sqlite = spawnSync('/bin/sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('ln', ['-s', sqlite, join(only, 'sqlite3')]);
    const r = s.run(['-'], `${KEY}\n`, only);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /brew install age/);
    assert.ok(!existsSync(join(s.root, 'ssh-calls')));
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- pre-push hook and test-and-record

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hook-test-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts', 'hooks'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'lib'));
  mkdirSync(bin);
  for (const f of ['scripts/hooks/pre-push', 'scripts/lib/green.sh', 'scripts/test-and-record.sh']) copyFileSync(join(REPO, f), join(repo, f));
  chmodSync(join(repo, 'scripts/hooks/pre-push'), 0o755);
  chmodSync(join(repo, 'scripts/test-and-record.sh'), 0o755);
  writeFileSync(join(repo, 'a.txt'), '1');
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  sh('git init -q -b main && git add -A && git commit -qm one', repo, env);
  // Fake npm: logs its arguments; fails when a "npm-fail" file exists.
  script(bin, 'npm', `echo "$@" >> "${root}/npm-calls"\n[ -f "${root}/npm-fail" ] && exit 1\nexit 0`);
  const sha = () => sh('git rev-parse HEAD', repo).stdout.trim();
  const e = { PATH: `${bin}:${process.env.PATH}` };
  const hook = (remote: string, url: string, ref: string, localSha: string, extra: Record<string, string> = {}) =>
    sh(`scripts/hooks/pre-push ${remote} ${url}`, repo, { ...e, ...extra }, `refs/heads/main ${localSha} ${ref} ${'0'.repeat(40)}\n`);
  const npmCalls = () => (existsSync(join(root, 'npm-calls')) ? readFileSync(join(root, 'npm-calls'), 'utf8') : '');
  const greenFile = join(repo, '.git', 'brainai-green');
  return { root, repo, sha, hook, npmCalls, greenFile, e, env };
}

test('the pre-push hook runs typecheck and tests for main to the minipc remote, records the sha, and skips the second time', () => {
  const g = gitRepo();
  try {
    const sha = g.sha();
    const first = g.hook('minipc', 'ssh://user@192.0.2.10/home/user/memory.git', 'refs/heads/main', sha);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(g.npmCalls(), 'run typecheck\ntest\n');
    assert.equal(readFileSync(g.greenFile, 'utf8').trim(), sha);
    const second = g.hook('minipc', 'x', 'refs/heads/main', sha);
    assert.equal(second.status, 0);
    assert.equal(g.npmCalls(), 'run typecheck\ntest\n', 'the same sha is not tested again');
    assert.match(second.stdout, /already recorded green/);
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('the pre-push hook lets other remotes and other branches through without running anything', () => {
  const g = gitRepo();
  try {
    const sha = g.sha();
    assert.equal(g.hook('origin', 'git@github.com:x/y.git', 'refs/heads/main', sha).status, 0);
    assert.equal(g.hook('minipc', 'x', 'refs/heads/feature', sha).status, 0);
    assert.equal(g.hook('minipc', 'x', 'refs/heads/main', '0'.repeat(40)).status, 0, 'deleting main runs nothing');
    // A push by URL counts as the mini PC only when git config brainai.deploy.pushurl names it.
    writeFileSync(join(g.root, 'npm-fail'), '');
    assert.equal(g.hook('ssh://user@192.0.2.10/home/user/memory.git', 'ssh://user@192.0.2.10/home/user/memory.git', 'refs/heads/main', sha).status, 0, 'a URL is not the mini PC unless git config says so');
    sh('git config brainai.deploy.pushurl ssh://user@192.0.2.10/home/user/memory.git', g.repo);
    assert.equal(g.hook('ssh://user@192.0.2.10/home/user/memory.git', 'ssh://user@192.0.2.10/home/user/memory.git', 'refs/heads/main', sha).status, 1);
    rmSync(join(g.root, 'npm-fail'));
    assert.equal(g.npmCalls(), 'run typecheck\n', 'only the mini PC push ran anything');
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('the pre-push hook blocks a push when the tests fail (nothing recorded), when the tree is not the pushed commit, and BRAINAI_SKIP_TESTS=1 skips with a loud warning', () => {
  const g = gitRepo();
  try {
    const sha = g.sha();
    writeFileSync(join(g.root, 'npm-fail'), '');
    const failed = g.hook('minipc', 'x', 'refs/heads/main', sha);
    assert.equal(failed.status, 1);
    assert.ok(!existsSync(g.greenFile), 'a failing run records nothing');
    rmSync(join(g.root, 'npm-fail'));
    writeFileSync(join(g.repo, 'a.txt'), 'changed');
    const dirty = g.hook('minipc', 'x', 'refs/heads/main', sha);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /cannot vouch/);
    const other = g.hook('minipc', 'x', 'refs/heads/main', 'a'.repeat(40));
    assert.equal(other.status, 1, 'a sha that is not HEAD cannot be vouched for either');
    const skip = g.hook('minipc', 'x', 'refs/heads/main', sha, { BRAINAI_SKIP_TESTS: '1' });
    assert.equal(skip.status, 0);
    assert.match(skip.stderr, /!!! pre-push: BRAINAI_SKIP_TESTS=1 .* WITHOUT typecheck or tests !!!/);
    assert.ok(!existsSync(g.greenFile), 'a skipped push is not recorded green');
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('the pre-push hook keeps git\'s own GIT_DIR out of the test run, so tests running git elsewhere cannot commit to the real worktree', () => {
  const g = gitRepo();
  try {
    const sha = g.sha();
    // A fake `npm test` that, like a test using a temp repo, commits from a folder outside any repo.
    script(join(g.root, 'bin'), 'npm', `echo "$@" >> "${g.root}/npm-calls"\nif [ "$1" = test ]; then cd "$(mktemp -d)" && git commit -q --allow-empty -m leaked 2>/dev/null; fi\nexit 0`);
    const r = g.hook('minipc', 'x', 'refs/heads/main', sha, { GIT_DIR: join(g.repo, '.git'), GIT_WORK_TREE: g.repo, ...g.env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(g.npmCalls(), /^test$/m, 'the tests ran');
    assert.equal(g.sha(), sha, 'no commit landed on the real worktree');
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('an untracked new file counts as a dirty tree for the hook and test-and-record, and a HEAD that moves during the tests is not recorded', () => {
  const g = gitRepo();
  try {
    const sha = g.sha();
    writeFileSync(join(g.repo, 'newModule.ts'), 'export {}');
    const blocked = g.hook('minipc', 'x', 'refs/heads/main', sha);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /cannot vouch/);
    assert.equal(sh('scripts/test-and-record.sh', g.repo, g.e).status, 0);
    assert.ok(!existsSync(g.greenFile), 'untracked file: nothing recorded');
    rmSync(join(g.repo, 'newModule.ts'));
    script(join(g.root, 'bin'), 'npm', `if [ "$1" = test ]; then git commit -q --allow-empty -m moved; fi\nexit 0`);
    const moved = sh('scripts/test-and-record.sh', g.repo, { ...g.e, ...g.env });
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /HEAD moved/);
    assert.ok(!existsSync(g.greenFile));
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('the green list keeps its newest 200 shas in order and does not reorder or drop recent ones', () => {
  const g = gitRepo();
  try {
    const shas = Array.from({ length: 205 }, (_, i) => `${String(205 - i).padStart(3, '0')}${'a'.repeat(37)}`);
    const r = sh(`. scripts/lib/green.sh; for s in ${shas.join(' ')}; do record_green $s; done; record_green ${shas[204]}`, g.repo, g.e);
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(g.greenFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 200);
    assert.deepEqual(lines, shas.slice(5), 'oldest five dropped, order kept, the repeated sha not added twice');
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('test-and-record runs typecheck and tests and records HEAD only when both pass on a clean tree', () => {
  const g = gitRepo();
  try {
    writeFileSync(join(g.root, 'npm-fail'), '');
    assert.notEqual(sh('scripts/test-and-record.sh', g.repo, g.e).status, 0);
    assert.ok(!existsSync(g.greenFile));
    rmSync(join(g.root, 'npm-fail'));
    writeFileSync(join(g.repo, 'a.txt'), 'dirty');
    const dirty = sh('scripts/test-and-record.sh', g.repo, g.e);
    assert.equal(dirty.status, 0);
    assert.ok(!existsSync(g.greenFile), 'uncommitted changes: nothing recorded');
    sh('git checkout a.txt', g.repo);
    const ok = sh('scripts/test-and-record.sh', g.repo, g.e);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(g.greenFile, 'utf8').trim(), g.sha());
    // And the hook now lets that sha through without running npm again.
    const before = g.npmCalls();
    assert.equal(g.hook('minipc', 'x', 'refs/heads/main', g.sha()).status, 0);
    assert.equal(g.npmCalls(), before);
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- deploy-minipc.sh

interface DeployOpts { remoteVersion?: string; psLine?: string; logErrors?: string; logRc?: number; curlCode?: string; schemaAfter?: string; wrongHead?: boolean; detached?: boolean }
function deploySetup(o: DeployOpts = {}) {
  const g = gitRepo();
  const { repo, root } = g;
  copyFileSync(join(REPO, 'scripts/deploy-minipc.sh'), join(repo, 'scripts/deploy-minipc.sh'));
  chmodSync(join(repo, 'scripts/deploy-minipc.sh'), 0o755);
  writeFileSync(join(repo, 'package.json'), '{\n  "name": "brainai",\n  "version": "9.9.9"\n}\n');
  sh('git add -A && git commit -qm two', repo, g.env);
  // The "mini PC" git remote is a local bare repo.
  sh(`git init -q --bare "${root}/memory.git" && git remote add minipc "${root}/memory.git" && git config core.hooksPath scripts/hooks`, repo);
  const bin = join(root, 'bin');
  script(bin, 'ssh', `
cmd="$(for a in "$@"; do last="$a"; done; printf "%s" "$last")"
printf "%s\\n" "$cmd" >> "${root}/ssh-calls"
case "$cmd" in
  *symbolic-ref*) ${o.detached ? 'exit 1' : 'exit 0'};;
  *"git rev-parse HEAD"*) if grep -q 'git pull' "${root}/ssh-calls"; then ${o.wrongHead ? 'echo deadbeef' : `git -C "${repo}" rev-parse HEAD`}; else echo prevsha1234; fi;;
  *"node -p"*) echo ${o.remoteVersion ?? '9.9.9'};;
  *schema_version*) if grep -q 'compose up' "${root}/ssh-calls"; then echo ${o.schemaAfter ?? '38'}; else echo 38; fi;;
  *"compose ps"*) echo "${o.psLine ?? 'memory-app-1  Up 4 seconds'}";;
  *"compose logs"*) ${o.logRc !== undefined ? `exit ${o.logRc}` : o.logErrors ? `echo "${o.logErrors}"` : 'exit 1'};;
  *) ;;
esac`);
  script(bin, 'curl', `echo "$@" >> "${root}/curl-calls"\nprintf '${o.curlCode ?? '401'}'`);
  const sshCalls = () => (existsSync(join(root, 'ssh-calls')) ? readFileSync(join(root, 'ssh-calls'), 'utf8') : '');
  const deploy = (args: string[] = []) => sh(`scripts/deploy-minipc.sh ${args.join(' ')}`, repo, { ...g.e, DEPLOY_SSH: 'user@192.0.2.10', DEPLOY_URL: 'https://memory.example.com', DEPLOY_WAIT: '1', DEPLOY_POLL: '1' });
  return { ...g, deploy, sshCalls };
}

test('deploy refuses a dirty tree, a main that is not recorded green and a branch other than main, but --force-untested goes ahead', () => {
  const d = deploySetup();
  try {
    const notGreen = d.deploy();
    assert.equal(notGreen.status, 1);
    assert.match(notGreen.stderr, /not recorded green/);
    assert.equal(d.sshCalls(), '', 'nothing reached the server');
    sh('scripts/test-and-record.sh', d.repo, d.e);
    writeFileSync(join(d.repo, 'a.txt'), 'dirty');
    const dirty = d.deploy();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes/);
    sh('git checkout a.txt && git checkout -q -b feature', d.repo);
    assert.match(d.deploy().stderr, /not on main/);
    sh('git checkout -q main && git commit -q --allow-empty -m three', d.repo, d.env);
    // The hook is installed (core.hooksPath) and the fake npm fails: only BRAINAI_SKIP_TESTS=1 lets the forced push through.
    writeFileSync(join(d.root, 'npm-fail'), '');
    const forced = d.deploy(['--force-untested']);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(forced.stderr, /WARNING --force-untested/);
    assert.match(forced.stderr, /BRAINAI_SKIP_TESTS=1/, 'the hook warned that it was skipped');
    assert.equal(sh('git rev-parse main', `${d.root}/memory.git`).stdout.trim(), d.sha());
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('deploy pushes, copies the database (mode 600), pulls, rebuilds, waits for the new version and reports every check', () => {
  const d = deploySetup();
  try {
    sh('scripts/test-and-record.sh', d.repo, d.e);
    const r = d.deploy();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /running version 9\.9\.9, app is Up, \/mcp answers 401/);
    assert.match(r.stdout, /schema_version 38/);
    assert.match(r.stdout, /no error lines/);
    assert.match(r.stdout, /DONE 9\.9\.9/);
    const calls = d.sshCalls().split('\n').filter(Boolean);
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const pre = /test ! -e 'data\/memory-pre-9\.9\.9-\d{8}-\d{6}-[0-9a-f]{7}\.db' && \(umask 077 && sqlite3 data\/memory\.db ".backup 'data\/memory-pre-9\.9\.9-\d{8}-\d{6}-[0-9a-f]{7}\.db'"\) && chmod 600 /;
    assert.ok(at(pre) >= 0, d.sshCalls());
    assert.ok(at(pre) < at(/git pull --ff-only/) && at(/git pull --ff-only/) < at(/docker compose up -d --build/), 'copy, then pull, then rebuild');
    assert.ok(calls.every((c) => c.startsWith("cd 'memory' && ")), d.sshCalls());
    assert.equal(sh('git rev-parse main', `${d.root}/memory.git`).stdout.trim(), d.sha(), 'main was pushed to the minipc remote');
    assert.match(readFileSync(join(d.root, 'curl-calls'), 'utf8'), /-X POST https:\/\/memory\.example\.com\/mcp/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('deploy fails and prints the rollback steps when the version is wrong, the app is not Up, logs hold errors, or /mcp does not answer 401', () => {
  const cases: [DeployOpts, RegExp][] = [
    [{ remoteVersion: '9.9.8' }, /reports version '9\.9\.8', expected 9\.9\.9/],
    [{ psLine: 'memory-app-1  Restarting (1) 3 seconds ago' }, /does not show the app as Up/],
    [{ curlCode: '200' }, /answered '200', expected 401/],
    [{ logErrors: 'FATAL: could not open database' }, /error or fatal lines[\s\S]*FATAL: could not open database/],
    [{ remoteVersion: '9.9.8', schemaAfter: '39' }, /The schema CHANGED \(38 -> 39\)/],
  ];
  for (const [opts, match] of cases) {
    const d = deploySetup(opts);
    try {
      sh('scripts/test-and-record.sh', d.repo, d.e);
      const r = d.deploy();
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, match);
      assert.match(r.stderr, /git checkout main && git reset --hard prevsha1234/);
      assert.doesNotMatch(r.stderr, /git checkout prevsha1234/, 'no detached HEAD');
      assert.match(r.stderr, /docker compose up -d --build/);
      assert.match(r.stderr, /cp data\/memory-pre-9\.9\.9-\d{8}-\d{6}-[0-9a-f]{7}\.db data\/memory\.db/);
      assert.match(r.stderr, /The schema (did not change \(38\)|CHANGED \(38 -> 39\))/);
      assert.match(r.stderr, /data\/memory\.db-wal data\/memory\.db\.broken-\d{8}-\d{6}-wal/, 'the -wal file is moved aside, not deleted');
      assert.ok(r.stderr.indexOf('docker compose stop app') < r.stderr.indexOf('cp data/') && r.stderr.indexOf('cp data/') < r.stderr.indexOf('git checkout main'));
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  }
});

test('deploy stops when the server is on a detached HEAD, and when the server does not end at the pushed commit; an unreadable log is a warning, not "no error lines"', () => {
  const det = deploySetup({ detached: true });
  try {
    sh('scripts/test-and-record.sh', det.repo, det.e);
    const r = det.deploy();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /detached HEAD/);
    assert.ok(!det.sshCalls().includes('git pull'), 'nothing was changed on the server');
    assert.equal(sh('git rev-parse --verify -q main', `${det.root}/memory.git`).status, 1, 'and nothing was pushed');
  } finally { rmSync(det.root, { recursive: true, force: true }); }
  const wrong = deploySetup({ wrongHead: true });
  try {
    sh('scripts/test-and-record.sh', wrong.repo, wrong.e);
    const r = wrong.deploy();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /after the pull the server is at 'deadbeef', not the pushed/);
    assert.match(r.stderr, /git checkout main && git reset --hard prevsha1234/);
    assert.doesNotMatch(r.stderr, /docker compose stop app/, 'only the one-line fix, not the full rollback');
    assert.ok(!wrong.sshCalls().includes('docker compose up'), 'it was not built');
  } finally { rmSync(wrong.root, { recursive: true, force: true }); }
  const logs = deploySetup({ logRc: 255 });
  try {
    sh('scripts/test-and-record.sh', logs.repo, logs.e);
    const r = logs.deploy();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /logs could not be read/);
    assert.doesNotMatch(r.stdout, /no error lines/);
  } finally { rmSync(logs.root, { recursive: true, force: true }); }
});

test('deploy --dry-run prints every command, remote and local, and runs none', () => {
  const d = deploySetup();
  try {
    const r = d.deploy(['--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /would refuse: .* not recorded green/, 'refusals are listed, not enforced');
    for (const re of [/\[dry-run\] git push minipc main/, /\.backup 'data\/memory-pre-9\.9\.9-\d{8}-\d{6}-[0-9a-f]{7}\.db'/, /umask 077/, /git symbolic-ref -q HEAD/, /chmod 600/, /git pull --ff-only/, /docker compose up -d --build/, /require\('\.\/package\.json'\)\.version/, /schema_version/, /docker compose ps app/, /docker compose logs --since 2m/, /curl .*-X POST https:\/\/memory\.example\.com\/mcp/]) {
      assert.match(r.stdout, re);
    }
    assert.equal(d.sshCalls(), '', 'no ssh call was made');
    assert.ok(!existsSync(join(d.root, 'curl-calls')), 'no curl call was made');
    assert.equal(sh('git rev-parse --verify -q main', `${d.root}/memory.git`).status, 1, 'nothing was pushed');
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test('deploy and the drill exit 2 and name the git config line when no server is set, and read it from git config when it is', () => {
  const d = deploySetup();
  try {
    const bare = (cmd: string) => spawnSync('/bin/sh', ['-c', cmd], { cwd: d.repo, encoding: 'utf8', env: cleanEnv({ PATH: d.e.PATH! }) });
    const r = bare('scripts/deploy-minipc.sh --dry-run');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git config brainai\.deploy\.ssh <user>@<server>/);
    sh('git config brainai.deploy.ssh user@192.0.2.10', d.repo);
    const r2 = bare('scripts/deploy-minipc.sh --dry-run');
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /git config brainai\.deploy\.url https:\/\/<your-domain>/);
    sh('git config brainai.deploy.url https://memory.example.com', d.repo);
    const r3 = bare('scripts/deploy-minipc.sh --dry-run');
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, /ssh user@192\.0\.2\.10:/);
    // The drill, copied into the same repo so it reads this repo's config and not the real one.
    copyFileSync(join(REPO, 'scripts/offsite-drill.sh'), join(d.repo, 'scripts/offsite-drill.sh'));
    sh('git config --unset brainai.deploy.ssh', d.repo);
    const q = bare('echo k | scripts/offsite-drill.sh -');
    assert.equal(q.status, 2);
    assert.match(q.stderr, /git config brainai\.deploy\.ssh <user>@<server>/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});
