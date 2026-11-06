import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupHealth, readBackupStatus, writeBackupStatus } from './backupStatus.js';

const now = new Date('2026-10-22T09:00:00Z');
const ok = { at: '2026-10-22T01:30:00Z', ok: true, copies: [{ where: '/mnt/ssd/memory-backups', result: 'copied' as const }, { where: '/mnt/nas/Backups/memory-backups', result: 'copied' as const }] };

test('backup health is fine with last night\'s copies all made and a recent off-site copy', () => {
  const h = backupHealth({ nightly: ok, offsite: { at: '2026-10-19T02:15:00Z', ok: true, where: 'gdrive:memory-backups' } }, now);
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
});

test('backup health names each problem: a copy skipped or failed, a stale or failed run, a missing or stale off-site copy', () => {
  const skipped = { ...ok, copies: [ok.copies[0]!, { where: '/mnt/nas/Backups/memory-backups', result: 'skipped' as const, detail: 'not mounted' }] };
  assert.deepEqual(backupHealth({ nightly: skipped }, now).problems, [
    'The nightly copy to /mnt/nas/Backups/memory-backups was skipped: not mounted.',
  ]);
  assert.deepEqual(backupHealth({ nightly: { ...ok, at: '2026-10-20T01:30:00Z' }, offsite: { at: '2026-10-10T02:00:00Z', ok: true } }, now).problems, [
    'The last nightly backup is more than a day old.',
    'The last off-site copy is more than 8 days old.',
  ]);
  assert.deepEqual(backupHealth({ nightly: { at: ok.at, ok: false, error: 'integrity check failed' }, offsite: { at: ok.at, ok: false, error: 'rclone: token expired' } }, now).problems, [
    'The nightly backup failed: integrity check failed.',
    'The off-site copy failed: rclone: token expired.',
  ]);
  assert.deepEqual(backupHealth({}, now).problems, ['No nightly backup has run yet.']);
});

test('the status files are written and read back; unreadable ones count as missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bstatus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeBackupStatus(dir, 'nightly', ok);
  writeFileSync(join(dir, 'offsite-status.json'), 'not json');
  assert.deepEqual(readBackupStatus(dir), { nightly: ok });
});

test('the work copy has no off-site check: its backups already go to OneDrive', () => {
  assert.deepEqual(backupHealth({ nightly: ok }, now, { offsite: false }).problems, []);
});

test('the optional jobs (off-site, git copy, export) warn only once set up: a new install with just the nightly backup is fine', () => {
  const offsite = { at: '2026-10-19T02:15:00Z', ok: true, where: 'gdrive:memory-backups' };
  assert.deepEqual(backupHealth({ nightly: ok }, now, { offsite: true, jobs: true }).problems, []);
  assert.deepEqual(backupHealth({ nightly: ok, offsite }, now, { jobs: true }).problems, []);
  assert.deepEqual(backupHealth({ nightly: ok, offsite, git: { at: '2026-10-18T03:40:00Z', ok: true }, export: { at: ok.at, ok: false, detail: 'pushing failed' } }, now, { jobs: true }).problems, [
    'The last git copy is more than a day old.', 'The Markdown export failed: pushing failed.',
  ]);
  assert.deepEqual(backupHealth({ nightly: ok }, now, { offsite: false, jobs: false }).problems, []);
});

test('the git and export status files are read back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bstatus-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'git-backup-status.json'), JSON.stringify({ at: ok.at, ok: true }));
  writeFileSync(join(dir, 'export-status.json'), JSON.stringify({ at: ok.at, ok: true, detail: 'at abc123' }));
  const s = readBackupStatus(dir);
  assert.deepEqual([s.git?.ok, s.export?.detail], [true, 'at abc123']);
});

test('missing pictures in last night\'s check make the backup need a look (audit F11)', () => {
  const h = backupHealth({ nightly: { ...ok, pictures: { missing: 2, stray: 0 } }, offsite: { at: '2026-10-19T02:15:00Z', ok: true, where: 'gdrive:memory-backups' } }, now);
  assert.equal(h.ok, false);
  assert.deepEqual(h.problems, ['2 pictures the database lists are missing from the brain\'s folder.']);
  assert.equal(backupHealth({ nightly: { ...ok, pictures: { missing: 0, stray: 3 } }, offsite: { at: '2026-10-19T02:15:00Z', ok: true, where: 'gdrive:memory-backups' } }, now).ok, true);
});
