import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeFolderReport, removeHooks } from './leftovers.js';

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  mkdirSync(join(h, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(h, '.claude', 'hooks', 'memory-start.mjs'), '// start');
  writeFileSync(join(h, '.claude', 'hooks', 'memory-save.mjs'), '// save');
  writeFileSync(join(h, '.claude', 'hooks', 'larder-lint.mjs'), '// other');
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({
    theme: 'dark',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-start.mjs' }] }, { hooks: [{ type: 'command', command: 'node ~/.claude/hooks/larder-lint.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-save.mjs' }, { type: 'command', command: 'echo wildlog' }] }],
    },
  }, null, 2));
  return h;
}

test('removeHooks keeps other hooks in settings.json', () => {
  const h = home();
  const r = removeHooks({ home: h }, false);
  assert.equal(r.kept, null);
  assert.equal(existsSync(join(h, '.claude', 'hooks', 'memory-start.mjs')), false);
  assert.equal(existsSync(join(h, '.claude', 'hooks', 'memory-save.mjs')), false);
  assert.ok(existsSync(join(h, '.claude', 'hooks', 'larder-lint.mjs')));
  const s = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.hooks, {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/hooks/larder-lint.mjs' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo wildlog' }] }],
  });
});

test('removeHooks drops an emptied hooks key and leaves a settings file that has none of ours untouched', () => {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  const plain = '{"theme":"dark"}';
  writeFileSync(join(h, '.claude', 'settings.json'), plain);
  assert.deepEqual(removeHooks({ home: h }, false), { removed: [], kept: null });
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), plain, 'not rewritten');
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ command: 'node ~/.claude/hooks/memory-save.mjs' }] }] } }));
  removeHooks({ home: h }, false);
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')), { theme: 'dark' });
});

test('removeHooks keeps everything while another brain is connected', () => {
  const h = home();
  const before = readFileSync(join(h, '.claude', 'settings.json'), 'utf8');
  const r = removeHooks({ home: h }, true);
  assert.deepEqual(r.removed, []);
  assert.match(r.kept!, /couldn't confirm no other brain uses them/);
  assert.ok(existsSync(join(h, '.claude', 'hooks', 'memory-start.mjs')));
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), before);
});

function reporter(url: string) {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  mkdirSync(join(h, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(h, '.config', 'brain'), { recursive: true });
  writeFileSync(join(h, 'Library', 'LaunchAgents', 'org.brain.folder-report.plist'), `<plist><dict><key>EnvironmentVariables</key><dict>\n<key>BRAIN_URL</key><string>${url}</string>\n</dict></dict></plist>`);
  writeFileSync(join(h, '.config', 'brain', 'device-token'), 'brain_dev_x');
  return h;
}

test('removeFolderReport removes a report that points at this app and stops its job', () => {
  const h = reporter('http://localhost:3100');
  const calls: string[][] = [];
  const r = removeFolderReport({ home: h, platform: 'darwin' }, ['http://localhost:3100'], (a) => { calls.push(a); });
  assert.deepEqual(r, { removed: true, kept: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.join(' '), /^bootout gui\/\d+\/org\.brain\.folder-report$/);
  assert.equal(existsSync(join(h, 'Library', 'LaunchAgents', 'org.brain.folder-report.plist')), false);
  assert.equal(existsSync(join(h, '.config', 'brain', 'device-token')), false);
});

test('removeFolderReport leaves a report pointing at another brain', () => {
  const h = reporter('https://brain.example.com');
  const calls: string[][] = [];
  const r = removeFolderReport({ home: h, platform: 'darwin' }, ['http://localhost:3100'], (a) => { calls.push(a); });
  assert.equal(r.removed, false);
  assert.match(r.kept!, /another brain/);
  assert.deepEqual(calls, []);
  assert.ok(existsSync(join(h, 'Library', 'LaunchAgents', 'org.brain.folder-report.plist')));
  assert.ok(existsSync(join(h, '.config', 'brain', 'device-token')));
});

test('removeFolderReport never acts off the Mac', () => {
  const h = reporter('http://localhost:3100');
  assert.deepEqual(removeFolderReport({ home: h, platform: 'win32' }, ['http://localhost:3100'], () => assert.fail('no')), { removed: false, kept: null });
  assert.ok(existsSync(join(h, 'Library', 'LaunchAgents', 'org.brain.folder-report.plist')));
});

test('removeHooks: a settings.json that is not valid JSON leaves the scripts in place and says what to remove by hand', () => {
  const h = home();
  writeFileSync(join(h, '.claude', 'settings.json'), '{ "hooks": // comment\n');
  const r = removeHooks({ home: h }, false);
  assert.deepEqual(r.removed, []);
  assert.match(r.kept!, /settings\.json/);
  assert.ok(existsSync(join(h, '.claude', 'hooks', 'memory-start.mjs')));
  assert.ok(existsSync(join(h, '.claude', 'hooks', 'memory-save.mjs')));
});

test('removeHooks: a hook that only looks like ours (team-memory-save.mjs, another folder) survives', () => {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  const other = { hooks: { Stop: [{ hooks: [{ command: 'node ~/.claude/hooks/team-memory-save.mjs' }, { command: 'node /srv/wildlog/memory-save.mjs' }] }] } };
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(other));
  removeHooks({ home: h }, false);
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')), other);
});

test('removeHooks says nothing when neither script exists and settings.json has no BrainAI entry, even if a brain may be connected', () => {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  assert.deepEqual(removeHooks({ home: h }, true), { removed: [], kept: null }, 'no .claude at all');
  mkdirSync(join(h, '.claude'), { recursive: true });
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  assert.deepEqual(removeHooks({ home: h }, true), { removed: [], kept: null }, "only the owner's own hooks");
  assert.match(removeHooks({ home: home() }, true).kept ?? '', /were left in place/, 'with ours present it still says so');
});

test('hooksPresent ignores team-memory-save.mjs in settings.json', () => {
  const h = mkdtempSync(join(tmpdir(), 'brainai-left-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/team/team-memory-save.mjs' }] }] } }));
  assert.deepEqual(removeHooks({ home: h }, true), { removed: [], kept: null });
});
