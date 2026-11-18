import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { SessionStore } from './sessions.js';
import { forgetAutoSessions } from './sessionReset.js';

test('sessions made by the old automatic sign-in are forgotten once, at the first start of this version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-reset-'));
  try {
    const db = openDb(':memory:');
    const sessions = new SessionStore(db, () => new Date());
    const old = sessions.create('curl/8');
    assert.equal(sessions.isValid(old), true);

    assert.equal(forgetAutoSessions(db, dir), true);
    assert.equal(sessions.isValid(old), false, 'the old session is gone');
    assert.equal(existsSync(join(dir, 'auto-sign-in-ended')), true);

    // A session made after the reset (the app window's) survives later starts.
    const fresh = sessions.create('app');
    assert.equal(forgetAutoSessions(db, dir), false);
    assert.equal(sessions.isValid(fresh), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
