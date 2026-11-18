import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quietApps, QUIET_READS } from './quietApps.js';

const calls = (client: string, tool: string, count: number) => ({ client, tool, count });

test('an app with many memory reads and no saves is listed, most reads first', () => {
  const rows = [calls('Codex', 'recall', 30), calls('Codex', 'project_brief', 10), calls('Grok', 'recall', QUIET_READS), calls('Claude Code', 'recall', 90)];
  assert.deepEqual(quietApps(rows, ['Codex', 'Grok', 'Claude Code']).map((a) => [a.app, a.reads]), [['Claude Code', 90], ['Codex', 40], ['Grok', 20]]);
});

test('any save, held or direct, clears it: remember, update_memory and suggest_memories', () => {
  for (const tool of ['remember', 'update_memory', 'suggest_memories']) {
    assert.deepEqual(quietApps([calls('Codex', 'recall', 50), calls('Codex', tool, 1)], ['Codex']), [], tool);
  }
});

test('under 20 reads, boilerplate calls only, and apps that are not connected are left out', () => {
  assert.deepEqual(quietApps([calls('Codex', 'recall', QUIET_READS - 1)], ['Codex']), []);
  assert.deepEqual(quietApps([calls('Codex', 'load_profile', 50), calls('Codex', 'list_skills', 50)], ['Codex']), []);
  assert.deepEqual(quietApps([calls('Old app', 'recall', 50)], ['Codex']), []);
  assert.equal(quietApps([calls('codex', 'recall', 50)], ['Codex']).length, 1, 'names match without regard to case');
});
