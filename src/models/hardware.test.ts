import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHardware } from './hardware.js';

test('readHardware reads this computer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-'));
  try {
    const hw = await readHardware(dir);
    assert.equal(hw.arch, process.arch);
    assert.equal(hw.platform, process.platform);
    assert.ok(hw.memoryBytes > 0);
    assert.ok(hw.freeDiskBytes > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
