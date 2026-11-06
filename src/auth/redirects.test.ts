import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { RedirectAllowlist } from './redirects.js';
import { COMMANDS } from '../cli.js';
import { OwnerAuth } from './owner.js';

test('seeded entries: Claude callbacks and loopback', () => {
  const a = new RedirectAllowlist(openDb(':memory:'));
  assert.ok(a.isAllowed('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(a.isAllowed('https://claude.ai/api/mcp/auth_callback?x=1'));
  assert.ok(a.isAllowed('http://localhost:49152/callback'));
  assert.ok(a.isAllowed('http://127.0.0.1:3000/'));
  // The consent page's CSP form-action can't name an IPv6 literal, so the browser would block the redirect to it.
  assert.ok(!a.isAllowed('http://[::1]:8080/cb'));
  assert.ok(!a.isAllowed('https://claude.ai/evil'));
  assert.ok(!a.isAllowed('https://evil.example/api/mcp/auth_callback'));
  assert.ok(!a.isAllowed('http://claude.ai/api/mcp/auth_callback'));
  assert.ok(!a.isAllowed('http://localhost.evil.com/cb'));
  assert.ok(!a.isAllowed('http://127.0.0.1.evil.com/cb'));
  assert.ok(!a.isAllowed('https://claude.ai@evil.example/api/mcp/auth_callback'));
  assert.ok(!a.isAllowed('javascript:alert(1)'));
  assert.ok(!a.isAllowed('not a url'));
  assert.ok(!a.isAllowed(''));
});

test('add/remove validate entries', () => {
  const a = new RedirectAllowlist(openDb(':memory:'));
  assert.ok(!a.isAllowed('https://grok.com/cb'));
  a.add('https://grok.com/cb');
  assert.ok(a.isAllowed('https://grok.com/cb'));
  assert.ok(a.originAllowed('https://grok.com'));
  assert.ok(!a.originAllowed('https://evil.example'));
  assert.throws(() => a.add('http://x.com'));
  assert.throws(() => a.add('https://x.com/cb#f'));
  assert.throws(() => a.add('https://x.com/cb?q=1'));
  assert.throws(() => a.add('garbage'));
  a.remove('https://grok.com/cb');
  assert.ok(!a.isAllowed('https://grok.com/cb'));
  assert.ok(!a.list().includes('https://grok.com/cb'));
});

test('cli redirects list/add/remove', async () => {
  const db = openDb(':memory:');
  const ctx = (args: string[]) => ({ db, owner: new OwnerAuth(db, () => new Date()), args });
  await COMMANDS.redirects(ctx(['add', 'https://grok.com/cb']));
  assert.ok(new RedirectAllowlist(db).isAllowed('https://grok.com/cb'));
  await COMMANDS.redirects(ctx(['list']));
  await COMMANDS.redirects(ctx(['remove', 'https://grok.com/cb']));
  assert.ok(!new RedirectAllowlist(db).isAllowed('https://grok.com/cb'));
  await assert.rejects(COMMANDS.redirects(ctx(['add'])));
});
