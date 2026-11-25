import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fakeTailscale, type FakeTailscaleState } from '../testing/fakeTailscale.js';
import { funnelOff, funnelOn, tailscaleState, type TailscaleEnv } from './tailscale.js';

function world(t: TestContext, state: FakeTailscaleState | null, timeoutMs?: number) {
  const f = fakeTailscale(state);
  t.after(() => f.cleanup());
  const env: TailscaleEnv = { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, appPath: '/nonexistent/Tailscale', timeoutMs };
  return { f, env };
}

test('Tailscale missing, stopped or signed out says what to do; running gives the Mac\'s public name', async (t) => {
  assert.deepEqual(await tailscaleState(world(t, null).env), { installed: false, running: false, host: null, timedOut: false });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'Stopped' }).env), { installed: true, running: false, host: null, timedOut: false });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'NeedsLogin' }).env), { installed: true, running: false, host: null, timedOut: false });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'Running', dns: 'brainai-mac.tail1234.ts.net.' }).env), { installed: true, running: true, host: 'brainai-mac.tail1234.ts.net', timedOut: false });
});

test('Funnel on shares this loopback port on 443 and gives back the public address; off stops it', async (t) => {
  const { f, env } = world(t, { backend: 'Running' });
  const on = await funnelOn(env, 3100);
  assert.deepEqual(on, { ok: true, url: 'https://brainai-mac.tail1234.ts.net' });
  assert.ok(f.calls().includes('funnel --bg --https=443 --yes http://127.0.0.1:3100'));
  assert.equal((await funnelOff(env)).ok, true);
  assert.ok(f.calls().includes('funnel --https=443 off'));
  assert.equal(f.state().funnel, false);
});

test('Funnel not yet allowed, Tailscale signed out, or the command hanging: a clear message and nothing on', async (t) => {
  const approval = await funnelOn(world(t, { backend: 'Running', needsApproval: true }).env, 3100);
  assert.equal(approval.ok, false);
  assert.match((approval as { reason: string }).reason, /https:\/\/login\.tailscale\.com\/f\/funnel\?node=abc123/);
  const out = await funnelOn(world(t, { backend: 'NeedsLogin' }).env, 3100);
  assert.match((out as { reason: string }).reason, /sign in/i);
  assert.equal((approval as { refused?: boolean }).refused, true, 'Funnel not allowed is a definite refusal');
  assert.equal((out as { refused?: boolean }).refused, undefined, 'signed out may pass');
  const missing = await funnelOn(world(t, null).env, 3100);
  assert.match((missing as { reason: string }).reason, /Install Tailscale/);
  assert.equal((missing as { refused?: boolean }).refused, true, 'not installed is a definite refusal');
  const hung = await funnelOn(world(t, { hang: true }, 500).env, 3100);
  assert.equal(hung.ok, false);
  assert.match((hung as { reason: string }).reason, /did not answer/);
});

test('a warning from Tailscale on stderr does not make it look signed out', async (t) => {
  const { env } = world(t, { backend: 'Running', warn: true });
  assert.deepEqual(await tailscaleState(env), { installed: true, running: true, host: 'brainai-mac.tail1234.ts.net', timedOut: false });
  assert.equal((await funnelOn(env, 3100)).ok, true);
});

test('a funnel command that fails or hangs after it ran is undone, so Tailscale is not left sharing', async (t) => {
  const failed = world(t, { backend: 'Running', funnelFails: true });
  assert.equal((await funnelOn(failed.env, 3100)).ok, false);
  assert.ok(failed.f.calls().includes('funnel --https=443 off'));
  assert.equal(failed.f.state().funnel, false);
  const hung = world(t, { backend: 'Running', hangFunnel: true }, 3000);
  assert.equal((await funnelOn(hung.env, 3100)).ok, false);
  assert.ok(hung.f.calls().includes('funnel --https=443 off'));
  assert.equal(hung.f.state().funnel, false);
});

test('a Tailscale link in a successful answer is not read as "approval needed"', async (t) => {
  const { env } = world(t, { backend: 'Running', linkOnSuccess: true });
  assert.deepEqual(await funnelOn(env, 3100), { ok: true, url: 'https://brainai-mac.tail1234.ts.net' });
});

test('the status check the page shows has its own short limit, while Turn on keeps the long one', async (t) => {
  const { env } = world(t, { hang: true }, 30_000);
  const t0 = Date.now();
  assert.deepEqual(await tailscaleState({ ...env, statusTimeoutMs: 300 }), { installed: true, running: false, host: null, timedOut: true });
  assert.ok(Date.now() - t0 < 5000, 'gave up at the short limit, not the 30 s one');
  // Turn on (funnelOn) asks status with timeoutMs, not statusTimeoutMs.
  const on = world(t, { hang: true }, 700);
  const r = await funnelOn({ ...on.env, statusTimeoutMs: 100 }, 3100);
  assert.equal(r.ok, false);
  assert.ok(on.f.calls().length >= 1);
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { funnelPointsAt } from './tailscale.js';

/** A `tailscale` that answers `serve status --json` with exactly this text and exit code. */
function serving(t: TestContext, out: string, code = 0): TailscaleEnv {
  const root = mkdtempSync(join(tmpdir(), 'brainai-ts-serve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'out.txt'), out);
  writeFileSync(join(root, 'bin', 'tailscale'), `#!/bin/sh\ncat "${join(root, 'out.txt')}"\nexit ${code}\n`);
  chmodSync(join(root, 'bin', 'tailscale'), 0o755);
  return { home: root, path: `${join(root, 'bin')}:/usr/bin:/bin`, appPath: '/nonexistent/Tailscale' };
}
const shape = (handlers: Record<string, { Proxy: string }>, host = 'mac.tail1234.ts.net:443') =>
  JSON.stringify({ TCP: { [host.split(':')[1]!]: { HTTPS: true } }, Web: { [host]: { Handlers: handlers } }, AllowFunnel: { [host]: true } });

test('funnelPointsAt says "ours" only when 443 has the single path "/" going to this loopback port', async (t) => {
  const at = async (out: string, code = 0, port = 3100) => (await funnelPointsAt(serving(t, out, code), port)).at;
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:3100' } })), 'ours', 'the real shape, with AllowFunnel');
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:3100/' } })), 'ours', 'trailing slash');
  assert.equal(await at(shape({ '/': { Proxy: 'http://localhost:3100' } })), 'ours', 'localhost');
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:3101' } })), 'other', 'another port');
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:31000' } })), 'other', 'a port that starts with ours');
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:3100' }, '/photos': { Proxy: 'http://127.0.0.1:9000' } })), 'other', "the owner's other paths would go too");
  assert.equal(await at(shape({ '/': { Proxy: 'http://127.0.0.1:3100' } }, 'mac.tail1234.ts.net:8443')), 'none', 'only :8443');
  assert.equal(await at('{}'), 'none');
  assert.equal(await at(''), 'none');
  assert.equal(await at('null'), 'none', 'older versions print null');
  assert.equal(await at('[1]'), 'none');
  assert.equal(await at('this is not json'), 'unknown');
  assert.equal(await at('', 1), 'unknown', 'a non-zero exit');
});
