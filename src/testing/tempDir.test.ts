/** The fakes' cleanup runs in a test's after hooks, before the app's close (registered later, run later). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fakeTailscale } from './fakeTailscale.js';
import { fakeCloudflared } from './fakeCloudflared.js';
import { fakeHome } from './fakeTools.js';

// node:test stops a test's after hooks at the first one that throws: a cleanup that threw skipped the app's close behind
// it, its server kept listening, and the test file never ended (reach.test.ts, 2026-11-25).
for (const [name, make] of [
  ['fakeTailscale', () => fakeTailscale({ backend: 'Running' })],
  ['fakeCloudflared', () => fakeCloudflared({})],
  ['fakeHome', () => fakeHome()],
] as const) {
  test(`${name}: a folder that cannot be removed does not make cleanup throw`, { skip: process.getuid?.() === 0 ? 'root removes it anyway' : false }, () => {
    const fake = make();
    const root = dirname(fake.home);
    assert.ok(readdirSync(fake.home).length > 0 || readdirSync(fake.bin).length > 0, 'the fake has files to remove');
    // Its entries cannot be removed (as when a process the app started keeps writing into it): rmSync throws.
    chmodSync(fake.bin, 0o500);
    try {
      assert.doesNotThrow(() => fake.cleanup());
    } finally {
      chmodSync(fake.bin, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(existsSync(root), false);
  });
}
