import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { seedSignIn } from '../testing/helpers.js';

const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const haveSqlite = have('sqlite3');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'backup-test-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, 'data'), { recursive: true });
  openDb(join(appDir, 'data', 'memory.db')).close();
  return { root, appDir };
}
const today = () => new Date().toLocaleDateString('sv-SE');

test('backup writes a verified copy everywhere and prunes only old memory-*.db files', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const copies = [join(root, 'copyA', 'memory-backups'), join(root, 'copyB', 'memory-backups')];
    const old = new Date(Date.now() - 60 * 86400_000);
    // Pre-create old files in the backups dir and each copy dir.
    mkdirSync(join(appDir, 'backups'), { recursive: true });
    for (const dir of [join(appDir, 'backups'), ...copies]) {
      mkdirSync(dir, { recursive: true });
      for (const f of ['memory-2020-01-01.db', 'keep-me.txt']) {
        writeFileSync(join(dir, f), 'x');
        utimesSync(join(dir, f), old, old);
      }
    }
    execFileSync('bash', ['scripts/backup.sh'], {
      env: { ...process.env, APP_DIR: appDir, COPY_DIRS: copies.join(' '), SKIP_MOUNT_CHECK: '1' },
    });
    const name = `memory-${today()}.db`;
    for (const dir of [join(appDir, 'backups'), ...copies]) {
      assert.ok(existsSync(join(dir, name)), `missing ${name} in ${dir}`);
      const out = execFileSync('sqlite3', [join(dir, name), 'PRAGMA integrity_check']).toString().trim();
      assert.equal(out, 'ok');
      assert.ok(!existsSync(join(dir, 'memory-2020-01-01.db')), 'old backup not pruned');
      assert.ok(existsSync(join(dir, 'keep-me.txt')), 'unrelated file was deleted');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup skips copy dirs whose parent is not a mount point', { skip: !haveSqlite || !have('mountpoint') }, () => {
  const { root, appDir } = setup();
  try {
    const dir = join(root, 'notmounted', 'memory-backups');
    const r = spawnSync('bash', ['scripts/backup.sh'], {
      env: { ...process.env, APP_DIR: appDir, COPY_DIRS: dir, SKIP_MOUNT_CHECK: '0' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not mounted/);
    assert.ok(!existsSync(dir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a copy dir that cannot be written does not stop the other copies, and the run fails', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    // A file where the first copy dir should be: neither mkdir nor cp can write there.
    writeFileSync(join(root, 'broken'), 'not a dir');
    const broken = join(root, 'broken', 'memory-backups');
    const good = join(root, 'good', 'memory-backups');
    mkdirSync(good, { recursive: true });
    const old = new Date(Date.now() - 60 * 86400_000);
    writeFileSync(join(good, 'memory-2020-01-01.db'), 'x');
    utimesSync(join(good, 'memory-2020-01-01.db'), old, old);
    const r = spawnSync('bash', ['scripts/backup.sh'], {
      env: { ...process.env, APP_DIR: appDir, COPY_DIRS: `${broken} ${good}`, SKIP_MOUNT_CHECK: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`backup: could not copy to ${broken}`));
    assert.ok(existsSync(join(good, `memory-${today()}.db`)), 'second copy dir skipped');
    assert.ok(!existsSync(join(good, 'memory-2020-01-01.db')), 'successful copy dir not pruned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the nightly backup leaves out the sign-in secrets too', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const db = openDb(join(appDir, 'data', 'memory.db'));
    seedSignIn(db);
    db.close();
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'copy', 'memory-backups'), SKIP_MOUNT_CHECK: '1' } });
    const path = join(appDir, 'backups', `memory-${today()}.db`);
    assert.equal(execFileSync('sqlite3', [path, 'SELECT COUNT(*) FROM owner']).toString().trim(), '0');
    const bytes = readFileSync(path).toString('latin1');
    for (const marker of ['TOTPSECRETMARKER', 'HASHMARKER', 'SESSIONMARKER', 'DEVICEMARKER', 'CLIENTSECRETMARKER']) assert.ok(!bytes.includes(marker), marker);
    assert.equal(execFileSync('sqlite3', [join(appDir, 'data', 'memory.db'), 'SELECT COUNT(*) FROM owner']).toString().trim(), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the nightly backup leaves out the Mac\'s device tokens, and still works on a database from before them', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const db = openDb(join(appDir, 'data', 'memory.db'));
    db.prepare("INSERT INTO device_tokens(id, name, token_hash, created_at) VALUES ('d1', 'Mac', 'MACTOKENHASHMARKER', 'x')").run();
    db.prepare("INSERT INTO folder_reports(device_id, received_at, folders) VALUES ('d1', 'x', '[]')").run();
    db.close();
    const env = { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'copy', 'memory-backups'), SKIP_MOUNT_CHECK: '1' };
    execFileSync('bash', ['scripts/backup.sh'], { env });
    const path = join(appDir, 'backups', `memory-${today()}.db`);
    assert.equal(execFileSync('sqlite3', [path, 'SELECT COUNT(*) FROM device_tokens']).toString().trim(), '0');
    assert.ok(!readFileSync(path).toString('latin1').includes('MACTOKENHASHMARKER'));
    const old = openDb(join(appDir, 'data', 'memory.db'));
    old.exec('DROP TABLE folder_reports; DROP TABLE device_tokens');
    old.close();
    rmSync(path);
    execFileSync('bash', ['scripts/backup.sh'], { env });
    assert.ok(existsSync(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the nightly backup also works on a database from before the known-devices table, and never leaves a half-stripped file', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const db = openDb(join(appDir, 'data', 'memory.db'));
    seedSignIn(db);
    db.exec('DROP TABLE known_devices');
    db.close();
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'copy', 'memory-backups'), SKIP_MOUNT_CHECK: '1' } });
    const path = join(appDir, 'backups', `memory-${today()}.db`);
    assert.equal(execFileSync('sqlite3', [path, 'SELECT COUNT(*) FROM oauth_tokens; SELECT COUNT(*) FROM owner']).toString().trim(), '0\n0');
    const secret = execFileSync('sqlite3', [path, "SELECT json_extract(metadata, '$.client_secret') FROM oauth_clients"]).toString().trim();
    assert.match(secret, /^[0-9a-f]{64}$/);
    // A database the strip cannot handle: the run fails and no backup file is left behind.
    const broken = openDb(join(appDir, 'data', 'memory.db'));
    broken.exec('DROP TABLE oauth_pending');
    broken.close();
    rmSync(path);
    const r = spawnSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'copy', 'memory-backups'), SKIP_MOUNT_CHECK: '1' }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(join(appDir, 'backups')).filter((f) => f.startsWith(`memory-${today()}`)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each nightly run records what happened to every copy for the dashboard', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    writeFileSync(join(root, 'broken'), 'not a dir');
    const good = join(root, 'good', 'memory-backups');
    const broken = join(root, 'broken', 'memory-backups');
    spawnSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: `${good} ${broken}`, SKIP_MOUNT_CHECK: '1' } });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.match(status.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(status.copies, [{ where: good, result: 'copied' }, { where: broken, result: 'failed', detail: 'could not copy' }]);
    // A run whose snapshot fails says so.
    rmSync(join(appDir, 'data', 'memory.db'));
    mkdirSync(join(appDir, 'data', 'memory.db'));
    spawnSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: good, SKIP_MOUNT_CHECK: '1' } });
    const failed = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a copy folder whose disk is not mounted is recorded as skipped', { skip: !haveSqlite || !have('mountpoint') }, () => {
  const { root, appDir } = setup();
  try {
    const dir = join(root, 'notmounted', 'memory-backups');
    spawnSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: dir, SKIP_MOUNT_CHECK: '0' } });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.deepEqual(status.copies, [{ where: dir, result: 'skipped', detail: 'not mounted' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup.sh records the facts and pages in the checked copy', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const db = openDb(join(appDir, 'data', 'memory.db'));
    const ins = db.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, deleted_at)
      VALUES (?, 'decision', 'x', 'p', '[]', x'00', '2026-11-01', 'o', '2026-11-01', 'o', ?)`);
    ins.run('m1', null); ins.run('m2', null); ins.run('m3', '2026-11-02');
    const page = db.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by, deleted_at)
      VALUES (?, ?, ?, NULL, 'start', 'b', 1, 'now', 'o', 'now', 'o', ?)`);
    page.run('p1', 'One', 'one', null); page.run('p2', 'Two', 'two', 'gone');
    db.close();
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'c', 'memory-backups'), SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.deepEqual(status.counts, { facts: 2, pages: 1, images: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup.sh leaves the counts out when it cannot count, instead of reporting zero', { skip: !haveSqlite }, () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-oldschema-'));
  try {
    const appDir = join(root, 'app');
    mkdirSync(join(appDir, 'data'), { recursive: true });
    openDb(join(appDir, 'data', 'memory.db'), { upTo: 14 }).close();
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: join(root, 'c', 'memory-backups'), SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.counts, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Pictures (round 2 section 12) ----

/** A data dir with picture rows and files: two live with files, one live without, one deleted 10 days ago, one 31. */
function withPictures(appDir: string) {
  const db = openDb(join(appDir, 'data', 'memory.db'));
  const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  const row = db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, removed_at) VALUES (?, ?, 3, 1, 1, '2026-11-01', 'owner', ?)");
  const file = (id: string, ext: string) => { mkdirSync(join(appDir, 'data', 'images', id.slice(0, 2)), { recursive: true }); writeFileSync(join(appDir, 'data', 'images', id.slice(0, 2), `${id}.${ext}`), id); };
  const ids = { a: 'a'.repeat(24), b: 'b'.repeat(24), lost: 'c'.repeat(24), recent: 'd'.repeat(24), old: 'e'.repeat(24) };
  row.run(ids.a, 'jpeg', null); file(ids.a, 'jpg');
  row.run(ids.b, 'png', null); file(ids.b, 'png');
  row.run(ids.lost, 'gif', null);
  row.run(ids.recent, 'webp', days(10)); file(ids.recent, 'webp');
  row.run(ids.old, 'png', days(31)); file(ids.old, 'png');
  db.close();
  return ids;
}
const pic = (dir: string, id: string, ext: string) => join(dir, 'images', id.slice(0, 2), `${id}.${ext}`);

