import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../projects/store.js';
import { makePages, makeService } from '../testing/helpers.js';
import { exportTree, fileName, writeTree } from './exportTree.js';
import { PageStore } from './store.js';
import { SkillService } from '../skills/service.js';

const owner = { type: 'owner' } as const;

async function setup() {
  let t = Date.parse('2026-11-03T10:00:00Z');
  const now = () => new Date(t);
  const given = makeService({ now });
  const registry = new ProjectStore(given.db, now);
  const pages = makePages(given, now);
  registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const remember = async (kind: 'decision' | 'summary' | 'roadmap' | 'profile', content: string, project?: string) => {
    t += 1000;
    return (await given.service.remember({ kind, content, project }, owner) as { memory: { id: string; updatedAt: string } }).memory;
  };
  return { ...given, registry, pages, remember, deps: { pages, memoryStore: given.store, memories: given.service } };
}
function tmp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('pages go under their area and project with front matter and the body unchanged', async () => {
  const { deps, pages } = await setup();
  const p = await pages.create({ title: 'wildlog — Bramble, wine cellar', project: 'wildlog', body: 'The cellar.\n\n## Stack\nSwiftUI.' }, 'Claude Code');
  await pages.create({ title: 'How this brain is organised', area: 'start', body: 'Facts and pages.' }, 'owner');
  const tree = exportTree(deps, new Date('2026-11-04T03:50:00Z'));
  const file = tree.get('pages/apps/wildlog/wildlog-bramble-wine-cellar.md')!;
  assert.ok(file, [...tree.keys()].join('\n'));
  assert.equal(file, [
    '---', 'title: "wildlog — Bramble, wine cellar"', `id: ${p.id}`, 'project: wildlog', 'area: apps', 'version: 1', `updated: ${p.updatedAt}`, 'updated_by: Claude Code', '---', '',
    'The cellar.\n\n## Stack\nSwiftUI.', '',
  ].join('\n').replace('updated_by: Claude Code', 'updated_by: "Claude Code"'));
  assert.ok(tree.has('pages/start/_area/how-this-brain-is-organised.md'));
  assert.match(tree.get('README.md')!, /every page and fact/i);
  assert.doesNotMatch(tree.get('README.md')!, /2026-11-04/, 'no date: an unchanged brain gives an unchanged tree');
});

test('facts go into one file per project, roadmap first, statuses newest first, decisions oldest first', async () => {
  const { deps, remember } = await setup();
  const d1 = await remember('decision', 'wildlog uses SwiftUI', 'wildlog');
  const d2 = await remember('decision', 'wildlog keeps data on the phone', 'wildlog');
  const s1 = await remember('summary', 'wildlog status: release 0.2.2 shipped', 'wildlog');
  const r = await remember('roadmap', 'Now: the label scanner\nNext: export', 'wildlog');
  await remember('profile', 'The owner lives in Berlin');
  await remember('decision', 'A fact with no project');
  const tree = exportTree(deps, new Date());
  const wine = tree.get('facts/wildlog.md')!;
  const order = [r.id, s1.id, d1.id, d2.id].map((id) => wine.indexOf(id));
  assert.ok(order.every((i) => i > 0) && order.join() === [...order].sort((a, b) => a - b).join(), wine);
  assert.match(wine, new RegExp(`### roadmap · \\d{4}-\\d{2}-\\d{2} · ${r.id}\\n\\nNow: the label scanner\\nNext: export\\n`));
  assert.match(tree.get('facts/_profile.md')!, /The owner lives in Berlin/);
  assert.match(tree.get('facts/_no-project.md')!, /A fact with no project/);
});

test('two titles that make the same file name get different files', async () => {
  const { deps, pages } = await setup();
  await pages.create({ title: 'Café notes', area: 'tools', body: 'one' }, 'owner');
  await pages.create({ title: 'cafe notes!', area: 'tools', body: 'two' }, 'owner');
  const files = [...exportTree(deps, new Date()).keys()].filter((k) => k.startsWith('pages/tools/_area/'));
  assert.deepEqual(files.sort(), ['pages/tools/_area/cafe-notes-2.md', 'pages/tools/_area/cafe-notes.md']);
  assert.equal(fileName('x'.repeat(200), new Set()).length, 83);
  assert.equal(fileName('!!!', new Set()), 'page.md');
});

