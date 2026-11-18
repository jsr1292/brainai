import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeHome, type FakeHome } from '../testing/fakeTools.js';
import { setupText } from '../setup/texts.js';
import { addReminders, backupFiles, connect, disconnect, dropSettingsBackup, toolStates, type ToolEnv } from './tools.js';
import { hasHooks, installHooks, removeToolHooks } from './hooksInstall.js';

const URL_ = 'http://localhost:3100/mcp';

function world(t: TestContext, tools?: Parameters<typeof fakeHome>[0]): { f: FakeHome; env: ToolEnv } {
  const f = fakeHome(tools);
  t.after(() => f.cleanup());
  const built = mkdtempSync(join(tmpdir(), 'brainai-hooks-'));
  for (const n of ['memoryStart.js', 'memorySave.js', 'memoryNudge.js']) writeFileSync(join(built, n), `// ${n}\n`);
  const env: ToolEnv = {
    home: f.home, apps: f.apps, mcpUrl: URL_, hooksDir: built,
    path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    rules: (slug) => setupText(slug, URL_),
    system: {}, claudeConfig: join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  };
  return { f, env };
}
const json = (f: FakeHome, rel: string) => JSON.parse(f.read(rel)!) as { hooks: Record<string, unknown[]> };
const commands = (hooks: unknown[]): string[] => hooks.flatMap((g) => {
  const x = g as { command?: string; hooks?: { command: string }[] };
  return x.command ? [x.command] : (x.hooks ?? []).map((h) => h.command);
});

test('Claude Code: Connect installs the start, stop and PreCompact hooks beside the owner\'s own, and Disconnect takes only those back', async (t) => {
  const { f, env } = world(t);
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, theme: 'dark' };
  f.write('.claude/settings.json', JSON.stringify(mine));
  const r = await connect('claude-code', env, {});
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(f.home, '.claude/hooks/memory-start.mjs')) && existsSync(join(f.home, '.claude/hooks/memory-save.mjs')));
  const s = json(f, '.claude/settings.json');
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
  assert.equal(commands(s.hooks.Stop!).length, 2);
  assert.ok(commands(s.hooks.Stop!).includes('say done'));
  assert.match(commands(s.hooks.PreCompact!)[0]!, /memory-save\.mjs"$/);
  assert.match(commands(s.hooks.SessionStart!)[0]!, /memory-start\.mjs"$/);
  assert.equal((s as unknown as { theme: string }).theme, 'dark');
  assert.deepEqual(JSON.parse(f.read('.claude/settings.json.brainai-backup')!), mine, 'a backup of the original first');
  assert.equal((await toolStates(env)).find((x) => x.id === 'claude-code')!.hooks, 'on');

  // Connecting again changes nothing (idempotent).
  const before = f.read('.claude/settings.json');
  await connect('claude-code', env, {});
  assert.equal(f.read('.claude/settings.json'), before);

  assert.equal((await disconnect('claude-code', env)).ok, true);
  assert.deepEqual(JSON.parse(f.read('.claude/settings.json')!), mine);
  assert.equal(existsSync(join(f.home, '.claude/hooks/memory-save.mjs')), false);
});

test('Codex: Connect writes ~/.codex/hooks.json (Stop and PostToolUse), says to trust it once, and Disconnect deletes the file it created', async (t) => {
  const { f, env } = world(t, ['codex']);
  const r = await connect('codex', env, {});
  assert.equal(r.ok, true);
  assert.match((r as { hooksNote?: string }).hooksNote ?? '', /\/hooks/);
  const s = json(f, '.codex/hooks.json');
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'Stop']);
  assert.match(commands(s.hooks.Stop!)[0]!, /\.brainai\/hooks\/memory-nudge\.mjs" codex$/);
  assert.ok(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')));
  assert.equal((await disconnect('codex', env)).ok, true);
  assert.equal(existsSync(join(f.home, '.codex/hooks.json')), false, 'BrainAI made it, so an empty one is deleted');
  assert.equal(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), false);
});

