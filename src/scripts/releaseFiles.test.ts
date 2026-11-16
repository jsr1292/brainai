/**
 * scripts/publish/check-release-files.sh: the privacy check over a finished release folder (the dmg, the Mac update
 * archive, the Windows installer and the small files beside them), and the argument checks of
 * scripts/publish/build-apps.sh (the build itself is too slow for a test: it is run by hand, docs/DESKTOP.md).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = join(repoRoot, 'scripts', 'publish', 'check-release-files.sh');
const build = join(repoRoot, 'scripts', 'publish', 'build-apps.sh');
const updaterKey = join(repoRoot, 'src', 'scripts', 'updaterKey.ts');
const tauriCli = join(repoRoot, 'desktop', 'node_modules', '.bin', 'tauri');
const isRoot = process.getuid?.() === 0;
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const haveTar = has('tar');
const haveHdiutil = has('hdiutil');
const have7z = has('7z');
// A made-up word standing in for the owner's name, and a made-up home folder. Built at run time so this file never
// holds them whole.
const WORD = ['Zan', 'zibar', 'quux'].join('');
const FAKE_HOME = ['/Users', ['bu', 'ild', 'er', 'qq'].join('')].join('/');
const V = '1.2.0';
const APP = 'BrainAI.app/Contents/Resources/server';

/** A key-shaped string that is not one of the known synthetic fixtures, built at run time (never in a file here). */
function realLookingKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return ['gh', 'p_'].join('') + [...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * A fake release folder: the Mac update archive holding the server's own code, one dependency and the shell
 * executable (binary: it holds a NUL byte), and the manifest.
 */
function world(t: TestContext, files: { dist?: string; dep?: string; exe?: Buffer } = {}, terms = `# private words\n${WORD}\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, content: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };
  write(`app/${APP}/dist/x.js`, files.dist ?? 'export const x = 1;\n');
  write(`app/${APP}/node_modules/m/index.js`, files.dep ?? 'module.exports = 2;\n');
  write(`app/${APP}/package.json`, '{ "name": "brainai" }\n');
  mkdirSync(join(dir, 'app/BrainAI.app/Contents/MacOS'), { recursive: true });
  writeFileSync(join(dir, 'app/BrainAI.app/Contents/MacOS/brainai'), files.exe ?? exe('the shell'));
  const rel = join(dir, 'release');
  mkdirSync(rel);
  const tar = spawnSync('tar', ['-czf', join(rel, `BrainAI_${V}_aarch64.app.tar.gz`), '-C', join(dir, 'app'), 'BrainAI.app']);
  assert.equal(tar.status, 0, String(tar.stderr));
  writeFileSync(join(rel, 'latest.json'), `{ "version": "${V}", "notes": "Fixes." }\n`);
  writeFileSync(join(rel, 'release-notes.md'), 'Fixes.\n');
  const denylist = join(dir, 'denylist.txt');
  writeFileSync(denylist, terms);
  return {
    dir, rel, denylist, write,
    run: (env: Record<string, string> = {}, list = denylist) => {
      const r = spawnSync('bash', [check, list, rel], { encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, ...env } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
}

/** A binary file (a NUL byte first, as the Mach-O header has) holding the text. */
const exe = (text: string, utf16 = false) => Buffer.concat([Buffer.from([0x7f, 0, 0, 0]), Buffer.from(`\n${text}\n`, utf16 ? 'utf16le' : 'utf8'), Buffer.from([0])]);

const quiet = (out: string, secret: string) => assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), out);

test('a clean release folder passes', { skip: !haveTar }, (t) => {
  const r = world(t).run();
  assert.equal(r.status, 0, r.out);
});

test("a denylisted word in BrainAI's own code fails, naming the file but never the word", { skip: !haveTar }, (t) => {
  const r = world(t, { dist: `// by ${WORD.toLowerCase()}\n` }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /server\/dist\/x\.js:1: a denylisted word/);
  assert.equal(r.out.trim().split('\n').length, 1, `one finding, printed once:\n${r.out}`);
  quiet(r.out, WORD);
});

