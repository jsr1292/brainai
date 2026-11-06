import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { ProjectStore } from '../projects/store.js';
import { PageService } from './service.js';
import { PageStore } from './store.js';

const REPO = join(import.meta.dirname, '../..');
const SCRIPT = join(REPO, 'scripts/export-brain.sh');

async function setup(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'brain-exportsh-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const app = join(base, 'memory');
  mkdirSync(join(app, 'data'), { recursive: true });
  // ~/git holds the other repos already: the export only adds its bare repo there.
  mkdirSync(join(base, 'git'));
  const db = openDb(join(app, 'data', 'memory.db'));
  const now = () => new Date();
  const store = new MemoryStore(db, now);
  const memories = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const pages = new PageService(new PageStore(db, now), createFakeEmbedder(), memories, new ProjectStore(db, now), store, now);
  const page = await pages.create({ title: 'How this brain is organised', area: 'start', body: 'Facts first.' }, 'owner');
  const env = {
    APP_DIR: app, EXPORT_DIR: join(base, 'brain-export'), BARE: join(base, 'git', 'brain-export.git'),
    EXPORT_CMD: `cd ${JSON.stringify(REPO)} && DATA_DIR=${JSON.stringify(join(app, 'data'))} PUBLIC_URL=http://localhost npx tsx src/cli.ts export-brain ${JSON.stringify(join(app, 'data', 'export'))}`,
  };
  const run = () => spawnSync('bash', [SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  const commits = () => execFileSync('git', ['--git-dir', env.BARE, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim();
  const status = () => JSON.parse(readFileSync(join(app, 'data', 'export-status.json'), 'utf8')) as { ok: boolean; detail?: string };
  return { base, db, pages, page, env, run, commits, status };
}

test('the first run creates the working copy and the bare repo, commits and pushes', async (t) => {
  const s = await setup(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.commits(), '1');
  const files = execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(files, /pages\/start\/_area\/how-this-brain-is-organised\.md/);
  assert.match(execFileSync('git', ['--git-dir', s.env.BARE, 'log', '-1', '--format=%an <%ae> %s', 'main'], { encoding: 'utf8' }), /^brain export <brain@localhost> brain export \d{4}-\d{2}-\d{2}\n$/);
  assert.equal(s.status().ok, true);
});

test('a second run with nothing changed makes no commit', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  assert.equal(s.run().status, 0);
  assert.equal(s.commits(), '1');
  assert.match(execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }), /how-this-brain-is-organised/);
});

test('an edited page makes exactly one new commit, pushed to the bare repo', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  await s.pages.save(s.page.id, { base: 1, body: 'Facts first, pages second.' }, 'owner');
  assert.equal(s.run().status, 0);
  assert.equal(s.commits(), '2');
  const show = execFileSync('git', ['--git-dir', s.env.BARE, 'show', 'main:pages/start/_area/how-this-brain-is-organised.md'], { encoding: 'utf8' });
  assert.match(show, /Facts first, pages second\./);
});

test('a failing export writes ok false and leaves the last commit as it was', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, ...s.env, EXPORT_CMD: 'exit 3' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(s.status().ok, false);
  assert.match(s.status().detail ?? '', /export/);
  assert.equal(s.commits(), '1');
  const empty = spawnSync('bash', [SCRIPT], { env: { ...process.env, ...s.env, EXPORT_CMD: `rm -rf ${JSON.stringify(join(s.env.APP_DIR, 'data', 'export'))} && mkdir -p ${JSON.stringify(join(s.env.APP_DIR, 'data', 'export'))}` }, encoding: 'utf8' });
  assert.notEqual(empty.status, 0, 'an export that produced nothing never mirrors an empty tree');
  assert.equal(s.commits(), '1');
  assert.match(execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }), /how-this-brain-is-organised/);
});

