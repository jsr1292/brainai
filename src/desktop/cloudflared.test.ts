import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeCloudflared, type FakeCloudflaredState } from '../testing/fakeCloudflared.js';
import { cloudflaredState, deleteTunnel, prepareTunnel, startSignIn, stopLeftover, TunnelRunner, validHostname, type CloudflaredEnv } from './cloudflared.js';

function world(t: TestContext, state: FakeCloudflaredState | null) {
  const f = fakeCloudflared(state);
  const dir = mkdtempSync(join(tmpdir(), 'brainai-cf-data-'));
  t.after(() => { f.cleanup(); rmSync(dir, { recursive: true, force: true }); });
  const env: CloudflaredEnv = { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  return { f, env, dir };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 50) { if (check()) return; await sleep(50); }
  assert.fail('timed out waiting');
}

test('not installed, not signed in, signed in', async (t) => {
  assert.deepEqual(await cloudflaredState(world(t, null).env), { installed: false, signedIn: false });
  const { env, f } = world(t, {});
  assert.deepEqual(await cloudflaredState(env), { installed: true, signedIn: false });
  const run = startSignIn(env);
  assert.equal((await run.done).ok, true);
  assert.deepEqual(await cloudflaredState(env), { installed: true, signedIn: true });
  assert.ok(existsSync(join(f.home, '.cloudflared', 'cert.pem')));
});

test('sign in shows Cloudflare\'s page address and gives up after the limit', async (t) => {
  const { env } = world(t, { hang: true });
  // The limit must outlast the fake cloudflared's start-up on a busy machine (the whole suite runs in parallel), or the
  // run gives up before it prints the address.
  const run = startSignIn(env, 4000);
  await until(() => run.url() !== null, 8000);
  assert.match(run.url()!, /^https:\/\/dash\.cloudflare\.com\/argotunnel\?/);
  const r = await run.done;
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /did not finish/);
});

test('a tunnel is made once and reused; its credentials stay in the data folder with mode 600', async (t) => {
  const { env, f, dir } = world(t, {});
  assert.equal((await startSignIn(env).done).ok, true);
  const a = await prepareTunnel(env, dir, 'brain.example.net');
  assert.equal(a.ok, true);
  const { tunnelId, credentials } = a as { tunnelId: string; credentials: string };
  assert.ok(credentials.startsWith(join(dir, 'cloudflared')));
  assert.equal(statSync(credentials).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(credentials, 'utf8')).TunnelID, tunnelId);
  const b = await prepareTunnel(env, dir, 'brain.example.net');
  assert.deepEqual(b, a);
  assert.equal(f.state().created, 1, 'one tunnel');
  assert.equal(f.calls().filter((c) => c.includes('route dns')).length, 1, 'the same name is routed once');
  assert.ok(f.calls().some((c) => / create --credentials-file \S+ brainai-[0-9a-f]{6}$/.test(c)), f.calls().join('\n'));
});

test('a name Cloudflare already has, or a domain not on the account, is refused and nothing is overwritten', async (t) => {
  const taken = world(t, { recordExists: true });
  await startSignIn(taken.env).done;
  const r = await prepareTunnel(taken.env, taken.dir, 'brain.example.net');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /Cloudflare already has a record for brain\.example\.net/);
  const other = world(t, { otherZone: 'example.org' });
  await startSignIn(other.env).done;
  const o = await prepareTunnel(other.env, other.dir, 'brain.example.net');
  assert.equal(o.ok, false);
  assert.match((o as { reason: string }).reason, /brain\.example\.net is not a domain on the Cloudflare account you signed in with/);
  for (const c of [...taken.f.calls(), ...other.f.calls()]) assert.ok(!c.includes('overwrite'), c);
});

test('the tunnel runs to the given door, comes back after it dies, and stops for good on stop()', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50, 50, 50] });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => (f.state().running as { url?: string } | null)?.url === 'http://127.0.0.1:4123');
  assert.ok(f.calls().some((c) => c.endsWith(`--no-autoupdate run --credentials-file ${p.credentials} --url http://127.0.0.1:4123 ${p.tunnelId}`)), f.calls().join('\n'));
  const first = (f.state().running as { pid: number }).pid;
  assert.equal(readFileSync(join(dir, 'cloudflared', 'cloudflared.pid'), 'utf8').trim(), String(first));
  process.kill(first, 'SIGKILL');
  await until(() => { const r = f.state().running as { pid: number } | null; return !!r && r.pid !== first && alive(r.pid); });
  const second = (f.state().running as { pid: number }).pid;
  runner.stop();
  await until(() => !alive(second));
  await sleep(200);
  assert.equal(runner.running(), false, 'not started again after stop()');
  assert.ok(!existsSync(join(dir, 'cloudflared', 'cloudflared.pid')));
});

