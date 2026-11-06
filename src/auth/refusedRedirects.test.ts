import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowableUri, RefusedRedirects } from './refusedRedirects.js';

test('the refused list keeps at most 10 addresses for a day, newest first, and never one already allowed', () => {
  let t = Date.parse('2026-11-06T10:00:00Z');
  const r = new RefusedRedirects(() => new Date(t));
  const allowed = new Set(['https://claude.ai/api/mcp/auth_callback']);
  r.record('ChatGPT', ['https://chatgpt.com/connector/oauth/a', 'https://claude.ai/api/mcp/auth_callback', 'http://x.example/cb', 'https://x.example/cb?q=1', 42], (u) => allowed.has(u));
  assert.deepEqual(r.list().map((x) => [x.clientName, x.uri]), [['ChatGPT', 'https://chatgpt.com/connector/oauth/a']]);
  for (let i = 0; i < 12; i++) { t += 1000; r.record(i % 2 ? '' : '  Grok  ', [`https://grok.example/cb${i}`], () => false); }
  const list = r.list();
  assert.equal(list.length, 10);
  assert.equal(list[0]!.uri, 'https://grok.example/cb11');
  assert.equal(list[0]!.clientName, 'An app');
  assert.equal(list[1]!.clientName, 'Grok');
  t += 25 * 3_600_000;
  assert.deepEqual(r.list(), []);
  r.record('x'.repeat(500), ['https://a.example/cb'], () => false);
  assert.equal(r.list()[0]!.clientName.length, 100);
  assert.equal(r.has('https://a.example/cb'), true);
  r.forget('https://a.example/cb');
  assert.equal(r.has('https://a.example/cb'), false);
});

test('allowableUri keeps origin and path of a plain https address, and refuses anything else', () => {
  assert.equal(allowableUri('https://chatgpt.com/connector/oauth/a'), 'https://chatgpt.com/connector/oauth/a');
  for (const bad of ['http://a.example/cb', 'https://a.example/cb?x=1', 'https://a.example/cb#f', 'https://u:p@a.example/', 'nope', 7]) assert.equal(allowableUri(bad), undefined, String(bad));
});

test('an app name loses control and direction characters, so it cannot reverse how the address reads', () => {
  const r = new RefusedRedirects(() => new Date('2026-11-06T10:00:00Z'));
  r.record('Chat‮GPT\u0000​', ['https://a.example/cb'], () => false);
  assert.equal(r.list()[0]!.clientName, 'ChatGPT');
});

test('addresses on this machine or the home network are never offered: allowing one would let anyone make the server fetch it', () => {
  for (const internal of ['https://192.168.1.10/cb', 'https://10.0.0.5/cb', 'https://[::1]/cb', 'https://localhost:8443/cb', 'https://nas/cb', 'https://printer.local/cb', 'https://router.lan/cb', 'https://box.internal/cb', 'https://h.home.arpa/cb']) {
    assert.equal(allowableUri(internal), undefined, internal);
  }
  assert.equal(allowableUri('https://chatgpt.com/connector/oauth/a'), 'https://chatgpt.com/connector/oauth/a');
});
