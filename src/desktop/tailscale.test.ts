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
  assert.deepEqual(await tailscaleState(world(t, null).env), { installed: false, running: false, host: null });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'Stopped' }).env), { installed: true, running: false, host: null });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'NeedsLogin' }).env), { installed: true, running: false, host: null });
  assert.deepEqual(await tailscaleState(world(t, { backend: 'Running', dns: 'brainai-mac.tail1234.ts.net.' }).env), { installed: true, running: true, host: 'brainai-mac.tail1234.ts.net' });
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
  const missing = await funnelOn(world(t, null).env, 3100);
  assert.match((missing as { reason: string }).reason, /Install Tailscale/);
  const hung = await funnelOn(world(t, { hang: true }, 500).env, 3100);
  assert.equal(hung.ok, false);
  assert.match((hung as { reason: string }).reason, /did not answer/);
});

test('a warning from Tailscale on stderr does not make it look signed out', async (t) => {
  const { env } = world(t, { backend: 'Running', warn: true });
  assert.deepEqual(await tailscaleState(env), { installed: true, running: true, host: 'brainai-mac.tail1234.ts.net' });
  assert.equal((await funnelOn(env, 3100)).ok, true);
});

test('a funnel command that fails or hangs after it ran is undone, so Tailscale is not left sharing', async (t) => {
  const failed = world(t, { backend: 'Running', funnelFails: true });
  assert.equal((await funnelOn(failed.env, 3100)).ok, false);
  assert.ok(failed.f.calls().includes('funnel --https=443 off'));
  assert.equal(failed.f.state().funnel, false);
  const hung = world(t, { backend: 'Running', hangFunnel: true }, 500);
  assert.equal((await funnelOn(hung.env, 3100)).ok, false);
  assert.ok(hung.f.calls().includes('funnel --https=443 off'));
  assert.equal(hung.f.state().funnel, false);
});

test('a Tailscale link in a successful answer is not read as "approval needed"', async (t) => {
  const { env } = world(t, { backend: 'Running', linkOnSuccess: true });
  assert.deepEqual(await funnelOn(env, 3100), { ok: true, url: 'https://brainai-mac.tail1234.ts.net' });
});
