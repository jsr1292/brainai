import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { SkillService } from './service.js';
import { contentHash, parseSkillMd, SkillSync, type ReportItem } from './sync.js';
import type { SkillFile } from './types.js';

function make() {
  let t = Date.parse('2026-11-05T10:00:00Z');
  const db = openDb(':memory:');
  const now = () => new Date(t += 1000);
  const skills = new SkillService(db, now);
  return { skills, sync: new SkillSync(db, now, skills) };
}
const md = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const macSkill = (name: string, body = 'Do it.', extra: SkillFile[] = []): { item: ReportItem; files: SkillFile[] } => {
  const files = [{ path: 'SKILL.md', text: md(name, `Use when ${name}.`, body) }, ...extra];
  return { item: { name, description: `Use when ${name}.`, hash: contentHash(files), files: files.length, bytes: 10, shareable: null }, files };
};
const brainFiles = (skills: SkillService, id: string): SkillFile[] => { const s = skills.get(id)!; return [{ path: 'SKILL.md', text: skills.skillMd(s) }, ...s.files]; };

test('contentHash matches a fixed vector', () => {
  // The same vector is checked against the Mac script (skillsReporter.test.ts): sha256 of 'SKILL.md\\0é\\n\\0b.md\\0B\\0'.
  const files = [{ path: 'b.md', text: 'B' }, { path: 'SKILL.md', text: 'é\n' }];
  assert.equal(contentHash(files), '47e3ecdb9014e0bf2dfd2cb73f5943befaffd91ee733e4ce278297ecc80a98e4');
  assert.equal(contentHash([...files].reverse()), '47e3ecdb9014e0bf2dfd2cb73f5943befaffd91ee733e4ce278297ecc80a98e4', 'order does not matter: sorted by path');
});

test('parseSkillMd reads plain, quoted and folded descriptions', () => {
  assert.deepEqual(parseSkillMd(md('a', 'Use when x.', 'Body.')), { name: 'a', description: 'Use when x.', body: 'Body.' });
  assert.deepEqual(parseSkillMd(md('a', '"Use: when \\"x\\"."', 'Body.')), { name: 'a', description: 'Use: when "x".', body: 'Body.' });
  assert.deepEqual(parseSkillMd('---\nname: a\ndescription: >\n  Use when\n  x.\n---\nBody.'), { name: 'a', description: 'Use when x.', body: 'Body.' });
  assert.deepEqual(parseSkillMd('No frontmatter.'), { name: null, description: '', body: 'No frontmatter.' });
});

test('a new device skill is wanted once, then not again while its hash is the same', () => {
  const { sync } = make();
  const a = macSkill('codex-delegation');
  assert.deepEqual(sync.report('mac', [a.item]).want, ['codex-delegation']);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  assert.deepEqual(sync.report('mac', [a.item]).want, []);
  const changed = macSkill('codex-delegation', 'Changed.');
  assert.deepEqual(sync.report('mac', [changed.item]).want, ['codex-delegation']);
});

test('share imports a reported skill Off with origin device:<id>, parsed from its SKILL.md, and links it', () => {
  const { sync, skills } = make();
  const a = macSkill('codex-delegation', 'Plan, then delegate.', [{ path: 'references/x.md', text: 'X' }]);
  sync.report('mac', [a.item]);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  const s = sync.share('mac', 'codex-delegation');
  assert.deepEqual([s.name, s.description, s.body, s.enabled, s.origin], ['codex-delegation', 'Use when codex-delegation.', 'Plan, then delegate.', false, 'device:mac']);
  assert.deepEqual(s.files, [{ path: 'references/x.md', text: 'X' }]);
  assert.deepEqual(sync.report('mac', [a.item]).actions, [], 'shared and unchanged: nothing to do, and Off never removes a Mac skill');
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['same']);
});

test('share of a skill with no content yet is refused as not yet', () => {
  const { sync } = make();
  sync.report('mac', [macSkill('codex-delegation').item]);
  assert.throws(() => sync.share('mac', 'codex-delegation'), /Not yet: the Mac sends it with its next report/);
});

