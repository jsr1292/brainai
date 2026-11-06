/** The Mac skills sync (round 2 §17c): the folder-report script's skills step, against the real app and a hostile one. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp } from '../testing/helpers.js';
import { contentHash } from '../skills/sync.js';

const SCRIPT = join(import.meta.dirname, '../../scripts/mac/brain-folder-report.py');
const run = (env: Record<string, string>) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const child = spawn('python3', [SCRIPT], { env: { ...process.env, ...env }, timeout: 30_000 });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.on('close', (status) => resolve({ status, stderr }));
});
const md = (name: string, body = 'Do it.') => `---\nname: ${name}\ndescription: Use when ${name}.\n---\n\n${body}\n`;

function folders(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'brain-skills-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const skills = join(base, 'skills');
  const projects = join(base, 'Projects');
  mkdirSync(skills); mkdirSync(projects);
  const put = (rel: string, text: string) => { mkdirSync(join(skills, rel, '..'), { recursive: true }); writeFileSync(join(skills, rel), text); };
  put('codex-delegation/SKILL.md', md('codex-delegation'));
  put('codex-delegation/references/briefs.md', 'Briefs.');
  put('synced/abc/pdf/SKILL.md', md('pdf'));
  put('.hidden/SKILL.md', md('hidden'));
  put('no-skill-md/README.md', 'x');
  put('big-one/SKILL.md', md('big-one'));
  for (let i = 0; i < 21; i++) put(`big-one/r/${i}.md`, 'x');
  writeFileSync(join(skills, 'big-one', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  return { base, skills, projects, put };
}
async function withApp(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const { device, token } = app.deps.devices.create('Mac');
  return { app, device, token };
}
const envFor = (base: string, url: string, token: string, skills: string, projects: string) => {
  const tokenFile = join(base, 'tok');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return { BRAIN_URL: url, BRAIN_TOKEN_FILE: tokenFile, BRAIN_PROJECTS: projects, BRAIN_SKILLS: skills };
};

test('the script reports skills, skipping synced/ and dot folders, marks too-big ones with their reason, and uploads what is wanted', async (t) => {
  const { app, device, token } = await withApp(t);
  const f = folders(t);
  const r = await run(envFor(f.base, app.baseUrl, token, f.skills, f.projects));
  assert.equal(r.status, 0, r.stderr);
  const listed = app.deps.skillSync.fromDevice(device.id);
  assert.deepEqual(listed.map((s) => s.name), ['big-one', 'codex-delegation']);
  const cd = listed.find((s) => s.name === 'codex-delegation')!;
  assert.equal(cd.hasContent, true, 'wanted content arrives in the same run');
  assert.equal(cd.hash, contentHash([{ path: 'SKILL.md', text: md('codex-delegation') }, { path: 'references/briefs.md', text: 'Briefs.' }]));
  assert.match(listed.find((s) => s.name === 'big-one')!.shareable ?? '', /too big to share|isn't text/);
});

test('a brain skill that is On is written into the skills folder, and an older folder is moved aside, never deleted', async (t) => {
  const { app, device, token } = await withApp(t);
  const f = folders(t);
  const env = envFor(f.base, app.baseUrl, token, f.skills, f.projects);
  const s = app.deps.skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.', files: [{ path: 'references/steps.md', text: 'Steps.' }] }, 'owner');
  app.deps.skills.setEnabled(s.id, true, 'owner');
  assert.equal((await run(env)).status, 0);
  assert.equal(readFileSync(join(f.skills, 'brain-deploy', 'SKILL.md'), 'utf8'), app.deps.skills.skillMd(app.deps.skills.get(s.id)!));
  assert.equal(readFileSync(join(f.skills, 'brain-deploy', 'references', 'steps.md'), 'utf8'), 'Steps.');
  assert.equal((await run(env)).status, 0);
  assert.deepEqual(app.deps.skillSync.stateFor(s.id).map((x) => x.state), ['same']);
  app.deps.skills.update(s.id, { base: 1, body: 'Back up first.' }, 'owner');
  assert.equal((await run(env)).status, 0);
  assert.match(readFileSync(join(f.skills, 'brain-deploy', 'SKILL.md'), 'utf8'), /Back up first\./);
  const aside = readdirSync(join(f.skills, '.brain-removed'));
  assert.equal(aside.length, 1);
  assert.match(aside[0]!, /^brain-deploy-\d{8}-\d{6}$/);
  void device;
});

test('remove moves the folder to .brain-removed', async (t) => {
  const { app, token } = await withApp(t);
  const f = folders(t);
  const env = envFor(f.base, app.baseUrl, token, f.skills, f.projects);
  const s = app.deps.skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  app.deps.skills.setEnabled(s.id, true, 'owner');
  await run(env); await run(env);
  app.deps.skills.setEnabled(s.id, false, 'owner');
  assert.equal((await run(env)).status, 0);
  assert.equal(existsSync(join(f.skills, 'brain-deploy')), false);
  assert.ok(readdirSync(join(f.skills, '.brain-removed')).some((n) => n.startsWith('brain-deploy-')));
});

test('a 401 changes nothing locally', async (t) => {
  const { app, device, token } = await withApp(t);
  const f = folders(t);
  const s = app.deps.skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  app.deps.skills.setEnabled(s.id, true, 'owner');
  app.deps.devices.revoke(device.id);
  const r = await run(envFor(f.base, app.baseUrl, token, f.skills, f.projects));
  assert.equal(r.status, 2);
  assert.equal(existsSync(join(f.skills, 'brain-deploy')), false);
});

/** A brain that answers the skills report with whatever actions the test gives it. */
async function fakeBrain(t: TestContext, actions: unknown[]) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/folder-report') { res.writeHead(204); res.end(); return; }
      if (req.url === '/api/skills/report') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ want: [], actions })); return; }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('a malicious action (bad name, escaping path, synced/) touches nothing outside its folder', async (t) => {
  const f = folders(t);
  const outside = join(f.base, 'outside.txt');
  const url = await fakeBrain(t, [
    { kind: 'write', name: '../escape', expect: null, files: [{ path: 'SKILL.md', text: 'x' }] },
    { kind: 'write', name: 'ok-name', expect: null, files: [{ path: '../../outside.txt', text: 'x' }] },
    { kind: 'write', name: 'synced', expect: null, files: [{ path: 'SKILL.md', text: 'x' }] },
    { kind: 'write', name: 'dots', expect: null, files: [{ path: '.git/config', text: 'x' }] },
    { kind: 'remove', name: 'codex-delegation', expect: '0'.repeat(64) },
    { kind: 'remove', name: '..', expect: '0'.repeat(64) },
  ]);
  const r = await run(envFor(f.base, url, 'tok', f.skills, f.projects));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(f.base, 'escape')), false);
  assert.equal(existsSync(join(f.skills, 'ok-name')), false);
  assert.equal(existsSync(join(f.skills, 'dots')), false);
  assert.ok(existsSync(join(f.skills, 'synced', 'abc', 'pdf', 'SKILL.md')), 'synced/ untouched');
  assert.ok(existsSync(join(f.skills, 'codex-delegation', 'SKILL.md')), 'a remove whose expected hash does not match is skipped');
  assert.match(r.stderr, /skipped/);
});

