/** Where the saved folder goes by default: the Documents folder, and whether a cloud service keeps it. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentsFolder } from './documents.js';

function home(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), 'docs-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('Mac plain: ~/Documents, not synced', (t) => {
  const h = home(t);
  mkdirSync(join(h, 'Documents'));
  assert.deepEqual(documentsFolder({ home: h, platform: 'darwin', env: {} }), { path: join(h, 'Documents'), synced: null });
});

test('Mac with iCloud Drive: synced when the CloudDocs Documents folder exists, or Documents points into it', (t) => {
  const h = home(t);
  mkdirSync(join(h, 'Library/Mobile Documents/com~apple~CloudDocs/Documents'), { recursive: true });
  assert.equal(documentsFolder({ home: h, platform: 'darwin', env: {} }).synced, 'iCloud');
  const h2 = home(t);
  mkdirSync(join(h2, 'Library/Mobile Documents/other/Documents'), { recursive: true });
  symlinkSync(join(h2, 'Library/Mobile Documents/other/Documents'), join(h2, 'Documents'));
  assert.equal(documentsFolder({ home: h2, platform: 'darwin', env: {} }).synced, 'iCloud');
});

test('Windows plain: the My Documents path the caller read, not synced', () => {
  const r = documentsFolder({ home: 'C:\\Users\\Alex', platform: 'win32', env: { OneDrive: 'C:\\Users\\Alex\\OneDrive' }, myDocuments: 'C:\\Users\\Alex\\Documents' });
  assert.deepEqual(r, { path: 'C:\\Users\\Alex\\Documents', synced: null });
});

test('Windows under OneDriveCommercial: synced', () => {
  const r = documentsFolder({
    home: 'C:\\Users\\Alex', platform: 'win32', env: { OneDriveCommercial: 'C:\\Users\\Alex\\OneDrive - Larder Co' },
    myDocuments: 'C:\\Users\\Alex\\OneDrive - Larder Co\\Documents',
  });
  assert.deepEqual(r, { path: 'C:\\Users\\Alex\\OneDrive - Larder Co\\Documents', synced: 'OneDrive' });
});

test('syncedCloud says whether a path is inside iCloud Drive or OneDrive', async () => {
  const { syncedCloud } = await import('./documents.js');
  const mac = { home: '/Users/ana', platform: 'darwin' as const, env: {} };
  assert.equal(syncedCloud('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Backups', mac), 'iCloud');
  assert.equal(syncedCloud('/Users/ana/Backups', mac), null);
  const win = { home: 'C:\\Users\\ana', platform: 'win32' as const, env: { OneDrive: 'C:\\Users\\ana\\OneDrive' } };
  assert.equal(syncedCloud('C:\\Users\\ana\\OneDrive\\Backups', win), 'OneDrive');
  assert.equal(syncedCloud('D:\\Backups', win), null);
  assert.equal(syncedCloud('/Users/ana/OneDrive/x', { ...mac, env: { OneDrive: '/Users/ana/OneDrive' } }), 'OneDrive');
});
