import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpAt } from './totp.js';

// RFC 6238 SHA-1 vectors (secret "12345678901234567890"), last 6 digits
test('totpAt matches RFC 6238 vectors', () => {
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(s, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(s, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpAt(s, Math.floor(1234567890 / 30)), '005924');
  assert.equal(totpAt(s, Math.floor(2000000000 / 30)), '279037');
  assert.deepEqual(base32Decode(base32Encode(Buffer.from('hello'))), Buffer.from('hello'));
});

test('generateTotpSecret is 20 random bytes in base32; otpauthUri has issuer and label', () => {
  const a = generateTotpSecret();
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, generateTotpSecret());
  const uri = otpauthUri(a, 'owner');
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${a}`));
  assert.ok(uri.startsWith('otpauth://totp/Cairn:owner?'), uri);
  assert.ok(uri.includes('&issuer=Cairn&'), uri);
  assert.ok(otpauthUri(a, 'owner', 'Work memory').includes('&issuer=Work%20memory&'));
});
