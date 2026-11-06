import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../projects/types.js';
import { matchFolders, notPushed } from './match.js';
import type { FolderState } from './report.js';

const f = (name: string, extra: Partial<FolderState> = {}): FolderState => ({ name, git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [], ...extra });
const p = (name: string, folder: string | null = null) => ({ name, folder } as unknown as Project);

test('folders match by the folder field, then the name, then an alias, after normalising', () => {
  const m = matchFolders(
    [f('Pine Lodge'), f('trellis-app'), f('coyote'), f('wildlog'), f('stray')],
    [p('pine-lodge'), p('trellis', 'trellis-app'), p('inflow'), p('wildlog')],
    [{ alias: 'coyote', project: 'inflow' }],
    new Set(),
  );
  assert.deepEqual([...m.byProject.entries()].map(([k, v]) => [k, v.name]).sort(), [['inflow', 'coyote'], ['pine-lodge', 'Pine Lodge'], ['trellis', 'trellis-app'], ['wildlog', 'wildlog']]);
  assert.deepEqual(m.unmatched.map((x) => x.name), ['stray']);
});

test('a folder that matches one project\'s folder field and another\'s name goes to the folder field', () => {
  const m = matchFolders([f('reports')], [p('reports'), p('trellis', 'Reports')], [], new Set());
  assert.equal(m.byProject.get('trellis')?.name, 'reports');
  assert.equal(m.byProject.has('reports'), false);
});

test('ignored folders are not unmatched', () => {
  const m = matchFolders([f('carpeta sin título'), f('jobs')], [], [], new Set(['carpeta-sin-título']));
  assert.deepEqual(m.unmatched.map((x) => x.name), ['jobs']);
});

test('notPushed: unpushed commits, or uncommitted work a day after the last commit', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  assert.equal(notPushed(f('a', { unpushed: 2 }), now), true);
  assert.equal(notPushed(f('a', { uncommitted: 3, lastCommit: '2026-11-03T09:00:00Z' }), now), false);
  assert.equal(notPushed(f('a', { uncommitted: 3, lastCommit: '2026-11-01T09:00:00Z' }), now), true);
  assert.equal(notPushed(f('a'), now), false);
  assert.equal(notPushed(f('a', { git: false, uncommitted: 0 }), now), false);
});

test('two folders with the same key: the one named exactly like the project matches, and the other is listed, not dropped', () => {
  const m = matchFolders([f('Pine Lodge'), f('pine-lodge')], [p('pine-lodge')], [], new Set());
  assert.equal(m.byProject.get('pine-lodge')?.name, 'pine-lodge');
  assert.deepEqual(m.unmatched.map((x) => x.name), ['Pine Lodge']);
  const byField = matchFolders([f('trellis-app'), f('Trellis App')], [p('trellis', 'Trellis App')], [], new Set());
  assert.equal(byField.byProject.get('trellis')?.name, 'Trellis App');
  assert.deepEqual(byField.unmatched.map((x) => x.name), ['trellis-app']);
});

test('a project whose folder field is not in the report still claims the folder with its own name', () => {
  const m = matchFolders([f('wildlog')], [p('wildlog', 'WildLog-old')], [], new Set());
  assert.equal(m.byProject.get('wildlog')?.name, 'wildlog');
  assert.deepEqual(m.unmatched, []);
});
