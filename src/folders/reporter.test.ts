import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp } from '../testing/helpers.js';

const SCRIPT = join(import.meta.dirname, '../../scripts/mac/brain-folder-report.py');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' });

function projects(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'brain-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'Wine DB');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'secret.txt'), 'SECRET_SENTINEL_1234\n');
  git(repo, 'add', 'secret.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  writeFileSync(join(repo, 'new.txt'), 'uncommitted\n');
  const remoteRepo = join(root, 'with-remote');
  mkdirSync(remoteRepo);
  git(remoteRepo, 'init', '-q');
  git(remoteRepo, 'remote', 'add', 'origin', 'https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789AB@example.com/a.git');
  const branches = join(root, 'branches');
  mkdirSync(branches);
  git(branches, 'init', '-q');
  writeFileSync(join(branches, 'a.txt'), 'a\n');
  git(branches, 'add', 'a.txt');
  git(branches, 'commit', '-q', '-m', 'one');
  git(branches, 'checkout', '-q', '-b', 'feature');
  for (const n of [2, 3]) { writeFileSync(join(branches, `${n}.txt`), `${n}\n`); git(branches, 'add', '.'); git(branches, 'commit', '-q', '-m', `c${n}`); }
  git(branches, 'checkout', '-q', 'main');
  git(branches, 'checkout', '-q', '-b', 'x'.repeat(230));
  git(root, 'init', '-q', '--bare', 'bare.git');
  mkdirSync(join(root, 'plain folder'));
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, 'a-file.txt'), 'not a folder');
  return root;
}
/** Runs the reporter without blocking: the test app answering it lives in this same process. */
const run = (env: Record<string, string>) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const child = spawn('python3', [SCRIPT], { env: { ...process.env, ...env }, timeout: 30_000 });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.on('close', (status) => resolve({ status, stderr }));
});

test('the reporter sends each folder\'s git state and never a file\'s contents', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const root = projects(t);
  const { token } = app.deps.devices.create('Mac');
  const tokenFile = join(root, '..', `tok-${process.pid}`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  t.after(() => rmSync(tokenFile, { force: true }));
  const r = await run({ BRAIN_URL: app.baseUrl, BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: root });
  assert.equal(r.status, 0, r.stderr);
  const latest = app.deps.devices.latestReport()!;
  const byName = new Map(latest.folders.map((f) => [f.name, f]));
  assert.deepEqual([...byName.keys()].sort(), ['Wine DB', 'bare.git', 'branches', 'plain folder', 'with-remote']);
  const b = byName.get('branches')!;
  assert.equal(b.unpushed, 3, 'commits on every local branch count, not only the checked-out one');
  assert.equal(b.branch!.length, 200, 'a long branch name is clipped to what the brain accepts');
  assert.equal(byName.get('bare.git')!.git, false, 'a bare repo has no work tree to report');
  const w = byName.get('Wine DB')!;
  assert.deepEqual([w.git, w.branch, w.uncommitted, w.unpushed], [true, 'main', 1, 1]);
  assert.match(w.lastCommit ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(w.remotes, []);
  assert.deepEqual(byName.get('plain folder')!.git, false);
  const rr = byName.get('with-remote')!;
  assert.deepEqual([rr.unpushed, rr.lastCommit, rr.remotes], [0, null, ['https://example.com/a.git']]);
  const stored = JSON.stringify(app.deps.devices.latestReport());
  assert.doesNotMatch(stored, /SECRET_SENTINEL_1234|ghp_/);
});

test('the reporter exits 2 on a revoked token and 1 when the brain can\'t be reached', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const root = projects(t);
  const { device, token } = app.deps.devices.create('Mac');
  app.deps.devices.revoke(device.id);
  const tokenFile = join(root, '..', `tok2-${process.pid}`);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  t.after(() => rmSync(tokenFile, { force: true }));
  assert.equal((await run({ BRAIN_URL: app.baseUrl, BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: root })).status, 2);
  assert.equal((await run({ BRAIN_URL: 'http://127.0.0.1:9', BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: root })).status, 1);
});

test('when git status or rev-list fails, the reporter sends the counts as unknown, not as 0', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const root = projects(t);
  const { token } = app.deps.devices.create('Mac');
  const tokenFile = join(root, '..', `tok3-${process.pid}`);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  t.after(() => rmSync(tokenFile, { force: true }));
  // A git that fails (as a timeout would) on status and rev-list, and is real git for everything else.
  const bin = mkdtempSync(join(tmpdir(), 'brain-fakegit-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*|*" rev-list "*) exit 128;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const r = await run({ BRAIN_URL: app.baseUrl, BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: root, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  const w = app.deps.devices.latestReport()!.folders.find((f) => f.name === 'Wine DB')!;
  assert.deepEqual([w.git, w.branch, w.uncommitted, w.unpushed], [true, 'main', null, null]);
  assert.match(r.stderr, /Wine DB/, 'the failure is logged');
});

test('a Python with no CA certificates of its own (python.org before Install Certificates) trusts the system list', (t) => {
  const systemCAs = '/etc/ssl/cert.pem';
  if (!existsSync(systemCAs)) { t.skip('no /etc/ssl/cert.pem here'); return; }
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("reporter", ${JSON.stringify(SCRIPT)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `print(m.tls_context(fallback=${JSON.stringify(systemCAs)}).cert_store_stats()["x509_ca"])`,
    'print(m.tls_context(fallback="/nonexistent/cert.pem").cert_store_stats()["x509_ca"])',
  ].join('\n');
  // No CA file or folder for this Python's OpenSSL: as a fresh python.org install on macOS.
  const out = execFileSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, SSL_CERT_FILE: '/nonexistent/cert.pem', SSL_CERT_DIR: '/nonexistent' } });
  const [withSystem, without] = out.trim().split('\n').map(Number);
  assert.ok(withSystem! > 0, `system CAs loaded: ${out}`);
  assert.equal(without, 0);
});

test('without BRAIN_URL the reporter sends nothing and says how to set it up (exit 3)', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const root = projects(t);
  const { token } = app.deps.devices.create('Mac');
  const tokenFile = join(root, '..', `tok3-${process.pid}`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  t.after(() => rmSync(tokenFile, { force: true }));
  const env: Record<string, string> = { BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: root, BRAIN_URL: '' };
  const r = await run(env);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no BRAIN_URL: run install-folder-report\.sh --url <your brain>/);
  assert.equal(app.deps.devices.latestReport(), undefined);
});