test('writeTree removes a page deleted since and leaves files outside pages/ and facts/ alone', async (t) => {
  const { deps, pages } = await setup();
  const dir = tmp(t);
  const a = await pages.create({ title: 'Keep me', area: 'tools', body: 'a' }, 'owner');
  const b = await pages.create({ title: 'Delete me', area: 'tools', body: 'b' }, 'owner');
  void a;
  const first = writeTree(dir, exportTree(deps, new Date()));
  assert.ok(first.written >= 3);
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  mkdirSync(join(dir, 'extra'), { recursive: true });
  writeFileSync(join(dir, 'extra', 'x.md'), 'mine too');
  pages.remove(b.id, 'owner');
  const second = writeTree(dir, exportTree(deps, new Date()));
  assert.deepEqual([second.written, second.removed], [0, 1]);
  assert.ok(!existsSync(join(dir, 'pages/tools/_area/delete-me.md')));
  assert.ok(existsSync(join(dir, 'pages/tools/_area/keep-me.md')));
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.ok(existsSync(join(dir, 'extra', 'x.md')));
});

test('deleted pages and facts are not exported', async () => {
  const { deps, pages, remember, service } = await setup();
  const p = await pages.create({ title: 'Gone', area: 'tools', body: 'x' }, 'owner');
  pages.remove(p.id, 'owner');
  const m = await remember('decision', 'wildlog forgotten fact', 'wildlog');
  service.forget(m.id, owner);
  const all = [...exportTree(deps, new Date()).values()].join('\n');
  assert.doesNotMatch(all, /Gone|forgotten fact/);
});

test('writeTree never follows a symlink out of the export folder', async (t) => {
  const { deps } = await setup();
  const dir = tmp(t);
  const outside = tmp(t);
  writeFileSync(join(outside, 'precious.md'), 'keep');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  symlinkSync(outside, join(dir, 'pages', 'link'));
  writeTree(dir, exportTree(deps, new Date()));
  assert.equal(readFileSync(join(outside, 'precious.md'), 'utf8'), 'keep');
});

test('a page under a merged project\'s old name is exported under the real project, and names are quoted', async () => {
  const { deps, pages, registry, service, remember } = await setup();
  registry.create('vista', { state: 'open', area: 'apps' }, 'owner');
  await remember('decision', 'vista is the old name', 'vista');
  await remember('decision', 'wildlog is the real name', 'wildlog');
  await pages.create({ title: 'vista — old page', project: 'vista', body: 'x' }, 'Claude: Code #beta');
  service.addAlias('vista', 'wildlog', owner);
  const tree = exportTree(deps, new Date());
  const file = tree.get('pages/apps/wildlog/vista-old-page.md')!;
  assert.ok(file, [...tree.keys()].join('\n'));
  assert.match(file, /^project: wildlog$/m);
  assert.match(file, /^updated_by: "Claude: Code #beta"$/m);
});

test('a project\'s file ends with its replaced facts, oldest replacement first', async () => {
  const { deps, remember, service } = await setup();
  const a = await remember('decision', 'wildlog drinking windows come from Cellarium', 'wildlog');
  const c = await remember('decision', 'wildlog photos stay in the app', 'wildlog');
  const b = await remember('decision', 'wildlog drinking windows are set by hand', 'wildlog');
  const d = await remember('decision', 'wildlog photos go to iCloud', 'wildlog');
  const before = exportTree(deps, new Date()).get('facts/wildlog.md')!;
  const [ab] = service.supersede([a.id], b.id, owner);
  const [cd] = service.supersede([c.id], d.id, owner);
  const gone = await remember('decision', 'wildlog labels use Futura', 'wildlog');
  const newer = await remember('decision', 'wildlog labels use Avenir', 'wildlog');
  service.supersede([gone.id], newer.id, owner);
  service.forget(gone.id, owner);
  const tree = exportTree(deps, new Date());
  const wine = tree.get('facts/wildlog.md')!;
  const day = (iso: string) => iso.slice(0, 10);
  const tail = `## Replaced\n\n### decision · ${day(a.updatedAt)} · ${a.id} · replaced ${day(ab!.createdAt)} by ${b.id}\n\nwildlog drinking windows come from Cellarium\n\n### decision · ${day(c.updatedAt)} · ${c.id} · replaced ${day(cd!.createdAt)} by ${d.id}\n\nwildlog photos stay in the app\n`;
  assert.ok(wine.endsWith(tail), wine);
  assert.ok(!wine.includes(gone.id));
  const current = wine.slice(0, wine.indexOf('## Replaced'));
  assert.ok(!current.includes(`· ${a.id}`) && current.includes(`· ${b.id}`));
  assert.ok(before.includes(`· ${a.id}`));
  assert.match(tree.get('README.md')!, /then the replaced facts, each with what replaced it/);
});

test('a project whose facts are all replaced still gets a file', async () => {
  const { deps, remember, service, db } = await setup();
  const a = await remember('decision', 'labels use Futura', 'labels');
  const b = await remember('decision', 'labels use Avenir', 'labels');
  service.supersede([a.id], b.id, owner);
  db.prepare("UPDATE memories SET project = 'wildlog' WHERE id = ?").run(b.id);
  assert.match(exportTree(deps, new Date()).get('facts/labels.md') ?? '', new RegExp(`## Replaced\\n\\n### decision · .* · ${a.id} · replaced`));
});

