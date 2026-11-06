import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from './secretScan.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gate = join(repoRoot, 'scripts', 'publish', 'check-public-tree.sh');
const haveGit = spawnSync('git', ['--version']).status === 0;
// A made-up word standing in for the owner's name. Built at run time so this file never holds it whole.
const WORD = ['Zan', 'zibar', 'quux'].join('');

/** A key-shaped string that is not one of the known synthetic fixtures, built at run time (never in a file here). */
function realLookingKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return ['gh', 'p_'].join('') + [...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join('');
}

function world(t: { after: (fn: () => void) => void }, files: Record<string, string>, terms = `# private words\n${WORD}\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0, args.join(' '));
  git('init', '-q');
  git('add', '-A');
  const denylist = join(dir, 'denylist.txt');
  writeFileSync(denylist, terms);
  return {
    dir, repo, denylist,
    run: (...extra: string[]) => {
      const r = spawnSync('bash', [gate, denylist, ...extra], { cwd: repo, encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
}

const CLEAN = { 'README.md': '# A brain\n\nNothing private here.\n', 'src/a.ts': 'export const a = 1;\n' };

test('a clean tree passes, and the copy holds exactly the tracked files', { skip: !haveGit }, (t) => {
  const w = world(t, CLEAN);
  const out = join(w.dir, 'out');
  const r = w.run(out, '--no-tests');
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(out, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.ok(!existsSync(join(out, '.git')));
});

test('a denylisted word fails the gate, naming the file and line but never the word', { skip: !haveGit }, (t) => {
  const w = world(t, { ...CLEAN, 'docs/notes.md': `line one\nWritten by ${WORD.toLowerCase()} at home\n` });
  const r = w.run('--no-tests');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /docs\/notes\.md:2: a denylisted word/);
  assert.ok(!r.out.toLowerCase().includes(WORD.toLowerCase()), r.out);
});

test('a denylisted word in a file name fails the gate too', { skip: !haveGit }, (t) => {
  const w = world(t, { ...CLEAN, [`docs/${WORD}-notes.md`]: 'fine\n' });
  const r = w.run('--no-tests');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /a file name holds a denylisted word/);
  assert.ok(!r.out.toLowerCase().includes(WORD.toLowerCase()), r.out);
});

test('a key-shaped string fails the gate without printing it, while the known synthetic fixtures pass', { skip: !haveGit }, (t) => {
  const key = realLookingKey();
  const w = world(t, { ...CLEAN, 'src/b.test.ts': `const k = '${key}';\n`, 'src/c.test.ts': "const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';\n" });
  const r = w.run('--no-tests');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /src\/b\.test\.ts:1: a key-shaped string/);
  assert.doesNotMatch(r.out, /c\.test\.ts/);
  assert.ok(!r.out.includes(key), r.out);
});

test('a private file (.env, a database, a key file) fails the gate', { skip: !haveGit }, (t) => {
  for (const name of ['.env', 'data/memory.db', 'notes.sqlite', 'my-key.txt', 'offsite-recipient.txt', 'deploy.pem']) {
    const w = world(t, { ...CLEAN, [name]: 'x\n' });
    const r = w.run('--no-tests');
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.match(r.out, /a private file/, name);
  }
  assert.equal(world(t, { ...CLEAN, '.env.example': 'PUBLIC_URL=https://memory.example.com\n' }).run('--no-tests').status, 0);
});

test('docs/superpowers is left out of the public tree, so its words do not count', { skip: !haveGit }, (t) => {
  const w = world(t, { ...CLEAN, 'docs/superpowers/plans/p.md': `${WORD} wrote this\n` });
  const out = join(w.dir, 'out');
  const r = w.run(out, '--no-tests');
  assert.equal(r.status, 0, r.out);
  assert.ok(!existsSync(join(out, 'docs', 'superpowers')));
});

test('an empty denylist checks no words but still checks files and keys', { skip: !haveGit }, (t) => {
  assert.equal(world(t, CLEAN, '').run('--no-tests').status, 0);
  assert.equal(world(t, { ...CLEAN, '.env': 'x\n' }, '\n\n').run('--no-tests').status, 1);
});

test('the gate refuses an output folder that already holds something, and never deletes it', { skip: !haveGit }, (t) => {
  const w = world(t, CLEAN);
  const out = join(w.dir, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'mine');
  const r = w.run(out, '--no-tests');
  assert.equal(r.status, 2, r.out);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'mine');
});

test('scanText reports the line and the kind of key, never the key', () => {
  const key = realLookingKey();
  assert.deepEqual(scanText(`ok\nuse ${key} here\n`), [{ line: 2, reason: 'GitHub token' }]);
  assert.deepEqual(scanText("const s = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';"), []);
  assert.deepEqual(scanText(`fixture abcdefghijklmnopqrstuvwxyz and ${key}`), [{ line: 1, reason: 'GitHub token' }]);
});

/** A Cloudflare tunnel token's shape (base64 JSON, no dots), built at run time. */
function tunnelToken(): string {
  return Buffer.from(JSON.stringify({ a: randomBytes(16).toString('hex'), t: randomBytes(16).toString('hex'), s: randomBytes(32).toString('base64') })).toString('base64');
}

test('the gate finds a tunnel token, a credential written in a doc and a private key inside JSON', { skip: !haveGit }, (t) => {
  const token = tunnelToken();
  const body = randomBytes(48).toString('base64');
  const pem = (word: string) => `-----${word} ${['PRIVATE', 'KEY'].join(' ')}-----`; // built here, so this file holds no key header
  for (const [name, content] of [
    ['.env.example', `PUBLIC_URL=https://memory.example.com\nTUNNEL_TOKEN=${token}\n`],
    ['docs/setup.md', `Then sign in with password: ${randomBytes(9).toString('base64')}\n`],
    ['keys/service.json', `{"type":"service_account","private_key":"${pem("BEGIN")}\\n${body}\\n${pem("END")}\\n"}\n`],
  ]) {
    const r = world(t, { ...CLEAN, [name]: content }).run('--no-tests');
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.match(r.out, /a key-shaped string/, name);
    assert.ok(!r.out.includes(token) && !r.out.includes(body), r.out);
  }
  // In code, "password = value" is normal test data, and is left alone.
  assert.equal(world(t, { ...CLEAN, 'src/login.test.ts': "const password = 'hunter2hunter2';\n" }).run('--no-tests').status, 0);
});