test('cloudflared dies with BrainAI even when BrainAI is killed hard (no exit handler runs)', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  // A stand-in for the server: a node process that starts the tunnel, then is killed with SIGKILL.
  const script = join(dir, 'host.mts');
  writeFileSync(script, `import { TunnelRunner } from ${JSON.stringify(new URL('./cloudflared.ts', import.meta.url).href)};
const r = new TunnelRunner({ home: ${JSON.stringify(env.home)}, path: ${JSON.stringify(env.path)} }, ${JSON.stringify(dir)});
r.start(${JSON.stringify(p.tunnelId)}, ${JSON.stringify(p.credentials)}, 4321);
setInterval(() => {}, 1000);
`);
  const host = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'ignore', cwd: process.cwd() });
  t.after(() => { try { host.kill('SIGKILL'); } catch { /* gone */ } });
  await until(() => (f.state().running as { url?: string } | null)?.url === 'http://127.0.0.1:4321', 15_000);
  const tunnel = (f.state().running as { pid: number }).pid;
  assert.ok(alive(tunnel));
  host.kill('SIGKILL');
  await until(() => !alive(tunnel), 5000);
});

test('stopping right after the start, again and again, never leaves a cloudflared behind', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const seen = new Set<number>();
  for (let i = 0; i < 25; i++) {
    const runner = new TunnelRunner(env, dir, { delays: [50] });
    runner.start(p.tunnelId, p.credentials, 4400 + i);
    if (i % 3 === 1) await sleep(i);
    runner.stop();
    await sleep(60);
    const r = f.state().running as { pid: number } | null;
    if (r) seen.add(r.pid);
  }
  await sleep(500);
  for (const pid of seen) assert.ok(!alive(pid), `cloudflared ${pid} is gone`);
  const r = f.state().running as { pid: number } | null;
  if (r) assert.ok(!alive(r.pid));
});

test('a leftover cloudflared from a crashed BrainAI is stopped; an unrelated process with that pid is not', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  // A tunnel started by an earlier BrainAI that never stopped it.
  const orphan = spawn(join(f.bin, 'cloudflared'), ['tunnel', '--no-autoupdate', 'run', '--credentials-file', p.credentials, '--url', 'http://127.0.0.1:4999', p.tunnelId], { env: { PATH: env.path, HOME: env.home }, stdio: 'ignore' });
  t.after(() => { try { orphan.kill('SIGKILL'); } catch { /* gone */ } });
  writeFileSync(join(dir, 'cloudflared', 'cloudflared.pid'), String(orphan.pid));
  await until(() => !!f.state().running);
  stopLeftover(dir);
  await until(() => !alive(orphan.pid!));
  // A pid file pointing at something else (the pid was reused): left alone.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { other.kill('SIGKILL'); });
  writeFileSync(join(dir, 'cloudflared', 'cloudflared.pid'), String(other.pid));
  stopLeftover(dir);
  await sleep(200);
  assert.ok(alive(other.pid!));
  assert.ok(!existsSync(join(dir, 'cloudflared', 'cloudflared.pid')));
});

test('only a plain host name is accepted', () => {
  for (const ok of ['brain.example.net', 'my-brain.sub.example.co.uk']) assert.ok(validHostname(ok), ok);
  for (const no of ['https://brain.example.net', 'example.net', 'a..b.net', 'brain.example.net:443', 'brain.example.net/x', 'Brain.Example.net', '-x.example.net', 'brain.example.net.', '']) assert.ok(!validHostname(no), no);
});

test("the owner's own cloudflared tunnels are never stopped, even if a stale pid file names one", async (t) => {
  const { env, f, dir } = world(t, {});
  const theirs = mkdtempSync(join(tmpdir(), 'owner-cf-'));
  t.after(() => rmSync(theirs, { recursive: true, force: true }));
  // The owner's own tunnel, with credentials outside BrainAI's data folder.
  const own = spawn(join(f.bin, 'cloudflared'), ['tunnel', '--no-autoupdate', 'run', '--credentials-file', join(theirs, 'home.json'), '--url', 'http://127.0.0.1:8080', 'their-tunnel'], { env: { PATH: env.path, HOME: env.home }, stdio: 'ignore' });
  t.after(() => { try { own.kill('SIGKILL'); } catch { /* gone */ } });
  await until(() => !!f.state().running);
  mkdirSync(join(dir, 'cloudflared'), { recursive: true });
  writeFileSync(join(dir, 'cloudflared', 'cloudflared.pid'), String(own.pid));
  stopLeftover(dir);
  await sleep(300);
  assert.ok(alive(own.pid!), 'still running');
});

test("the owner's own cloudflared settings (~/.cloudflared/config.yml) never reach BrainAI's tunnel", async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  writeFileSync(join(f.home, '.cloudflared', 'config.yml'), 'tunnel: their-tunnel\ningress:\n  - hostname: www.example.net\n    service: http://localhost:8080\n  - service: http_status:404\n');
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50] });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => (f.state().running as { url?: string } | null)?.url === 'http://127.0.0.1:4123');
  for (const c of f.calls().filter((x) => /create|route dns| run /.test(x))) assert.ok(c.includes(`--config ${join(dir, 'cloudflared', 'config.yml')}`), c);
});

