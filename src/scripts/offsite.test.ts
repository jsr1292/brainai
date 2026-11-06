import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { seedSignIn } from '../testing/helpers.js';

/** Stand-ins for age and rclone: age copies its input to -o and notes the recipients file; rclone copies or deletes in a local folder. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'offsite-test-'));
  const appDir = join(root, 'app');
  const bin = join(root, 'bin');
  const remote = join(root, 'remote');
  for (const d of [join(appDir, 'backups'), join(appDir, 'data'), bin, remote]) mkdirSync(d, { recursive: true });
  writeFileSync(join(appDir, 'backups', 'memory-2026-10-20.db'), 'older');
  // The newest nightly file, here one from before backups were stripped: the off-site copy strips it again.
  const db = openDb(join(appDir, 'backups', 'memory-2026-10-21.db'));
  seedSignIn(db);
  db.close();
  // A full copy taken by hand before a migration (sign-in data included): never the one sent off-site.
  writeFileSync(join(appDir, 'backups', 'memory-pre-migration11.db'), 'has secrets');
  writeFileSync(join(appDir, 'offsite-recipient.txt'), 'age1examplepublickey\n');
  writeFileSync(join(bin, 'age'), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -R) echo "$2" > "${root}/age-recipients";shift 2;; -o) out="$2";shift 2;; *) in="$1";shift;; esac; done
cp "$in" "$out"\n`);
  writeFileSync(join(bin, 'rclone'), `#!/bin/sh
echo "$@" >> "${root}/rclone-calls"
[ -f "${root}/rclone-fail" ] && { echo "token expired" >&2; exit 1; }
case "$1" in
  copy) cp "$2" "${remote}/";;
  delete) ;;
  lsf) d="${remote}/$(echo "$2" | sed 's|^[^:]*:[^/]*/*||')"; [ -d "$d" ] && ls -1 "$d"; true;;
  copyto) [ -f "${root}/copyto-fail" ] && exit 1; mkdir -p "${remote}/images"; cp "$2" "${remote}/images/$(basename "$3")";;
  deletefile) rm -f "${remote}/images/$(basename "$2")";;