test('the same word only in a dependency passes: third-party files are checked for the build path only', { skip: !haveTar }, (t) => {
  const r = world(t, { dep: `// ${WORD}\n` }).run();
  assert.equal(r.status, 0, r.out);
});

test("the build Mac's home path in any file fails, with / or \\ separators", { skip: !haveTar }, (t) => {
  const r = world(t, { dep: `require("${FAKE_HOME}/src/m")\n` }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /node_modules\/m\/index\.js:1: a build path/);
  quiet(r.out, FAKE_HOME);
  const w = world(t);
  writeFileSync(join(w.rel, 'install-app.ps1'), `$p = "C:${FAKE_HOME.replaceAll('/', '\\')}\\x"\n`);
  const r2 = w.run();
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /install-app\.ps1:1: a build path/);
});

test("a key-shaped string in BrainAI's own code fails without printing it", { skip: !haveTar }, (t) => {
  const key = realLookingKey();
  const r = world(t, { dist: `const k = '${key}';\n` }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /server\/dist\/x\.js:1: a key-shaped string/);
  quiet(r.out, key);
});

test('an empty denylist, a missing one or a missing folder is wrong use', { skip: !haveTar }, (t) => {
  const w = world(t);
  const empty = join(w.dir, 'empty.txt');
  writeFileSync(empty, '# only a comment\n\n');
  assert.equal(w.run({}, empty).status, 2);
  assert.equal(w.run({}, join(w.dir, 'nope.txt')).status, 2);
  assert.equal(spawnSync('bash', [check, w.denylist, join(w.dir, 'nope')]).status, 2);
  assert.equal(spawnSync('bash', [check]).status, 2);
});

test('the dmg is opened read-only and always detached afterwards', { skip: !haveHdiutil ? 'no hdiutil (not a Mac)' : false }, (t) => {
  const w = world(t);
  const dmg = join(w.rel, `BrainAI_${V}_aarch64.dmg`);
  const made = spawnSync('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'BrainAI', '-srcfolder', join(w.dir, 'app'), '-format', 'UDZO', dmg]);
  assert.equal(made.status, 0, String(made.stderr));
  assert.equal(w.run().status, 0);
  w.write(`app/${APP}/dist/x.js`, `// ${WORD}\n`);
  rmSync(dmg);
  assert.equal(spawnSync('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'BrainAI', '-srcfolder', join(w.dir, 'app'), '-format', 'UDZO', dmg]).status, 0);
  rmSync(join(w.rel, `BrainAI_${V}_aarch64.app.tar.gz`));
  const r = w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\.dmg\/BrainAI\.app\/Contents\/Resources\/server\/dist\/x\.js:1: a denylisted word/);
  quiet(r.out, WORD);
  assert.ok(!spawnSync('hdiutil', ['info'], { encoding: 'utf8' }).stdout.includes(dmg), 'the dmg is still attached');
});

test('the Windows installer is unpacked with 7z and its own files checked', { skip: !have7z ? 'no 7z' : false }, (t) => {
  const w = world(t);
  w.write('win/server/dist/x.js', `// ${WORD}\n`);
  w.write('win/server/node_modules/m/index.js', `// ${WORD}\n`);
  // 7z finds the format from the bytes, so a zip stands in for the NSIS installer.
  const made = spawnSync('7z', ['a', '-tzip', '-bd', join(w.rel, `BrainAI_${V}_x64-setup.exe`), '.'], { cwd: join(w.dir, 'win') });
  assert.equal(made.status, 0, String(made.stderr));
  const r = w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /x64-setup\.exe\/server\/dist\/x\.js:1: a denylisted word/);
  assert.doesNotMatch(r.out, /node_modules/);
  quiet(r.out, WORD);
});

test('the shell executable gets the build-path and key scans, never the denylist scan', { skip: !haveTar }, (t) => {
  // Its text comes from gated sources (desktop/src-tauri/src, desktop/ui, tauri.conf.json) and from Rust crates
  // whose data tables (time zones) and joined string constants would be false findings.
  let r = world(t, { exe: exe(`a constant: ${WORD}`) }).run();
  assert.equal(r.status, 0, r.out);
  r = world(t, { exe: exe(`panicked at ${FAKE_HOME}/.cargo/registry/src/x.rs`) }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Contents\/MacOS\/brainai(:\d+)?: a build path/);
  quiet(r.out, FAKE_HOME);
  const key = realLookingKey();
  r = world(t, { exe: exe(`token=${key}`) }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Contents\/MacOS\/brainai:\d+: a key-shaped string/);
  quiet(r.out, key);
});

test('a build path written as UTF-16 text in a binary file is found too', { skip: !haveTar }, (t) => {
  const r = world(t, { exe: exe(`C:${FAKE_HOME.replaceAll('/', '\\')}\\x.pdb`, true) }).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Contents\/MacOS\/brainai.*: a build path/);
  quiet(r.out, FAKE_HOME);
});

