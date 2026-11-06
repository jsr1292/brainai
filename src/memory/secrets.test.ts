import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecret } from './secrets.js';

test('detects common secrets and ignores normal text', () => {
  for (const s of ['-----BEGIN OPENSSH PRIVATE KEY-----', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'password: hunter2hunter2',
    'contraseña = Sup3rS3creta!', 'TUNNEL_TOKEN=eyJhIjoiYWJjZGVmZ2hpams.eyJzdWIiOiJ4eHh4eHh4eHh4.abc']) {
    assert.ok(looksLikeSecret(s), s);
  }
  for (const s of ['Uses OAuth tokens for auth', 'Password manager is Bitwarden', 'Mini PC IP is 192.0.2.20']) {
    assert.equal(looksLikeSecret(s), null, s);
  }
});

test('looksLikeKey ignores credential assignments but catches keys', async () => {
  const { looksLikeKey } = await import('./secrets.js');
  assert.equal(looksLikeKey('const token = randomToken()'), null);
  assert.equal(looksLikeKey('password: hunter2hunter2'), null);
  assert.equal(looksLikeKey('-----BEGIN RSA PRIVATE KEY-----'), 'private key');
  assert.equal(looksLikeKey('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'), 'API key');
});

test('prose and code that only mention a token or secret are not refused', () => {
  for (const s of [
    "const token = randomBytes(32).toString('base64url');",
    'inputSchema: { token: z.string() }',
    'The Authorization header carries the device token: Bearer <token>',
    '`TUNNEL_TOKEN=<token>` goes in the .env file',
    '**Reused refresh token = disconnect.**',
    'export API_KEY=$OPENAI_API_KEY',
    'password: ********',
    'const secret = process.env.SESSION_SECRET;',
    'token: {{ secrets.DEPLOY_TOKEN }}',
  ]) assert.equal(looksLikeSecret(s), null, s);
  for (const s of ['password: hunter2hunter2.', "token = 'a8Fj3kL0pQ9z'", 'secret: Sup3rS3creta!, user: admin', 'api_key=0123456789abcdef', 'password = hunter2.hunter2', 'token = abcdefghijk']) {
    assert.equal(looksLikeSecret(s), 'credential assignment', s);
  }
});

test('findSecret says on which line the secret is, without repeating it', async () => {
  const { findSecret } = await import('./secrets.js');
  const found = findSecret('# Setup\n\nThe device token: Bearer <token>\nThe TOTP secret: base32, stored in the owner table.');
  assert.deepEqual(found, { reason: 'credential assignment', line: 4, excerpt: 'secret: ba…' });
  const key = findSecret('one\ntwo ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
  assert.deepEqual(key, { reason: 'GitHub token', line: 2, excerpt: 'ghp_…' });
  assert.equal(findSecret('nothing here'), null);
});

test('a bearer token after "token:" is refused; only a placeholder after the scheme word is let through', () => {
  for (const s of ['token: Bearer 9f8a7b6c5d4e3f2a1b0c', 'Authorization token: Bearer a8Fj3kL0pQ9zXc77', 'secret = Basic dXNlcjpwYXNzd29yZA==', 'api_key: Token 0123456789abcdef']) {
    assert.equal(looksLikeSecret(s), 'credential assignment', s);
  }
  for (const s of ['The device token: Bearer <token>', 'token: Bearer $DEVICE_TOKEN', 'token: Bearer {{ secrets.DEVICE }}', 'token: Bearer [redacted]']) {
    assert.equal(looksLikeSecret(s), null, s);
  }
});

test('a password that starts with a symbol, or is a capitalised or dotted word, is still refused', () => {
  for (const s of ['password: $ecretP4ss!', 'password: %Tg8!kq2zz', 'password: <Xy9#kq2zz', 'password: [Xy9kq2zz', 'api_key: {{abc123def456',
    'password: Sunshine', 'password: Welcome', 'secret: correct.horse.battery.staple', 'password: $ecretp4ss']) {
    assert.equal(looksLikeSecret(s), 'credential assignment', s);
  }
  for (const s of ['token: <your-token>', 'token = ${DEPLOY_TOKEN}', 'password: %DB_PASSWORD%', 'secret: [REDACTED]', 'api_key: {{secrets.KEY}}',
    'secret: ${{ secrets.DEPLOY }}', 'token = config.auth.token;', 'secret = settings.sessionSecret']) {
    assert.equal(looksLikeSecret(s), null, s);
  }
});

test('a lowercase password at the end of a sentence, or a dotted one ending in ";", is still refused; prose words are not', () => {
  for (const s of ['password: correcthorse.', 'password: hunter.two;', 'secret = sunshinebeach!']) {
    assert.equal(looksLikeSecret(s), 'credential assignment', s);
  }
  for (const s of ['**Reused refresh token = disconnect.**', 'The old token: expired.', 'Its secret: rotated, then stored.', 'token = config.auth.token;']) {
    assert.equal(looksLikeSecret(s), null, s);
  }
});
