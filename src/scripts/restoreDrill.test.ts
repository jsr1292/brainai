import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, runDrill } from './restoreDrill.js';

// The restore drill's core, with the fake embedder and without age: every copy path restores onto a clean machine and
// is checked against the source's fingerprint. The off-site pack and the real model run from `npm run drill:restore`.
test('every restore path brings the brain back whole, and the checks that must hold do', { timeout: 120_000 }, async () => {
  const { checks } = await runDrill({ noOffsite: true });
  const failed = checks.filter((c) => c.status === 'FAIL');
  assert.deepEqual(failed.map((c) => `${c.path}: ${c.name} [${c.detail}]`), []);
  // Nothing may be skipped but the off-site pack: a skipped path would be a path nobody tested.
  assert.deepEqual([...new Set(checks.filter((c) => c.status === 'SKIPPED').map((c) => c.path))], [PATHS.c]);
  for (const path of [PATHS.a1, PATHS.a2, PATHS.b1, PATHS.b2, PATHS.d1, PATHS.d2]) {
    assert.ok(checks.filter((c) => c.path === path && c.status === 'PASS').length >= 4, `${path} has passing checks`);
  }
  // The checks that carry the promises must exist for every path that restores a backup (a drill that stops asking is no drill).
  for (const path of [PATHS.a1, PATHS.a2, PATHS.b1, PATHS.b2]) {
    for (const name of ['facts (all fields) identical', 'picture files present with the same sha256', 'the old access token is rejected (401)', 'an assistant re-saving the forgotten text is held, not saved', 'the held item is still held']) {
      assert.ok(checks.some((c) => c.path === path && c.name === name && c.status === 'PASS'), `${path}: ${name}`);
    }
  }
});
