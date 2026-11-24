import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busy, busyTick, setBusyDir } from './busyMarker.js';
import { sha256Of } from './memory/reranker.js';
import { writeFileSync } from 'node:fs';

const mk = () => { const d = mkdtempSync(join(tmpdir(), 'busy-')); setBusyDir(d); return d; };

test('the marker is up while the work runs, with what and when, and gone after', () => {
  const d = mk(); const f = join(d, 'busy.json');
  const before = Date.now();
  busy('backing up', () => {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(m.what, 'backing up');
    assert.ok(m.since >= before && m.since <= Date.now());
  });
  assert.equal(existsSync(f), false);
  setBusyDir(undefined);
});

test('it comes down when the work throws or its promise rejects, and stays up for nested work', async () => {
  const d = mk(); const f = join(d, 'busy.json');
  assert.throws(() => busy('x', () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(f), false);
  await assert.rejects(busy('y', async () => { throw new Error('later'); }), /later/);
  assert.equal(existsSync(f), false);
  await busy('outer', async () => {
    busy('inner', () => 1);
    assert.equal(existsSync(f), true, 'the inner end does not take the outer marker down');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(existsSync(f), true);
  });
  assert.equal(existsSync(f), false);
  setBusyDir(undefined);
});

test('without a folder it only runs the work', () => {
  setBusyDir(undefined);
  assert.equal(busy('z', () => 7), 7);
});

test('hashing a model file marks the server busy', () => {
  const d = mk(); const file = join(d, 'm.bin'); writeFileSync(file, 'abc');
  assert.equal(sha256Of(file).length, 64);
  assert.equal(existsSync(join(d, 'busy.json')), false);
  setBusyDir(undefined);
});

test('setBusyDir removes a marker (and its tmp file) left by a server that was killed', () => {
  const d = mkdtempSync(join(tmpdir(), 'busy-'));
  writeFileSync(join(d, 'busy.json'), '{"what":"old","since":1}');
  writeFileSync(join(d, '.busy.json.tmp'), 'x');
  setBusyDir(d);
  assert.equal(existsSync(join(d, 'busy.json')), false);
  assert.equal(existsSync(join(d, '.busy.json.tmp')), false);
  setBusyDir(undefined);
});

test('busyTick refreshes the time at most every 30 s, and only while work is marked', () => {
  const d = mk(); const f = join(d, 'busy.json');
  const since = () => JSON.parse(readFileSync(f, 'utf8')).since as number;
  busyTick(Date.now() + 1000);
  assert.equal(existsSync(f), false, 'nothing marked: no marker made');
  busy('copying', () => {
    const first = since();
    busyTick(first + 10_000);
    assert.equal(since(), first, 'too soon');
    busyTick(first + 30_000);
    assert.equal(since(), first + 30_000, 'refreshed');
    busyTick(first + 40_000);
    assert.equal(since(), first + 30_000, 'throttled again from the refresh');
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).what, 'copying');
  });
  setBusyDir(undefined);
});