test('a brain edit of a linked skill yields a write expecting the Mac hash; once reported back, nothing', () => {
  const { sync, skills } = make();
  const a = macSkill('codex-delegation');
  sync.report('mac', [a.item]);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  const s = sync.share('mac', 'codex-delegation');
  skills.update(s.id, { base: s.version, body: 'Brain edit.' }, 'owner');
  const { actions } = sync.report('mac', [a.item]);
  assert.equal(actions.length, 1);
  const w = actions[0]!;
  assert.equal(w.kind, 'write');
  assert.equal(w.expect, a.item.hash);
  assert.deepEqual((w as any).files, brainFiles(skills, s.id));
  const written = { ...a.item, hash: contentHash(brainFiles(skills, s.id)) };
  assert.deepEqual(sync.report('mac', [written]).actions, []);
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['same']);
});

test('a Mac edit shows mac_changed and writes nothing; takeMac updates the brain; keepBrain yields a forced write', () => {
  const { sync, skills } = make();
  const a = macSkill('codex-delegation');
  sync.report('mac', [a.item]);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  const s = sync.share('mac', 'codex-delegation');
  const edited = macSkill('codex-delegation', 'Mac edit.');
  assert.deepEqual(sync.report('mac', [edited.item]).actions, []);
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['mac_changed']);
  sync.upload('mac', [{ name: edited.item.name, hash: edited.item.hash, files: edited.files }]);
  assert.equal(sync.takeMac(s.id, 'mac').body, 'Mac edit.');
  assert.deepEqual(sync.report('mac', [edited.item]).actions, [], 'no ping-pong after taking the Mac version');
  const edited2 = macSkill('codex-delegation', 'Another Mac edit.');
  sync.report('mac', [edited2.item]);
  sync.keepBrain(s.id, 'mac');
  const { actions } = sync.report('mac', [edited2.item]);
  assert.deepEqual(actions.map((x) => [x.kind, x.expect]), [['write', edited2.item.hash]]);
});

test('a brain skill that is On reaches a device without it; a same-named unlinked Mac folder is own_copy and never written', () => {
  const { sync, skills } = make();
  const s = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  assert.deepEqual(sync.report('mac', []).actions, [], 'Off: not sent');
  skills.setEnabled(s.id, true, 'owner');
  const { actions } = sync.report('mac', []);
  assert.deepEqual(actions.map((x) => [x.kind, x.name, x.expect]), [['write', 'brain-deploy', null]]);
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['pending']);
  const t = skills.create({ name: 'release-notes', description: 'Use when writing notes.', body: 'x' }, 'owner');
  skills.setEnabled(t.id, true, 'owner');
  const own = macSkill('release-notes');
  const r = sync.report('laptop', [own.item]);
  assert.ok(!r.actions.some((x) => x.name === 'release-notes'));
  assert.ok(sync.stateFor(t.id).some((x) => x.deviceId === 'laptop' && x.state === 'own_copy'));
});

test('turning a brain-made skill Off removes it from the Mac; a skill shared from the Mac is never removed', () => {
  const { sync, skills } = make();
  const s = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  sync.report('mac', []);
  const there = { name: 'brain-deploy', description: 'Use when deploying.', hash: contentHash(brainFiles(skills, s.id)), files: 1, bytes: 10, shareable: null };
  assert.deepEqual(sync.report('mac', [there]).actions, []);
  skills.setEnabled(s.id, false, 'owner');
  assert.deepEqual(sync.report('mac', [there]).actions, [{ kind: 'remove', name: 'brain-deploy', expect: there.hash }]);
  const a = macSkill('codex-delegation');
  sync.report('mac', [a.item]);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  const shared = sync.share('mac', 'codex-delegation');
  skills.remove(shared.id, 'owner');
  assert.ok(!sync.report('mac', [a.item]).actions.some((x) => x.kind === 'remove' && x.name === 'codex-delegation'));
});

test('the same skill name on two devices keeps separate links', () => {
  const { sync, skills } = make();
  const s = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  assert.equal(sync.report('mac', []).actions.length, 1);
  assert.equal(sync.report('laptop', []).actions.length, 1);
  const there = { name: 'brain-deploy', description: 'Use when deploying.', hash: contentHash(brainFiles(skills, s.id)), files: 1, bytes: 10, shareable: null };
  sync.report('mac', [there]);
  assert.deepEqual(sync.stateFor(s.id).map((x) => [x.deviceId, x.state]).sort(), [['laptop', 'pending'], ['mac', 'same']]);
});

