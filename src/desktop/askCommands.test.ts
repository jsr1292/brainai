import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fakeHome } from '../testing/fakeTools.js';
import { setupText } from '../setup/texts.js';
import { connect, type ToolEnv } from './tools.js';
import { askCommandsFor, defaultAskCommands } from './askCommands.js';

const CLAUDE = 'claude -p "{prompt}" --allowedTools mcp__brainai';
const CODEX = 'codex exec --skip-git-repo-check "{prompt}"';
const URL_ = 'http://localhost:3100/mcp';

test('both connected tools get their command, verbatim', () => {
  assert.deepEqual(defaultAskCommands(['claude-code', 'codex']), { 'Claude Code': CLAUDE, Codex: CODEX });
});
test('tools with no ask command give an empty map; each command is present only when its tool is connected', () => {
  assert.deepEqual(defaultAskCommands(['opencode', 'cursor']), {});
  assert.deepEqual(defaultAskCommands(['codex']), { Codex: CODEX });
});

function world(t: TestContext, tools: Parameters<typeof fakeHome>[0]) {
  const f = fakeHome(tools);
  t.after(() => f.cleanup());
  const env: ToolEnv = { home: f.home, apps: f.apps, mcpUrl: URL_, system: {}, claudeConfig: join(f.home, 'claude_desktop_config.json'), path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, rules: (s) => setupText(s, URL_) };
  return { f, env };
}

test('a connected tool whose command cannot be found is left out', async (t) => {
  const { f, env } = world(t, ['claude', 'codex']);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.equal((await connect('codex', env, {})).ok, true);
  const got = await askCommandsFor(env);
  assert.deepEqual(got, { 'Claude Code': CLAUDE, Codex: CODEX });
  const none = world(t, ['claude']);
  assert.equal((await connect('claude-code', none.env, {})).ok, true);
  // codex is not installed at all: not in the map; claude is present
  assert.deepEqual(await askCommandsFor(none.env), { 'Claude Code': CLAUDE });
  // connected in its config but the command is gone from the PATH
  const gone = world(t, ['claude']);
  assert.equal((await connect('claude-code', gone.env, {})).ok, true);
  assert.deepEqual(await askCommandsFor({ ...gone.env, path: '/nonexistent-dir' }), {});
});

import { cachedAskCommands } from './askCommands.js';

const tick = () => new Promise((r) => setImmediate(r));

test('the cached reader looks at most once a minute and never waits', async (t) => {
  const { env } = world(t, []);
  let clock = 0, looks = 0;
  const read = cachedAskCommands(env, { now: () => clock, look: async () => { looks++; return { Codex: `c${looks}` }; } });
  assert.deepEqual(read(), {});
  await tick();
  clock = 30_000;
  assert.deepEqual(read(), { Codex: 'c1' }); assert.equal(looks, 1);
  clock = 61_000;
  read(); await tick();
  assert.deepEqual(read(), { Codex: 'c2' }); assert.equal(looks, 2);
});

test('primed with refresh(), the first read already has the commands', async (t) => {
  const { env } = world(t, []);
  const read = cachedAskCommands(env, { now: () => 0, look: async () => ({ Codex: 'x' }) });
  await read.refresh();
  assert.deepEqual(read(), { Codex: 'x' });
});

test('refresh() right after a change shows it without waiting a minute, even while a look is running', async (t) => {
  const { env } = world(t, []);
  let state = 'old';
  const read = cachedAskCommands(env, { now: () => 0, look: async () => { const v = state; await tick(); return { Codex: v }; } });
  await read.refresh();
  assert.deepEqual(read(), { Codex: 'old' });
  state = 'new';
  await read.refresh();
  assert.deepEqual(read(), { Codex: 'new' });
});

test('a failing look keeps the last good value, does not throw, and is logged once per minute', async (t) => {
  const { env } = world(t, []);
  let clock = 0, fail = false; const logged: unknown[] = [];
  const read = cachedAskCommands(env, { now: () => clock, log: (e) => logged.push(e), look: async () => { if (fail) throw new Error('boom'); return { Codex: 'good' }; } });
  await read.refresh();
  fail = true;
  await read.refresh(); await read.refresh();
  assert.deepEqual(read(), { Codex: 'good' });
  assert.equal(logged.length, 1);
  clock = 61_000;
  await read.refresh();
  assert.equal(logged.length, 2);
});