test('a write whose expected hash no longer matches is skipped', async (t) => {
  const f = folders(t);
  const url = await fakeBrain(t, [{ kind: 'write', name: 'codex-delegation', expect: '0'.repeat(64), files: [{ path: 'SKILL.md', text: md('codex-delegation', 'From the brain.') }] }]);
  const r = await run(envFor(f.base, url, 'tok', f.skills, f.projects));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(f.skills, 'codex-delegation', 'SKILL.md'), 'utf8'), /From the brain/);
});

test('the Python hash matches contentHash on the fixed vector', () => {
  const py = `import importlib.util, sys
spec = importlib.util.spec_from_file_location('r', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.content_hash([('b.md', 'B'), ('SKILL.md', '\\u00e9\\n')]))`;
  const out = execFileSync('python3', ['-c', py, SCRIPT], { encoding: 'utf8' }).trim();
  assert.equal(out, '47e3ecdb9014e0bf2dfd2cb73f5943befaffd91ee733e4ce278297ecc80a98e4');
  assert.equal(out, contentHash([{ path: 'b.md', text: 'B' }, { path: 'SKILL.md', text: 'é\n' }]));
  void symlinkSync;
});

test('a skill with frontmatter beyond name and description is not shareable, naming the key', async (t) => {
  const { app, device, token } = await withApp(t);
  const f = folders(t);
  f.put('pick-ui-library/SKILL.md', '---\nname: pick-ui-library\ndescription: Use when picking.\ndisable-model-invocation: true\n---\n\nBody.\n');
  assert.equal((await run(envFor(f.base, app.baseUrl, token, f.skills, f.projects))).status, 0);
  const row = app.deps.skillSync.fromDevice(device.id).find((x) => x.name === 'pick-ui-library')!;
  assert.match(row.shareable ?? '', /frontmatter the brain can't hold yet \(disable-model-invocation\)/);
  assert.equal(row.hasContent, false);
});

test('a malformed brain answer never stops the script or the other actions', async (t) => {
  const f = folders(t);
  const url = await fakeBrain(t, ['x', { kind: 'write', name: 'ok-two', expect: null, files: ['x'] }, null,
    { kind: 'write', name: 'ok-three', expect: null, files: [{ path: 'SKILL.md', text: '---\nname: ok-three\ndescription: x\n---\n\nx\n' }] }]);
  const r = await run(envFor(f.base, url, 'tok', f.skills, f.projects));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(f.skills, 'ok-three', 'SKILL.md')), 'the good action after the bad ones still ran');
});

test('a write whose paths collide when case is ignored is skipped (audit F08)', async (t) => {
  const f = folders(t);
  const url = await fakeBrain(t, [{ kind: 'write', name: 'case-clash', expect: null, files: [
    { path: 'SKILL.md', text: '---\nname: case-clash\ndescription: x\n---\n\nx\n' }, { path: 'A.txt', text: 'one' }, { path: 'a.txt', text: 'two' }] }]);
  const r = await run(envFor(f.base, url, 'tok', f.skills, f.projects));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(f.skills, 'case-clash')), false);
  assert.match(r.stderr, /skipped write case-clash/);
});