test('a page deleted between runs leaves the export, and the owner\'s own files in it stay', async (t) => {
  const s = await setup(t);
  const extra = await s.pages.create({ title: 'Short lived', area: 'tools', body: 'x' }, 'owner');
  assert.equal(s.run().status, 0);
  writeFileSync(join(s.env.EXPORT_DIR, 'notes.txt'), 'mine');
  mkdirSync(join(s.env.EXPORT_DIR, 'pages', 'tools', '_area'), { recursive: true });
  writeFileSync(join(s.env.EXPORT_DIR, 'pages', 'tools', '_area', 'pic.png'), 'png');
  s.pages.remove(extra.id, 'owner');
  assert.equal(s.run().status, 0);
  const tree = execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.doesNotMatch(tree, /short-lived\.md/);
  assert.ok(existsSync(join(s.env.EXPORT_DIR, 'notes.txt')));
  assert.ok(existsSync(join(s.env.EXPORT_DIR, 'pages', 'tools', '_area', 'pic.png')));
});

test('an export of an empty brain is refused when the last export had pages', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  s.pages.remove(s.page.id, 'owner');
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(s.status().detail ?? '', /no pages/);
  assert.match(execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }), /how-this-brain-is-organised/);
});

test('a missing ~/git is never re-created, so backup-git.sh never mirrors a ~/git holding only the export', async (t) => {
  const s = await setup(t);
  rmSync(join(s.base, 'git'), { recursive: true });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(s.base, 'git')), '~/git stays missing');
  assert.equal(s.status().ok, false);
  assert.match(s.status().detail ?? '', /git/);
});

test('a bare repo that vanished after the first run is not re-created empty', async (t) => {
  const s = await setup(t);
  assert.equal(s.run().status, 0);
  rmSync(s.env.BARE, { recursive: true });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(s.env.BARE));
  assert.equal(s.status().ok, false);
  assert.match(s.status().detail ?? '', /brain-export\.git/);
});

test('a removed skill, or a removed file of one, leaves the git mirror too (audit F09)', async (t) => {
  const s = await setup(t);
  const { SkillService } = await import('../skills/service.js');
  const skills = new SkillService(s.db, () => new Date());
  const sk = skills.create({ name: 'tooling', description: 'Use when x.', body: 'x', files: [{ path: 'scripts/run.sh', text: 'echo hi' }, { path: 'notes.md', text: 'n' }] }, 'owner');
  assert.equal(s.run().status, 0);
  const tree = () => execFileSync('git', ['--git-dir', s.env.BARE, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(tree(), /skills\/tooling\/scripts\/run\.sh/);
  skills.update(sk.id, { base: 1, files: [{ path: 'notes.md', text: 'n' }] }, 'owner');
  assert.equal(s.run().status, 0);
  assert.doesNotMatch(tree(), /skills\/tooling\/scripts\/run\.sh/);
  skills.remove(sk.id, 'owner');
  assert.equal(s.run().status, 0);
  assert.doesNotMatch(tree(), /skills\/tooling/);
  assert.equal(existsSync(join(s.env.EXPORT_DIR, 'skills', 'tooling')), false);
});

test('a skill folder that becomes a file never stops the export (audit F09, review)', async (t) => {
  const s = await setup(t);
  const { SkillService } = await import('../skills/service.js');
  const skills = new SkillService(s.db, () => new Date());
  const sk = skills.create({ name: 'tooling', description: 'Use when x.', body: 'x', files: [{ path: 'ref/b.md', text: 'b' }] }, 'owner');
  assert.equal(s.run().status, 0);
  skills.update(sk.id, { base: 1, files: [{ path: 'ref', text: 'now a file' }] }, 'owner');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(execFileSync('git', ['--git-dir', s.env.BARE, 'show', 'main:skills/tooling/ref'], { encoding: 'utf8' }), 'now a file\n');
});

test("the export commits with the owner's name and email from overlay/scripts.env (O1)", async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.env.APP_DIR, 'overlay'), { recursive: true });
  writeFileSync(join(s.env.APP_DIR, 'overlay', 'scripts.env'), 'EXPORT_GIT_NAME=Ada Owner\nEXPORT_GIT_EMAIL=ada@example.com\n');
  assert.equal(s.run().status, 0);
  assert.match(execFileSync('git', ['--git-dir', s.env.BARE, 'log', '-1', '--format=%an <%ae>', 'main'], { encoding: 'utf8' }), /^Ada Owner <ada@example\.com>\n$/);
});
