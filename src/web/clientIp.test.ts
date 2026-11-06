import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipKey } from './clientIp.js';

test('ipKey keeps IPv4 as is and keys IPv6 by its /64 prefix', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0DB8:0001:0002:ffff:0:0:1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('2001:db8:1:2::'), '2001:db8:1:2::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
});

test('ipKey treats IPv4-mapped IPv6 as the IPv4 address', () => {
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::FFFF:cb00:7107'), '203.0.113.7');
  assert.equal(ipKey('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7');
});

test('ipKey passes anything that is not an IP address through', () => {
  assert.equal(ipKey('unknown'), 'unknown');
});
