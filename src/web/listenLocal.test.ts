import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLocal } from './listenLocal.js';

const ok = (_req: unknown, res: { end(s: string): void }) => res.end('brainai');
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test('local mode holds both loopback addresses, so another account cannot take the IPv6 one', async (t) => {
  const servers = await listenLocal(ok as never, 0);
  t.after(() => Promise.all(servers.map(close)));
  const port = (servers[0]!.address() as AddressInfo).port;
  const hosts = servers.map((s) => (s.address() as AddressInfo).address).sort();
  assert.ok(hosts.includes('127.0.0.1'));
  // ::1 when this machine has IPv6 loopback (almost every one does); either way nobody else can serve it.
  const squatter = createServer(ok as never);
  const err = await new Promise<NodeJS.ErrnoException | null>((r) => { squatter.once('error', r); squatter.listen(port, '::1', () => r(null)); });
  if (err === null) { await close(squatter); assert.fail('::1 was free for someone else'); }
  assert.ok(['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code ?? ''), err.code);
});

test('if someone already holds the IPv6 address, local mode refuses to start', async (t) => {
  const squatter = createServer(ok as never);
  const err = await new Promise<NodeJS.ErrnoException | null>((r) => { squatter.once('error', r); squatter.listen(0, '::1', () => r(null)); });
  if (err) return t.skip('no IPv6 loopback here');
  t.after(() => close(squatter));
  const port = (squatter.address() as AddressInfo).port;
  await assert.rejects(listenLocal(ok as never, port), /::1:\d+ is already in use/);
});
