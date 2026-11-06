/** The Mac reporter's installer (open source O1): it needs its brain's address, checks it, and keeps it for launchd. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp } from '../testing/helpers.js';

const INSTALLER = join(import.meta.dirname, '../../scripts/mac/install-folder-report.sh');

function home(t: TestContext) {
  const h = mkdtempSync(join(tmpdir(), 'brain-home-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  mkdirSync(join(h, 'Projects'));
  const bin = join(h, 'bin');
  mkdirSync(bin);
  // launchctl is stubbed: it records its calls.
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${join(h, 'launchctl.log')}"\n`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  // Not spawnSync: the test brain answering the installer lives in this same process.
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [INSTALLER, ...args], { env: { ...process.env, HOME: h, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { h, run, plist: join(h, 'Library', 'LaunchAgents', 'org.brain.folder-report.plist'), log: () => (existsSync(join(h, 'launchctl.log')) ? readFileSync(join(h, 'launchctl.log'), 'utf8') : '') };
}

test('the installer needs --url, refuses an address that is not a brain, and writes nothing then', async (t) => {
  const { run, plist } = home(t);
  const token = 'brain_dev_' + 'a'.repeat(43);
  assert.notEqual((await run([token])).status, 0, 'no --url');
  const bare = await run(['--url']);
  assert.equal(bare.status, 64);
  assert.match(bare.stderr, /Give your brain's address/);
  const r = await run(['--url', 'https://example.invalid', token]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /doesn't answer like a brain/);
  assert.equal(existsSync(plist), false);
  assert.notEqual((await run(['--url', 'http://memory.example.com', token])).status, 0, 'http only for localhost');
});

test('the installer keeps the address in the launchd job, replaces the old job, and reuses the stored token when none is given', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { token } = app.deps.devices.create('Mac');
  const { h, run, plist, log } = home(t);
  const old = join(h, 'Library', 'LaunchAgents', 'com.example.brain-folder-report.plist');
  mkdirSync(join(h, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(old, '<plist/>');
  const r = await run(['--url', app.baseUrl, token]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const p = readFileSync(plist, 'utf8');
  assert.match(p, /<key>Label<\/key><string>org\.brain\.folder-report<\/string>/);
  assert.match(p, new RegExp(`<key>BRAIN_URL</key><string>${app.baseUrl.replace(/[.:/]/g, (c) => `\\${c}`)}</string>`));
  assert.equal(existsSync(old), false, 'the old job is gone');
  assert.match(log(), /bootout gui\/\d+\/com\.example\.brain-folder-report/);
  assert.ok(app.deps.devices.latestReport(), 'the first report reached the brain');
  const again = await run(['--url', app.baseUrl]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(h, '.config', 'brain', 'device-token'), 'utf8').trim(), token);
});