test('a file the check cannot read is wrong use, never a pass, and its path is not printed raw', { skip: !haveTar || isRoot ? 'needs tar, and a user that file modes apply to' : false }, (t) => {
  const w = world(t);
  writeFileSync(join(w.rel, 'latest.json'), `{ "notes": "${WORD}" }\n`);
  chmodSync(join(w.rel, 'latest.json'), 0o000);
  const r = w.run();
  assert.equal(r.status, 2, r.out);
  assert.ok(!r.out.includes(w.rel), r.out);
  quiet(r.out, WORD);
});

test('a release folder the check cannot open, an empty one, or one holding a folder or a broken link is wrong use', { skip: !haveTar || isRoot ? 'needs tar, as a user' : false }, (t) => {
  const locked = world(t);
  chmodSync(locked.rel, 0o000);
  const r1 = locked.run();
  chmodSync(locked.rel, 0o755);
  assert.equal(r1.status, 2, r1.out);
  assert.ok(!r1.out.includes(locked.rel), r1.out);

  const empty = world(t);
  for (const f of ['latest.json', 'release-notes.md', `BrainAI_${V}_aarch64.app.tar.gz`]) rmSync(join(empty.rel, f));
  assert.equal(empty.run().status, 2);

  const nested = world(t);
  mkdirSync(join(nested.rel, 'extra'));
  writeFileSync(join(nested.rel, 'extra', 'notes.txt'), `${WORD}\n`);
  const r3 = nested.run();
  assert.equal(r3.status, 2, r3.out);
  quiet(r3.out, WORD);

  const broken = world(t);
  symlinkSync(join(broken.dir, 'nowhere'), join(broken.rel, 'gone.json'));
  assert.equal(broken.run().status, 2);
});

test('an unreadable file inside the update archive is wrong use, never a pass',{ skip: !haveTar || isRoot || !/bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout) ? 'needs bsdtar, as a user' : false }, (t) => {
  const w = world(t);
  const src = join(w.dir, 'y.js');
  writeFileSync(src, `// ${WORD}\n`);
  const archive = join(w.rel, `BrainAI_${V}_aarch64.app.tar.gz`);
  rmSync(archive);
  // An mtree spec makes the archive hold a mode-000 file without making one on disk.
  const made = spawnSync('tar', ['-czf', archive, '@-'], { cwd: w.dir, input: `#mtree\n./BrainAI.app/Contents/Resources/server/dist/y.js type=file mode=0000 contents=${src}\n` });
  assert.equal(made.status, 0, String(made.stderr));
  const r = w.run();
  assert.equal(r.status, 2, r.out);
  quiet(r.out, WORD);
});

