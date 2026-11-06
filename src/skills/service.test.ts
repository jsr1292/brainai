import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { MAX_BODY } from '../pages/types.js';
import { SkillError, SkillService } from './service.js';

function make() {
  let t = Date.parse('2026-11-05T10:00:00Z');
  const svc = new SkillService(openDb(':memory:'), () => new Date(t += 1000));
  return svc;
}
const code = (c: string, re?: RegExp) => (e: unknown) => e instanceof SkillError && e.code === c && (re ? re.test(e.message) : true);
const base = { name: 'release-notes', description: 'Use when writing release notes for an app.', body: '# Release notes\n\n1. Read the commits.' };

test('a new skill starts Off, at version 1, origin here, and reads back as SKILL.md', () => {
  const svc = make();
  const s = svc.create(base, 'owner');
  assert.equal(s.enabled, false);
  assert.equal(s.version, 1);
  assert.equal(s.origin, 'here');
  assert.equal(svc.skillMd(s), '---\nname: release-notes\ndescription: "Use when writing release notes for an app."\n---\n\n# Release notes\n\n1. Read the commits.\n');
});

test('names: lowercase-hyphen only, at most 64, unique among live skills, free again after delete', () => {
  const svc = make();
  for (const bad of ['Release', 'release_notes', '-x', 'x-', 'a--b', 'a'.repeat(65), '']) assert.throws(() => svc.create({ ...base, name: bad }, 'owner'), code('invalid'), bad);
  const s = svc.create(base, 'owner');
  assert.throws(() => svc.create(base, 'owner'), code('invalid', /already/));
  svc.remove(s.id, 'owner');
  assert.equal(svc.create(base, 'owner').name, 'release-notes');
});

test('description 1-1024 and a body over MAX_BODY are refused', () => {
  const svc = make();
  assert.throws(() => svc.create({ ...base, description: '' }, 'owner'), code('invalid'));
  assert.throws(() => svc.create({ ...base, description: 'x'.repeat(1025) }, 'owner'), code('invalid'));
  assert.throws(() => svc.create({ ...base, body: 'x'.repeat(MAX_BODY + 1) }, 'owner'), code('invalid'));
});

test('files: at most 20, 64 KB each, 256 KB in all; escaping paths, SKILL.md and NUL text refused', () => {
  const svc = make();
  const f = (path: string, text = 'x') => ({ path, text });
  assert.throws(() => svc.create({ ...base, files: Array.from({ length: 21 }, (_, i) => f(`r/${i}.md`)) }, 'owner'), code('invalid'));
  assert.throws(() => svc.create({ ...base, files: [f('a.md', 'x'.repeat(64 * 1024 + 1))] }, 'owner'), code('invalid'));
  assert.throws(() => svc.create({ ...base, files: Array.from({ length: 5 }, (_, i) => f(`r/${i}.md`, 'x'.repeat(60 * 1024))) }, 'owner'), code('invalid'));
  for (const p of ['../x', '/etc/passwd', 'a//b', 'a/./b', 'SKILL.md', 'a b.md', '']) assert.throws(() => svc.create({ ...base, files: [f(p)] }, 'owner'), code('invalid'), p);
  assert.throws(() => svc.create({ ...base, files: [f('a.md', 'x\u0000y')] }, 'owner'), code('invalid', /Skills hold text files only/));
  const s = svc.create({ ...base, files: [f('references/palette.md', 'colours')] }, 'owner');
  assert.deepEqual(s.files, [{ path: 'references/palette.md', text: 'colours' }]);
});

test('a secret in the body or a file is refused, naming where', () => {
  const svc = make();
  const key = 'sk-ant-api03-' + 'a'.repeat(80);
  assert.throws(() => svc.create({ ...base, body: `Use ${key}` }, 'owner'), code('secret_detected', /the skill/));
  assert.throws(() => svc.create({ ...base, files: [{ path: 'k.md', text: key }] }, 'owner'), code('secret_detected', /k\.md/));
});

test('update with an old base is refused as changed; every save adds a version with its files; restore brings a version back', () => {
  const svc = make();
  const s = svc.create({ ...base, files: [{ path: 'a.md', text: 'one' }] }, 'owner');
  const s2 = svc.update(s.id, { base: 1, body: 'Two.', files: [] }, 'owner');
  assert.equal(s2.version, 2);
  assert.deepEqual(s2.files, []);
  assert.throws(() => svc.update(s.id, { base: 1, body: 'Stale.' }, 'owner'), code('changed'));
  assert.deepEqual(svc.versions(s.id).map((v) => v.version), [2, 1]);
  const back = svc.restore(s.id, 1, 'owner');
  assert.equal(back.version, 3);
  assert.equal(back.body, base.body);
  assert.deepEqual(back.files, [{ path: 'a.md', text: 'one' }]);
});