test('Cursor: flat hooks.json entries with version 1; the shared script stays while Codex still uses it', async (t) => {
  const { f, env } = world(t, ['codex']);
  f.write('.cursor/mcp.json', '{}');
  f.write('.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { stop: [{ command: './mine.sh' }] } }));
  assert.equal((await connect('cursor', env, {})).ok, true);
  await connect('codex', env, {});
  const s = json(f, '.cursor/hooks.json');
  assert.deepEqual(s.hooks.stop!.length, 2);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['postToolUse', 'stop']);
  assert.match(commands(s.hooks.postToolUse!)[0]!, /memory-nudge\.mjs" cursor$/);
  assert.equal((await disconnect('cursor', env)).ok, true);
  assert.deepEqual(json(f, '.cursor/hooks.json').hooks, { stop: [{ command: './mine.sh' }] });
  assert.ok(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), 'Codex still uses the script');
  await disconnect('codex', env);
  assert.equal(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), false);
});

test('a hook config that is not plain JSON is never rewritten: Connect still works and says so', async (t) => {
  const { f, env } = world(t, ['codex']);
  f.write('.codex/hooks.json', '{ // comment\n}');
  const r = await connect('codex', env, {});
  assert.equal(r.ok, true);
  assert.match((r as { hooksNote?: string }).hooksNote ?? '', /not plain JSON/);
  assert.equal(f.read('.codex/hooks.json'), '{ // comment\n}');
  assert.equal(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), false);
});

test('without built scripts, or for tools with no hooks, Connect adds no reminders', async (t) => {
  const { f, env } = world(t);
  assert.equal(hasHooks('opencode'), false);
  assert.equal(hasHooks('claude-desktop'), false);
  assert.equal((await connect('opencode', env, {})).ok, true);
  assert.equal(existsSync(join(f.home, '.brainai')), false);
  assert.equal((await toolStates(env)).find((x) => x.id === 'opencode')!.hooks, 'none');
  const bare = { ...env, hooksDir: undefined };
  await connect('claude-code', bare, {});
  assert.equal(f.read('.claude/settings.json'), null);
});

test('"Add save reminders" works on a tool that was connected before', async (t) => {
  const { f, env } = world(t, ['codex']);
  await connect('codex', { ...env, hooksDir: undefined }, {});
  assert.equal((await toolStates(env)).find((x) => x.id === 'codex')!.hooks, 'off');
  f.write('.codex/hooks.json', JSON.stringify({ hooks: {} }));
  assert.equal((await addReminders('codex', env)).ok, true);
  assert.equal((await toolStates(env)).find((x) => x.id === 'codex')!.hooks, 'on');
  assert.ok(backupFiles(env).some((p) => p.endsWith('hooks.json.brainai-backup')));
  assert.equal((await addReminders('opencode', env)).ok, false);
});

test('backupFiles leaves out the settings.json backup (it can hold tokens); dropSettingsBackup deletes it', async (t) => {
  const { f, env } = world(t);
  f.write('.claude/settings.json', JSON.stringify({ env: { TOKEN: 'secret' } }));
  await connect('claude-code', env, {});
  assert.ok(existsSync(join(f.home, '.claude/settings.json.brainai-backup')));
  assert.equal(backupFiles(env).some((p) => p.endsWith('settings.json.brainai-backup')), false);
  assert.match(dropSettingsBackup(env) ?? '', /deleted its backup/);
  assert.equal(existsSync(join(f.home, '.claude/settings.json.brainai-backup')), false);
  assert.equal(dropSettingsBackup(env), null);
});

test('an event that holds something other than a list is never overwritten: the file is left alone and a note says so', async (t) => {
  const { f, env } = world(t, ['codex']);
  f.write('.cursor/mcp.json', '{}');
  const mine = JSON.stringify({ version: 1, hooks: { stop: { command: './mine.sh' } } });
  f.write('.cursor/hooks.json', mine);
  const note = installHooks('cursor', env);
  assert.match(note ?? '', /unexpected shape.*will not rewrite/);
  assert.equal(f.read('.cursor/hooks.json'), mine);
  assert.equal(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), false);
});