test('the nightly export writes nothing about when a page was brought up to date', async () => {
  const { deps, pages, db } = await setup();
  const p = await pages.create({ title: 'wildlog — Bramble', project: 'wildlog', body: 'The cellar.\n\n## Key decisions\n- 2026-11-01 Offline first.' }, 'Claude Code');
  new PageStore(db, () => new Date('2026-11-03T11:00:00Z')).markStillTrue(p.id);
  const text = [...exportTree(deps, new Date('2026-11-04T03:50:00Z')).values()].join('\n');
  assert.ok(text.includes('The cellar.'));
  for (const word of ['caught', 'still_true', 'still true', 'page_checks', '2026-11-03T11:00']) assert.ok(!text.includes(word), word);
});

test('picture links point at the backups\' images folder from each file\'s depth; the export ignores that folder and says why', async () => {
  const { deps, pages } = await setup();
  const id = 'ab' + '0'.repeat(22);
  await pages.create({ title: 'wildlog — screens', project: 'wildlog', body: `Lead.\n\n![a](/images/${id}.jpg "t")\n\n\`\`\`\n![x](/images/${id}.jpg)\n\`\`\`` }, 'owner');
  await pages.create({ title: 'Loose screens', area: 'start', body: `![b](/images/${id}.png)` }, 'owner');
  const tree = exportTree(deps, new Date());
  const file = (re: RegExp) => [...tree.entries()].find(([k]) => re.test(k))![1];
  const project = file(/wildlog-screens\.md$/);
  assert.match(project, new RegExp(`!\\[a\\]\\(\\.\\./\\.\\./\\.\\./images/ab/${id}\\.jpg "t"\\)`));
  assert.match(project, new RegExp('```\\n!\\[x\\]\\(/images/' + id + '\\.jpg\\)\\n```'), 'code stays as written');
  assert.match(file(/_area\/loose-screens\.md$/), new RegExp(`!\\[b\\]\\(\\.\\./\\.\\./\\.\\./images/ab/${id}\\.png\\)`));
  assert.equal(tree.get('.gitignore'), '/images/\n', 'only the root images folder: a project called images still exports');
  assert.match(tree.get('README.md')!, /Pictures are not in this repository\. They are in the nightly backups under `images\/`\. Copy that folder here to see them\./);
});

test('the export writes each live skill as SKILL.md with its files, and drops a deleted one', async (t) => {
  const { deps, db } = await setup();
  const skills = new SkillService(db, () => new Date());
  const on = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: '1. Back up.', files: [{ path: 'references/steps.md', text: 'Detail.' }] }, 'owner');
  skills.setEnabled(on.id, true, 'owner');
  skills.create({ name: 'release-notes', description: 'Use when writing notes.', body: 'Group them.' }, 'owner');
  const gone = skills.create({ name: 'old-skill', description: 'Gone.', body: 'x' }, 'owner');
  skills.remove(gone.id, 'owner');
  const tree = exportTree({ ...deps, skills }, new Date());
  assert.equal(tree.get('skills/brain-deploy/SKILL.md'), '---\nname: brain-deploy\ndescription: "Use when deploying."\n---\n\n1. Back up.\n');
  assert.equal(tree.get('skills/brain-deploy/references/steps.md'), 'Detail.\n');
  assert.ok(tree.has('skills/release-notes/SKILL.md'), 'skills that are Off are exported too');
  assert.ok(![...tree.keys()].some((k) => k.startsWith('skills/old-skill')));
  assert.match(tree.get('README.md')!, /Skills are under `skills\/`, one folder each, readable by Claude Code as they are\./);
  const dir = tmp(t);
  writeTree(dir, tree);
  writeTree(dir, exportTree(deps, new Date()));
  assert.equal(existsSync(join(dir, 'skills', 'brain-deploy', 'SKILL.md')), false, 'a later export without the skill removes its file');
});

test("a later export removes a skill's non-Markdown files too", async (t) => {
  const { deps, db } = await setup();
  const skills = new SkillService(db, () => new Date());
  const s = skills.create({ name: 'tooling', description: 'Use when x.', body: 'x', files: [{ path: 'scripts/run.sh', text: 'echo hi' }] }, 'owner');
  const dir = tmp(t);
  writeTree(dir, exportTree({ ...deps, skills }, new Date()));
  assert.ok(existsSync(join(dir, 'skills', 'tooling', 'scripts', 'run.sh')));
  skills.remove(s.id, 'owner');
  writeTree(dir, exportTree({ ...deps, skills }, new Date()));
  assert.equal(existsSync(join(dir, 'skills', 'tooling', 'scripts', 'run.sh')), false);
});