esac\n`);
  for (const f of ['age', 'rclone']) chmodSync(join(bin, f), 0o755);
  // The nightly page and fact export (scripts/export-brain.sh), with its git folder.
  const exportDir = join(root, 'brain-export');
  for (const d of [join(exportDir, 'pages', 'apps', 'wildlog'), join(exportDir, 'facts'), join(exportDir, '.git')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(exportDir, 'README.md'), '# The brain\n');
  writeFileSync(join(exportDir, 'pages', 'apps', 'wildlog', 'overview.md'), '# wildlog\n');
  writeFileSync(join(exportDir, 'facts', 'wildlog.md'), '- a fact\n');
  writeFileSync(join(exportDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const run = () => spawnSync('bash', ['scripts/offsite.sh'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_DIR: appDir, BRAIN_EXPORT_DIR: exportDir, OFFSITE_REMOTE: 'gdrive:memory-backups', EXPORT_CMD: 'printf "# Shared memory\n"' },
  });
  return { root, appDir, remote, exportDir, run };
}

test("the weekly off-site copy packs the newest nightly backup and a Markdown export, encrypted to the owner's key, and uploads it", () => {
  const { root, appDir, remote, run } = setup();
  try {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const [file] = readdirSync(remote);
    assert.match(file!, /^memory-\d{4}-\d\d-\d\d\.tar\.gz\.age$/);
    const listing = spawnSync('tar', ['-tzf', join(remote, file!)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(listing.filter((f) => !f.endsWith('/')), ['brain-export/README.md', 'brain-export/facts/wildlog.md', 'brain-export/pages/apps/wildlog/overview.md', 'memory-2026-10-21.db', 'memory.md']);
    assert.ok(!listing.some((f) => f.includes('.git')), 'the export\'s git folder stays home');
    const unpacked = join(root, 'unpacked');
    mkdirSync(unpacked);
    spawnSync('tar', ['-xzf', join(remote, file!), '-C', unpacked]);
    const bytes = readFileSync(join(unpacked, 'memory-2026-10-21.db')).toString('latin1');
    for (const marker of ['TOTPSECRETMARKER', 'HASHMARKER', 'SESSIONMARKER', 'DEVICEMARKER', 'CLIENTSECRETMARKER']) assert.ok(!bytes.includes(marker), marker);
    assert.equal(readFileSync(join(root, 'age-recipients'), 'utf8').trim(), join(appDir, 'offsite-recipient.txt'));
    assert.match(readFileSync(join(root, 'rclone-calls'), 'utf8'), /^copy .*memory-.*\.tar\.gz\.age gdrive:memory-backups\ndelete gdrive:memory-backups --min-age 90d --include memory-\*\.tar\.gz\.age --drive-use-trash=false\n$/);
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.where, 'gdrive:memory-backups');
    assert.equal(status.file, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed upload, or no key to encrypt to, is recorded with the step that failed, and leaves nothing behind', () => {
  const { root, appDir, run } = setup();
  try {
    writeFileSync(join(root, 'rclone-fail'), '');
    assert.notEqual(run().status, 0);
    let status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.match(status.error, /uploading to gdrive:memory-backups/);
    rmSync(join(appDir, 'offsite-recipient.txt'));
    assert.notEqual(run().status, 0);
    status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.match(status.error, /no key to encrypt to/);
    assert.ok(!existsSync(join(appDir, 'backups', 'offsite')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('error text with quotes or newlines still leaves a readable status file', () => {
  const { root, appDir, run } = setup();
  try {
    writeFileSync(join(appDir, 'offsite-recipient.txt'), '');
    const r = spawnSync('bash', ['scripts/offsite.sh'], { encoding: 'utf8', env: { ...process.env, APP_DIR: appDir, OFFSITE_RECIPIENT_FILE: join(root, 'a "quoted"\nkey') } });
    assert.notEqual(r.status, 0);
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.match(status.error, /no key to encrypt to: .*a "quoted" key/);
    void run;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without the page export the copy is still uploaded, and the status says the pages are missing', () => {
  const { root, appDir, remote, exportDir, run } = setup();
  try {
    rmSync(exportDir, { recursive: true });
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readdirSync(remote).length, 1, 'the database and facts still leave the house');
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.match(status.error, /without the pages/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed copy of the page export still uploads the database, and the status says the pages are missing', () => {
  const { root, appDir, remote, run } = setup();
  try {
    // A file vanishing mid-copy (the nightly export running at the same time) makes rsync exit 24.
    writeFileSync(join(root, 'bin', 'rsync'), '#!/bin/sh\necho "file has vanished" >&2\nexit 24\n');
    chmodSync(join(root, 'bin', 'rsync'), 0o755);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readdirSync(remote).length, 1, 'the database and facts still leave the house');
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.match(status.error, /uploaded without the pages: copying .+ failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Pictures (round 2 section 12) ----

/** Two live pictures and two deleted ones (100 and 10 days ago), in the newest nightly backup and in data/images. */
function withPictures(appDir: string) {
  const db = openDb(join(appDir, 'backups', 'memory-2026-10-21.db'));
  const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  const row = db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at) VALUES (?, ?, 3, 1, 1, '2026-10-01', 'owner', ?)");
  const ids = { a: 'a'.repeat(24), b: 'b'.repeat(24), old: 'e'.repeat(24), recent: 'd'.repeat(24) };
  row.run(ids.a, 'jpeg', null); row.run(ids.b, 'png', null); row.run(ids.old, 'png', days(100)); row.run(ids.recent, 'gif', days(10));
  db.close();
  for (const [id, ext] of [[ids.a, 'jpg'], [ids.b, 'png'], [ids.old, 'png'], [ids.recent, 'gif']] as const) {
    mkdirSync(join(appDir, 'data', 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(appDir, 'data', 'images', id.slice(0, 2), `${id}.${ext}`), `picture ${id}`);
  }
  mkdirSync(join(appDir, 'data', 'images', 'tmp'), { recursive: true });
  writeFileSync(join(appDir, 'data', 'images', 'tmp', 'half'), 'x');
  return ids;
}

test('pictures go off-site one encrypted file each, once, and leave 90 days after Delete for good', () => {
  const { root, appDir, remote, run } = setup();
  try {
    const ids = withPictures(appDir);
    mkdirSync(join(remote, 'images'), { recursive: true });
    writeFileSync(join(remote, 'images', `${ids.old}.png.age`), 'old');
    writeFileSync(join(remote, 'images', `${ids.recent}.gif.age`), 'recent');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const there = readdirSync(join(remote, 'images')).sort();
    assert.deepEqual(there, [`${ids.a}.jpg.age`, `${ids.b}.png.age`, `${ids.recent}.gif.age`]);
    assert.equal(readFileSync(join(remote, 'images', `${ids.a}.jpg.age`), 'utf8'), `picture ${ids.a}`, 'the age stand-in copied that one file');
    const calls = () => readFileSync(join(root, 'rclone-calls'), 'utf8').split('\n').filter(Boolean);
    assert.equal(calls().filter((c) => c.startsWith('lsf ')).length, 1);
    writeFileSync(join(root, 'rclone-calls'), '');
    assert.equal(run().status, 0);
    assert.equal(calls().filter((c) => c.startsWith('copyto ')).length, 0, 'nothing is sent twice');
    assert.equal(calls().filter((c) => c.startsWith('lsf ')).length, 1);
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a picture that cannot be sent leaves the copy uploaded and says so', () => {
  const { root, appDir, remote, run } = setup();
  try {
    withPictures(appDir);
    writeFileSync(join(root, 'copyto-fail'), '');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readdirSync(remote).some((f) => f.endsWith('.tar.gz.age')), 'the pack went');
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'offsite-status.json'), 'utf8'));
    assert.equal(status.ok, false);
    assert.equal(status.error, 'uploaded, but the pictures could not all be sent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no pictures yet the copy runs as before, with no picture calls', () => {
  const { root, run } = setup();
  try {
    assert.equal(run().status, 0);
    assert.doesNotMatch(readFileSync(join(root, 'rclone-calls'), 'utf8'), /lsf|copyto|deletefile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
