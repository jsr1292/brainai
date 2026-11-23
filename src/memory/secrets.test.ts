import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecret } from './secrets.js';
import { fakeAnthropicKey, fakeAwsKey, fakeGithubToken, fakePrivateKeyHeader, fakeJwt } from '../testing/fakeSecrets.js';

test('detects common secrets and ignores normal text', () => {
  for (const s of [fakePrivateKeyHeader('OPENSSH'), 'key ' + fakeAnthropicKey('api03-abcdefghijklmnopqrstuvwxyz012345'),
    fakeGithubToken('abcdefghijklmnopqrstuvwxyz0123456789'), fakeAwsKey('ABCDEFGHIJKLMNOP'), 'password: hunter2hunter2',
    'contraseña = Sup3rS3creta!', 'TUNNEL_TOKEN=' + fakeJwt()]) {
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
  assert.equal(looksLikeKey(fakePrivateKeyHeader('RSA')), 'private key');
  assert.equal(looksLikeKey('key ' + fakeAnthropicKey('api03-abcdefghijklmnopqrstuvwxyz012345')), 'API key');
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
  const key = findSecret('one\ntwo ' + fakeGithubToken('abcdefghijklmnopqrstuvwxyz0123456789AB'));
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

test('a labelled bare key is refused; ids, hashes, commits and UUIDs are not', () => {
  for (const s of [
    'Weather service API key is 7f3a9c2e41b84d06a5e1c9f27d3b6a80',
    'Here is the token: Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    'clave de la API: 9f86d081884c7d659a2feaa0c55ad015',
    'contraseña = Xk29QmLp0Vb7Tn3Rw8Yc5Hd1Jf4Gs6A',
    'secret 0123456789abcdef0123456789abcdef0123456789abcdef',
    'The webhook secret is "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY"',
  ]) assert.ok(looksLikeSecret(s), s);
  assert.equal(looksLikeSecret('Weather service API key is 7f3a9c2e41b84d06a5e1c9f27d3b6a80'), 'labelled key');
  for (const s of [
    'Decision recorded in fact 7f3a9c2e41b84d06a5e1c9f27d3b6a80 about the key rotation.',
    'The key commit is 3b18e512ba79d4c8e1c9f27d3b6a80f1c2d3e4f5, merged on Monday.',
    'primary key id: 550e8400-e29b-41d4-a716-446655440000',
    'Refers to [[fact:7f3a9c2e41b84d06a5e1c9f27d3b6a80]] for the token design.',
    'Token hash stored: 9f86d081884c7d659a2feaa0c55ad015',
    'The key is garden-sensor-calibration-notes-2026',
    'Token expiry is 24 hours; the secret lives in the keychain.',
    'Clave del wifi guardada en el router.',
    'key: https://example.com/docs/7f3a9c2e41b84d06a5e1c9f27d3b6a80',
    'Session key rotation runs nightly at 03:00 on the mini PC.',
    'Page 2026-11-23-keyrotationnotesabcdef is the write-up.',
  ]) assert.equal(looksLikeSecret(s), null, s);
});

test('labelled key: public keys, fingerprints and git SHAs in sentences are fine; snake_case labels are caught', () => {
  const sha = '9fceb02d7a1c4e8b53f06a2d91c7e4b83a5d0f16';
  for (const s of [
    `Fixed the token refresh bug in ${sha}`,
    `The key change is in ${sha}`,
    'Deploy key (public): ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'minisign public key: RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
    `GPG key fingerprint: ${sha}`,
    'ssh public key AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDhA9eXz0f1',
  ]) assert.equal(looksLikeSecret(s), null, s);
  for (const s of [
    'client_secret is Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    'access_token 7f3a9c2e41b84d06a5e1c9f27d3b6a80',
    'OPENAI_API_KEY 9f86d081884c7d659a2feaa0c55ad015',
    'The api key: "7f3a9c2e41b84d06a5e1c9f27d3b6a80"',
  ]) assert.ok(looksLikeSecret(s), s);
});

test('labelled key: secrets near public-key words are still refused; qualifiers and JSON are understood', () => {
  const hex = '7f3a9c2e41b84d06a5e1c9f27d3b6a80';
  for (const s of [
    'GPG passphrase is Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    'GPG key passphrase: Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    'minisign secret key password is Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    'Supabase public anon key fine, service key is Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga',
    `API key (weather service): ${hex}`,
    `clave API del tiempo: ${hex}`,
    '{"password": "Zk3Qp9Lm2Xv8Rt5Wy1Nb7Hc4Jd6Fs0Ga"}',
  ]) assert.ok(looksLikeSecret(s), s);
});