test('deleteTunnel deletes the tunnel by its id and returns the DNS name without deleting it', async (t) => {
  const { env, f, dir } = world(t, {});
  assert.equal((await startSignIn(env).done).ok, true);
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string };
  const r = await deleteTunnel(env, dir);
  assert.deepEqual(r, { hostname: 'brain.example.net', deleted: true });
  assert.ok(f.calls().some((c) => c.endsWith(`delete -f ${p.tunnelId}`) && c.includes('--origincert')), f.calls().join('\n'));
  assert.ok(f.calls().every((c) => !/route dns .*delete|dns delete/.test(c)), 'the name is never deleted');
});

test('deleteTunnel says why when Cloudflare refuses, and when there is no tunnel or no cloudflared', async (t) => {
  const { env, f, dir } = world(t, {});
  assert.equal((await deleteTunnel(env, dir)).deleted, false, 'no tunnel saved');
  assert.equal((await startSignIn(env).done).ok, true);
  await prepareTunnel(env, dir, 'brain.example.net');
  f.setState({ deleteFails: true });
  const r = await deleteTunnel(env, dir);
  assert.equal(r.deleted, false);
  assert.equal(r.hostname, 'brain.example.net');
  assert.match(r.reason!, /active connections/);
  const none = world(t, null);
  const missing = await deleteTunnel({ ...none.env, path: none.env.path }, dir);
  assert.equal(missing.deleted, false);
  assert.match(missing.reason!, /Install cloudflared/);
});

test('after a long healthy run the next stop is retried quickly, not after the longest wait', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50, 8000], healthyMs: 400 });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => !!f.state().running);
  const first = (f.state().running as { pid: number }).pid;
  process.kill(first, 'SIGKILL'); // a quick failure: counted (the next wait would be 8 s)
  await until(() => { const r = f.state().running as { pid: number } | null; return !!r && r.pid !== first && alive(r.pid); });
  const second = (f.state().running as { pid: number }).pid;
  await sleep(600); // healthy for longer than healthyMs
  process.kill(second, 'SIGKILL');
  // The failures reset after the healthy run, so the wait is the short one.
  await until(() => { const r = f.state().running as { pid: number } | null; return !!r && r.pid !== second && alive(r.pid); }, 2500);
});

type Emitter = { pid?: number; emit(e: string, ...a: unknown[]): boolean };
const childOf = (r: TunnelRunner) => (r as unknown as { child: Emitter }).child;
const runningPid = (f: { state(): Record<string, unknown> }) => (f.state().running as { pid: number } | null)?.pid;

test('a spawn failure (an error with no pid and no exit) starts the tunnel again, and the late exit does not start a second one', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50] });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => !!runningPid(f));
  const first = runningPid(f)!;
  t.after(() => { try { process.kill(first, 'SIGKILL'); } catch { /* gone */ } });
  const child = childOf(runner);
  Object.defineProperty(child, 'pid', { value: undefined, configurable: true }); // as for a spawn that failed
  child.emit('error', new Error('spawn failed')); // no 'exit' follows
  await until(() => { const r = runningPid(f); return !!r && r !== first && alive(r); });
  const second = runningPid(f)!;
  child.emit('exit', 1, null); // a late exit from the first child
  await sleep(300);
  assert.equal(runningPid(f), second, 'no second restart from the late exit');
});

test('an error on a child that did start (it has a pid) is left to its exit: no second cloudflared', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50] });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => !!runningPid(f));
  const first = runningPid(f)!;
  childOf(runner).emit('error', new Error('could not signal'));
  await sleep(300);
  assert.equal(runningPid(f), first);
  assert.ok(runner.running());
});

test('a start that throws (the data folder is not usable) is retried after the next wait instead of crashing', async (t) => {
  const { env, f, dir } = world(t, {});
  await startSignIn(env).done;
  const p = await prepareTunnel(env, dir, 'brain.example.net') as { tunnelId: string; credentials: string };
  const runner = new TunnelRunner(env, dir, { delays: [50] });
  t.after(() => runner.stop());
  runner.start(p.tunnelId, p.credentials, 4123);
  await until(() => !!runningPid(f));
  const first = runningPid(f)!;
  const folderPath = join(dir, 'cloudflared');
  const saved = join(dir, 'cloudflared-saved');
  renameSync(folderPath, saved);
  writeFileSync(folderPath, 'in the way'); // mkdirSync now throws
  process.kill(first, 'SIGKILL');
  await sleep(300); // several tries have thrown
  rmSync(folderPath);
  renameSync(saved, folderPath);
  await until(() => { const r = runningPid(f); return !!r && r !== first && alive(r); });
});
