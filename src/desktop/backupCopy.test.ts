import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCopy } from './backupCopy.js';

test('the second backup folder is kept in backup-copy.json and read back by a new BackupCopy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bcopy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(new BackupCopy(dir).folder(), null);
  new BackupCopy(dir).set('/tmp/x');
  assert.ok(existsSync(join(dir, 'backup-copy.json')));
  assert.equal(new BackupCopy(dir).folder(), '/tmp/x');
  assert.equal(new BackupCopy(dir).lastResult(), null);
  new BackupCopy(dir).set(null);
  assert.equal(new BackupCopy(dir).folder(), null);
});
