import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(dirname(fileURLToPath(import.meta.url)), 'releaseManifest.ts');
const V = '9.9.9';
const FILES = [`BrainAI_${V}_aarch64.app.tar.gz`, `BrainAI_${V}_x64-setup.exe`, `BrainAI_${V}_aarch64.dmg`, 'install-app.ps1'];
const SIGS: Record<string, string> = { [`BrainAI_${V}_aarch64.app.tar.gz`]: 'made-up-mac-signature==\n', [`BrainAI_${V}_x64-setup.exe`]: 'made-up-win-signature==\n\n' };
const CHANGELOG = `# Changelog\n\n## Unreleased\n\n- Later.\n\n## ${V} (2026-01-01)\n\nUpdating needs nothing from you.\n\n- **Bold thing:** it is [documented here](https://example.com/doc) now.\n\n## 9.9.8 (2025-12-31)\n\n- Older.\n`;

function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'relman-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'out');
  mkdirSync(dir);
  for (const f of FILES) writeFileSync(join(dir, f), `made-up bytes of ${f}\n`);
  for (const [f, s] of Object.entries(SIGS)) writeFileSync(join(dir, `${f}.sig`), s);
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  const run = (...extra: string[]) => spawnSync('node', ['--import', 'tsx', script, V, dir, '--changelog', join(root, 'CHANGELOG.md'), ...extra], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CHANGELOG_PATH: '/nonexistent/ignored' } });
  return { root, dir, run };
}

test('latest.json parses, carries the signatures' + ' and the urls under the default base', (t) => {
  const w = world(t);
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(w.dir, 'latest.json'), 'utf8'));
  assert.equal(j.version, V);
  assert.ok(!Number.isNaN(Date.parse(j.pub_date)));
  assert.match(j.pub_date, /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/);
  assert.equal(j.platforms['darwin-aarch64'].signature, SIGS[FILES[0]].trim());
  assert.equal(j.platforms['windows-x86_64'].signature, SIGS[FILES[1]].trim());
  const base = `https://github.com/jsr1292/brainai/releases/download/v${V}`;
  assert.equal(j.platforms['darwin-aarch64'].url, `${base}/${FILES[0]}`);
  assert.equal(j.platforms['windows-x86_64'].url, `${base}/${FILES[1]}`);
});

test('--base-url is honoured', (t) => {
  const w = world(t);
  assert.equal(w.run('--base-url', 'http://127.0.0.1:8765').status, 0);
  const j = JSON.parse(readFileSync(join(w.dir, 'latest.json'), 'utf8'));
  assert.equal(j.platforms['darwin-aarch64'].url, `http://127.0.0.1:8765/${FILES[0]}`);
});

test('the notes are the changelog section, plain in latest.json', (t) => {
  const w = world(t);
  assert.equal(w.run().status, 0);
  const j = JSON.parse(readFileSync(join(w.dir, 'latest.json'), 'utf8'));
  assert.ok(!j.notes.includes('**'));
  assert.ok(j.notes.includes('Bold thing: it is documented here now.'));
  assert.ok(!j.notes.includes('https://example.com'));
  const md = readFileSync(join(w.dir, 'release-notes.md'), 'utf8');
  assert.ok(md.includes('**Bold thing:**') && md.includes('[documented here](https://example.com/doc)'));
  assert.ok(!md.includes('## ') && !md.includes('Older.') && !md.includes('Later.'));
});

test('SHA256SUMS matches shasum -a 256, sorted by name', (t) => {
  const w = world(t);
  assert.equal(w.run().status, 0);
  const lines = readFileSync(join(w.dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const names = [...FILES].sort();
  assert.deepEqual(lines.map((l) => l.split('  ')[1]), names);
  for (const l of lines) {
    const [sum, name] = l.split('  ');
    const s = spawnSync('shasum', ['-a', '256', join(w.dir, name)], { encoding: 'utf8' });
    assert.equal(sum, s.stdout.split(' ')[0]);
  }
});

test('a missing .sig exits 2', (t) => {
  const w = world(t);
  unlinkSync(join(w.dir, `${FILES[1]}.sig`));
  assert.equal(w.run().status, 2);
});

test('a version with no changelog section exits 2', (t) => {
  const w = world(t);
  writeFileSync(join(w.root, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0 (2026-01-01)\n\n- x\n');
  assert.equal(w.run().status, 2);
});

test('a CRLF changelog still works', (t) => {
  const w = world(t);
  writeFileSync(join(w.root, 'CHANGELOG.md'), CHANGELOG.replaceAll('\n', '\r\n'));
  assert.equal(w.run().status, 0);
  const md = readFileSync(join(w.dir, 'release-notes.md'), 'utf8');
  assert.ok(md.includes('Bold thing') && !md.includes('\r') && !md.includes('Older.'));
});

test('a bullet wrapped over three lines is one line of notes in latest.json, and stays wrapped in release-notes.md', (t) => {
  const w = world(t);
  const wrapped = '- **Lead-in:** this made-up sentence runs long enough that the changelog wraps it\n  onto a second line, and then it carries on\n  onto a third line and ends here.\n- Short one.';
  writeFileSync(join(w.root, 'CHANGELOG.md'), `# Changelog\n\n## ${V} (2026-01-01)\n\n${wrapped}\n\n## 9.9.8\n\n- Older.\n`);
  assert.equal(w.run().status, 0);
  const j = JSON.parse(readFileSync(join(w.dir, 'latest.json'), 'utf8'));
  assert.equal(j.notes, 'Lead-in: this made-up sentence runs long enough that the changelog wraps it onto a second line, and then it carries on onto a third line and ends here.\n- Short one.'.replace(/^/, '- '));
  assert.equal(readFileSync(join(w.dir, 'release-notes.md'), 'utf8'), `${wrapped}\n`);
});