test('a secret found in a file whose path holds a denylisted word never prints the word', { skip: !haveGit }, (t) => {
  const w = world(t, { ...CLEAN, [`src/${WORD}-cfg.ts`]: `export const k = '${realLookingKey()}';\n` });
  const r = w.run('--no-tests');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /a key-shaped string/);
  assert.ok(!r.out.toLowerCase().includes(WORD.toLowerCase()), r.out);
});

test('an output folder that cannot be made stops the gate (exit 2) and copies nothing anywhere', { skip: !haveGit }, (t) => {
  const w = world(t, { ...CLEAN, 'sub/keep.md': 'mine\n' });
  const r = spawnSync('bash', [gate, w.denylist, '/nonexistent-root-folder/out', '--no-tests'], { cwd: join(w.repo, 'sub'), encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.ok(!existsSync(join(w.repo, 'sub', 'src')), 'the tree was copied into the current folder');
});

function npmWorld(testScript: string) {
  const pkg = { name: 'gate-world', version: '1.0.0', private: true, scripts: { test: testScript } };
  const lock = { name: 'gate-world', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'gate-world', version: '1.0.0' } } };
  return { ...CLEAN, 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` };
}

test('the test run happens in a scratch copy: the output folder gains nothing from npm ci or npm test', { skip: !haveGit }, (t) => {
  const w = world(t, npmWorld('node -e "require(\'fs\').writeFileSync(\'made-by-test.txt\', \'x\')"'));
  const out = join(w.dir, 'out');
  const r = w.run(out);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(out, 'package.json')));
  assert.ok(!existsSync(join(out, 'made-by-test.txt')), 'npm test wrote into the checked copy');
  assert.ok(!existsSync(join(out, 'node_modules')), 'npm ci wrote into the checked copy');
});

test('a failing npm test fails the gate', { skip: !haveGit }, (t) => {
  const r = world(t, npmWorld('node -e "process.exit(1)"')).run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /npm test failed/);
});
