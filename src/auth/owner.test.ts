import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { OwnerAuth } from './owner.js';
import { generateTotpSecret, totpAt } from './totp.js';

const T = Date.UTC(2026, 0, 1, 12, 0, 0);
const step = (ms: number) => Math.floor(ms / 1000 / 30);

test('password: min 12 chars, verifies, wrong fails', async () => {
  const db = openDb(':memory:');
  const o = new OwnerAuth(db, () => new Date(T));
  await assert.rejects(o.setPassword('short'));
  assert.equal(await o.verifyPassword('anything'), false);
  await o.setPassword('correct horse battery');
  assert.equal(await o.verifyPassword('correct horse battery'), true);
  assert.equal(await o.verifyPassword('nope'), false);
  const h = (db.prepare('SELECT password_hash h FROM owner').get() as { h: string }).h;
  assert.ok(h.startsWith('$argon2id$'));
  assert.ok(!h.includes('correct horse'));
});

test('TOTP: accepts ±1 step, rejects replay and far codes', () => {
  const secret = generateTotpSecret();
  const mk = () => { const o = new OwnerAuth(openDb(':memory:'), () => new Date(T)); o.setTotpSecret(secret); return o; };
  const s = step(T);
  let o = mk();
  assert.equal(o.verifyTotp(totpAt(secret, s)), true);
  assert.equal(o.verifyTotp(totpAt(secret, s)), false); // replay
  assert.equal(o.verifyTotp(totpAt(secret, s + 1)), true);
  assert.equal(o.verifyTotp(totpAt(secret, s - 1)), false); // <= last step
  o = mk();
  assert.equal(o.verifyTotp(totpAt(secret, s + 5)), false);
  assert.equal(o.verifyTotp(totpAt(secret, s - 2)), false);
  assert.equal(o.verifyTotp(totpAt(secret, s - 1)), true);
});

test('verifyTotp rejects malformed input and an unset secret', () => {
  const o = new OwnerAuth(openDb(':memory:'), () => new Date(T));
  assert.equal(o.verifyTotp('123456'), false);
  const secret = generateTotpSecret();
  o.setTotpSecret(secret);
  const good = totpAt(secret, step(T));
  for (const bad of ['', '12345', `${good}0`, ` ${good}`, 'abcdef', '１２３４５６']) assert.equal(o.verifyTotp(bad), false);
  assert.equal(o.verifyTotp(good), true);
});

test('isConfigured needs both password and TOTP', async () => {
  const o = new OwnerAuth(openDb(':memory:'), () => new Date(T));
  assert.equal(o.isConfigured(), false);
  await o.setPassword('correct horse battery');
  assert.equal(o.isConfigured(), false);
  o.setTotpSecret(generateTotpSecret());
  assert.equal(o.isConfigured(), true);
});