test('upload is refused for a name not reported, or content not matching its hash', () => {
  const { sync } = make();
  const a = macSkill('codex-delegation');
  assert.throws(() => sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]), /not reported/);
  sync.report('mac', [a.item]);
  assert.throws(() => sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: [{ path: 'SKILL.md', text: 'tampered' }] }]), /does not match/);
});

test('a write the Mac has not applied yet stays pending and is sent again, never shown as changed on the Mac', () => {
  const { sync, skills } = make();
  const a = macSkill('codex-delegation');
  sync.report('mac', [a.item]);
  sync.upload('mac', [{ name: a.item.name, hash: a.item.hash, files: a.files }]);
  const s = sync.share('mac', 'codex-delegation');
  skills.update(s.id, { base: s.version, body: 'Brain edit.' }, 'owner');
  const first = sync.report('mac', [a.item]);
  assert.deepEqual(first.actions.map((x) => [x.kind, x.expect]), [['write', a.item.hash]]);
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['pending'], 'not "changed on the Mac" while the write is on its way');
  const again = sync.report('mac', [a.item]);
  assert.deepEqual(again.actions.map((x) => [x.kind, x.expect]), [['write', a.item.hash]], 'an unapplied write is sent again with the same expect');
  assert.deepEqual(sync.stateFor(s.id).map((x) => x.state), ['pending']);
  sync.keepBrain(s.id, 'mac');
  const edited = macSkill('codex-delegation', 'Mac edit.');
  assert.deepEqual(sync.report('mac', [edited.item]).actions.map((x) => x.expect), [edited.item.hash]);
  assert.deepEqual(sync.report('mac', [edited.item]).actions.map((x) => x.expect), [edited.item.hash], 'Keep this one holds until the Mac reports the brain version');
});

test('upload refuses unshareable or oversized skills, and a secret makes the skill unshareable with the reason', () => {
  const { sync } = make();
  const big = macSkill('big-one');
  sync.report('mac', [{ ...big.item, shareable: 'too big to share (59 files, 19575 KB)' }]);
  assert.throws(() => sync.upload('mac', [{ name: 'big-one', hash: big.item.hash, files: big.files }]), /can't be shared/);
  const many = macSkill('many', 'x', Array.from({ length: 21 }, (_, i) => ({ path: `r/${i}.md`, text: 'x' })));
  sync.report('mac', [many.item]);
  assert.throws(() => sync.upload('mac', [{ name: 'many', hash: many.item.hash, files: many.files }]), /too many files|too big/);
  const key = macSkill('leaky', 'Use sk-ant-api03-' + 'a'.repeat(80));
  sync.report('mac', [key.item]);
  sync.upload('mac', [{ name: 'leaky', hash: key.item.hash, files: key.files }]);
  const row = sync.fromDevice('mac').find((x) => x.name === 'leaky')!;
  assert.equal(row.hasContent, false);
  assert.match(row.shareable ?? '', /looks like it holds a secret/);
});

test('a removal is sent again until the device reports the folder gone (audit F04)', () => {
  const { sync, skills } = make();
  const s = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  sync.report('mac', []);
  const there = { name: 'brain-deploy', description: 'Use when deploying.', hash: contentHash(brainFiles(skills, s.id)), files: 1, bytes: 10, shareable: null };
  sync.report('mac', [there]);
  skills.setEnabled(s.id, false, 'owner');
  assert.deepEqual(sync.report('mac', [there]).actions.map((a) => a.kind), ['remove']);
  assert.deepEqual(sync.report('mac', [there]).actions.map((a) => a.kind), ['remove'], 'the answer was lost: asked again');
  assert.deepEqual(sync.report('mac', []).actions, [], 'gone: nothing more to do');
  assert.deepEqual(sync.report('mac', []).actions, []);
});

test('turning a skill Off before the Mac confirmed the write still removes it there (audit F04, review)', () => {
  const { sync, skills } = make();
  const s = skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  assert.deepEqual(sync.report('mac', []).actions.map((a) => a.kind), ['write']);
  const there = { name: 'brain-deploy', description: 'Use when deploying.', hash: contentHash(brainFiles(skills, s.id)), files: 1, bytes: 10, shareable: null };
  skills.setEnabled(s.id, false, 'owner');
  assert.deepEqual(sync.report('mac', [there]).actions.map((a) => [a.kind, a.expect]), [['remove', there.hash]]);
  assert.deepEqual(sync.report('mac', []).actions, []);
});
