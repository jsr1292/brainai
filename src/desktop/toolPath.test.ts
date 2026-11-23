import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeWindowsPath, expandVars, forgetToolPath, parseReg, pathFromReg, refreshToolPath, toolPathFor } from './toolPath.js';
import { findCommand, type ToolEnv } from './tools.js';

test('Windows: the session PATH first, then npm, .local\\bin and WinGet, like the app\'s TOOL_PATH', () => {
  assert.equal(
    toolPathFor({ platform: 'win32', path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', home: 'C:\\Users\\Ana', appData: 'C:\\Users\\Ana\\AppData\\Roaming', localAppData: 'C:\\Users\\Ana\\AppData\\Local' }),
    'C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\Ana\\AppData\\Roaming\\npm;C:\\Users\\Ana\\.local\\bin;C:\\Users\\Ana\\AppData\\Local\\Microsoft\\WinGet\\Links',
  );
  assert.equal(toolPathFor({ platform: 'win32', path: undefined, home: 'C:\\U', appData: 'C:\\R', localAppData: 'C:\\L' }), 'C:\\R\\npm;C:\\U\\.local\\bin;C:\\L\\Microsoft\\WinGet\\Links');
  assert.equal(toolPathFor({ platform: 'win32', path: ';C:\\A;', home: 'C:\\U' }), 'C:\\A;C:\\U\\.local\\bin', 'unset variables are skipped');
});

test('elsewhere: ~/.local/bin is added to a colon list', () => {
  assert.equal(toolPathFor({ platform: 'darwin', path: '/usr/bin:/bin', home: '/Users/ana' }), '/usr/bin:/bin:/Users/ana/.local/bin');
});

test('Windows: the Node folder follows the others when ProgramFiles is known', () => {
  assert.equal(toolPathFor({ platform: 'win32', path: 'C:\\A', home: 'C:\\U', programFiles: 'C:\\Program Files' }), 'C:\\A;C:\\U\\.local\\bin;C:\\Program Files\\nodejs');
});

test('registry output: every string value is read, Path and the variables a Path names', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %NVM_HOME%;%USERPROFILE%\\bin\r\n    NVM_HOME    REG_SZ    C:\\nvm\r\n    Count    REG_DWORD    0x1\r\n';
  assert.deepEqual(parseReg(out), { Path: '%NVM_HOME%;%USERPROFILE%\\bin', NVM_HOME: 'C:\\nvm' });
  assert.equal(pathFromReg(out), '%NVM_HOME%;%USERPROFILE%\\bin');
  assert.equal(pathFromReg('    Other    REG_SZ    x'), null);
  assert.equal(expandVars('%userprofile%\\bin;%NOPE%', { USERPROFILE: 'C:\\U' }), 'C:\\U\\bin;%NOPE%');
  assert.equal(expandVars('%A%', { A: '%B%', B: 'x' }), 'x', 'a variable may name another');
});

test('Windows PATH: registry values are expanded (also their own variables), merged with the run\'s PATH and the usual folders, without duplicates', () => {
  const p = composeWindowsPath({ system: 'C:\\Windows\\System32;C:\\Program Files\\nodejs\\', user: '%NVM_HOME%;%USERPROFILE%\\AppData\\Roaming\\npm', current: 'c:\\program files\\nodejs;D:\\mine', vars: { NVM_HOME: 'C:\\nvm', USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\AppData\\Roaming', LOCALAPPDATA: 'C:\\U\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, home: 'C:\\U' });
  assert.deepEqual(p.split(';'), ['C:\\Windows\\System32', 'C:\\Program Files\\nodejs\\', 'C:\\nvm', 'C:\\U\\AppData\\Roaming\\npm', 'D:\\mine', 'C:\\U\\.local\\bin', 'C:\\U\\AppData\\Local\\Microsoft\\WinGet\\Links']);
  // Unset variables are skipped, as in toolPathFor: nothing is guessed.
  assert.equal(composeWindowsPath({ system: null, user: 'C:\\A', current: '', vars: {}, home: 'C:\\U' }), 'C:\\A;C:\\U\\.local\\bin');
});

test('Windows PATH: a tool installed after BrainAI started is found once the Path is read again; reads are cached and shared', async (t) => {
  forgetToolPath();
  t.after(() => forgetToolPath());
  const root = mkdtempSync(join(tmpdir(), 'brainai-wpath-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: ToolEnv = { home: root, mcpUrl: 'http://localhost:3100/mcp', path: 'C:\\Windows', rules: () => '', platform: 'win32', system: { PATHEXT: '.CMD' } };
  const later = join(root, 'later');
  mkdirSync(later);
  writeFileSync(join(later, 'claude.cmd'), '');
  assert.equal(findCommand('claude', env), null, 'not on the PATH it started with');
  let now = 1000;
  let reads = 0;
  const read = async () => { reads++; return { system: null, user: later }; };
  await Promise.all([refreshToolPath(env, read, () => now), refreshToolPath({ ...env }, read, () => now)]);
  assert.equal(reads, 1, 'simultaneous callers share one read');
  assert.ok(findCommand('claude', env), 'found after the registry now lists the folder');
  // Within 5 s nothing is read again, even if the registry changed.
  now += 1000;
  const env2: ToolEnv = { ...env, path: 'C:\\Windows' };
  await refreshToolPath(env2, async () => { reads++; return { system: null, user: 'C:\\other' }; }, () => now);
  assert.equal(reads, 1, 'kept for 5 s');
  assert.ok(findCommand('claude', env2), 'the kept Path is applied');
  // After 5 s a failed read keeps what there was, and is itself kept (not retried at once).
  now += 10_000;
  await refreshToolPath(env2, async () => { reads++; throw new Error('no registry'); }, () => now);
  assert.equal(reads, 2);
  await refreshToolPath(env2, async () => { reads++; return { system: null, user: null }; }, () => now + 100);
  assert.equal(reads, 2, 'a failed read is cached too');
  assert.ok(findCommand('claude', env2));
  const mac: ToolEnv = { ...env, platform: 'darwin', path: '/usr/bin' };
  await refreshToolPath(mac, async () => { throw new Error('must not be called'); });
  assert.equal(mac.path, '/usr/bin');
});

test('Windows PATH: composed from the PATH the run started with, so a folder removed from the registry drops out', async (t) => {
  forgetToolPath();
  t.after(() => forgetToolPath());
  const env: ToolEnv = { home: 'C:\\U', mcpUrl: 'http://localhost:3100/mcp', path: 'C:\\Windows', rules: () => '', platform: 'win32', system: {} };
  let now = 1000;
  await refreshToolPath(env, async () => ({ system: null, user: 'C:\\gone' }), () => now);
  assert.match(env.path, /C:\\gone/);
  now += 10_000;
  await refreshToolPath(env, async () => ({ system: null, user: 'C:\\new' }), () => now);
  assert.match(env.path, /C:\\new/);
  assert.doesNotMatch(env.path, /C:\\gone/, 'no longer in the registry, no longer on the PATH');
  assert.match(env.path, /^C:\\new;C:\\Windows/);
});