test('pictures are copied next to every backup, checked against their rows, and pruned only from the copies', { skip: !haveSqlite || !have('rsync') }, () => {
  const { root, appDir } = setup();
  try {
    const ids = withPictures(appDir);
    mkdirSync(join(appDir, 'data', 'images', 'ab'), { recursive: true });
    writeFileSync(join(appDir, 'data', 'images', 'ab', `${'ab'.repeat(12)}.png`), 'stray');
    mkdirSync(join(appDir, 'data', 'images', 'tmp'), { recursive: true });
    writeFileSync(join(appDir, 'data', 'images', 'tmp', 'half-written'), 'x');
    const copies = [join(root, 'copyA', 'memory-backups'), join(root, 'copyB', 'memory-backups')];
    // A copy that already holds the old deleted picture (from an earlier night) loses it.
    for (const c of copies) { mkdirSync(join(c, 'images', 'ee'), { recursive: true }); writeFileSync(pic(c, ids.old, 'png'), 'old'); }
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: copies.join(' '), SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    for (const c of copies) {
      assert.ok(existsSync(pic(c, ids.a, 'jpg')) && existsSync(pic(c, ids.b, 'png')), c);
      assert.ok(existsSync(pic(c, ids.recent, 'webp')), 'deleted 10 days ago: kept');
      assert.ok(!existsSync(pic(c, ids.old, 'png')), 'deleted 31 days ago: pruned');
      assert.ok(!existsSync(join(c, 'images', 'tmp')), 'images/tmp is not copied');
    }
    assert.ok(existsSync(pic(join(appDir, 'data'), ids.old, 'png')), 'never pruned from data/images');
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(status.counts.images, 3);
    assert.deepEqual(status.pictures, { missing: 1, stray: 1 });
    assert.deepEqual(status.copies.map((x: { result: string }) => x.result), ['copied', 'copied']);
    // A second night copies nothing again: a copied file keeps its (older) time.
    const back = new Date(Date.now() - 3600_000);
    utimesSync(pic(copies[0]!, ids.a, 'jpg'), back, back);
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: copies.join(' '), SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    assert.ok(Math.abs(statSync(pic(copies[0]!, ids.a, 'jpg')).mtimeMs - back.getTime()) < 2000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a brain with no pictures yet backs up as before, with images 0 and no empty pictures folder', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const c = join(root, 'c', 'memory-backups');
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: c, SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(status.counts.images, 0);
    assert.deepEqual(status.pictures, { missing: 0, stray: 0 });
    assert.ok(!existsSync(join(c, 'images')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the nightly backup leaves out upload links, and still works on a database from before them', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const db = openDb(join(appDir, 'data', 'memory.db'));
    db.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by) VALUES ('p', 'P', 'p', NULL, 'start', 'b', 1, 'now', 'o', 'now', 'o')`).run();
    db.prepare("INSERT INTO image_upload_links(token_hash, grant_id, page_id, alt, created_by, created_at, expires_at) VALUES ('h', 'g', 'p', 'a', 'x', 'now', 'later')").run();
    db.close();
    const c = join(root, 'c', 'memory-backups');
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: appDir, COPY_DIRS: c, SKIP_MOUNT_CHECK: '1' }, stdio: 'pipe' });
    const out = execFileSync('sqlite3', [join(c, `memory-${today()}.db`), 'SELECT count(*) FROM image_upload_links'], { encoding: 'utf8' }).trim();
    assert.equal(out, '0');
    const old = mkdtempSync(join(tmpdir(), 'backup-pre25-'));
    try {
      mkdirSync(join(old, 'data'), { recursive: true });
      openDb(join(old, 'data', 'memory.db'), { upTo: 24 }).close();
      const r = spawnSync('bash', ['scripts/backup.sh'], { env: { ...process.env, APP_DIR: old, COPY_DIRS: join(old, 'c'), SKIP_MOUNT_CHECK: '1' }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const st = JSON.parse(readFileSync(join(old, 'data', 'backup-status.json'), 'utf8'));
      assert.equal(st.ok, true);
      assert.equal(st.counts.images, undefined, 'no images table: not counted');
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup reads the owner's overlay/scripts.env, the environment winning; with no copy folders it keeps the local copy only (O1)", { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const viaOverlay = join(root, 'overlay-copy', 'memory-backups');
    mkdirSync(join(appDir, 'overlay'), { recursive: true });
    writeFileSync(join(appDir, 'overlay', 'scripts.env'), `# the owner's mounts\nCOPY_DIRS=${viaOverlay}\nNOT VALID LINE\n$(touch ${join(root, 'pwned')})=x\n`);
    const env = { ...process.env, APP_DIR: appDir, SKIP_MOUNT_CHECK: '1' } as Record<string, string | undefined>;
    delete env.COPY_DIRS;
    execFileSync('bash', ['scripts/backup.sh'], { env: env as NodeJS.ProcessEnv });
    const name = `memory-${today()}.db`;
    assert.ok(existsSync(join(viaOverlay, name)), 'the overlay copy folder was used');
    assert.ok(!existsSync(join(root, 'pwned')), 'the overlay is read as KEY=value lines, never run');
    const viaEnv = join(root, 'env-copy');
    execFileSync('bash', ['scripts/backup.sh'], { env: { ...env, COPY_DIRS: viaEnv } as NodeJS.ProcessEnv });
    assert.ok(existsSync(join(viaEnv, name)), 'the environment wins over the overlay');
    rmSync(join(appDir, 'overlay'), { recursive: true });
    execFileSync('bash', ['scripts/backup.sh'], { env: env as NodeJS.ProcessEnv });
    const status = JSON.parse(readFileSync(join(appDir, 'data', 'backup-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.deepEqual(status.copies, []);
    assert.ok(existsSync(join(appDir, 'backups', name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlay values may be quoted or end in CRLF: the quotes and the CR are not part of the value (O1 review)', { skip: !haveSqlite }, () => {
  const { root, appDir } = setup();
  try {
    const a = join(root, 'quoted a', 'memory-backups');
    const b = join(root, 'b', 'memory-backups');
    mkdirSync(join(appDir, 'overlay'), { recursive: true });
    writeFileSync(join(appDir, 'overlay', 'scripts.env'), `COPY_DIRS="${b} ${join(root, 'c', 'memory-backups')}"\r\n`);
    const env = { ...process.env, APP_DIR: appDir, SKIP_MOUNT_CHECK: '1' } as Record<string, string | undefined>;
    delete env.COPY_DIRS;
    execFileSync('bash', ['scripts/backup.sh'], { env: env as NodeJS.ProcessEnv });
    const name = `memory-${today()}.db`;
    assert.ok(existsSync(join(b, name)), 'the first folder, without the opening quote');
    assert.ok(existsSync(join(root, 'c', 'memory-backups', name)), 'the last folder, without the closing quote or CR');
    assert.ok(!readdirSync(root).some((n) => n.includes('"')), 'no folder named with a quote');
    void a;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the scripts work from wherever the repo was cloned: with no APP_DIR they use their own repo folder, not ~/memory', { skip: !haveSqlite }, () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-anywhere-'));
  try {
    // A clone in ~/cairn (the default folder for `git clone …/cairn`), and a home with no ~/memory at all.
    const repo = join(root, 'home', 'cairn');
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(repo, 'data'), { recursive: true });
    for (const f of ['backup.sh', 'strip-signin.sh', 'backup-git.sh', 'export-brain.sh', 'offsite.sh', 'lib/overlay.sh']) { writeFileSync(join(repo, 'scripts', f), readFileSync(join('scripts', f))); chmodSync(join(repo, 'scripts', f), 0o755); }
    openDb(join(repo, 'data', 'memory.db')).close();
    const env = { ...process.env, HOME: join(root, 'home'), COPY_DIRS: '' } as Record<string, string>;
    delete env.APP_DIR;
    execFileSync('bash', [join(repo, 'scripts', 'backup.sh')], { env });
    assert.ok(existsSync(join(repo, 'backups', `memory-${today()}.db`)), 'the backup is in the clone');
    assert.ok(existsSync(join(repo, 'data', 'backup-status.json')), 'the status is where the clone\'s dashboard reads it');
    assert.ok(!existsSync(join(root, 'home', 'memory')), 'nothing was written to ~/memory');
    for (const f of ['backup-git.sh', 'export-brain.sh', 'offsite.sh', 'lib/overlay.sh']) {
      assert.doesNotMatch(readFileSync(join('scripts', f), 'utf8'), /\$HOME\/memory/, `${f} still assumes ~/memory`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
