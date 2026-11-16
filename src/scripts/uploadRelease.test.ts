/** scripts/publish/upload-release.sh and upload-models.sh, run against a fake `gh` and a fake `curl`: nothing real is contacted. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uploadRelease = join(repoRoot, 'scripts', 'publish', 'upload-release.sh');
const uploadModels = join(repoRoot, 'scripts', 'publish', 'upload-models.sh');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  [ "\${GH_EXISTS:-0}" = 1 ] || exit 1
  [ -f "$GH_ASSETS" ] && cat "$GH_ASSETS"
  exit 0
fi
[ -n "\${GH_FAIL:-}" ] && [ "$2" = "$GH_FAIL" ] && exit 1
exit 0
`;
const FAKE_CURL = `#!/usr/bin/env bash
out="" url=""
echo "ARGS $*" >> "$CURL_LOG"
while [ $# -gt 0 ]; do case "$1" in -o|--max-time) [ "$1" = -o ] && out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$url" >> "$CURL_LOG"
f="$SERVE/$(basename "$url")"
[ -f "$f" ] || exit 22
if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi
`;

function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'upload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); const serve = join(dir, 'serve'); const rel = join(dir, 'rel'); const cache = join(dir, 'cache');
  for (const d of [bin, serve, rel]) mkdirSync(d);
  writeFileSync(join(bin, 'gh'), FAKE_GH); writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'gh'), 0o755); chmodSync(join(bin, 'curl'), 0o755);
  const ghLog = join(dir, 'gh.log'); const curlLog = join(dir, 'curl.log'); const assetsFile = join(dir, 'assets.txt');
  writeFileSync(ghLog, ''); writeFileSync(curlLog, '');
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog, CURL_LOG: curlLog, GH_ASSETS: assetsFile, SERVE: serve,
        BRAINAI_ASSET_CACHE: cache, BRAINAI_VERIFY_WAIT: '0', ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ghCalls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
  return { dir, rel, serve, cache, run, ghCalls, assetsFile, curlLog };
}

function releaseFiles(w: ReturnType<typeof world>, v: string) {
  const sums = 'abc  BrainAI_x\n';
  for (const n of [`BrainAI_${v}_aarch64.dmg`, `BrainAI_${v}_aarch64.app.tar.gz`, `BrainAI_${v}_x64-setup.exe`, 'install-app.ps1']) writeFileSync(join(w.rel, n), n);
  writeFileSync(join(w.rel, 'latest.json'), JSON.stringify({ version: v }));
  writeFileSync(join(w.rel, 'release-notes.md'), 'notes');
  writeFileSync(join(w.rel, 'SHA256SUMS'), sums);
  writeFileSync(join(w.serve, 'latest.json'), JSON.stringify({ version: v }));
  writeFileSync(join(w.serve, 'SHA256SUMS'), sums);
}

test('upload-release creates a draft, then publishes it as the latest, verifying the tag, with all six files', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  const r = w.run(uploadRelease, ['1.3.0', w.rel]);
  assert.equal(r.status, 0, r.out);
  const create = w.ghCalls().find((c) => c.startsWith('release create'))!;
  assert.ok(create, 'no create call');
  assert.match(create, /release create v1\.3\.0 --repo jsr1292\/brainai --verify-tag --title BrainAI 1\.3\.0 --notes-file .*release-notes\.md --draft/);
  assert.ok(!create.split(' ').includes('--latest'), 'a new release is a draft until its files are up');
  for (const n of ['BrainAI_1.3.0_aarch64.dmg', 'BrainAI_1.3.0_aarch64.app.tar.gz', 'BrainAI_1.3.0_x64-setup.exe', 'install-app.ps1', 'latest.json', 'SHA256SUMS']) assert.ok(create.includes(`/${n}`), n);
  assert.ok(w.ghCalls().every((c) => !c.includes('--clobber')));
  const calls = w.ghCalls();
  const edit = calls.findIndex((c) => c.startsWith('release edit v1.3.0'));
  assert.ok(edit > calls.findIndex((c) => c.startsWith('release create')), 'edit comes after create');
  assert.ok(calls[edit].includes('--draft=false') && calls[edit].includes('--latest'), calls[edit]);
});

test('upload-release edits to published only after a successful upload, and not at all after a failed one', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  const r = w.run(uploadRelease, ['1.3.0', w.rel], { GH_EXISTS: '1', GH_FAIL: 'upload' });
  assert.equal(r.status, 1, r.out);
  assert.ok(w.ghCalls().every((c) => !c.startsWith('release edit')));
});

test('upload-release --check-only makes no gh call and checks the published files', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  const r = w.run(uploadRelease, ['1.3.0', w.rel, '--check-only']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.ghCalls(), []);
  writeFileSync(join(w.serve, 'latest.json'), JSON.stringify({ version: '1.2.9' }));
  assert.equal(w.run(uploadRelease, ['1.3.0', w.rel, '--check-only']).status, 1);
  assert.deepEqual(w.ghCalls(), []);
});

test('upload-release on an existing release uploads with --clobber and edits it to the latest', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  const r = w.run(uploadRelease, ['1.3.0', w.rel], { GH_EXISTS: '1' });
  assert.equal(r.status, 0, r.out);
  const calls = w.ghCalls();
  assert.ok(calls.some((c) => c.startsWith('release upload v1.3.0') && c.includes('--clobber')));
  assert.ok(calls.some((c) => c.startsWith('release edit v1.3.0') && c.includes('--latest')));
  assert.ok(calls.every((c) => !c.startsWith('release create')));
});

test('upload-release gives its checking downloads a time limit', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  assert.equal(w.run(uploadRelease, ['1.3.0', w.rel]).status, 0);
  const calls = readFileSync(w.curlLog, 'utf8').split('\n').filter((l) => l.startsWith('ARGS'));
  assert.ok(calls.length >= 2 && calls.every((c) => c.includes('--max-time 20')), calls.join('\n'));
});

test('upload-release exits 1 when the published latest.json names another version', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  writeFileSync(join(w.serve, 'latest.json'), JSON.stringify({ version: '1.2.9' }));
  const r = w.run(uploadRelease, ['1.3.0', w.rel]);
  assert.equal(r.status, 1, r.out);
});

test('upload-release exits 1 when the published SHA256SUMS differs from the local one', (t) => {
  const w = world(t); releaseFiles(w, '1.3.0');
  writeFileSync(join(w.serve, 'SHA256SUMS'), 'other\n');
  assert.equal(w.run(uploadRelease, ['1.3.0', w.rel]).status, 1);
});

function modelWorld(t: TestContext, goodHash = true) {
  const w = world(t);
  const body = 'model bytes';
  writeFileSync(join(w.serve, 'a.onnx'), body);
  const list = join(w.dir, 'assets.json');
  writeFileSync(list, JSON.stringify([{ name: 'org__m__a.onnx', url: 'https://huggingface.co/org/m/resolve/main/a.onnx', sha256: goodHash ? sha(body) : sha('something else') }]));
  return { ...w, env: { BRAINAI_MODEL_ASSETS_JSON: list } };
}

test('upload-models creates models-v1 as a prerelease, never the latest, and uploads the asset', (t) => {
  const w = modelWorld(t);
  const r = w.run(uploadModels, [], w.env);
  assert.equal(r.status, 0, r.out);
  const calls = w.ghCalls();
  const create = calls.find((c) => c.startsWith('release create models-v1'))!;
  assert.ok(create, 'no create call');
  assert.ok(create.includes('--prerelease') && create.includes('--latest=false') && create.includes('--repo jsr1292/brainai'));
  assert.ok(!create.split(' ').includes('--latest'));
  assert.ok(calls.some((c) => c.startsWith('release upload models-v1') && c.includes('org__m__a.onnx')));
});

test('upload-models refuses a file whose hash differs from the pin, and uploads nothing', (t) => {
  const w = modelWorld(t, false);
  const r = w.run(uploadModels, [], w.env);
  assert.equal(r.status, 1, r.out);
  assert.ok(w.ghCalls().every((c) => !c.startsWith('release upload') && !c.startsWith('release create')));
});

test('upload-models --if-missing with every asset present makes no upload call', (t) => {
  const w = modelWorld(t);
  writeFileSync(w.assetsFile, 'org__m__a.onnx\n');
  const r = w.run(uploadModels, ['--if-missing'], { ...w.env, GH_EXISTS: '1' });
  assert.equal(r.status, 0, r.out);
  assert.ok(w.ghCalls().every((c) => c.startsWith('release view')));
  assert.equal(existsSync(w.cache), false, 'nothing is downloaded when nothing is missing');
});
