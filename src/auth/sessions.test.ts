import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { DEVICE_DAYS, SessionStore } from './sessions.js';

const DAY = 86_400_000;

test('sessions last 30 days and can be destroyed or revoked by id', () => {
  let t = Date.UTC(2026, 0, 1);
  const s = new SessionStore(openDb(':memory:'), () => new Date(t));
  const tok = s.create('iPhone');
  assert.equal(s.isValid(tok), true);
  t += 29 * DAY;
  assert.equal(s.isValid(tok), true);
  t += 1 * DAY + 1000;
  assert.equal(s.isValid(tok), false);

  const a = s.create(undefined);
  assert.equal(s.isValid(a), true);
  s.destroy(a);
  assert.equal(s.isValid(a), false);

  const b = s.create('iPhone');
  assert.equal(s.list()[0]!.userAgent, 'iPhone');
  assert.equal(s.list().length, 1); // expired one excluded
  assert.equal(s.idFor(b), s.list()[0]!.id);
  s.revoke(s.list()[0]!.id);
  assert.equal(s.isValid(b), false);
  assert.equal(s.isValid(undefined), false);
  assert.equal(s.isValid('garbage'), false);
  assert.equal(s.idFor('garbage'), undefined);
});

test('stores only a hash of the token; last_seen_at updates at most once a minute', () => {
  let t = Date.UTC(2026, 0, 1);
  const db = openDb(':memory:');
  const s = new SessionStore(db, () => new Date(t));
  const tok = s.create('ua');
  assert.equal((db.prepare('SELECT count(*) c FROM sessions WHERE token_hash = ?').get(tok) as any).c, 0);
  const seen = () => (s.list()[0]!.lastSeenAt);
  const first = seen();
  t += 30_000; s.isValid(tok);
  assert.equal(seen(), first);
  t += 31_000; s.isValid(tok);
  assert.equal(seen(), new Date(t).toISOString());
});

test('a known device stops counting once it has not been used for DEVICE_DAYS, and resetting the sign-in forgets all of them', async () => {
  const { purgeExpired } = await import('../db.js');
  const { OwnerAuth } = await import('./owner.js');
  let t = Date.UTC(2026, 0, 1);
  const db = openDb(':memory:');
  const s = new SessionStore(db, () => new Date(t));
  const old = s.rememberDevice();
  t += 100 * DAY;
  const recent = s.rememberDevice();
  t += (DEVICE_DAYS - 50) * DAY;
  purgeExpired(db, new Date(t));
  assert.equal(s.isKnownDevice(old), false);
  assert.equal(s.isKnownDevice(recent), true);
  await new OwnerAuth(db, () => new Date(t)).setPassword('a new long password');
  assert.equal(s.isKnownDevice(recent), false);
  const again = s.rememberDevice();
  new OwnerAuth(db, () => new Date(t)).setTotpSecret('JBSWY3DPEHPK3PXP');
  assert.equal(s.isKnownDevice(again), false);
});

test('resetting the password or the authenticator signs every browser out', async () => {
  const { OwnerAuth } = await import('./owner.js');
  const db = openDb(':memory:');
  const now = () => new Date(Date.UTC(2026, 0, 1));
  const s = new SessionStore(db, now);
  const owner = new OwnerAuth(db, now);
  const stolen = s.create('Laptop');
  await owner.setPassword('a new long password');
  assert.equal(s.isValid(stolen), false);
  assert.equal(s.list().length, 0);
  const again = s.create('Laptop');
  owner.setTotpSecret('JBSWY3DPEHPK3PXP');
  assert.equal(s.isValid(again), false);
});