test('updaterKey.ts accepts signatures by the trusted key and refuses another key', { skip: !existsSync(tauriCli) ? 'no desktop/node_modules (npm ci in desktop/)' : false }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'updater-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tauri = (...args: string[]) => {
    const r = spawnSync(tauriCli, args, { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 0, `${args[1]}: ${r.stderr}`);
  };
  // Two throwaway keys; the file is signed with the first.
  tauri('signer', 'generate', '--ci', '-p', 'pw', '-w', join(dir, 'a'));
  tauri('signer', 'generate', '--ci', '-p', 'pw', '-w', join(dir, 'b'));
  writeFileSync(join(dir, 'app.tar.gz'), 'an update\n');
  tauri('signer', 'sign', '-f', join(dir, 'a'), '-p', 'pw', join(dir, 'app.tar.gz'));
  const check = (...args: string[]) => spawnSync('node', ['--import', 'tsx', updaterKey, ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(check(join(dir, 'a.pub'), join(dir, 'app.tar.gz.sig')).status, 0);
  const conf = join(dir, 'tauri.conf.json');
  writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: readFileSync(join(dir, 'a.pub'), 'utf8').trim() } } }));
  assert.equal(check(conf, join(dir, 'app.tar.gz.sig')).status, 0);
  const r = check(join(dir, 'b.pub'), join(dir, 'app.tar.gz.sig'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /app\.tar\.gz\.sig was not signed with the updater key the apps trust/);
  assert.equal(check(join(dir, 'b.pub')).status, 2);
});

// build-apps.sh: only what it refuses before any build starts.
// The version as the script reads it: from HEAD, not from the working tree. The release gate runs the tests in a copy
// with no git history; there the file is all there is.
const confHead = spawnSync('git', ['show', 'HEAD:desktop/src-tauri/tauri.conf.json'], { cwd: repoRoot, encoding: 'utf8' });
const confVersion = (JSON.parse(confHead.status === 0 ? confHead.stdout : readFileSync(join(repoRoot, 'desktop/src-tauri/tauri.conf.json'), 'utf8')) as { version: string }).version;
// build-apps.sh builds only inside the git repository, so its tests are skipped in such a copy.
const buildSkip = confHead.status === 0 ? false : 'build-apps.sh runs only inside the git repository';

/** A made-up home folder and a stand-in `security` tool, so the owner's Keychain and key files are never touched. */
function buildWorld(t: TestContext, identity: string, items: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'build-apps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const found = items.length > 0 ? items.join('|') : 'no-item-at-all';
  writeFileSync(join(bin, 'security'), `#!/bin/sh
case "$1" in
  find-identity) echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "${identity}"'; echo '     1 valid identities found' ;;
  find-generic-password) shift; while [ $# -gt 0 ]; do
    if [ "$1" = -s ]; then case "$2" in ${found}) echo made-up; exit 0 ;; esac; fi; shift
  done; exit 44 ;;
esac
`);
  chmodSync(join(bin, 'security'), 0o755);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'brainai'), { recursive: true });
  return {
    home,
    run: (...args: string[]) => {
      const r = spawnSync('bash', [build, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
}

test('build-apps.sh refuses no version, and a version unlike tauri.conf.json', { skip: buildSkip }, (t) => {
  const w = buildWorld(t, 'Apple Development: Test (TEAM123456)');
  assert.equal(w.run().status, 2);
  const r = w.run('9.9.99');
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /tauri\.conf\.json/);
  assert.equal(w.run('1.2').status, 2);
});

test('build-apps.sh refuses a real build without a Developer ID, the Apple account, the notary item or the updater key', { skip: buildSkip }, (t) => {
  let w = buildWorld(t, 'Apple Development: Test (TEAM123456)');
  let r = w.run(confVersion);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /Developer ID Application/);
  w = buildWorld(t, 'Developer ID Application: Test (TEAM123456)');
  r = w.run(confVersion);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /release\.env/);
  // An optional `export ` prefix, as a shell file would have it.
  writeFileSync(join(w.home, '.config', 'brainai', 'release.env'), 'export APPLE_ID=someone@example.com\nAPPLE_TEAM_ID=TEAM123456\n');
  r = w.run(confVersion);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /brainai-notary/);
  w = buildWorld(t, 'Developer ID Application: Test (TEAM123456)', ['brainai-notary', 'brainai-updater']);
  writeFileSync(join(w.home, '.config', 'brainai', 'release.env'), 'APPLE_ID=someone@example.com\nAPPLE_TEAM_ID=TEAM123456\n');
  r = w.run(confVersion);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /updater\.key/);
  quiet(r.out, 'made-up');
});
