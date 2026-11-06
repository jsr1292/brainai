import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { DeviceService } from './devices.js';
import type { FolderState } from './report.js';

const setup = () => {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-03T10:00:00Z');
  return { db, devices: new DeviceService(db, () => new Date(t)), tick: (ms: number) => { t += ms; } };
};
const folder = (name: string): FolderState => ({ name, git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] });

test('a device token authenticates until revoked, and only its hash is stored', () => {
  const { db, devices } = setup();
  const { device, token } = devices.create('Mac');
  assert.match(token, /^brain_dev_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([device.name, device.lastReportAt, device.revokedAt], ['Mac', null, null]);
  assert.equal(devices.authenticate(token)!.id, device.id);
  assert.equal(devices.authenticate(`${token}x`), undefined);
  assert.equal(devices.authenticate(''), undefined);
  const row = db.prepare('SELECT * FROM device_tokens').get() as Record<string, string>;
  assert.ok(!JSON.stringify(row).includes(token), 'the token itself is never stored');
  devices.revoke(device.id);
  assert.equal(devices.authenticate(token), undefined);
  assert.notEqual(devices.list()[0]!.revokedAt, null);
  assert.throws(() => devices.create('  '), /1 to 60 characters/);
  assert.throws(() => devices.create('x'.repeat(61)), /1 to 60 characters/);
});

test('storeReport replaces the device\'s report; latestReport skips revoked devices', () => {
  const { devices, tick } = setup();
  const mac = devices.create('Mac').device;
  const old = devices.create('Old Mac').device;
  devices.storeReport(mac.id, [folder('wildlog')]);
  tick(1000);
  devices.storeReport(mac.id, [folder('wildlog'), folder('castle3d')]);
  assert.deepEqual(devices.latestReport()!.folders.map((f) => f.name), ['wildlog', 'castle3d']);
  assert.equal(devices.list().find((d) => d.id === mac.id)!.lastReportAt, '2026-11-03T10:00:01.000Z');
  tick(1000);
  devices.storeReport(old.id, [folder('only-old')]);
  assert.equal(devices.latestReport()!.device.id, old.id);
  devices.revoke(old.id);
  assert.equal(devices.latestReport()!.device.id, mac.id);
});

test('ignore and unignore folder names by key', () => {
  const { devices } = setup();
  devices.ignore('carpeta sin título');
  devices.ignore('Puzzle club');
  assert.deepEqual([...devices.ignored()].sort(), ['carpeta-sin-título', 'puzzle-club']);
  devices.unignore('puzzle club');
  assert.deepEqual([...devices.ignored()], ['carpeta-sin-título']);
});