test('setEnabled and listOn; a deleted skill is never listed', () => {
  const svc = make();
  const a = svc.create(base, 'owner');
  const b = svc.create({ ...base, name: 'brain-deploy' }, 'owner');
  svc.setEnabled(a.id, true, 'owner');
  assert.deepEqual(svc.listOn().map((s) => s.name), ['release-notes']);
  svc.setEnabled(b.id, true, 'owner');
  svc.remove(a.id, 'owner');
  assert.deepEqual(svc.listOn().map((s) => s.name), ['brain-deploy']);
  assert.deepEqual(svc.list().map((s) => s.name), ['brain-deploy']);
  assert.equal(svc.byName('release-notes'), undefined);
});

test('propose: a new name is a new-skill proposal, an existing name a change with base_version; the same proposer replaces its pending one; 21st refused', () => {
  const svc = make();
  const p1 = svc.propose(base, 'Claude');
  assert.equal(p1.skillId, null);
  assert.equal(p1.baseVersion, null);
  const s = svc.create({ ...base, name: 'brain-deploy' }, 'owner');
  const p2 = svc.propose({ ...base, name: 'brain-deploy', body: 'Better.' }, 'ChatGPT');
  assert.equal(p2.skillId, s.id);
  assert.equal(p2.baseVersion, 1);
  svc.propose({ ...base, body: 'Newer.' }, 'Claude');
  assert.deepEqual(svc.pendingProposals().map((p) => [p.name, p.proposedBy, p.body]).sort(), [['brain-deploy', 'ChatGPT', 'Better.'], ['release-notes', 'Claude', 'Newer.']]);
  for (let i = 0; i < 18; i++) svc.propose({ ...base, name: `n${i}` }, 'Grok');
  assert.throws(() => svc.propose({ ...base, name: 'one-more' }, 'Grok'), code('invalid', /20 skill proposals already wait/));
});

test('addProposal creates the skill Off or On with origin proposed:<name>; applyProposal applies a change and keeps it On; a moved-on skill needs confirmChanged', () => {
  const svc = make();
  const added = svc.addProposal(svc.propose(base, 'Claude').id, true);
  assert.equal(added.origin, 'proposed:Claude');
  assert.equal(added.enabled, true);
  const change = svc.propose({ ...base, body: 'Changed.' }, 'ChatGPT');
  const applied = svc.applyProposal(change.id);
  assert.equal(applied.body, 'Changed.');
  assert.equal(applied.enabled, true);
  const later = svc.propose({ ...base, body: 'Later.' }, 'ChatGPT');
  svc.update(applied.id, { base: applied.version, body: 'Owner edit.' }, 'owner');
  assert.throws(() => svc.applyProposal(later.id), code('changed'));
  assert.equal(svc.applyProposal(later.id, true).body, 'Later.');
  assert.deepEqual(svc.pendingProposals(), []);
});

test('rejectProposal leaves everything else as it was', () => {
  const svc = make();
  const p = svc.propose(base, 'Claude');
  svc.rejectProposal(p.id);
  assert.deepEqual(svc.pendingProposals(), []);
  assert.deepEqual(svc.list(), []);
});

test('SKILL.md always quotes the description, so YAML never misreads it', () => {
  const svc = make();
  for (const d of ['[WIP] use when x', '- when x', '> x', 'yes', '123', 'a: b', '`code` first']) {
    const md = svc.skillMd({ name: 'x', description: d, body: '' });
    assert.ok(md.includes(`description: ${JSON.stringify(d)}\n`), d);
  }
});

test('file paths the export or git could not write are refused', () => {
  const svc = make();
  for (const files of [[{ path: '.git/config', text: 'x' }], [{ path: 'r/.hidden', text: 'x' }], [{ path: 'skill.md', text: 'x' }], [{ path: 'a', text: 'x' }, { path: 'a/b.md', text: 'y' }]]) {
    assert.throws(() => svc.create({ ...base, files }, 'owner'), code('invalid'), JSON.stringify(files));
  }
});

test('paths that would collide on a Mac (case only, or a file against a folder) are refused (audit F08)', () => {
  const svc = make();
  for (const files of [[{ path: 'A.txt', text: 'x' }, { path: 'a.txt', text: 'y' }], [{ path: 'Ref', text: 'x' }, { path: 'ref/b.md', text: 'y' }]]) {
    assert.throws(() => svc.create({ ...base, files }, 'owner'), code('invalid'), JSON.stringify(files));
  }
});