test('Disconnect of one tool keeps the shared script while the other tool\'s config cannot be parsed but still names it', async (t) => {
  const { f, env } = world(t, ['codex']);
  f.write('.cursor/mcp.json', '{}');
  await connect('cursor', env, {});
  await connect('codex', env, {});
  f.write('.cursor/hooks.json', `// mine\n${f.read('.cursor/hooks.json')!}`);
  assert.equal(removeToolHooks('codex', env), null);
  assert.ok(existsSync(join(f.home, '.brainai/hooks/memory-nudge.mjs')), 'Cursor still runs it');
});

test('Codex and Cursor Disconnect leave the reminders when another brain\'s memory entry is in the tool', async (t) => {
  const { f, env } = world(t, ['codex']);
  await connect('codex', env, {});
  f.write('.codex/config.toml', `${f.read('.codex/config.toml') ?? ''}\n[mcp_servers.memory]\nurl = "https://other/mcp"\n`);
  const r = await disconnect('codex', env);
  assert.equal(r.ok, true);
  assert.match((r as { hooksNote?: string }).hooksNote ?? '', /left in place/);
  assert.ok(existsSync(join(f.home, '.codex/hooks.json')));
});

test('the saved command runs plain node when it is on the PATH; the absolute interpreter is only the fallback', async (t) => {
  const { f, env } = world(t, ['codex']);
  await connect('codex', env, {});
  assert.match(commands(json(f, '.codex/hooks.json').hooks.Stop!)[0]!, /^node "/);
  const bare = world(t, ['codex']);
  const noNode = { ...bare.env, path: bare.f.bin };
  installHooks('codex', noNode);
  assert.ok(commands(json(bare.f, '.codex/hooks.json').hooks.Stop!)[0]!.startsWith(`"${process.execPath}" "`));
});

test('Cursor on Windows with no node on the PATH: the absolute interpreter is called with PowerShell\'s & operator', async (t) => {
  const { f, env } = world(t, ['codex']);
  f.write('.cursor/mcp.json', '{}');
  installHooks('cursor', { ...env, platform: 'win32', path: '' });
  assert.ok(commands(json(f, '.cursor/hooks.json').hooks.stop!)[0]!.startsWith(`& "${process.execPath}" "`));
});

test('the state turns off when the interpreter in the saved command no longer exists, and Add save reminders fixes it', async (t) => {
  const { f, env } = world(t, ['codex']);
  await connect('codex', env, {});
  assert.equal((await toolStates(env)).find((x) => x.id === 'codex')!.hooks, 'on');
  const noNode = { ...env, path: f.bin };
  assert.equal((await toolStates(noNode)).find((x) => x.id === 'codex')!.hooks, 'off', 'bare node is not on the PATH any more');
  f.write('.codex/hooks.json', f.read('.codex/hooks.json')!.replaceAll('"command": "node ', '"command": "\\"/gone/node\\" '));
  assert.equal((await toolStates(env)).find((x) => x.id === 'codex')!.hooks, 'off', 'the absolute interpreter is gone');
  assert.equal((await addReminders('codex', env)).ok, true);
  assert.equal((await toolStates(env)).find((x) => x.id === 'codex')!.hooks, 'on');
});

test('config writes go through a temp file renamed over the real file: a symlink stays a symlink and no temp is left', async (t) => {
  const { f, env } = world(t, ['codex']);
  const real = join(f.home, 'dotfiles', 'hooks.json');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  mkdirSync(join(f.home, '.codex'), { recursive: true });
  symlinkSync(real, join(f.home, '.codex/hooks.json'));
  await connect('codex', env, {});
  assert.ok(lstatSync(join(f.home, '.codex/hooks.json')).isSymbolicLink());
  assert.match(f.read('dotfiles/hooks.json')!, /memory-nudge\.mjs/);
  assert.deepEqual(readdirSync(dirname(real)).filter((n) => n.includes('.tmp')), []);
});
