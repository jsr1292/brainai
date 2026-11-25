import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';

/** The real save-copy names the folder for the local day (savedCopy.ts), so this does too. */
const DAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const SAVED = `BrainAI saved ${DAY}`;
const REPO = process.cwd();

/** A brain with two facts, copied into each test clone's data/ for the real save-copy to read. */
const SEED = mkdtempSync(join(tmpdir(), 'remove-seed-'));
{
  const db = openDb(join(SEED, 'memory.db'));
  const service = new MemoryService(new MemoryStore(db, () => new Date()), createFakeEmbedder(), { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  await service.remember({ kind: 'decision', content: 'Larder shelves are oak', project: 'larder' }, { type: 'owner' });
  await service.remember({ kind: 'decision', content: 'Wildlog keeps photos on disk', project: 'wildlog' }, { type: 'owner' });
  db.close();
}
process.on('exit', () => rmSync(SEED, { recursive: true, force: true }));

/**
 * A temp home with a clone at ~/memory and stand-ins on PATH for docker, crontab and rclone (a local folder as the
 * remote). git is the real one, in a temp repo. docker's `compose run` runs the REAL `cli save-copy` on the clone's
 * data/, with the `-v <host>:/saved` mount turned into the host folder and back, as the container would see it.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'remove-test-'));
  const home = join(root, 'home');
  const appDir = join(home, 'memory');
  const bin = join(root, 'bin');
  const remote = join(root, 'remote');
  const gitRoot = join(home, 'git');
  const exportDir = join(home, 'brain-export');
  for (const d of [join(appDir, 'scripts', 'lib'), join(appDir, 'data'), bin, join(remote, 'images'), join(gitRoot, 'brain-export.git'), exportDir]) mkdirSync(d, { recursive: true });
  for (const f of ['overlay.sh']) writeFileSync(join(appDir, 'scripts', 'lib', f), readFileSync(join('scripts', 'lib', f)));
  writeFileSync(join(appDir, 'docker-compose.yml'), 'services: {}\n');
  copyFileSync(join(SEED, 'memory.db'), join(appDir, 'data', 'memory.db'));
  writeFileSync(join(appDir, 'offsite-recipient.txt'), 'age1examplepublickey\n');
  writeFileSync(join(remote, 'memory-2026-11-01.tar.gz.age'), 'x');
  writeFileSync(join(remote, 'memory-2026-11-08.tar.gz.age'), 'x');
  writeFileSync(join(remote, 'images', 'aa11.age'), 'x');
  writeFileSync(join(remote, 'other.txt'), 'x');
  // The export folder BrainAI keeps: tracked files, plus a file of the owner's.
  mkdirSync(join(exportDir, 'pages', 'apps'), { recursive: true });
  writeFileSync(join(exportDir, 'README.md'), '# The brain\n');
  writeFileSync(join(exportDir, 'pages', 'apps', 'wildlog.md'), '# wildlog\n');
  writeFileSync(join(exportDir, 'my-notes.txt'), 'Alex wrote this\n');
  spawnSync('git', ['init', '-q'], { cwd: exportDir });
  spawnSync('git', ['add', 'README.md', 'pages'], { cwd: exportDir });
  const crontab = join(root, 'crontab');
  writeFileSync(crontab, [
    '0 1 * * * /usr/local/bin/mine.sh',
    `30 3 * * * ~/memory/scripts/backup.sh >> ~/memory/backups/backup.log 2>&1`,
    `45 3 * * * ${appDir}/scripts/export-brain.sh >> /tmp/x 2>&1`,
    `0 4 * * * $HOME/memory/scripts/backup-git.sh >> /tmp/x 2>&1`,
    `15 4 * * 0 \${HOME}/memory/scripts/offsite.sh >> /tmp/x 2>&1`,
    '',
  ].join('\n').replace('0 1 * * * /usr/local/bin/mine.sh\n', '0 1 * * * /usr/local/bin/mine.sh\n\n# my own\n'));
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${root}/docker-calls"
case " $* " in
  *" ps "*) [ -f "${root}/app-down" ] || echo abc123; exit 0;;
  *" stop "*) [ -f "${root}/stopfail" ] && { echo "cannot stop" >&2; exit 1; }; exit 0;;
  *" down "*) [ -f "${root}/downfail" ] && { echo "daemon not running" >&2; exit 1; }; exit 0;;
  *" run "*)
    [ -f "${root}/savefail" ] && { echo "disk full" >&2; exit 1; }
    host=""; prev=""; last=""
    for a in "$@"; do [ "$prev" = -v ] && case "$a" in *:/saved) host="\${a%:/saved}";; esac; prev="$a"; last="$a"; done
    case " $* " in *" app node dist/cli.js save-copy "*) ;; *) echo "not the save-copy command" >&2; exit 2;; esac
    [ -n "$host" ] && [ -d "$host" ] && [ "$last" = /saved ] || { echo "no -v <folder>:/saved mount" >&2; exit 2; }
    out="${root}/save-out"
    ( cd "${REPO}" && DATA_DIR="${appDir}/data" PUBLIC_URL=https://larder.example.org "${process.execPath}" --import tsx src/cli.ts save-copy "$host" ) > "$out" || exit 1
    sed "s|^$host|/saved|" "$out";;
esac\n`);
  writeFileSync(join(bin, 'crontab'), `#!/bin/sh
case "$1" in -l) cat "${crontab}";; -) cat > "${crontab}";; esac\n`);
  writeFileSync(join(bin, 'rclone'), `#!/bin/sh
echo "$@" >> "${root}/rclone-calls"
[ -f "${root}/rclone-fail" ] && { echo "token expired" >&2; exit 1; }
d="${remote}/$(echo "$2" | sed 's|^[^:]*:[^/]*/*||')"
case "$1" in
  lsf) [ -d "$d" ] && ls -1 "$d"; true;;
  delete) pat=""; while [ $# -gt 0 ]; do [ "$1" = "--include" ] && pat="$2"; shift; done
          # Like rclone: a pattern starting with / matches from the top only; otherwise at any depth.
          case "$pat" in
            /*) for f in ${remote}$pat; do rm -f "$f"; done;;
            *) find "${remote}" -type f -name "$pat" -exec rm -f {} +;;
          esac;;
esac\n`);
  for (const f of ['docker', 'crontab', 'rclone']) chmodSync(join(bin, f), 0o755);
  const run = (input: string, env: Record<string, string> = {}) => spawnSync('bash', [join(appDir, 'scripts', 'remove.sh')], {
    encoding: 'utf8',
    input,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, APP_DIR: appDir, GIT_DIR_ROOT: gitRoot, EXPORT_DIR: exportDir, SKIP_MOUNT_CHECK: '1', OFFSITE_REMOTE: 'gdrive:memory-backups', COPY_DIRS: '', GIT_COPY_DIRS: '', ...env },
  });
  const child = (env: Record<string, string> = {}) => spawn('bash', [join(appDir, 'scripts', 'remove.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, APP_DIR: appDir, GIT_DIR_ROOT: gitRoot, EXPORT_DIR: exportDir, SKIP_MOUNT_CHECK: '1', OFFSITE_REMOTE: 'gdrive:memory-backups', COPY_DIRS: '', GIT_COPY_DIRS: '', ...env },
  });
  writeFileSync(join(appDir, 'scripts', 'remove.sh'), readFileSync(join('scripts', 'remove.sh')));
  const calls = () => (existsSync(join(root, 'docker-calls')) ? readFileSync(join(root, 'docker-calls'), 'utf8') : '');
  return { root, home, appDir, remote, gitRoot, exportDir, crontab, calls, run, child };
}

const GO = '\nremove\n';

test('answers other than remove remove nothing', () => {
  const { root, home, appDir, crontab, calls, gitRoot, run } = setup();
  try {
    const before = readFileSync(crontab, 'utf8');
    for (const word of ['', 'yes', 'Remove', 'remove it']) {
      rmSync(join(home, SAVED), { recursive: true, force: true });
      const r = run(`\n${word}\n`);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /Nothing was removed\./);
    }
    assert.ok(existsSync(appDir) && existsSync(join(gitRoot, 'brain-export.git')));
    assert.equal(readFileSync(crontab, 'utf8'), before);
    assert.ok(!/ down /.test(calls()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the saved copy moves to home, with the scp line and the Enter prompt', () => {
  const { root, home, run } = setup();
  try {
    const r = run('\nno\n');
    assert.ok(existsSync(join(home, SAVED, 'README.txt')));
    assert.match(r.stdout, new RegExp(`scp -r "[^"]+@[^:"]+:${join(home, SAVED)}" \\.`));
    assert.match(r.stdout, /Press Enter once you have it on your computer \(it also stays at /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed save removes nothing', () => {
  const { root, appDir, crontab, calls, run } = setup();
  try {
    writeFileSync(join(root, 'savefail'), '');
    const before = readFileSync(crontab, 'utf8');
    const r = run(GO);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Nothing was removed\./);
    assert.ok(existsSync(appDir));
    assert.equal(readFileSync(crontab, 'utf8'), before);
    assert.ok(!/ down /.test(calls()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the save always runs in a one-off container, into a folder of the home mounted at /saved', () => {
  const { root, home, calls, run } = setup();
  try {
    const r = run('\nno\n');
    const mount = new RegExp(`^compose -f \\S+ run --rm -v ${join(home, '.brainai-save.')}[A-Za-z0-9]{6}:/saved app node dist/cli\\.js save-copy /saved$`, 'm');
    assert.match(calls(), mount, r.stdout + r.stderr);
    assert.ok(!/ exec /.test(calls()));
    // The real save-copy wrote the folder; the script moved it to the home folder and removed the temporary one.
    assert.match(readFileSync(join(home, SAVED, 'README.txt'), 'utf8'), /2 facts/);
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.brainai-save.')), []);
    assert.ok(!existsSync(join(root, 'home', 'memory', 'data', 'saved-copy')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed save leaves no temporary folder behind', () => {
  const { root, home, run } = setup();
  try {
    writeFileSync(join(root, 'savefail'), '');
    const r = run(GO);
    assert.match(r.stdout, /The save failed\.\nBrainAI is running again\.\nNothing was removed\./);
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.brainai-save.') || n.startsWith('BrainAI saved')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only BrainAI's crontab lines go", () => {
  const { root, crontab, appDir, calls, run } = setup();
  try {
    const r = run(GO);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // The owner's repo list holds only brain-export.git here, so backup-git's line goes too.
    assert.equal(readFileSync(crontab, 'utf8'), '0 1 * * * /usr/local/bin/mine.sh\n\n# my own\n');
    assert.match(calls(), /down --rmi local --volumes/);
    // --rmi local takes only the image built here, never the downloaded cloudflared one.
    assert.match(r.stdout, /^  \* the BrainAI containers and volumes, and BrainAI's own image$/m);
    assert.doesNotMatch(r.stdout.slice(r.stdout.indexOf('This will remove:'), r.stdout.indexOf('Type remove')), /images/);
    assert.ok(!existsSync(appDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the git-copy job stays while ~/git holds the owner's repos", () => {
  const { root, crontab, gitRoot, run } = setup();
  try {
    mkdirSync(join(gitRoot, 'larder.git'));
    const r = run(GO);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(readFileSync(crontab, 'utf8'), '0 1 * * * /usr/local/bin/mine.sh\n\n# my own\n0 4 * * * $HOME/memory/scripts/backup-git.sh >> /tmp/x 2>&1\n');
    assert.ok(!existsSync(join(gitRoot, 'brain-export.git')));
    assert.ok(existsSync(join(gitRoot, 'larder.git')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the git-copy job goes when only brain-export.git is there', () => {
  const { root, crontab, gitRoot, run } = setup();
  try {
    run(GO);
    assert.ok(!readFileSync(crontab, 'utf8').includes('backup-git.sh'));
    assert.ok(!existsSync(join(gitRoot, 'brain-export.git')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the owner's own file in ~/brain-export stays", () => {
  const { root, exportDir, run } = setup();
  try {
    run(GO);
    assert.deepEqual(readdirSync(exportDir), ['my-notes.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the export folder goes whole when nothing of the owner is in it', () => {
  const { root, exportDir, run } = setup();
  try {
    rmSync(join(exportDir, 'my-notes.txt'));
    run(GO);
    assert.ok(!existsSync(exportDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Enter keeps every outside copy', () => {
  const { root, remote, run } = setup();
  try {
    const snaps = join(root, 'usb', 'memory-backups');
    const gits = join(root, 'usb', 'git-backups');
    mkdirSync(snaps, { recursive: true });
    mkdirSync(join(gits, 'brain-export.git'), { recursive: true });
    writeFileSync(join(snaps, 'memory-2026-11-11.db'), 'x');
    const r = run(`${GO}\n\n\n\n`, { COPY_DIRS: snaps, GIT_COPY_DIRS: gits });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal((r.stdout.match(/\[y\/N\]/g) ?? []).length, 4);
    assert.ok(existsSync(join(snaps, 'memory-2026-11-11.db')) && existsSync(join(gits, 'brain-export.git')));
    assert.deepEqual(readdirSync(remote).sort(), ['images', 'memory-2026-11-01.tar.gz.age', 'memory-2026-11-08.tar.gz.age', 'other.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('y deletes the snapshots in one copy folder only when asked', () => {
  const { root, run } = setup();
  try {
    const a = join(root, 'usb-a');
    const b = join(root, 'usb-b');
    for (const d of [a, b]) { mkdirSync(d); writeFileSync(join(d, 'memory-2026-11-10.db'), 'x'); writeFileSync(join(d, 'memory-2026-11-11.db'), 'x'); writeFileSync(join(d, 'mine.txt'), 'x'); }
    const r = run(`${GO}y\nn\n`, { COPY_DIRS: `${a} ${b}`, OFFSITE_REMOTE: '' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /holds 2 nightly snapshot\(s\), newest memory-2026-11-11\.db/);
    assert.deepEqual(readdirSync(a), ['mine.txt']);
    assert.equal(readdirSync(b).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('y on the off-site questions deletes the packs, then the pictures, and nothing else', () => {
  const { root, remote, run } = setup();
  try {
    const r = run(`${GO}y\ny\n`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /holds 2 off-site copy file\(s\), newest memory-2026-11-08\.tar\.gz\.age/);
    assert.deepEqual(readdirSync(remote).sort(), ['images', 'other.txt']);
    assert.deepEqual(readdirSync(join(remote, 'images')), []);
    const calls = readFileSync(join(root, 'rclone-calls'), 'utf8');
    assert.ok(!/config|listremotes/.test(calls));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreachable remote is left alone', () => {
  const { root, remote, run } = setup();
  try {
    writeFileSync(join(root, 'rclone-fail'), '');
    const r = run(`${GO}y\ny\n`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Couldn't check the off-site copies on gdrive:memory-backups \(couldn't reach it\): they are still there\./);
    assert.equal(readdirSync(remote).length, 4);
    assert.ok(!/^delete /m.test(readFileSync(join(root, 'rclone-calls'), 'utf8')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the checklist is printed last', () => {
  const { root, run } = setup();
  try {
    const r = run(`${GO}\n\n`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const tail = r.stdout.trimEnd().split('\n');
    const from = tail.lastIndexOf('Things BrainAI could not remove:');
    assert.ok(from > 0, r.stdout);
    assert.ok(tail.slice(from + 1).every((l) => l.startsWith('* ')), 'nothing after the checklist');
    assert.ok(tail.includes('* Cloudflare: delete the tunnel and the public address larder.example.org (Zero Trust › Networks › Tunnels)'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second run on the same day keeps the first folder and names the new one (2)', () => {
  const { root, home, run } = setup();
  try {
    run('\nno\n');
    const r = run('\nno\n');
    assert.ok(existsSync(join(home, SAVED, 'README.txt')));
    assert.ok(existsSync(join(home, `${SAVED} (2)`, 'README.txt')));
    assert.ok(r.stdout.includes(`${SAVED} (2)`), r.stdout);
    const third = run('\nno\n');
    assert.ok(existsSync(join(home, `${SAVED} (3)`)), third.stdout);
    // Stopping after the save leaves no temporary folder behind.
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.brainai-save.')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a "y" on the off-site questions reaches only the top level of the remote', () => {
  const { root, remote, run } = setup();
  try {
    mkdirSync(join(remote, 'old'));
    writeFileSync(join(remote, 'old', 'memory-2025-01-01.tar.gz.age'), 'x');
    mkdirSync(join(remote, 'old', 'images'));
    writeFileSync(join(remote, 'old', 'images', 'zz.age'), 'x');
    run(`${GO}y\ny\n`);
    assert.ok(existsSync(join(remote, 'old', 'memory-2025-01-01.tar.gz.age')));
    assert.ok(existsSync(join(remote, 'old', 'images', 'zz.age')));
    assert.ok(!existsSync(join(remote, 'memory-2026-11-08.tar.gz.age')));
    assert.ok(!existsSync(join(remote, 'images', 'aa11.age')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed docker compose down stops before the git folder, the export and the clone go', () => {
  const { root, appDir, gitRoot, exportDir, crontab, run } = setup();
  try {
    writeFileSync(join(root, 'downfail'), '');
    const r = run(GO);
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(appDir) && existsSync(join(gitRoot, 'brain-export.git')) && existsSync(join(exportDir, '.git')));
    assert.ok(!/Removed BrainAI from this server\./.test(r.stdout));
    assert.match(r.stdout, new RegExp(`cd ${realpathSync(appDir)} && docker compose down`));
    assert.match(r.stdout, /run remove\.sh again/);
    assert.equal(readFileSync(crontab, 'utf8'), '0 1 * * * /usr/local/bin/mine.sh\n\n# my own\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a kept git-copy line is called out at the end, with the checklist", () => {
  const { root, gitRoot, run } = setup();
  try {
    mkdirSync(join(gitRoot, 'larder.git'));
    const r = run(GO);
    assert.match(r.stdout, /Your nightly copy of .*git \(crontab line: 0 4 \* \* \* \$HOME\/memory\/scripts\/backup-git\.sh >> \/tmp\/x 2>&1\) ran BrainAI's backup-git\.sh, which is gone now: copy the script somewhere else and point the line at it, or remove the line\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an APP_DIR that is not the clone the script lives in is refused, and nothing is touched', () => {
  const { root, home, appDir, crontab, calls, run } = setup();
  try {
    const other = join(root, 'other');
    mkdirSync(join(other, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(other, 'keep.txt'), 'x');
    for (const bad of [other, home, '/']) {
      const r = run(GO, { APP_DIR: bad });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /Refusing|Nothing was removed/);
    }
    assert.ok(existsSync(join(other, 'keep.txt')) && existsSync(appDir));
    assert.equal(calls(), '');
    assert.match(readFileSync(crontab, 'utf8'), /backup\.sh/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('files with non-ASCII names in the export go too', () => {
  const { root, exportDir, run } = setup();
  try {
    writeFileSync(join(exportDir, 'pages', 'apps', 'café.md'), '# x\n');
    spawnSync('git', ['add', 'pages'], { cwd: exportDir });
    run(GO);
    assert.deepEqual(readdirSync(exportDir), ['my-notes.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only what the export writes goes: the owner's committed notes stay", () => {
  const { root, exportDir, run } = setup();
  try {
    // export-brain.sh commits everything in the folder (git add -A), so the owner's notes are tracked too.
    mkdirSync(join(exportDir, 'notes'));
    writeFileSync(join(exportDir, 'notes', 'mine.md'), 'Alex wrote this\n');
    writeFileSync(join(exportDir, 'pages', 'apps', 'wildlog-photo.jpg'), 'x');
    mkdirSync(join(exportDir, 'facts'));
    writeFileSync(join(exportDir, 'facts', 'larder.md'), '# larder\n');
    mkdirSync(join(exportDir, 'skills', 'tidy'), { recursive: true });
    writeFileSync(join(exportDir, 'skills', 'tidy', 'SKILL.md'), 'x');
    writeFileSync(join(exportDir, 'skills', 'tidy', 'helper.py'), 'x');
    spawnSync('git', ['add', '-A'], { cwd: exportDir });
    spawnSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.org', 'commit', '-q', '-m', 'export'], { cwd: exportDir });
    const r = run(GO);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(exportDir, 'notes', 'mine.md'), 'utf8'), 'Alex wrote this\n');
    assert.ok(existsSync(join(exportDir, 'pages', 'apps', 'wildlog-photo.jpg')), "the owner's picture beside the pages stays");
    assert.deepEqual(readdirSync(exportDir).sort(), ['my-notes.txt', 'notes', 'pages']);
    assert.deepEqual(readdirSync(join(exportDir, 'pages', 'apps')), ['wildlog-photo.jpg']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an export holding only the export\'s own files (with .gitignore) leaves no brain-export folder', () => {
  const { root, exportDir, run } = setup();
  try {
    rmSync(exportDir, { recursive: true, force: true });
    mkdirSync(join(exportDir, 'pages', 'apps'), { recursive: true });
    writeFileSync(join(exportDir, 'README.md'), '# export\n');
    writeFileSync(join(exportDir, '.gitignore'), 'x\n');
    writeFileSync(join(exportDir, 'pages', 'apps', 'larder.md'), '# larder\n');
    spawnSync('git', ['init', '-q'], { cwd: exportDir });
    spawnSync('git', ['add', '-A'], { cwd: exportDir });
    spawnSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.org', 'commit', '-q', '-m', 'export'], { cwd: exportDir });
    const r = run(GO);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(exportDir), 'the export folder is gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a save that prints an unexpected last line leaves no temporary save folder, and nothing is removed', () => {
  const { root, home, appDir, run } = setup();
  try {
    const dockerPath = join(root, 'bin', 'docker');
    writeFileSync(dockerPath, `#!/bin/sh
case " $* " in *" run "*)
  prev=""; for a in "$@"; do [ "$prev" = -v ] && host="\${a%:/saved}"; prev="$a"; done
  mkdir -p "$host/BrainAI saved x"; echo "BrainAI saved x" > "$host/BrainAI saved x/secret.txt"; echo "all done";;
esac\n`);
    const r = run('\nno\n');
    assert.match(r.stdout, /The save did not make a folder\./);
    assert.match(r.stdout, /Nothing was removed\./);
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.brainai-save.')), []);
    assert.ok(existsSync(appDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('with off-site set up but rclone missing, it says the copies are still there', () => {
  const { root, run } = setup();
  try {
    rmSync(join(root, 'bin', 'rclone'));
    const r = run(GO, { PATH: `${join(root, 'bin')}:/usr/bin:/bin` });
    assert.match(r.stdout, /Couldn't check the off-site copies on gdrive:memory-backups \(rclone isn't installed\): they are still there\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a forged stage-2 environment deletes nothing', () => {
  const { root, appDir, run } = setup();
  try {
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'precious.txt'), 'x');
    const r = run('\nno\n', { REMOVE_STAGE2: '1', REMOVE_TMP: victim, REMOVE_APP_DIR: join(root, 'nonexistent') });
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(victim, 'precious.txt')) && existsSync(appDir));
    // From a genuine-looking temp copy, a REMOVE_APP_DIR that is not the clone is refused too.
    const other = join(root, 'other');
    mkdirSync(join(other, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(other, 'scripts', 'remove.sh'), 'something else\n');
    const tmp = join(root, 'brainai-remove.abc123');
    mkdirSync(tmp);
    writeFileSync(join(tmp, 'remove.sh'), readFileSync(join('scripts', 'remove.sh')));
    const r2 = spawnSync('bash', [join(tmp, 'remove.sh')], {
      encoding: 'utf8', input: '\nremove\n',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), TMPDIR: root, REMOVE_STAGE2: '1', REMOVE_TMP: tmp, REMOVE_APP_DIR: other },
    });
    assert.notEqual(r2.status, 0);
    assert.ok(existsSync(other) && existsSync(appDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an APP_DIR given as a symlink removes the real clone, never just the link', () => {
  const { root, appDir, run } = setup();
  try {
    const link = join(root, 'memory-link');
    symlinkSync(appDir, link);
    const r = run(GO, { APP_DIR: link });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(appDir), 'the real clone is gone');
    assert.match(r.stdout, /Removed BrainAI from this server\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a folder of the export that is a link leading elsewhere never lets the delete reach outside it', () => {
  const { root, exportDir, run } = setup();
  try {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'apps'), { recursive: true });
    writeFileSync(join(outside, 'apps', 'x.md'), 'mine');
    writeFileSync(join(outside, 'x.md'), 'mine');
    mkdirSync(join(exportDir, 'facts'));
    symlinkSync(outside, join(exportDir, 'facts', 'linked'));
    symlinkSync(join(outside, 'apps'), join(exportDir, 'skills'));
    const r = run(GO);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(outside, 'x.md')) && existsSync(join(outside, 'apps', 'x.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the app stops before the copy; "no" starts it again, "remove" leaves it stopped', () => {
  for (const answer of ['no', 'remove']) {
    const { root, calls, run } = setup();
    try {
      const r = run(`\n${answer}\n`);
      const c = calls().split('\n').filter(Boolean);
      const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
      const stopAt = idx(/ stop app$/), saveAt = idx(/save-copy/);
      assert.ok(stopAt >= 0 && saveAt > stopAt, calls());
      assert.match(r.stdout, /Stopping BrainAI so nothing is saved after the copy/);
      if (answer === 'no') {
        assert.ok(idx(/ start$/) > saveAt, calls());
        assert.match(r.stdout, /BrainAI is running again\./);
        assert.ok(idx(/ down /) < 0);
      } else {
        assert.ok(idx(/ start$/) < 0, calls());
        assert.ok(idx(/ down /) > saveAt, calls());
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a failed save starts the app again', () => {
  const { root, calls, run } = setup();
  try {
    writeFileSync(join(root, 'savefail'), '');
    const r = run(GO);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BrainAI is running again\./);
    assert.match(calls(), / stop app\n[\s\S]*save-copy[\s\S]* start\n/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('if stopping the app fails, it says so, does not try to start it, and changes nothing', () => {
  const { root, calls, run } = setup();
  try {
    writeFileSync(join(root, 'stopfail'), '');
    const r = run(GO);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Stopping BrainAI failed/);
    assert.doesNotMatch(r.stdout, /Could not start|running again/);
    assert.ok(!/save-copy| start$| down /m.test(calls()), calls());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an app that was not running is not started by a cancel', () => {
  const { root, calls, run } = setup();
  try {
    writeFileSync(join(root, 'app-down'), '');
    const r = run('\nno\n');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/ start$/m.test(calls()), calls());
    assert.doesNotMatch(r.stdout, /running again/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a TERM while it waits at the prompt starts the app again and leaves no temporary folder', async () => {
  const { root, home, calls, child } = setup();
  try {
    const c = child();
    let out = '';
    // One TERM only: `out` keeps matching as more output arrives (the trap's own lines), and on a loaded machine that
    // output comes in several chunks, so a check per chunk would send a second TERM while the trap is still running.
    let sent = false;
    c.stdout.on('data', (b) => { out += b; if (!sent && /Press Enter once/.test(out)) { sent = true; c.kill('SIGTERM'); } });
    const code = await new Promise<number | null>((resolve) => c.on('close', resolve));
    assert.equal(code, 143, out);
    assert.match(calls(), / stop app\n[\s\S]*save-copy[\s\S]* start\n/);
    assert.ok(!/ down /.test(calls()));
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('.brainai-save.')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
