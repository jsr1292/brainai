import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter } from './loginLimiter.js';

test('5 failures from one IP blocks that IP only', async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 5; i++) await l.fail('1.1.1.1');
  const r = await l.check('1.1.1.1');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec > 0);
  assert.equal((await l.check('2.2.2.2')).allowed, true);
});

test('check does not consume points', async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 20; i++) await l.check('1.1.1.1');
  assert.equal((await l.check('1.1.1.1')).allowed, true);
});

test('4 failures still allowed; succeed resets only the per-IP limit', async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 4; i++) await l.fail('1.1.1.1');
  assert.equal((await l.check('1.1.1.1')).allowed, true);
  await l.fail('1.1.1.1');
  assert.equal((await l.check('1.1.1.1')).allowed, false);
  await l.succeed('1.1.1.1');
  assert.equal((await l.check('1.1.1.1')).allowed, true);
  // global points were not reset: 5 already spent; 25 more from other IPs trips global
  for (let i = 0; i < 24; i++) await l.fail(`10.0.0.${i}`);
  assert.equal((await l.check('9.9.9.9')).allowed, true);
  await l.fail('10.0.1.1');
  assert.equal((await l.check('9.9.9.9')).allowed, false);
});

test('30 failures spread across IPs block everyone', async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 30; i++) await l.fail(`10.0.0.${i}`);
  const r = await l.check('9.9.9.9');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec > 0);
});

test('a known device skips the limit shared by all addresses, but not its own address\'s limit', async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 30; i++) await l.fail(`10.0.0.${i}`);
  assert.equal((await l.check('9.9.9.9', { knownDevice: true })).allowed, true);
  for (let i = 0; i < 5; i++) await l.fail('9.9.9.9');
  assert.equal((await l.check('9.9.9.9', { knownDevice: true })).allowed, false);
});
