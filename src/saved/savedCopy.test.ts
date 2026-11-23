/** The saved folder: archive, Markdown and README, the check against the live counts, and moving files in. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../skills/service.js';
import { makePages, makeService } from '../testing/helpers.js';
import { checkArchive } from './archive.js';
import { makeSavedCopy, moveIntoSaved, savedReadme, writeReadme } from './savedCopy.js';

const T = new Date('2026-11-12T09:00:00Z');
const me = { type: 'owner' } as const;

function tmp(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'savedcopy-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function setup(t: TestContext) {
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, me);
  const pages = makePages(given, () => T);
  await pages.create({ title: 'Wildlog setup', area: 'apps', body: 'Run it with the usual command.' }, 'owner');
  const dataDir = tmp(t);
  const deps = { db: given.db, dataDir, pages, memoryStore: given.store, memories: given.service, skills: new SkillService(given.db, () => T) };
  return { ...given, deps, dataDir };
}

test('makeSavedCopy writes the archive, Markdown and README', async (t) => {
  const s = await setup(t);
  const parent = tmp(t);
  const r = await makeSavedCopy(s.deps, parent, T, ['Claude: remove it']);
  assert.equal(r.folder, join(parent, 'BrainAI saved 2026-11-12'));
  assert.equal(r.archive, join(r.folder, 'brainai-saved-2026-11-12.tar.gz'));
  assert.deepEqual({ facts: r.facts, pages: r.pages }, { facts: 1, pages: 1 });
  const check = await checkArchive(r.archive);
  assert.ok(check.ok && check.facts === 1 && check.pages === 1);
  assert.ok(readdirSync(join(r.folder, 'Markdown')).includes('facts'));
  const readme = readFileSync(join(r.folder, 'README.txt'), 'utf8');
  assert.match(readme, /It holds every memory in plain text: keep it private\./);
  assert.match(readme, /Things BrainAI could not remove/);
  assert.match(readme, /Claude: remove it/);
  assert.equal(statSync(r.folder).mode & 0o777, 0o700);
});

test('a second save the same day is "BrainAI saved <day> (2)"', async (t) => {
  const s = await setup(t);
  const parent = tmp(t);
  await makeSavedCopy(s.deps, parent, T, []);
  const second = await makeSavedCopy(s.deps, parent, T, []);
  assert.equal(second.folder, join(parent, 'BrainAI saved 2026-11-12 (2)'));
  assert.ok(existsSync(second.archive));
});

test('checkSavedCopy retries once when the counts moved', async (t) => {
  const s = await setup(t);
  const parent = tmp(t);
  let packs = 0;
  const r = await makeSavedCopy(s.deps, parent, T, [], {
    afterPack: () => { if (++packs === 1) s.db.prepare("INSERT INTO memories(id, kind, content, embedding, created_at, created_by, updated_at, updated_by) VALUES ('late1', 'decision', 'Larder list added', x'00', 'x', 'o', 'x', 'o')").run(); },
  });
  assert.equal(packs, 2);
  assert.equal(r.facts, 2);
});

test('a brain that keeps changing throws and leaves no folder', async (t) => {
  const s = await setup(t);
  const parent = tmp(t);
  let n = 0;
  await assert.rejects(
    makeSavedCopy(s.deps, parent, T, [], { afterPack: () => { s.db.prepare("INSERT INTO memories(id, kind, content, embedding, created_at, created_by, updated_at, updated_by) VALUES (?, 'decision', 'more', x'00', 'x', 'o', 'x', 'o')").run(`late${++n}`); } }),
    /The brain changed while saving; try again\./,
  );
  assert.deepEqual(readdirSync(parent), []);
});

test('a parent inside the data folder is refused', async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.dataDir, 'inside'));
  await assert.rejects(makeSavedCopy(s.deps, join(s.dataDir, 'inside'), T, []), /outside the BrainAI data folder/);
  await assert.rejects(makeSavedCopy(s.deps, s.dataDir, T, []), /outside the BrainAI data folder/);
});

test('moveIntoSaved keeps the path below home, skips what is missing, and leaves README alone', async (t) => {
  const home = tmp(t);
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md.brainai-backup'), 'original words');
  const folder = join(tmp(t), 'BrainAI saved 2026-11-12');
  mkdirSync(folder);
  writeFileSync(join(folder, 'README.txt'), 'untouched');
  const moved = moveIntoSaved(folder, [join(home, '.claude/CLAUDE.md.brainai-backup'), join(home, '.codex/missing')], home);
  assert.deepEqual(moved, ['.claude/CLAUDE.md.brainai-backup']);
  assert.equal(readFileSync(join(folder, 'Original tool settings/.claude/CLAUDE.md.brainai-backup'), 'utf8'), 'original words');
  assert.equal(existsSync(join(home, '.claude/CLAUDE.md.brainai-backup')), false);
  assert.equal(readFileSync(join(folder, 'README.txt'), 'utf8'), 'untouched');
});

test('writeReadme is generated whole each time and lists the original tool settings when there are some', (t) => {
  const folder = tmp(t);
  writeReadme(folder, { day: '2026-11-12', facts: 3, pages: 2, checklist: ['One thing'], originals: [] });
  const first = readFileSync(join(folder, 'README.txt'), 'utf8');
  assert.doesNotMatch(first, /Your original tool settings/);
  writeReadme(folder, { day: '2026-11-12', facts: 3, pages: 2, checklist: ['One thing', 'Two'], originals: ['.claude/CLAUDE.md.brainai-backup'] });
  const second = readFileSync(join(folder, 'README.txt'), 'utf8');
  assert.match(second, /Your original tool settings[\s\S]*\.claude\/CLAUDE\.md\.brainai-backup/);
  assert.equal(second.match(/Things BrainAI could not remove/g)?.length, 1);
  assert.match(savedReadme({ day: '2026-11-12', facts: 3, pages: 2, checklist: [], originals: [] }), /Open BrainAI and choose I have a saved BrainAI folder/);
  assert.match(savedReadme({ day: '2026-11-12', facts: 3, pages: 2, checklist: [], originals: [] }), /docs\/RUNBOOK\.md, Coming back from a saved copy/);
});

test('the README counts in words: 1 fact and 1 page', () => {
  assert.match(savedReadme({ day: '2026-11-12', facts: 1, pages: 1, checklist: [], originals: [] }), /: 1 fact and 1 page\./);
  assert.match(savedReadme({ day: '2026-11-12', facts: 2, pages: 0, checklist: [], originals: [] }), /: 2 facts and 0 pages\./);
});

test('the folder and the archive are named by the local day, as the moving file and the nightly backup are', async (t) => {
  const s = await setup(t);
  const parent = tmp(t);
  const tz = process.env.TZ;
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  // UTC+14: 20:00 UTC on the 12th is already the 13th there.
  process.env.TZ = 'Pacific/Kiritimati';
  const r = await makeSavedCopy(s.deps, parent, new Date('2026-11-12T20:00:00Z'), []);
  assert.equal(r.folder, join(parent, 'BrainAI saved 2026-11-13'));
  assert.equal(r.archive, join(r.folder, 'brainai-saved-2026-11-13.tar.gz'));
  assert.equal(r.day, '2026-11-13');
  assert.match(readFileSync(join(r.folder, 'README.txt'), 'utf8'), /^BrainAI saved 2026-11-13\n/);
});

test('moveIntoSaved gives a file outside home a flat safe name, never a path that climbs out of the folder', (t) => {
  const home = join(tmp(t), 'home');
  mkdirSync(home);
  const elsewhere = tmp(t);
  const file = join(elsewhere, 'mcp.json.brainai-backup');
  writeFileSync(file, 'original');
  const folder = join(tmp(t), 'BrainAI saved 2026-11-12');
  mkdirSync(folder);
  const moved = moveIntoSaved(folder, [file], home);
  assert.equal(moved.length, 1);
  assert.doesNotMatch(moved[0]!, /^\.\.|\/|\\/);
  assert.equal(readFileSync(join(folder, 'Original tool settings', moved[0]!), 'utf8'), 'original');
  assert.equal(existsSync(file), false);
});
